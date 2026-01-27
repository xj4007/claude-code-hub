# 补充请求体逻辑简述

## 触发条件
- 仅当 `providerType` 为 `claude` / `claude-auth` 且 `session.needsClaudeDisguise === true` 时执行补全。
- `needsClaudeDisguise` 由客户端识别阶段设置（非 Claude CLI 请求会开启伪装）。

## 补充内容（Claude 伪装）
1. `messages[0].content`
   - 若为字符串，先转换为数组格式。
   - 若不存在 `<system-reminder>`，在数组头部插入空的 `<system-reminder></system-reminder>` 文本块。
2. `system`
   - 若为字符串，转换为数组格式；若缺失则创建空数组。
   - 确保包含 Claude Code 身份文本：
     `You are Claude Code, Anthropic's official CLI for Claude.`
   - 确保包含 `x-anthropic-billing-header` 文本；若已存在则替换为固定值。
3. `metadata.user_id`
   - 缺失时补齐；若供应商启用 `useUnifiedClientId`，优先用统一客户端 ID；否则使用默认固定 client id。

## 位置与时机
- 在转发上游前、请求格式转换之后执行（`ProxyForwarder.doForward` 内）。
- 仅影响被判定为需要伪装的 Claude 请求，不影响 Codex/OpenAI/Gemini 请求。

## 涉及文件
- `src/app/v1/_lib/proxy/forwarder.ts`
  - `ensureClaudeRequestDefaults()`：补充系统提示与 metadata
- `src/app/v1/_lib/proxy/client-guard.ts`
  - 设置 `session.needsClaudeDisguise`（触发补全逻辑的前置条件）
