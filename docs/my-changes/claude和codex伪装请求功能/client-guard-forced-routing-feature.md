# Claude CLI 检测与强制路由功能

**更新时间**: 2026-01-14
**状态**: 已上线
**适用范围**: Claude 请求路径（/v1/messages 等）
**当前版本**: 4.2

---

## 1. 背景与需求

### 1.1 业务场景

- **真实 Claude CLI 请求**：使用真实的 Claude CLI 工具发送的请求，包含完整的 Claude Code 特征
- **非 CLI 请求**：其他客户端（如 curl、Postman、浏览器等）发送的请求，或者伪造的请求
- **路由策略**：
  - 真实 Claude CLI 请求：按正常分组策略路由到 `cli` 分组
  - 非 CLI 请求：强制路由到 `2api` 分组，并进行伪装

### 1.2 需求变更

**原版本（3.0）**：
- 移除强制路由逻辑，仅保留 `allowedClients` 白名单校验
- 所有 Claude 请求都在 Forwarder 层补全字段

**新版本（4.0）**：
- 新增 Claude CLI 检测逻辑（组合判断：User-Agent + 请求体特征）
- 非 CLI 请求强制路由到 `2api` 分组
- 仅对非 CLI 请求执行伪装（避免对真实 CLI 重复补全）

---

## 2. 核心功能

### 2.1 Claude CLI 检测（组合判断）

**检测维度**：

| 维度 | 检测方法 | 说明 |
|------|---------|------|
| **User-Agent** | 使用 `parseUserAgent()` 解析 | 检测 `claude-cli` 或 `claude-vscode` |
| **system 特征** | 检查 `system[0]` 包含 Claude Code 身份标识 | "You are Claude Code, Anthropic's official CLI for Claude" (支持标准 CLI 和 Agent SDK) |
| **metadata.user_id 格式** | 检查符合 `user_{64hex}_account__session_{uuid}` 格式 | 符合 Claude Code 生成格式 |

**检测流程**：
```
1. 检查 User-Agent 是否包含 claude-cli 或 claude-vscode
   ├─ 不符合 → 判定为非 CLI
   └─ 符合 → 继续检查请求体特征

2. 检查 system[0] 是否包含 Claude Code 身份标识
   ├─ 不符合 → 判定为非 CLI
   └─ 符合 → 继续检查

3. 检查 metadata.user_id 格式是否正确
   ├─ 不符合 → 判定为非 CLI
   └─ 符合 → 判定为 Claude CLI 请求
```

### 2.2 强制路由逻辑

**路由策略**：

| 请求类型 | 路由行为 | 伪装标记 |
|---------|---------|---------|
| Claude CLI 请求 | 按原分组策略路由（key.providerGroup > user.providerGroup） | needsClaudeDisguise = false |
| 非 CLI 请求 | 强制路由到 `2api` 分组 | needsClaudeDisguise = true |

**分组优先级**：
```
forcedProviderGroup > key.providerGroup > user.providerGroup > default
```

### 2.3 伪装逻辑

**伪装触发条件**：仅当 `session.needsClaudeDisguise === true` 时执行

**伪装内容**（`ensureClaudeRequestDefaults`）：
1. **messages[0].content** - 插入 `<system-reminder></system-reminder>`
2. **system** - 插入 Claude Code 身份标识
3. **metadata.user_id** - 生成符合格式的用户标识
   - 优先使用供应商的 `unifiedClientId`（如配置）
   - 否则使用默认 client ID

### 2.4 与模拟缓存交互（新增）

**目标**：避免伪装注入影响模拟缓存判定。

**处理顺序**：
1. **ProxyClientGuard** 在伪装前提取并保存 `session.cacheSignals`
2. **ProxyForwarder** 依据 `needsClaudeDisguise` 可能注入 `<system-reminder>` 并补齐 system
3. **ProxyResponseHandler** 优先使用 `session.cacheSignals` 判断是否模拟缓存

**判定依据**：
- **子代理**：model 含 `haiku` 且 (tools 为空/缺失 或 system 为空/缺失)
- **主进程**：tools 与 system 均为非空数组（且开启 `simulate_cache_enabled` 则模拟缓存）

**结论**：即使后续将伪装标签改为非空 `<system-reminder>省略</system-reminder>`，或补齐 system，模拟缓存判定仍基于伪装前快照，不受影响。

---

## 3. 代码落点

### 3.1 修改的文件

#### **`src/app/v1/_lib/proxy/session.ts`** ✅ 已修改
**新增字段**：
```typescript
// 强制分组（优先级最高，用于非 CLI 请求路由到 2api）
forcedProviderGroup?: string;

// 是否需要伪装为 Claude Code 请求（用于非 CLI 请求）
needsClaudeDisguise?: boolean;
```

---

#### **`src/app/v1/_lib/proxy/client-guard.ts`** ✅ 已修改
**新增方法**：
```typescript
/**
 * 检测请求是否为 Claude CLI 请求（组合判断：User-Agent + 请求体特征）
 */
private static isClaudeCliRequest(
  userAgent: string | null,
  requestBody: Record<string, unknown>
): { isCli: boolean; reasons: string[] }
```

**修改 `ensure()` 方法**：
- 新增 Claude CLI 检测逻辑（无论是否配置 `allowedClients`）
- 非 CLI 请求 → 设置 `forcedProviderGroup = "2api"` + `needsClaudeDisguise = true`
- CLI 请求 → 继续原有的 `allowedClients` 校验逻辑
- 伪装前记录 `session.cacheSignals`（供模拟缓存判定使用）

**日志记录**：
- `ProxyClientGuard: CLI detection result` - 记录检测结果和原因
- `ProxyClientGuard: Non-CLI request detected, routing to 2api` - 记录强制路由
- `ProxyClientGuard: CLI request allowed (no restrictions)` - 记录 CLI 放行
- `ProxyClientGuard: CLI request allowed (in whitelist)` - 记录白名单匹配

---

#### **`src/app/v1/_lib/proxy/provider-selector.ts`** ✅ 已修改
**修改 `getEffectiveProviderGroup()`**：
```typescript
function getEffectiveProviderGroup(session?: ProxySession): string | null {
  // 优先级 1: 强制分组（最高优先级，用于非 CLI 请求路由到 2api）
  if (session?.forcedProviderGroup) {
    return session.forcedProviderGroup;
  }

  // 优先级 2 & 3: key.providerGroup > user.providerGroup
  // ... 原有逻辑
}
```

**新增 `forced_group_unavailable` 错误处理**：
- 当强制分组（如 2api）无可用供应商时，返回专用错误码
- 错误码：`forced_group_unavailable`
- 错误详情：`{ group: "2api", totalAttempts: number }`

**日志记录**：
- `ProviderSelector: Forced group unavailable` - 记录强制分组失败

---

#### **`src/app/v1/_lib/proxy/forwarder.ts`** ✅ 已修改
**修改伪装触发条件**：
```typescript
if (provider.providerType === "claude" || provider.providerType === "claude-auth") {
  // 仅在 needsClaudeDisguise 为 true 时执行伪装
  if (session.needsClaudeDisguise) {
    ensureClaudeRequestDefaults(session.request.message, provider);
    logger.debug("ProxyForwarder: Applied Claude Code disguise", {
      providerId: provider.id,
      providerName: provider.name,
    });
  }
}
```

**日志记录**：
- `ProxyForwarder: Applied Claude Code disguise` - 记录伪装执行

---

#### **`src/app/v1/_lib/proxy/response-handler.ts`** ✅ 已修改
**补充说明**：
- 模拟缓存判定优先使用 `session.cacheSignals`（伪装前快照），避免伪装补齐 system/注入标签影响判断。

---

#### **`src/types/message.ts`** ✅ 已修改
**新增类型定义**：
```typescript
decisionContext?: {
  // ... 现有字段 ...
  forcedGroup?: string; // 强制分组（如 2api，用于非 CLI 请求）
};
```

---

### 3.2 职责说明

| 层级 | 职责 | 具体实现 |
|------|------|----------|
| **Guard 层** | CLI 检测与标记 | `ClientGuard.isClaudeCliRequest()` - 检测并设置 `forcedProviderGroup` 和 `needsClaudeDisguise` |
| **Session 层** | 状态传递 | 传递 `forcedProviderGroup` 和 `needsClaudeDisguise` 标记 |
| **Selector 层** | 强制分组 | 优先使用 `forcedProviderGroup`，处理分组不可用错误 |
| **Forwarder 层** | 条件伪装 | 仅在 `needsClaudeDisguise === true` 时执行伪装 |

---

## 4. 完整请求流程

```
客户端请求
  ↓
ProxyAuthenticator (认证)
  ↓
ProxyClientGuard
  ├─ isClaudeCliRequest == false
  │    → session.forcedProviderGroup = "2api"
  │    → session.needsClaudeDisguise = true
  │    → logger.info("Non-CLI request detected, routing to 2api")
  │    → continue
  │
  └─ isClaudeCliRequest == true
       → allowedClients 逻辑保持原样（若配置则校验）
  ↓
其他 Guards (model, version, session, rateLimit...)
  ↓
ProxyProviderResolver
  ├─ 读取 forcedProviderGroup（如存在）
  ├─ 若 group=2api 且无可用供应商
  │    → 返回 forced_group_unavailable 错误
  └─ 选择供应商
  ↓
ProxyForwarder
  ├─ 格式转换
  ├─ needsClaudeDisguise == true → ensureClaudeRequestDefaults()
  └─ 转发请求
  ↓
上游 Claude 供应商
```

---

## 5. 配置影响

### 5.1 用户/密钥配置

**分组配置**（`providerGroup`）：
- 仅当 `forcedProviderGroup` 未设置时生效
- 优先级：`forcedProviderGroup > key.providerGroup > user.providerGroup`

**客户端白名单**（`allowedClients`）：
- 仅对 Claude CLI 请求生效
- 非 CLI 请求直接路由到 2api，不走白名单校验

### 5.2 供应商配置

**2api 分组供应商**：
- 需要存在 `groupTag: "2api"` 的供应商
- 建议配置 `useUnifiedClientId: true` 和 `unifiedClientId`
- 用于接收非 CLI 请求

**CLI 分组供应商**：
- 配置 `groupTag: "cli"` 或其他分组
- 用于接收真实 Claude CLI 请求

---

## 6. 日志关注点

### 6.1 ClientGuard 相关日志

| 日志内容 | 说明 |
|---------|------|
| `ProxyClientGuard: CLI detection result` | Claude CLI 检测结果（包含 isCli 和 reasons） |
| `ProxyClientGuard: Non-CLI request detected, routing to 2api` | 非 CLI 请求被强制路由到 2api |
| `ProxyClientGuard: CLI request allowed (no restrictions)` | Claude CLI 请求通过（无限制配置） |
| `ProxyClientGuard: CLI request allowed (in whitelist)` | Claude CLI 请求通过（白名单匹配） |

### 6.2 ProviderSelector 相关日志

| 日志内容 | 说明 |
|---------|------|
| `ProviderSelector: Forced group unavailable` | 强制分组（2api）无可用供应商 |

### 6.3 Forwarder 相关日志

| 日志内容 | 说明 |
|---------|------|
| `ProxyForwarder: Applied Claude Code disguise` | 对非 CLI 请求执行伪装 |

### 6.4 检测失败原因（reasons 字段）

| 原因 | 说明 |
|------|------|
| `UA not Claude CLI (parsed: xxx)` | User-Agent 不匹配 |
| `missing Claude Code identity in system` | 缺少 Claude Code 身份标识 |
| `metadata.user_id missing or not string` | metadata.user_id 缺失或格式错误 |
| `metadata.user_id format invalid: xxx...` | metadata.user_id 格式无效 |

---

## 7. 错误处理

### 7.1 新增错误码

**`forced_group_unavailable`**（HTTP 503）

**触发条件**：强制分组（如 2api）不存在或无可用供应商

**错误响应**：
```json
{
  "type": "error",
  "error": {
    "type": "forced_group_unavailable",
    "message": "Forced group \"2api\" unavailable",
    "details": {
      "group": "2api",
      "totalAttempts": 0
    }
  }
}
```

**排查建议**：
1. 检查是否存在 `groupTag: "2api"` 的供应商
2. 检查 2api 分组供应商是否已启用
3. 检查 2api 分组供应商是否超过费用限制
4. 检查 2api 分组供应商是否被熔断

### 7.2 现有错误码

**`invalid_request_error`**（HTTP 400）

**触发条件**：
- `allowedClients` 已配置但 User-Agent 为空
- `allowedClients` 已配置且 User-Agent 不在白名单（仅 CLI 请求）

---

## 8. 测试建议

### 8.1 功能测试

#### 测试场景 1：非 Claude CLI + 任意 UA
**输入**：
- User-Agent: `curl/7.68.0`
- 请求体：无 Claude Code 特征

**期望结果**：
- ✅ `forcedProviderGroup = "2api"`
- ✅ `needsClaudeDisguise = true`
- ✅ 路由到 2api 分组
- ✅ Forwarder 执行伪装
- ✅ 日志：`Non-CLI request detected, routing to 2api`

---

#### 测试场景 2：真实 Claude CLI（完整特征）
**输入**：
- User-Agent: `claude-cli/2.0.31 (external, cli)`
- 请求体：包含完整 Claude Code 特征

**期望结果**：
- ✅ `forcedProviderGroup = undefined`
- ✅ `needsClaudeDisguise = false`
- ✅ 按原分组策略路由
- ✅ 不执行伪装
- ✅ 日志：`CLI request allowed (no restrictions)` 或 `CLI request allowed (in whitelist)`

---

#### 测试场景 3：伪造 UA（无请求体特征）
**输入**：
- User-Agent: `claude-cli/2.0.31 (external, cli)`
- 请求体：无 Claude Code 特征

**期望结果**：
- ✅ 判定为非 CLI（请求体特征不匹配）
- ✅ `forcedProviderGroup = "2api"`
- ✅ `needsClaudeDisguise = true`
- ✅ 路由到 2api 分组
- ✅ 执行伪装

---

#### 测试场景 4：2api 分组缺失/无可用供应商
**输入**：
- 非 CLI 请求
- 2api 分组不存在或所有供应商不可用

**期望结果**：
- ✅ 返回 503 错误
- ✅ 错误码：`forced_group_unavailable`
- ✅ 错误详情：`{ group: "2api" }`
- ✅ 日志：`Forced group unavailable`

---

#### 测试场景 5：真实 CLI 请求字段缺失（历史兼容）
**输入**：
- User-Agent: `claude-cli/2.0.20`（旧版本）
- 请求体：部分字段缺失

**期望结果**：
- ✅ 判定为 CLI（UA 匹配）
- ✅ `needsClaudeDisguise = false`
- ✅ 不执行伪装（避免重复补全）
- ✅ 日志记录检测原因

---

### 8.2 回归测试

1. **真实 Claude CLI 请求**：
   - 应保持原分组、不被改写
   - 请求体在 Forwarder 层不执行伪装
   - 日志中不应出现 `Applied Claude Code disguise`

2. **配置 `allowedClients` 的场景**：
   - CLI + UA 在白名单：正常访问
   - CLI + UA 不在白名单：返回 400 错误（非 CLI 不走此逻辑）

3. **`useUnifiedClientId` 功能**：
   - 验证 2api 分组供应商的统一客户端 ID 是否正确应用

4. **模型重定向**：
   - 验证伪装后不影响模型重定向逻辑

---

## 9. 监控建议

### 9.1 关键指标

| 指标 | 说明 | 告警阈值 |
|------|------|---------|
| `forced_group_unavailable` 错误频率 | 2api 分组失败次数 | 5分钟内 > 10次 |
| 非 CLI 请求比例 | 路由到 2api 的请求占比 | 突然飙升 |
| CLI 检测失败率 | 被误判为非 CLI 的真实 CLI 请求 | > 1% |

### 9.2 日志关键词

**DEBUG 级别**：
- `CLI detection result`
- `Applied Claude Code disguise`

**INFO 级别**：
- `Non-CLI request detected, routing to 2api`
- `CLI request allowed`

**WARN/ERROR 级别**：
- `Forced group unavailable`

---

## 10. 安全考虑

### 10.1 防止误判

- Claude CLI 检测综合多个维度，降低误判率
- 所有检测步骤都有日志记录，便于排查
- 检测失败时返回非 CLI（更安全的方向）

### 10.2 伪装安全

- 伪装仅对非 CLI 请求执行
- 保留幂等检查，避免重复插入
- 使用 `unifiedClientId` 时遵循供应商配置

### 10.3 日志脱敏

- `metadata.user_id` 日志仅显示前 30 字符
- `unifiedClientId` 日志仅显示前缀

---

## 11. 版本历史

| 版本 | 日期 | 变更说明 |
|------|------|---------|
| **4.2** | **2026-01-15** | **增强日志诊断 + 支持 Claude Agent SDK 变体** |
| 4.1 | 2026-01-13 | 修复：仅对 Claude 请求执行 CLI 检测（修复 Codex/Gemini 被误路由问题） |
| 4.0 | 2026-01-13 | 新增 Claude CLI 检测与强制路由功能 |
| 3.0 | 2025-01-03 | 职责分离，移除强制路由（解决主分支合并冲突） |
| 2.0 | 2025-01-02 | 增强校验与伪装（已废弃） |
| 1.0 | 2025-01-01 | 初始版本 |

---

## 12. 版本 4.1 修复说明（2026-01-13）

### 12.1 问题描述

**版本 4.0 的 Bug**：所有非 Claude CLI 的请求（包括 Codex CLI、Gemini CLI、OpenAI 请求等）都被错误地强制路由到 `2api` 分组。

**影响**：
- ❌ Codex CLI 请求（`/v1/responses`）被错误路由到 2api
- ❌ Gemini CLI 请求被错误路由到 2api
- ❌ OpenAI 请求（`/v1/chat/completions`）被错误路由到 2api
- ❌ 导致这些请求无法正常工作（找不到支持的供应商）

**根本原因**：版本 4.0 的实现没有区分请求类型，对所有请求都执行 Claude CLI 检测。

---

### 12.2 修复方案

**核心修改**：仅对 **Claude 请求**（`originalFormat === "claude"`）执行 CLI 检测和强制路由。

**实现逻辑**：
```typescript
// 仅对 Claude 请求执行 CLI 检测
if (session.originalFormat === "claude") {
  // 执行 Claude CLI 检测
  const cliDetection = ProxyClientGuard.isClaudeCliRequest(...);

  if (!cliDetection.isCli) {
    // 非 Claude CLI → 强制路由到 2api
    session.forcedProviderGroup = "2api";
    session.needsClaudeDisguise = true;
  }
  // Claude CLI → 继续 allowedClients 校验
}

// 非 Claude 请求（Codex、OpenAI、Gemini 等）：跳过所有检测
logger.debug("ProxyClientGuard: Non-Claude request, skipping CLI detection");
return null;
```

---

### 12.3 请求类型判断

系统通过 `session.originalFormat` 字段判断请求类型（由路径自动检测）：

| 请求路径 | originalFormat | 处理方式 |
|---------|---------------|---------|
| `/v1/messages` | `claude` | ✅ 执行 CLI 检测 + 强制路由 |
| `/v1/responses` | `response` (Codex) | ⏭️ **跳过检测，正常路由** |
| `/v1/chat/completions` | `openai` | ⏭️ 跳过检测，正常路由 |
| `/v1beta/models/{model}:generateContent` | `gemini` | ⏭️ 跳过检测，正常路由 |
| `/v1internal/models/{model}:generateContent` | `gemini-cli` | ⏭️ 跳过检测，正常路由 |

**格式检测函数**：`detectFormatByEndpoint()` (定义在 `format-mapper.ts`)

---

### 12.4 代码修改

**文件**：`src/app/v1/_lib/proxy/client-guard.ts`

**修改位置**：
- **第 13 行**：更新注释说明仅对 Claude 请求生效
- **第 133 行**：添加 `originalFormat` 检查
- **第 208-213 行**：添加非 Claude 请求的处理逻辑

**关键代码**：
```typescript
// 第 133 行
if (session.originalFormat === "claude") {
  // 仅对 Claude 请求执行检测
}

// 第 208-213 行
// 非 Claude 请求（Codex、OpenAI、Gemini 等）：跳过所有检测
logger.debug("ProxyClientGuard: Non-Claude request, skipping CLI detection", {
  userName: user.name,
  originalFormat: session.originalFormat,
});
return null;
```

---

### 12.5 行为对比

| 请求类型 | 版本 4.0（Bug） | 版本 4.1（修复后） |
|---------|----------------|------------------|
| Claude CLI | ✅ 正常路由 | ✅ 正常路由（不变） |
| 非 Claude CLI（curl等） | ✅ 强制路由到 2api | ✅ 强制路由到 2api（不变） |
| **Codex CLI** | ❌ **错误路由到 2api** | ✅ **正常路由** ✨ |
| **Gemini CLI** | ❌ 错误路由到 2api | ✅ 正常路由 |
| **OpenAI 请求** | ❌ 错误路由到 2api | ✅ 正常路由 |

---

### 12.6 日志变化

**新增日志**（非 Claude 请求）：
```
ProxyClientGuard: Non-Claude request, skipping CLI detection
{
  userName: "codex",
  originalFormat: "response"
}
```

**不再出现的日志**（Codex/Gemini 请求）：
- ❌ `ProxyClientGuard: CLI detection result` - 不再对非 Claude 请求执行检测
- ❌ `ProxyClientGuard: Non-CLI request detected, routing to 2api` - 不再错误路由

---

### 12.7 测试验证

**测试场景**：

1. **Codex CLI 请求**（`/v1/responses`）：
   - ✅ 跳过 CLI 检测
   - ✅ 按正常分组策略路由
   - ✅ 日志：`Non-Claude request, skipping CLI detection`

2. **Claude CLI 请求**（`/v1/messages`）：
   - ✅ 执行 CLI 检测
   - ✅ 真实 CLI → 正常路由
   - ✅ 非 CLI → 强制路由到 2api

3. **Gemini CLI 请求**（`/v1internal/models/{model}:generateContent`）：
   - ✅ 跳过 CLI 检测
   - ✅ 按正常分组策略路由

---

### 12.8 验证结果

| 检查项 | 结果 |
|-------|------|
| TypeScript 类型检查 | ✅ 通过 |
| 代码语法 | ✅ 正确 |
| Codex CLI 正常工作 | ✅ 验证通过 |
| Claude CLI 不受影响 | ✅ 验证通过 |

---

**文档版本**: 4.2（增强日志诊断 + 支持 Claude Agent SDK）
**维护者**: Team
**上次更新**: 2026-01-15

---

## 13. 版本 4.2 增强说明（2026-01-15）

### 13.1 问题背景

**版本 4.1 的局限**：
- 日志信息不足，无法快速判断为什么请求被判定为非 CLI
- 不支持 Claude Agent SDK 的系统提示词变体
- 真实的 Agent SDK 请求被错误路由到 2api

**实际案例**：
```json
{
  "userName": "cc多渠道",
  "reasons": ["UA matched: claude-cli", "missing Claude Code identity in system"],
  "msg": "ProxyClientGuard: Non-Claude-CLI request detected, routing to 2api"
}
```

用户 UA 是 `claude-cli`，但被路由到 2api，无法从日志判断原因。

---

### 13.2 增强内容

#### 13.2.1 日志诊断增强

**新增辅助方法**：`buildSystemDiagnostics()`

**功能**：安全地提取和截断 system/messages 字段信息

**返回字段**：
```typescript
{
  systemType: string;           // 类型（string/array/object/null/undefined）
  systemIsArray: boolean;       // 是否数组
  systemLen: number | null;     // 长度（字符串长度或数组长度）
  systemPreview: string | null; // 前 100 字符（去换行、截断）
  system0Keys?: string[];       // 如果是对象数组，显示 system[0] 的 keys
  messages0Preview?: string | null; // messages[0].content[0] 的预览
}
```

**安全措施**：
- ✅ 所有文本截断到 100 字符
- ✅ 去除换行符（避免日志混乱）
- ✅ JSON.stringify 有 try-catch 保护
- ✅ 不输出完整的敏感内容

**日志输出位置**：

1. **Debug 日志**（第 143 行）：missing identity 分支
   ```typescript
   logger.debug("ProxyClientGuard: Missing Claude Code identity in system", {
     systemType: systemDiagnostics.systemType,
     systemIsArray: systemDiagnostics.systemIsArray,
     systemLen: systemDiagnostics.systemLen,
     systemPreview: systemDiagnostics.systemPreview,
     system0Keys: systemDiagnostics.system0Keys,
     messages0Preview: systemDiagnostics.messages0Preview,
   });
   ```

2. **Info 日志**（第 211 行）：路由到 2api
   ```typescript
   logger.info("ProxyClientGuard: Non-Claude-CLI request detected, routing to 2api", {
     userName: user.name,
     reasons: cliDetection.reasons,
     systemPreview: systemDiagnostics.systemPreview, // 新增
   });
   ```

**增强后的日志示例**：
```json
{
  "level": "info",
  "userName": "cc多渠道",
  "reasons": ["UA matched: claude-cli", "missing Claude Code identity in system"],
  "systemPreview": "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "msg": "ProxyClientGuard: Non-Claude-CLI request detected, routing to 2api"
}
```

现在可以直接从日志看到 system 的实际内容！

---

#### 13.2.2 支持 Claude Agent SDK 变体

**问题发现**：
通过增强的日志，发现用户使用的是 **Claude Agent SDK**，系统提示词为：
```
"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
```

**原检测逻辑**（严格匹配，失败）：
```typescript
text.includes("You are Claude Code, Anthropic's official CLI for Claude.")
```

**新检测逻辑**（前缀匹配，成功）：
```typescript
const checkClaudeIdentity = (text: string): boolean => {
  return text.includes("You are Claude Code, Anthropic's official CLI for Claude");
};
```

**支持的变体**：
- ✅ 标准 CLI: `"You are Claude Code, Anthropic's official CLI for Claude."`
- ✅ Agent SDK: `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."`
- ✅ 未来其他变体（只要包含核心身份标识）

---

### 13.3 代码修改

**文件**：`src/app/v1/_lib/proxy/client-guard.ts`

**修改点 1**：新增 `buildSystemDiagnostics` 方法（第 17-90 行）
```typescript
private static buildSystemDiagnostics(
  requestBody: Record<string, unknown>
): {
  systemType: string;
  systemIsArray: boolean;
  systemLen: number | null;
  systemPreview: string | null;
  system0Keys?: string[];
  messages0Preview?: string | null;
} {
  // ... 实现代码
}
```

**修改点 2**：增强 missing identity 分支日志（第 141-150 行）
```typescript
if (!hasClaudeIdentity) {
  const systemDiagnostics = ProxyClientGuard.buildSystemDiagnostics(requestBody);
  logger.debug("ProxyClientGuard: Missing Claude Code identity in system", {
    systemType: systemDiagnostics.systemType,
    systemIsArray: systemDiagnostics.systemIsArray,
    systemLen: systemDiagnostics.systemLen,
    systemPreview: systemDiagnostics.systemPreview,
    system0Keys: systemDiagnostics.system0Keys,
    messages0Preview: systemDiagnostics.messages0Preview,
  });
  reasons.push("missing Claude Code identity in system");
  return { isCli: false, reasons };
}
```

**修改点 3**：增强路由到 2api 日志（第 207-215 行）
```typescript
if (!cliDetection.isCli) {
  const systemDiagnostics = ProxyClientGuard.buildSystemDiagnostics(
    session.request.message as Record<string, unknown>
  );
  logger.info("ProxyClientGuard: Non-Claude-CLI request detected, routing to 2api", {
    userName: user.name,
    reasons: cliDetection.reasons,
    systemPreview: systemDiagnostics.systemPreview, // 新增
  });
  // ...
}
```

**修改点 4**：放宽身份检测逻辑（第 125-142 行）
```typescript
// 2. 检查 system[0] 是否包含 Claude Code 身份
// 支持两种变体：
// - 标准 CLI: "You are Claude Code, Anthropic's official CLI for Claude."
// - Agent SDK: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
const system = requestBody.system;
let hasClaudeIdentity = false;

const checkClaudeIdentity = (text: string): boolean => {
  return text.includes("You are Claude Code, Anthropic's official CLI for Claude");
};

if (typeof system === "string") {
  hasClaudeIdentity = checkClaudeIdentity(system);
} else if (Array.isArray(system) && system.length > 0) {
  const firstSystem = system[0] as Record<string, unknown>;
  const text = firstSystem?.text;
  hasClaudeIdentity = typeof text === "string" && checkClaudeIdentity(text);
}
```

**修改点 5**：更新注释文档（第 92-104 行）
```typescript
/**
 * 检测请求是否为 Claude CLI 请求（组合判断：User-Agent + 请求体特征）
 *
 * Claude CLI 请求特征：
 * 1. User-Agent 包含 claude-cli 或 claude-vscode
 * 2. system[0] 包含 "You are Claude Code, Anthropic's official CLI for Claude"
 *    - 支持标准 CLI 和 Agent SDK 两种变体
 * 3. metadata.user_id 符合 user_{64hex}_account__session_{uuid} 格式
 *
 * @param userAgent - User-Agent 头
 * @param requestBody - 请求体
 * @returns { isCli: boolean, reasons: string[] } - 判定结果和原因
 */
```

---

### 13.4 行为对比

| 场景 | 版本 4.1 | 版本 4.2 |
|------|---------|---------|
| **标准 Claude CLI** | ✅ 正常识别 | ✅ 正常识别（不变） |
| **Agent SDK CLI** | ❌ 误判为非 CLI，路由到 2api | ✅ **正常识别** ✨ |
| **日志诊断能力** | ❌ 信息不足，无法判断原因 | ✅ **显示 systemPreview，快速定位** ✨ |
| **Debug 日志** | ❌ 无详细诊断 | ✅ **6 个字段完整诊断** ✨ |

---

### 13.5 测试验证

#### 测试场景 1：Agent SDK 请求（修复验证）

**输入**：
- User-Agent: `claude-cli/2.0.31 (external, cli)`
- system: `"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."`

**版本 4.1 行为**：
- ❌ 判定为非 CLI
- ❌ 强制路由到 2api
- ❌ 日志无 systemPreview

**版本 4.2 行为**：
- ✅ 判定为 CLI
- ✅ 按正常分组策略路由
- ✅ 日志显示完整 systemPreview（如果失败）

---

#### 测试场景 2：日志诊断（新功能验证）

**输入**：
- User-Agent: `curl/7.68.0`
- system: `undefined` 或其他异常结构

**版本 4.2 日志输出**：
```json
{
  "level": "info",
  "userName": "test_user",
  "reasons": ["UA not Claude CLI (parsed: null)"],
  "systemPreview": null,
  "msg": "ProxyClientGuard: Non-Claude-CLI request detected, routing to 2api"
}
```

**Debug 日志**（如果启用）：
```json
{
  "level": "debug",
  "systemType": "undefined",
  "systemIsArray": false,
  "systemLen": null,
  "systemPreview": null,
  "system0Keys": undefined,
  "messages0Preview": "Hello, I need help...",
  "msg": "ProxyClientGuard: Missing Claude Code identity in system"
}
```

---

### 13.6 监控建议

#### 新增监控指标

| 指标 | 说明 | 告警阈值 |
|------|------|---------|
| `systemPreview: null` 频率 | system 字段缺失的请求占比 | 突然飙升 |
| Agent SDK 请求量 | 包含 "Agent SDK" 的请求数 | 监控趋势 |
| 日志诊断命中率 | systemPreview 非 null 的比例 | < 80% |

#### 日志关键词

**INFO 级别**：
- `systemPreview` - 快速查看 system 内容
- `Non-Claude-CLI request detected, routing to 2api` - 强制路由事件

**DEBUG 级别**：
- `Missing Claude Code identity in system` - 详细诊断信息
- `systemType`, `systemLen`, `messages0Preview` - 结构化诊断

---

### 13.7 未来优化建议

1. **更灵活的身份检测**：
   - 维护身份标识列表（支持多个版本）
   - 使用正则表达式匹配
   - 配置化身份检测规则

2. **日志级别优化**：
   - 生产环境可考虑将 systemPreview 提升到 info 级别
   - 添加采样率控制（避免高频日志）

3. **兼容性测试**：
   - 收集更多 Claude CLI 版本的 system 提示词样本
   - 建立自动化测试用例

---

### 13.8 总结

**版本 4.2 解决的问题**：
1. ✅ **日志诊断能力不足** → 新增 6 个诊断字段 + systemPreview
2. ✅ **Agent SDK 误判** → 放宽检测逻辑，支持前缀匹配
3. ✅ **排查效率低** → 从日志直接看到 system 内容

**核心价值**：
- 🔍 **快速定位**：从日志直接看到为什么被判定为非 CLI
- 🛡️ **安全可靠**：所有输出截断 100 字符 + 去换行
- 🚀 **向后兼容**：支持标准 CLI 和 Agent SDK 两种变体

**影响范围**：
- ✅ 不影响现有 CLI 请求
- ✅ 修复 Agent SDK 误判问题
- ✅ 提升日志可观测性

---

**文档版本**: 4.2（增强日志诊断 + 支持 Claude Agent SDK）
**维护者**: Team
**上次更新**: 2026-01-15
