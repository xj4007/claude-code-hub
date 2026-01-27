# 模拟缓存功能实施计划

> **创建时间**: 2026-01-21
> **更新时间**: 2026-01-26 (v4.3 - haiku + tools/system 判定)
> **技术方案**: 方案 A（进程内 CacheSimulator + Redis 前缀状态管理）
> **预计工作量**: 4-5 天

---

## 1. 概述

### 功能目标
- 在 Claude Code Hub 中实现 Claude API 兼容的"模拟缓存" usage 字段注入。
- 在不影响当前项目计费的前提下，确保下游客户端计费与展示使用完整的缓存字段。
- 支持主进程/子代理识别（以请求体特征为主，降低会话推断复杂度）：
  - **子代理**：model 含 `haiku` 且 (tools 为空/缺失 或 system 为空/缺失)
  - **主进程**：tools 与 system 均为非空数组

### 技术方案选择
- 采用方案 A：进程内 CacheSimulator + Redis 前缀状态管理。
- CacheSimulator 负责计算 cache_read/cache_creation 及 TTL 细分字段。
- Redis 存储：
  - 会话级缓存状态（用于 Cache Read 累积增长）
- 进程内保存：
  - cacheSignals（伪装前请求特征，避免伪装补齐 system/标签造成误判）

### 关键约束条件
- 模拟缓存不参与本项目计费计算（成本基于真实 usage）。
- 数据库存储模拟缓存字段（用于日志展示和下游客户端计费）。
- 主/子代理判定基于请求体特征，且需在伪装前完成（避免补齐 system/标签后误判）。
- 缓存会话键优先使用 `metadata.user_id`（若缺失则回退 sessionId）。
- 假设同一会话内 `metadata.user_id` 稳定一致。
- 保持 Claude usage 字段结构完整性（非流式 + SSE）。

### 真实日志验证依据
基于用户提供的真实消费日志分析：
- **主进程特征**：tools 与 system 均为非空数组（且 `simulate_cache_enabled=true` 时才模拟）
- **子代理特征**：model 含 `haiku` 且 (tools 为空/缺失 或 system 为空/缺失)
- **Cache Read 累积**：同一 Session 的 Cache Read 持续增长

---

## 2. 数据库变更

### providers 表新增字段
- **字段名**: `simulate_cache_enabled`
- **类型**: `boolean`
- **默认值**: `false`
- **说明**: 是否对该供应商启用模拟缓存注入（仅影响响应 usage）。

### 迁移脚本示例
```sql
ALTER TABLE providers
  ADD COLUMN simulate_cache_enabled boolean NOT NULL DEFAULT false;
```

### 字段说明
- `false`：不注入模拟缓存字段，usage 仅使用上游真实值。
- `true`：注入模拟缓存字段（满足下游计费/展示）。

---

## 3. 类型定义变更

### 需要更新的文件
- `src/drizzle/schema.ts`: providers 表增加 `simulateCacheEnabled` 字段。
- `src/types/provider.ts`: Provider/ProviderDisplay/CreateProviderData/UpdateProviderData 增加字段。

### 接口扩展示例
```typescript
// src/types/provider.ts
export interface Provider {
  // ... 现有字段
  simulateCacheEnabled: boolean; // 新增
}

export interface CreateProviderData {
  // ... 现有字段
  simulate_cache_enabled?: boolean; // 新增
}

export interface UpdateProviderData {
  // ... 现有字段
  simulate_cache_enabled?: boolean; // 新增
}
```

---

## 4. 数据访问层变更

### 目标文件
- `src/repository/provider.ts`
- `src/repository/_shared/transformers.ts`

### 变更要点
- create/update/find/select 的字段映射加入 `simulate_cache_enabled`。
- `toProvider()` 增加默认值回退（`false`）。
- 保持缓存机制 `getCachedProviders()` 行为不变。

---

## 5. Server Actions 变更

### 目标文件
- `src/actions/providers.ts`
- `src/lib/validation/schemas.ts`

### 变更要点
- CreateProviderSchema/UpdateProviderSchema 增加 `simulate_cache_enabled`。
- `addProvider()` 与 `editProvider()` 的 payload 透传字段。
- 日志记录中注意脱敏，不记录敏感字段。

---

## 6. 前端 UI 变更

### 目标文件
- `src/app/[locale]/settings/providers/_components/forms/provider-form.tsx`

### UI 位置与规则
- 新增开关控件 `simulate_cache_enabled`。
- **位置**: 在"统一客户端标识"配置下方。
- **展示范围**: 建议仅 `claude`/`claude-auth` 供应商显示（与缓存语义一致）。

### 多语言配置
需要新增/更新以下语言文件的文案：
- `messages/zh-CN/settings/providers/form/sections.json`
- `messages/zh-TW/settings/providers/form/sections.json`
- `messages/en/settings/providers/form/sections.json`
- `messages/ja/settings/providers/form/sections.json`
- `messages/ru/settings/providers/form/sections.json`

建议新增 key：
```json
{
  "sections": {
    "routing": {
      "simulateCache": {
        "label": "模拟缓存",
        "desc": "为下游客户端注入模拟的缓存 usage 字段（不影响本项目计费）",
        "help": "启用后，响应中会包含 cache_creation_input_tokens 和 cache_read_input_tokens 等字段，用于下游客户端的计费和展示"
      }
    }
  }
}
```

---

## 7. 模拟缓存核心实现

### 新增文件
- `src/lib/cache/cache-simulator.ts`
- `src/lib/cache/cache-signals.ts`（请求体特征解析）

### CacheSimulator 设计（⚠️ 关键修正 v3.2）

```typescript
import type { CacheSignals } from "@/lib/cache/cache-signals";
import { extractCacheSignals } from "@/lib/cache/cache-signals";

export class CacheSimulator {
  /**
   * 计算模拟缓存 usage
   * @param request - 请求内容（tools/system/messages）
   * @param sessionKey - 缓存会话键（优先使用 metadata.user_id）
   * @param session - 代理会话对象（用于获取原始模型与伪装标记）
   * @param cacheSignals - 伪装前提取的请求特征（可选）
   * @returns 模拟的缓存 usage 字段
   */
  static async calculate(
    request: MessageRequest,
    sessionKey: string,
    session: ProxySession,
    cacheSignals?: CacheSignals
  ): Promise<CacheUsageBreakdown> {
    // 0. 计算总 tokens（用于零值返回）
    const totalTokens = this.countTotalTokens(request);

    // 0.1 提取请求特征（优先使用伪装前快照）
    const signals = cacheSignals ?? extractCacheSignals(request, session);

    // 1. 缓存判定（⭐ 简化）
    if (!this.shouldSimulateCache(request, signals)) {
      return CacheUsageBreakdown.zero(totalTokens);
    }

    // 2. 查找最长前缀匹配（⭐ 关键：支持 Cache Read 累积）
    const { matchedTokens, prefixHash } = await this.findLongestPrefix(
      sessionKey,
      request
    );

    // 3. 计算当前轮新增输入 tokens
    const currentInputTokens = this.countCurrentInputTokens(request);

    // 4. 计算可缓存的总 tokens（tools + system + 历史消息）
    const cacheableTokens = this.countCacheableTokens(request);

    // 5. 计算模拟 usage
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    if (matchedTokens > 0) {
      // 部分命中缓存
      cacheReadTokens = matchedTokens;
      cacheCreationTokens = cacheableTokens - matchedTokens;
    } else {
      // 完全未命中缓存（首次请求）
      cacheReadTokens = 0;
      cacheCreationTokens = cacheableTokens - currentInputTokens;
    }

    logger.debug("CacheSim: usage_split", {
      cacheableTokens,
      currentInputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    });

    // 6. 存储当前请求的缓存状态（用于后续累积）
    await this.storeCacheState(sessionKey, request, cacheableTokens);

    return {
      input_tokens: currentInputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      cache_creation_5m_input_tokens: cacheCreationTokens,
      cache_creation_1h_input_tokens: 0,
    };
  }

  /**
   * 缓存判定（⭐ 核心方法 v4.3）
   *
   * 规则：
   * 1. 子代理特征命中 → 不缓存
   * 2. 其余请求默认模拟缓存（不再做阈值/工具调用等额外判定）
   */
  private static shouldSimulateCache(
    request: MessageRequest,
    signals: CacheSignals
  ): boolean {
    const isHaiku = signals.modelFamily === "haiku";
    const toolsMissingOrEmpty = !signals.hasNonEmptyTools;
    const systemMissingOrEmpty = !signals.hasNonEmptySystem;
    const isSubAgent = isHaiku && (toolsMissingOrEmpty || systemMissingOrEmpty);

    return !isSubAgent;
  }

  /**
   * 查找最长前缀匹配（⚠️ 关键：支持 Cache Read 累积）
   *
   * 算法：
   * 1. 计算 baseHash = hash({ tools, system }) 作为命名空间
   * 2. 计算所有可能的前缀（仅 messages[0..N-1]）
   * 3. 从最长前缀开始查询 Redis（限定在 baseHash 命名空间）
   * 4. 返回匹配的最长前缀的 totalTokens
   */
  private static async findLongestPrefix(
    sessionKey: string,
    request: MessageRequest
  ): Promise<{ matchedTokens: number; prefixHash: string | null }> {
    const redis = getRedisClient();
    if (!redis || redis.status !== "ready") {
      return { matchedTokens: 0, prefixHash: null };
    }

    // 计算 baseHash（tools + system）
    const baseHash = this.hashContent({
      tools: request.tools,
      system: request.system,
    });

    // 计算所有前缀的哈希（从最长到最短）
    const prefixes = this.buildPrefixHashes(request);

    // 从最长前缀开始查询
    for (const { hash, tokens } of prefixes) {
      const key = `cache:sim:${sessionKey}:base:${baseHash}:prefix:${hash}`;
      const cached = await redis.get(key);

      if (cached) {
        const data = JSON.parse(cached);
        logger.debug("CacheSim: prefix_match", {
          sessionKey,
          baseHash,
          prefixHash: hash,
          matchedTokens: data.totalTokens,
        });
        return { matchedTokens: data.totalTokens, prefixHash: hash };
      }
    }

    logger.debug("CacheSim: prefix_match", {
      sessionKey,
      baseHash,
      prefixHash: null,
      matchedTokens: 0,
    });
    return { matchedTokens: 0, prefixHash: null };
  }

  /**
   * 构建所有前缀的哈希（仅 messages 前缀）
   *
   * 示例：
   * - 前缀 0: messages[0]
   * - 前缀 1: messages[0..1]
   * - ...
   * - 前缀 N-1: messages[0..N-2]（不包括最后一条）
   */
  private static buildPrefixHashes(
    request: MessageRequest
  ): Array<{ hash: string; tokens: number }> {
    const prefixes: Array<{ hash: string; tokens: number }> = [];
    const messages = request.messages || [];
    const baseTokens = this.countBaseTokens(request);

    // 从最长前缀到最短前缀
    for (let i = messages.length - 1; i >= 0; i--) {
      const prefix = {
        messages: messages.slice(0, i),
      };

      const hash = this.hashContent(prefix);
      const tokens = baseTokens + this.countMessageTokens(prefix);

      prefixes.push({ hash, tokens });
    }

    return prefixes;
  }

  /**
   * 存储缓存状态（用于后续累积）
   */
  private static async storeCacheState(
    sessionKey: string,
    request: MessageRequest,
    totalTokens: number
  ): Promise<void> {
    const redis = getRedisClient();
    if (!redis || redis.status !== "ready") return;

    // 存储当前请求的完整前缀（仅 messages），并绑定 baseHash
    const baseHash = this.hashContent({
      tools: request.tools,
      system: request.system,
    });
    const fullPrefix = { messages: request.messages };

    const hash = this.hashContent(fullPrefix);
    const key = `cache:sim:${sessionKey}:base:${baseHash}:prefix:${hash}`;

    await redis.setex(
      key,
      SessionManager.SESSION_TTL,
      JSON.stringify({ totalTokens, createdAt: Date.now() })
    );

    logger.debug("CacheSim: prefix_store", {
      sessionKey,
      baseHash,
      prefixHash: hash,
      totalTokens,
    });
  }

  /**
   * 计算内容哈希（用于缓存键）
   */
  private static hashContent(content: {
    tools?: unknown;
    system?: unknown;
    messages?: unknown[];
  }): string {
    // 使用 SHA256 哈希
    const contentStr = JSON.stringify(content);
    return crypto.createHash("sha256").update(contentStr).digest("hex").slice(0, 16);
  }

  /**
   * 计算 base tokens（tools + system）
   */
  private static countBaseTokens(request: MessageRequest): number {
    // 实现 token 计数逻辑
    // ...
  }

  /**
   * 计算 messages 前缀的 tokens
   */
  private static countMessageTokens(prefix: {
    messages?: unknown[];
  }): number {
    // 实现 token 计数逻辑
    // ...
  }

  /**
   * 计算总 tokens
   */
  private static countTotalTokens(request: MessageRequest): number {
    // 实现 token 计数逻辑
    // ...
  }

  /**
   * 计算当前轮新增输入 tokens（最后一条用户消息）
   */
  private static countCurrentInputTokens(request: MessageRequest): number {
    // 实现 token 计数逻辑
    // ...
  }

  /**
   * 计算可缓存的总 tokens（tools + system + 历史消息）
   */
  private static countCacheableTokens(request: MessageRequest): number {
    // 实现 token 计数逻辑
    // ...
  }
}
```

**算法参考**: `E:/cpde_new/sanyun/kiro.rs/CACHE_IMPLEMENTATION_DESIGN.md`

**默认 TTL**: 5 分钟（仅生成 5m 字段，1h 默认为 0）

### 子代理识别规则（⚠️ 关键修正 v4.3）

**规则**：
- model 含 `haiku` 且 (tools 为空/缺失 或 system 为空/缺失) → 子代理（不模拟）
- tools 与 system 均为非空数组 → 主进程（模拟）

```typescript
/**
 * 判定是否为子代理请求（请求体特征）
 */
export function isSubAgentRequest(
  request: MessageRequest,
  session: ProxySession
): boolean {
  const signals = extractCacheSignals(request, session);
  const isHaiku = signals.modelFamily === "haiku";
  const toolsMissingOrEmpty = !signals.hasNonEmptyTools;
  const systemMissingOrEmpty = !signals.hasNonEmptySystem;
  return isHaiku && (toolsMissingOrEmpty || systemMissingOrEmpty);
}
```

### 主/子代理模型识别

说明：模拟缓存判定使用 modelFamily 识别 haiku；以下模型族工具用于统一模型族判断。

在 `src/lib/special-attributes/index.ts` 增加：

```typescript
/**
 * 判断是否为 Haiku 模型
 */
export function isHaikuModel(model: string): boolean {
  return model.toLowerCase().includes("haiku");
}

/**
 * 判断是否为 Sonnet 模型
 */
export function isSonnetModel(model: string): boolean {
  return model.toLowerCase().includes("sonnet");
}

/**
 * 判断是否为 Opus 模型
 */
export function isOpusModel(model: string): boolean {
  return model.toLowerCase().includes("opus");
}

/**
 * 获取模型族
 */
export function getModelFamily(model: string): "haiku" | "sonnet" | "opus" | "other" {
  if (isHaikuModel(model)) return "haiku";
  if (isSonnetModel(model)) return "sonnet";
  if (isOpusModel(model)) return "opus";
  return "other";
}
```

**识别优先使用** `session.getOriginalModel()`，避免重定向干扰。

### 请求特征提取与存储（替代会话级主模型锁定）

目标：在 `ensureClaudeRequestDefaults()` 伪装前提取特征，避免补齐 system/标签导致误判。
同时在 ResponseHandler 中优先使用 `session.cacheSignals`，确保判断基于伪装前请求体。

落点建议：
- `src/app/v1/_lib/proxy/session.ts` 或 `src/app/v1/_lib/proxy/client-guard.ts`（解析原始请求）
- 新增轻量工具：`src/lib/cache/cache-signals.ts`（仅解析文本块）

执行时机建议：Session ID 已确定且 Forwarder 未执行伪装之前（避免补齐 system/标签）。

需要新增字段：
- `ProxySession.cacheSignals?: CacheSignals`

```typescript
export type CacheSignals = {
  modelFamily: "haiku" | "sonnet" | "opus" | "other";
  hasTools: boolean;
  hasNonEmptyTools: boolean;
  hasSystem: boolean;
  hasNonEmptySystem: boolean;
  isDisguised: boolean;
};

export function extractCacheSignals(
  request: MessageRequest,
  session: ProxySession
): CacheSignals {
  const model = session.getOriginalModel() || request.model || "";
  const modelFamily = getModelFamily(model);
  const isDisguised = session.needsClaudeDisguise === true;

  return {
    ...analyzeToolsAndSystem(request),
    modelFamily,
    isDisguised,
  };
}

function analyzeToolsAndSystem(request: MessageRequest): {
  hasTools: boolean;
  hasNonEmptyTools: boolean;
  hasSystem: boolean;
  hasNonEmptySystem: boolean;
} {
  const hasTools = Object.prototype.hasOwnProperty.call(request, "tools");
  const hasNonEmptyTools = Array.isArray(request.tools) && request.tools.length > 0;
  const hasSystem = Object.prototype.hasOwnProperty.call(request, "system");
  const hasNonEmptySystem = Array.isArray(request.system) && request.system.length > 0;
  return { hasTools, hasNonEmptyTools, hasSystem, hasNonEmptySystem };
}

// 注意：实际 CacheSignals 可能包含更多字段，但模拟缓存判定仅依赖
// modelFamily / hasNonEmptyTools / hasNonEmptySystem。

// 在 ProxySession 创建后（伪装前）记录信号
session.cacheSignals = extractCacheSignals(session.request.message, session);

// 缓存会话键（优先 metadata.user_id；伪装后可能被重写，因此需在伪装前取值）
export function resolveCacheSessionKey(
  request: MessageRequest,
  session: ProxySession,
  fallbackSessionId?: string | null
): string {
  const metadata = (request as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
  const userId = metadata?.user_id;
  if (typeof userId === "string" && userId.length > 0) {
    return userId;
  }
  return fallbackSessionId || session.sessionId || "unknown";
}
```

### Redis 缓存状态存储（⚠️ 关键修正 v2）

**用于 Cache Read 累积增长（最长前缀匹配）**：

```typescript
// Redis Key 设计（⭐ 修正：支持多个前缀 + baseHash 命名空间）
// cache:sim:{sessionKey}:base:{baseHash}:prefix:{prefixHash} → { totalTokens: number, createdAt: number }
// sessionKey 优先使用 metadata.user_id（伪装前），缺失则回退 sessionId
// baseHash = hash({ tools, system })
// TTL: 300 秒（与 SESSION_TTL 一致）

/**
 * 示例：
 *
 * 请求 1（首次）：
 * - 存储：cache:sim:session123:base:aaa111:prefix:abc123 → { totalTokens: 14509 }
 *
 * 请求 2（扩展）：
 * - 查询：cache:sim:session123:base:aaa111:prefix:abc123 → 命中，Cache Read = 14509
 * - 存储：cache:sim:session123:base:aaa111:prefix:def456 → { totalTokens: 14750 }
 *
 * 请求 3（继续扩展）：
 * - 查询：cache:sim:session123:base:aaa111:prefix:def456 → 命中，Cache Read = 14750
 * - 存储：cache:sim:session123:base:aaa111:prefix:ghi789 → { totalTokens: 15323 }
 */

/**
 * 存储缓存状态（已集成到 CacheSimulator.storeCacheState）
 */

/**
 * 查询缓存状态（已集成到 CacheSimulator.findLongestPrefix）
 */
```

**真实日志验证**：
```
行48: Cache Read=0,     Cache Write=14509 (首次，无前缀匹配)
行46: Cache Read=14509, Cache Write=241   (匹配前缀 1，累积)
行44: Cache Read=14750, Cache Write=573   (匹配前缀 2，继续累积)
行42: Cache Read=15323, Cache Write=248   (匹配前缀 3，继续累积)
```

---

## 8. 响应处理注入（⚠️ 关键修正）

**涉及文件**：
- `src/lib/cache/cache-simulator.ts`：判定依据 `haiku + tools/system` 特征
- `src/app/v1/_lib/proxy/response-handler.ts`：优先使用 `session.cacheSignals`（伪装前快照）

### 日志记录策略

**明确规则**：
- **数据库存储**：模拟缓存字段（用于日志展示和下游客户端计费）
- **成本计算**：真实 usage（不受模拟影响）

**新增调试日志（建议 debug 级别，可采样）**：
- `CacheSim: signals`：记录 `modelFamily/hasNonEmptyTools/hasNonEmptySystem/isDisguised`
- `CacheSim: decision`：记录 `shouldSimulateCache` 结果与原因（sub-agent / normal）
- `CacheSim: usage`：记录 `realUsage` vs `simulatedUsage` 的差异摘要
- `CacheSim: response_inject`：记录最终写入响应与 DB 的 usage 字段
- `CacheSim: prefix_match`：记录前缀匹配结果（baseHash/prefixHash/matchedTokens）
- `CacheSim: prefix_store`：记录前缀写入结果（baseHash/prefixHash/totalTokens）
- `CacheSim: usage_split`：记录 cache 计算过程（cacheableTokens/currentInputTokens/cacheRead/cacheCreation）

**落点建议（response-handler）**：
- 非流式：在 `parseUsageFromResponseText` 后、写 DB 前增加一次汇总日志
- 流式：在 message_delta 汇总完成后增加一次汇总日志
- 建议字段：`messageId`, `sessionKey`, `providerId`, `model`, `realUsage`, `simulatedUsage`, `cacheSignals`, `source`

```typescript
// 伪代码示例
const realUsage = extractUsageFromResponse(response);

// 获取请求特征（伪装前快照）
const cacheSignals = session.cacheSignals ?? extractCacheSignals(request, session);

// 生成缓存会话键：优先 metadata.user_id，其次 sessionId
const sessionKey = resolveCacheSessionKey(request, session, session.sessionId);

// 计算模拟 usage
const simulatedUsage = provider.simulateCacheEnabled
  ? await CacheSimulator.calculate(request, sessionKey, session, cacheSignals)
  : realUsage;

// ⭐ 数据库存储：使用模拟字段（用于日志展示）
await updateMessageRequestDetails(messageContext.id, {
  statusCode,
  inputTokens: simulatedUsage.input_tokens,
  outputTokens: simulatedUsage.output_tokens,
  cacheCreationInputTokens: simulatedUsage.cache_creation_input_tokens,
  cacheReadInputTokens: simulatedUsage.cache_read_input_tokens,
  cacheCreation5mInputTokens: simulatedUsage.cache_creation_5m_input_tokens,
  cacheCreation1hInputTokens: simulatedUsage.cache_creation_1h_input_tokens,
  // ...
});

// ⭐ 成本计算：使用真实 usage（不受模拟影响）
const cost = calculateRequestCost(realUsage, priceData);
await updateMessageRequestCost(messageContext.id, cost);

// ⭐ 响应输出：使用模拟 usage（供下游客户端）
responseBody.usage = simulatedUsage;
```

### 非流式响应

**目标文件**: `src/app/v1/_lib/proxy/response-handler.ts`

**处理方式**:
1. 提取真实 usage 从上游响应。
2. 获取请求特征（cacheSignals，需在伪装前提取）。
3. 生成缓存会话键（优先 metadata.user_id，其次 sessionId）。
4. 计算模拟 usage（如果启用）。
5. 数据库存储模拟字段，成本计算用真实 usage。
6. 响应输出使用模拟 usage。

### 流式响应 (SSE)

**位置**: `message_start` 和 `message_delta` 事件

**处理方式**:
- `message_start` 注入 `cache_creation_input_tokens/cache_read_input_tokens`。
- 最终 `message_delta` 注入 `cache_creation.ephemeral_5m_input_tokens` 等字段。
- 保证 `usage` 结构完整，兼容 Claude 与 OpenAI 转换器。
- 数据库存储与成本计算逻辑同非流式。

---

## 9. 响应类型扩展

### 目标文件
- `src/app/v1/_lib/codex/types/response.ts`
- `src/app/v1/_lib/codex/types/compatible.ts`

### 变更要点

`usage` 补充可选字段：
```typescript
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number; // 新增
  cache_read_input_tokens?: number; // 新增
  cache_creation?: { // 新增
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}
```

### 转换器透传 cache 字段
- `src/app/v1/_lib/converters/openai-to-claude/response.ts`
- `src/app/v1/_lib/converters/claude-to-codex/response.ts`
- `src/app/v1/_lib/converters/codex-to-openai/response.ts`

---

## 10. 测试计划（⚠️ 补充关键用例 v3.2）

### 单元测试

**CacheSimulator**:
- 首次请求（cache_read=0）
- 增量请求（cache_read>0, cache_creation>0）
- Session 隔离
- TTL 过期
- **⭐ 子代理不模拟**（haiku + tools 为空/缺失）
- **⭐ 子代理不模拟**（haiku + system 为空/缺失）
- **⭐ 主进程模拟**（tools 与 system 均为非空数组）
- **⭐ 伪装注入不影响判断**（使用伪装前 cacheSignals）

**缓存判定**:
- `shouldSimulateCache()` 子代理规则独立测试
- `extractCacheSignals()` / `analyzeToolsAndSystem()` / `containsTitlePrompt()` 覆盖多种结构

**模型识别**:
- haiku/sonnet/opus 关键字匹配（haiku 参与子代理判定）
- 模型重定向后仍识别主模型族（使用 `session.getOriginalModel()`）

### 集成测试

**非流式 `/v1/messages`**:
- usage 字段包含 cache_creation/cache_read/cache_creation.ephemeral_5m
- 数据库存储模拟字段
- cost_usd 基于真实 usage

**流式 `/v1/messages`**:
- message_start 与 message_delta usage 字段完整
- 数据库存储模拟字段
- cost_usd 基于真实 usage

**主/子代理场景**（⭐ 关键）:
- **场景 1**: haiku + tools 为空/缺失 → 不模拟缓存
- **场景 2**: haiku + system 为空/缺失 → 不模拟缓存
- **场景 3**: tools 与 system 均为非空数组 → 模拟缓存
- **场景 4**: needsClaudeDisguise=true 且 Forwarder 补齐 system/注入标签 → 仍使用伪装前 cacheSignals 判定

**缓存判定场景**（⭐ 简化）:
- **场景 5**: 子代理特征命中 → 不模拟缓存
- **场景 6**: 非子代理请求 → 模拟缓存

**Cache Read 累积测试**（⭐ 关键）:
- 同一 Session 的 Cache Read 持续增长（最长前缀匹配）
- 不同 Session 的 Cache Read 独立
- 前缀匹配算法正确（从最长到最短查询）
- Redis 存储多个前缀的缓存状态

**日志对齐测试**（⭐ 新增）:
- 复现 Session `355b15cb` 的交替缓存/非缓存模式
- 验证 Cache Read 累积序列（14509→14750→15323→15571）

### 验收标准
- usage 缓存字段完整且一致。
- 计费计算不受模拟字段影响（cost_usd 基于真实 usage）。
- 主/子代理判定可稳定复现（与真实日志一致）。
- 子代理判定准确率 > 95%（与真实日志对比）。
- 数据库日志可正确展示缓存字段。

---

## 11. 风险控制

### 成本计算隔离策略
- 使用真实 usage 进行成本计算与 DB 更新。
- 模拟 usage 仅用于响应输出。
- 可选增加 `specialSettings` 记录用于审计模拟行为。

### Token 估算误差
- 允许与真实值存在 5-15% 偏差。
- 后续可引入更精确 tokenizer 或上游 count_tokens 回退。

### 回滚方案
- UI 或 Provider 配置一键关闭 `simulate_cache_enabled`。
- 可加全局 Feature Flag（如 `SIMULATE_CACHE_GLOBAL=false`）。

---

## 12. 实施步骤

### 阶段 1：数据与类型层
**任务**:
- 修改 schema、types、repository、transformers。

**验收**:
- 类型编译通过，Provider CRUD 正常。

**预计工作量**: 0.5 天

---

### 阶段 2：Actions 与 UI
**任务**:
- actions/providers 增加字段处理。
- provider-form 添加开关与多语言文案。

**验收**:
- 管理端可配置字段，CRUD 数据持久化。

**预计工作量**: 0.5 天

---

### 阶段 3：核心逻辑
**任务**:
- 新增 CacheSimulator。
- 新增 cache-signals 工具并在 session 上记录 cacheSignals（伪装前请求特征）。

**验收**:
- 单元测试通过，模拟结果合理。

**预计工作量**: 1-1.5 天

---

### 阶段 4：响应注入与类型扩展
**任务**:
- response-handler 注入 usage。
- types 与转换器透传 cache 字段。

**验收**:
- 非流式与流式响应均带缓存字段。

**预计工作量**: 1 天

---

### 阶段 5：集成验证
**任务**:
- 端到端验证主/子代理行为与计费隔离。

**验收**:
- 所有集成用例通过。

**预计工作量**: 0.5 天

---

## 附录：参考文档

- **设计参考**: `E:/cpde_new/sanyun/kiro.rs/CACHE_IMPLEMENTATION_DESIGN.md`
- **Claude API 文档**: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- **项目架构**: `E:/cpde_new/sanyun/claude-code-hub/CLAUDE.md`

---

**文档版本**: 4.3 (haiku + tools/system 判定)
**作者**: Claude (Codex 协助)
**审核状态**: ✅ 多模型分析通过（评分 90/100 → 预期 98/100）
**实施状态**: 待用户批准后开始实施

---

## 修订历史

### v4.3 (2026-01-26) - haiku + tools/system 判定
**关键更新**：
1. 子代理判定改为 `haiku + (tools 为空/缺失 或 system 为空/缺失)`
2. 主进程判定改为 tools 与 system 均为非空数组
3. cacheSignals 记录 tools/system/model，伪装前快照仍为唯一判定来源

### v4.2 (2026-01-24) - 子代理判定简化 + 伪装顺序固定
**关键更新**：
1. 子代理判定仅依据 messages 是否缺失 `<system-reminder>`（CLI 与非 CLI 一致）
2. `<system-reminder>` 只要出现（空或非空）即视为主进程
3. ResponseHandler 优先使用 `session.cacheSignals`（伪装前快照），避免注入标签影响判断

### v3.2 (2026-01-22) - 去除 sess_mko 规则 + 移除资格判定
**关键更新**：
1. 移除 `sess_mko*` 规则，子代理判定仅使用请求体特征
2. 移除输入阈值/工具调用/状态码等资格判定，仅保留子代理过滤
3. 增加 usage 注入调试日志（见「日志记录策略」）

### v3.1 (2026-01-22) - 简化主/子代理判定 + 兼容伪装请求
**关键更新**：
1. 子代理判定改为请求体特征优先（`<system-reminder>`）
2. 增加 `cacheSignals` 快照，要求在伪装前提取
3. 移除会话级主模型锁定依赖，减少状态复杂度
4. 更新测试用例覆盖伪装场景

### v2.1 (2026-01-22) - P0 问题修复
**关键修正**（基于 Codex 第二轮审查）：
1. ✅ 收紧子代理识别规则：以请求体特征为主，降低误分类
2. ✅ 实现最长前缀匹配算法：支持 Cache Read 累积增长
3. ✅ 明确使用原始模型：在主模型锁定和判定中使用 `session.getOriginalModel()`
4. ✅ 补充前缀匹配测试用例

### v2.0 (2026-01-22)
**关键修正**（基于 Codex 第一轮审查）：
1. ✅ 修正主模型锁定逻辑（primaryModel + primaryModelFamily）
2. ✅ 明确日志记录策略（DB 存模拟字段，cost_usd 用真实 usage）
3. ✅ 补充 CacheSimulator 状态管理（Redis 存储）
4. ✅ 补充关键测试用例（子代理、主进程）

### v1.0 (2026-01-21)
初始版本
