# Codex CLI 兼容性与请求补全说明

**更新日期**: 2025-xx-xx  
**状态**: 已上线（替代旧“2apiCodex 强制路由 + 伪装”方案）

---

## 1. 背景与问题

- 旧方案：基于 `allowedClients` 和特征判定，把“非 Codex”请求强制路由到 `2apiCodex` 分组并伪装。
- 问题：误判会导致真实请求被错误分组；分组劫持让用户/密钥的分组配置失效。

## 2. 新目标

- 保留用户/密钥分组，不再强制改组。
- 统一在转发层补全 Codex 所需指令和会话头，确保上游兼容。
- 继续清洗不支持的 Codex 参数，官方 UA 仍可绕过清洗。

## 3. 行为变更概览

- **分组**：删除 `forcedProviderGroup` / 伪装标记，ProviderSelector 仅按用户/密钥分组过滤。
- **指令补全**：按模型调用 `getInstructionsForModel`，缺失或不匹配则替换 instructions。
- **头部补全**：缺失 `session_id` / `conversation_id` 时填充 UUID。
- **清洗**：保留 `sanitizeCodexRequest`，移除不支持参数，设置默认 store/parallel_tool_calls；官方 UA 透传。

## 4. 代码落点

- `src/app/v1/_lib/proxy/forwarder.ts`
  - 新增 `ensureCodexRequestDefaults`：统一替换 instructions、补全 session headers。
  - 继续调用 `sanitizeCodexRequest`，官方 UA 可绕过清洗。
- `src/app/v1/_lib/codex/constants/codex-instructions.ts`
  - 复用 `getInstructionsForModel` 选择官方 prompt。
- `src/app/v1/_lib/proxy/session.ts`、`src/app/v1/_lib/proxy/client-guard.ts`
  - 移除 Codex 相关的分组/伪装标记与分流逻辑。

## 5. 流程（Codex 请求）

```
认证 → （其他 Guard） → ProxyForwarder (providerType/toFormat = codex)
    ├─ ensureCodexRequestDefaults   # 替换 instructions + 补齐 session_id / conversation_id
    ├─ sanitizeCodexRequest         # 清理不支持参数 / 透传官方客户端
    └─ 转发上游
```

## 6. 日志关注点

- `ProxyForwarder: Codex instructions normalized`（补全/替换 instructions 时）。
- `ProxyForwarder: Added session_id header (Codex)`（缺失时补齐）。
- `[CodexSanitizer] Request sanitized successfully`（清洗完成）。

## 7. 测试建议

- 无 instructions/错误 instructions 的请求：应被替换为官方 prompt，且仍能正常转发。
- 缺失 session_id/conversation_id：应被自动补齐并记录日志。
- 官方 Codex UA：应绕过清洗但仍保留必需头部补全。
- 分组验证：用户/密钥分组应保持生效，不再被改为 `2apiCodex`。

---

**文档版本**: 2.0  
**维护者**: Team
