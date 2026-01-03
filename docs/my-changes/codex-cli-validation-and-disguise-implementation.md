# Codex CLI 客户端校验与请求伪装功能实现

**开发日期**: 2026-01-02

**功能版本**: 1.1

**状态**: 已完成并修复 Response API 兼容性问题

---

## 一、功能概述

为 Codex CLI 客户端添加校验与伪装机制，与现有的 Claude Code 逻辑完全独立。

### 核心能力

1. **Codex CLI 特征检测**：三重特征校验（instructions + headers）
2. **智能路由**：非 Codex CLI 请求强制路由到 `2apiCodex` 分组
3. **请求伪装**：自动为非 Codex CLI 请求补充必要参数
4. **Response API 兼容**：修复 Response API 格式请求的 Guard 执行问题

---

## 二、涉及文件

| 文件路径 | 修改类型 | 说明 |
|---------|---------|------|
| `src/app/v1/_lib/proxy/session.ts` | 新增字段 | 添加 `needsCodexCliDisguise` 标记字段 |
| `src/app/v1/_lib/proxy/client-guard.ts` | 新增方法 + 扩展逻辑 | 添加 `isCodexCliRequest()` 方法，扩展 `ensure()` 方法 |
| `src/app/v1/_lib/proxy/forwarder.ts` | 新增函数 + 调用逻辑 | 添加 `disguiseAsCodexCliRequest()` 函数及调用 |
| `src/app/v1/_lib/codex/chat-completions-handler.ts` | 补充 Guard 调用 | Response API 路径添加 `ProxyClientGuard` 调用 |
| `src/app/v1/_lib/codex/constants/codex-instructions.ts` | 新增常量 + 更新列表 | 添加 `CODEX_CLI_INSTRUCTIONS_PROMPTS`，更新 `OFFICIAL_PROMPTS` |

---

## 三、详细修改

### 3.1 session.ts

**新增字段**（第 85-86 行）：

```typescript
// 标记此请求是否需要 Codex CLI 伪装（用于 2apiCodex 分组）
needsCodexCliDisguise?: boolean;
```

### 3.2 client-guard.ts

**新增导入**：

```typescript
import { isOfficialInstructions } from "../codex/constants/codex-instructions";
```

**新增方法** `isCodexCliRequest()`（第 93-164 行）：

- 检查 `instructions` 是否为官方 Codex CLI prompt
- 检查 `User-Agent` 或 `originator` 是否包含 `codex_cli_rs`
- 检查 `session_id` 和 `conversation_id` headers（UUID 格式）

**扩展 `ensure()` 方法**：

- 将 Claude Code 和 Codex CLI 校验逻辑完全独立
- `allowedClients` 包含 `"claude-cli"` 时执行 Claude Code 校验
- `allowedClients` 包含 `"codex-cli"` 时执行 Codex CLI 校验
- 非 Codex CLI 请求设置 `forcedProviderGroup = "2apiCodex"` 和 `needsCodexCliDisguise = true`

### 3.3 forwarder.ts

**新增导入**：

```typescript
import {
  CODEX_CLI_INSTRUCTIONS_PROMPTS,
  isOfficialInstructions,
} from "../codex/constants/codex-instructions";
```

**新增函数** `disguiseAsCodexCliRequest()`（第 277-346 行）：

- 注入完整的 Codex CLI instructions（`CODEX_CLI_INSTRUCTIONS_PROMPTS`）
- 添加 `session_id` 和 `conversation_id` headers（使用相同 UUID）

**新增调用逻辑**（第 1207-1222 行）：

```typescript
// ⭐ Codex CLI 请求伪装（针对 2apiCodex 分组的非 Codex CLI 请求）
if (session.needsCodexCliDisguise && provider.providerType === "codex") {
  logger.info("ProxyForwarder: Codex CLI disguise triggered", {
    providerId: provider.id,
    providerName: provider.name,
    needsCodexCliDisguise: session.needsCodexCliDisguise,
    providerType: provider.providerType,
  });
  disguiseAsCodexCliRequest(session.request.message, session, provider);
} else if (session.needsCodexCliDisguise) {
  logger.warn("ProxyForwarder: needsCodexCliDisguise set but provider type mismatch", {
    providerId: provider.id,
    providerName: provider.name,
    providerType: provider.providerType,
    needsCodexCliDisguise: session.needsCodexCliDisguise,
  });
}
```

### 3.4 chat-completions-handler.ts（关键修复）

**问题**：Response API 格式的请求没有经过 `ProxyClientGuard`

**新增导入**（第 13 行）：

```typescript
import { ProxyClientGuard } from "../proxy/client-guard";
```

**在 Guard 执行流程中添加客户端校验**（第 173-177 行）：

```typescript
// 2. 客户端校验（支持 Claude Code / Codex CLI 伪装）
const clientRestricted = await ProxyClientGuard.ensure(session);
if (clientRestricted) {
  return clientRestricted;
}
```

**设置 session.request.message**（第 152-154 行）：

```typescript
// ⚠️ IMPORTANT: 确保 session.request.message 包含完整请求（用于 Client Guard 和 Disguise）
session.request.message = request;
session.request.model = request.model || "";
```

### 3.5 codex-instructions.ts

**新增常量** `CODEX_CLI_INSTRUCTIONS_PROMPTS`（第 144-145 行）：

```typescript
export const CODEX_CLI_INSTRUCTIONS_PROMPTS =
  "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.\r\n\r\n...";
```

> 注意：此常量包含正确的 `\r\n` 转义符，与上游供应商期望的格式一致。

**更新 OFFICIAL_PROMPTS 列表**（第 152-156 行）：

```typescript
export const OFFICIAL_PROMPTS = [
  CODEX_CLI_INSTRUCTIONS_PROMPTS,  // ← 优先检测带 \r\n 的版本
  GPT5_CODEX_PROMPT,
  GPT5_PROMPT,
];
```

---

## 四、工作流程

```
请求进入 → chat-completions-handler（Response API 格式）
    │
    ├─ 设置 session.request.message = request
    │
    └─ ProxyClientGuard.ensure()
        │
        ├─ allowedClients 包含 "codex-cli"？
        │   ├─ 是 → 执行 Codex CLI 特征检测
        │   │   ├─ 是 Codex CLI → 检查 User-Agent 白名单
        │   │   │   ├─ 在白名单 → 正常路由
        │   │   │   └─ 不在白名单 → 路由到 2apiCodex（不伪装）
        │   │   └─ 不是 Codex CLI → 路由到 2apiCodex + 标记需要伪装
        │   └─ 否 → 跳过 Codex CLI 校验
        │
        └─ ProxyForwarder.doForward()
            │
            └─ needsCodexCliDisguise && providerType === "codex"？
                └─ 是 → 执行 disguiseAsCodexCliRequest()
                    ├─ 注入 CODEX_CLI_INSTRUCTIONS_PROMPTS
                    └─ 添加 session_id / conversation_id headers
```

---

## 五、配置要求

### 5.1 用户配置

```json
{
  "allowedClients": ["claude-cli", "codex-cli"]
}
```

### 5.2 供应商配置

必须创建 `groupTag` 为 `2apiCodex` 的 Codex 类型供应商：

```json
{
  "name": "Backup Codex Provider",
  "providerType": "codex",
  "groupTag": "2apiCodex",
  "isEnabled": true
}
```

---

## 六、日志示例

**校验日志**：

```json
{
  "level": "info",
  "msg": "ProxyClientGuard: Checking client restrictions",
  "userName": "codex",
  "allowedClients": ["codex-cli"],
  "allowedClientsLength": 1
}

{
  "level": "info",
  "msg": "ProxyClientGuard: Codex CLI restriction check",
  "hasCodexRestriction": true,
  "allowedClients": ["codex-cli"]
}

{
  "level": "info",
  "msg": "ProxyClientGuard: Non-Codex CLI request detected, routing to 2apiCodex",
  "userName": "codex",
  "hasInstructions": false,
  "instructionsPreview": "N/A"
}

{
  "level": "info",
  "msg": "ProxyClientGuard: Set needsCodexCliDisguise flag",
  "userName": "codex",
  "needsCodexCliDisguise": true
}
```

**伪装日志**：

```json
{
  "level": "info",
  "msg": "ProxyForwarder: Codex CLI disguise triggered",
  "providerId": 5,
  "providerName": "88code",
  "needsCodexCliDisguise": true,
  "providerType": "codex"
}

{
  "level": "info",
  "msg": "ProxyForwarder: Starting Codex CLI disguise",
  "providerId": 5,
  "hasInstructions": false,
  "instructionsType": "undefined",
  "instructionsLength": 0
}

{
  "level": "info",
  "msg": "ProxyForwarder: Injected Codex CLI instructions for disguise",
  "providerId": 5,
  "instructionsLength": 8256
}

{
  "level": "info",
  "msg": "ProxyForwarder: Successfully disguised request as Codex CLI",
  "providerId": 5,
  "providerName": "88code"
}
```

---

## 七、与 Claude Code 逻辑的隔离

| 对比项 | Claude Code | Codex CLI |
|-------|-------------|-----------|
| allowedClients 值 | `"claude-cli"` | `"codex-cli"` |
| 检测方法 | `isClaudeCodeRequest()` | `isCodexCliRequest()` |
| 伪装标记 | `needsClaudeCodeDisguise` | `needsCodexCliDisguise` |
| 路由分组 | `2api` | `2apiCodex` |
| 伪装函数 | `disguiseAsClaudeCodeRequest()` | `disguiseAsCodexCliRequest()` |
| 供应商类型 | `claude` / `claude-auth` | `codex` |

---

## 八、问题排查与修复记录

### 问题 1：Response API 请求未触发 Client Guard

**症状**：
- 日志中完全没有 `ProxyClientGuard` 相关输出
- `needsCodexCliDisguise` 标记未设置
- instructions 未注入

**根本原因**：

Response API 格式的请求在 `chat-completions-handler.ts` 中走的是特殊流程，手动调用了部分 Guard（认证、Session、敏感词、限流、供应商选择），但**漏掉了 ProxyClientGuard**。

**解决方案**：

在 `chat-completions-handler.ts` 的 Guard 执行流程中添加 `ProxyClientGuard.ensure()` 调用（第 173-177 行）。

### 问题 2：Instructions 格式不正确导致上游校验失败

**症状**：
- instructions 已注入（日志显示 `instructionsLength: 11098`）
- 但上游返回 `"Instructions are not valid"`

**根本原因**：

原始使用的 `GPT5_CODEX_PROMPT` 是普通字符串，缺少正确的 `\r\n` 转义符，与上游供应商期望的格式不一致。

**解决方案**：

1. 添加 `CODEX_CLI_INSTRUCTIONS_PROMPTS` 常量（包含正确的 `\r\n` 转义符）
2. 更新 `disguiseAsCodexCliRequest()` 使用新常量
3. 更新 `OFFICIAL_PROMPTS` 列表优先检测新格式

---

## 九、后续维护说明

### 如何更新 Codex CLI Instructions Prompt

当官方 Codex CLI 更新 instructions 时，需要修改以下 3 个位置：

#### 位置 1：定义新的 prompt 常量

**文件**：`src/app/v1/_lib/codex/constants/codex-instructions.ts`

**修改内容**（第 144-145 行）：

```typescript
export const CODEX_CLI_INSTRUCTIONS_PROMPTS =
  "You are Codex, based on GPT-5...";  // ← 更新此字符串（保留 \r\n 转义符）
```

> ⚠️ **重要**：必须保留 `\r\n` 转义符，这是上游供应商期望的格式！

#### 位置 2：更新检测列表（可选）

**文件**：`src/app/v1/_lib/codex/constants/codex-instructions.ts`

**修改内容**（第 152-156 行）：

```typescript
export const OFFICIAL_PROMPTS = [
  CODEX_CLI_INSTRUCTIONS_PROMPTS,  // ← 确保新 prompt 在列表首位（优先匹配）
  GPT5_CODEX_PROMPT,
  GPT5_PROMPT,
];
```

#### 位置 3：确认导入引用正确

**文件**：`src/app/v1/_lib/proxy/forwarder.ts`

**确认导入**（第 21-24 行）：

```typescript
import {
  CODEX_CLI_INSTRUCTIONS_PROMPTS,  // ← 确保导入的是正确的常量
  isOfficialInstructions,
} from "../codex/constants/codex-instructions";
```

**确认使用**（第 307 行）：

```typescript
body.instructions = CODEX_CLI_INSTRUCTIONS_PROMPTS;  // ← 确保注入的是正确的常量
```

### 验证步骤

更新 prompt 后，按以下步骤验证：

1. **类型检查**：
   ```bash
   bun run typecheck
   ```

2. **重新构建**：
   ```bash
   bun run build
   ```

3. **查看日志**：
   - 确认 `instructionsLength` 值与新 prompt 长度一致
   - 确认上游不再返回 `"Instructions are not valid"` 错误

4. **测试请求**：
   - 发送非 Codex CLI 请求
   - 确认请求成功（状态码 200）

---

**文档版本**: 1.1

**维护者**: Claude Code Hub Team

**最后更新**: 2026-01-02

**变更记录**：
- 1.0 (2026-01-02): 初始版本
- 1.1 (2026-01-02): 添加 Response API 修复说明和后续维护指南
