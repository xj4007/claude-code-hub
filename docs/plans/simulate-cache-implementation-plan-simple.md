# 模拟缓存功能实施计划（简化 usage 分拆版）

> **创建时间**: 2026-01-23
> **更新时间**: 2026-01-23 (v4.1 - 明确启用条件与会话键规则)
> **技术方案**: 方案 A-简化版（usage 分拆 + 轻量会话缓存）
> **预计工作量**: 2-3 天

---

## 1. 概述

### 功能目标
- 在 Claude Code Hub 中实现 Claude API 兼容的"模拟缓存" usage 字段注入。
- 在不影响当前项目计费的前提下，确保下游客户端计费与展示使用完整的缓存字段。
- **启用规则**：只要 `simulate_cache_enabled` 开启，除子代理外一律模拟缓存（不区分真实/未伪装 CLI）。
- 支持子代理识别（以请求体特征为主，降低会话推断复杂度）：
  - **子代理**：命中任一特征则不模拟缓存（保持上游 usage 原样，不注入 cache 字段）
    - messages 无 `<system-reminder>` 且模型为 Haiku（仅在真实 Claude CLI 请求时使用该规则）
    - 任意文本块包含 `Please write a 5-10 word title`

### 技术方案选择（简化点）
- **核心思路**：完全基于上游返回的 `usage.input_tokens` 进行模拟拆分，不做前缀哈希/长前缀匹配。
- **会话缓存**：仅记录「上一次请求的上游 input_tokens」，用于后续计算 Cache Read。
- **必要的文本计数**：仅在“首次请求”需要估算最后一个 user 消息的 text token 数。

### 关键约束条件
- 模拟缓存不参与本项目计费计算（成本基于真实 usage）。
- 数据库存储模拟缓存字段（用于日志展示和下游客户端计费）。
- 主/子代理判定基于请求体特征，且需在伪装前完成（避免 `<system-reminder>` 注入后误判）。
- 模型判定优先使用原始模型名（避免重定向影响 Haiku 识别）。
- 缓存会话键仅使用 `metadata.user_id`（不再回退 sessionId）。
- 保持 Claude usage 字段结构完整性（非流式 + SSE）。

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

---

## 3. 类型定义变更

### 需要更新的文件
- `src/drizzle/schema.ts`: providers 表增加 `simulateCacheEnabled` 字段。
- `src/types/provider.ts`: Provider/ProviderDisplay/CreateProviderData/UpdateProviderData 增加字段。

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

---

## 7. 模拟缓存核心实现（简化版）

### 新增文件
- `src/lib/cache/cache-simulator.ts`
- `src/lib/cache/cache-signals.ts`（请求体特征解析）

### CacheSimulator 设计（v4.0：基于 usage.input_tokens 分拆）

```typescript
type UpstreamUsage = {
  input_tokens: number;
  output_tokens: number;
};

type CacheSplit = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation_5m_input_tokens?: number;
  cache_creation_1h_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
};

const MIN_CACHE_CREATION = 50;

export class CacheSimulator {
  /**
   * 计算模拟缓存 usage（仅依赖上游 usage.input_tokens）
   * 注意：仅在 simulate_cache_enabled 开启且非子代理时调用
   */
  static async calculate(
    request: MessageRequest,
    sessionKey: string,
    session: ProxySession,
    upstreamUsage: UpstreamUsage,
    cacheSignals?: CacheSignals
  ): Promise<CacheSplit> {
    const signals = cacheSignals ?? extractCacheSignals(request, session);

    // 1) 子代理不模拟缓存
    if (!this.shouldSimulateCache(request, signals)) {
      return { ...upstreamUsage };
    }

    const current = Math.max(0, upstreamUsage.input_tokens || 0);
    const last = await this.getLastInputTokens(sessionKey);

    // 2) 首次请求：按最后一条 user 文本估算 input_tokens
    if (last == null) {
      const userTokens = this.countLastUserTextTokens(request);
      const cacheCreation = Math.max(0, current - userTokens);

      await this.setLastInputTokens(sessionKey, current);
      return this.buildUsage({
        inputTokens: userTokens,
        outputTokens: upstreamUsage.output_tokens,
        cacheReadTokens: 0,
        cacheCreationTokens: cacheCreation,
      });
    }

    // 3) 正常情况：current >= last
    if (current >= last) {
      const delta = current - last;
      const { inputTokens, cacheCreationTokens } = this.splitDelta(delta);

      await this.setLastInputTokens(sessionKey, current);
      return this.buildUsage({
        inputTokens,
        outputTokens: upstreamUsage.output_tokens,
        cacheReadTokens: last,
        cacheCreationTokens,
      });
    }

    // 4) 特殊情况：current < last（上下文压缩）
    const cacheCreationTokens = Math.floor(current * 0.1);
    const cacheReadTokens = Math.max(0, current - cacheCreationTokens);

    await this.setLastInputTokens(sessionKey, current);
    return this.buildUsage({
      inputTokens: 0,
      outputTokens: upstreamUsage.output_tokens,
      cacheReadTokens,
      cacheCreationTokens,
    });
  }

  /**
   * 拆分 delta 为 input_tokens + cache_creation
   */
  private static splitDelta(delta: number): {
    inputTokens: number;
    cacheCreationTokens: number;
  } {
    if (delta <= 0) {
      return { inputTokens: 0, cacheCreationTokens: 0 };
    }
    if (delta < MIN_CACHE_CREATION) {
      return { inputTokens: 0, cacheCreationTokens: delta };
    }

    // 使用随机拆分，但 cache_creation >= 50（不要求可复现）
    const cacheCreationTokens = this.randomInt(MIN_CACHE_CREATION, delta);
    const inputTokens = Math.max(0, delta - cacheCreationTokens);
    return { inputTokens, cacheCreationTokens };
  }

  /**
   * 统一生成 usage 结构
   */
  private static buildUsage(args: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }): CacheSplit {
    const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = args;

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      cache_creation_5m_input_tokens: cacheCreationTokens,
      cache_creation_1h_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: cacheCreationTokens,
        ephemeral_1h_input_tokens: 0,
      },
    };
  }
}
```

### 计数规则（首次请求）
- **仅计算最后一个 `role: "user"` 的 text 块**。
- `content` 可能是字符串或数组，需合并所有 `type: "text"` 的文本。
- 计数可使用现有的文本 token 估算函数，若无统一工具可采用简化估算（如 `Math.ceil(text.length / 4)`）。

### 会话缓存（简化）
- **只存上一次的上游 `usage.input_tokens`**。
- **会话键仅使用 `metadata.user_id`**。
- Redis Key 设计：
  - `cache:sim:last_input:{sessionKey}` → `{ input_tokens: number, updatedAt: number }`
  - TTL: 300 秒（与 5m 缓存语义一致）

---

## 8. 响应处理注入（简化）

### 处理方式（非流式 + 流式一致）
1. 提取真实 usage（上游返回）。
2. 获取请求特征（cacheSignals，需在伪装前提取）。
3. 生成缓存会话键（仅 metadata.user_id）。
4. 计算模拟 usage（`simulate_cache_enabled` 开启且非子代理；子代理则保持上游 usage）。
5. 数据库存储模拟字段，成本计算用真实 usage。
6. 响应输出使用模拟 usage。

### 关键差异点
- 不再依赖消息前缀匹配，仅使用 `usage.input_tokens` 做增量拆分。
- `cache_read_input_tokens` = 上一次请求的 `usage.input_tokens`（正常场景）。
- 特殊压缩场景：`current < last` 时，按当前 input 的 10% 作为 cache creation，input_tokens 置 0，其余作为 cache_read。

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
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}
```

---

## 10. 测试计划（简化版）

### 单元测试
**CacheSimulator**:
- 首次请求（用最后 user 文本估算 input_tokens）
- 增量请求（current > last）
- delta < 50（全部归入 cache_creation）
- current < last（压缩场景）
- Session 隔离（不同 sessionKey 不互串）
- TTL 过期（视 Redis 存储策略）
- 子代理不模拟（标题提示词）
- 子代理不模拟（Haiku + 无 `<system-reminder>`，仅 CLI 请求）
- 伪装请求不使用 `<system-reminder>` 规则（needsClaudeDisguise=true）

### 集成测试
**非流式 `/v1/messages`**:
- usage 字段包含 cache_creation/cache_read/cache_creation.ephemeral_5m
- 数据库存储模拟字段
- cost_usd 基于真实 usage

**流式 `/v1/messages`**:
- message_start 与 message_delta usage 字段完整
- 数据库存储模拟字段
- cost_usd 基于真实 usage

---

## 11. 风险控制

### 计费隔离
- 使用真实 usage 进行成本计算与 DB 更新。
- 模拟 usage 仅用于响应输出与展示。

### 模拟误差
- 使用估算 token 可能与真实值存在偏差（可接受 5-15%）。
- 若后续需要更精准，可引入上游 count_tokens 或统一 tokenizer。

### 回滚方案
- UI 或 Provider 配置一键关闭 `simulate_cache_enabled`。

---

## 12. 实施步骤（简化）

### 阶段 1：数据与类型层
- 修改 schema、types、repository、transformers。

### 阶段 2：Actions 与 UI
- actions/providers 增加字段处理。
- provider-form 添加开关与多语言文案。

### 阶段 3：核心逻辑
- 新增 CacheSimulator（简化 usage 拆分版）。
- 新增 cache-signals 工具并在 session 上记录 cacheSignals（伪装前请求特征）。
- Redis 存储 last_input_tokens。

### 阶段 4：响应注入与类型扩展
- response-handler 注入 usage。
- types 与转换器透传 cache 字段。

### 阶段 5：集成验证
- 端到端验证主/子代理行为与计费隔离。

---

## 修订历史

### v4.1 (2026-01-23) - 明确启用条件与会话键
**关键更新**：
1. `simulate_cache_enabled` 开启后不区分 CLI/伪装，除子代理外一律模拟缓存
2. 会话键仅使用 `metadata.user_id`（不再回退 sessionId）

### v4.0 (2026-01-23) - 简化 usage 分拆逻辑
**关键更新**：
1. 基于上游 `usage.input_tokens` 做增量拆分，不再依赖前缀哈希/全量 token 统计
2. 首次请求使用「最后一个 user 文本」估算 input_tokens
3. 引入压缩场景兜底规则（current < last）
4. 会话缓存简化为 last_input_tokens
