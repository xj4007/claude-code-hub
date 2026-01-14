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
| **system 特征** | 检查 `system[0]` 包含 Claude Code 身份标识 | "You are Claude Code, Anthropic's official CLI for Claude." |
| **metadata.user_id 格式** | 检查符合 `user_{64hex}_account__session_{uuid}` 格式 | 符合 Claude Code 生成格式 |

**检测流程**：
```
1. 检查 User-Agent 是否包含 claude-cli 或 claude-vscode
   ├─ 不符合 → 判定为非 CLI
   └─ 符合 → 继续检查请求体特征

2. 检查 system[0] 是否包含 Claude Code 身份
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
| `messages array missing or empty` | messages 数组缺失或为空 |
| `missing <system-reminder> in messages[0].content` | 缺少 system-reminder 标记 |
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
| **4.1** | **2026-01-13** | **修复：仅对 Claude 请求执行 CLI 检测（修复 Codex/Gemini 被误路由问题）** |
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

**文档版本**: 4.1（修复 Codex/Gemini 误路由问题）
**维护者**: Team
**上次更新**: 2026-01-13