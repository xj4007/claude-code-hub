# Client Guard 行为调整说明（移除 2api 强制路由）

**更新时间**: 2025-xx-xx  
**状态**: 已上线  
**适用范围**: Claude 请求路径（/v1/messages 等）

---

## 1. 背景与问题

- 旧方案：当 `allowedClients` 不满足时，将请求强制路由到 `2api` 分组，并在 forwarder 做伪装。
- 问题：真实 Claude CLI 请求可能因校验缺失被误判并被错误分组；强制路由带来不可控的跨分组行为。

## 2. 新目标

- 保留用户/密钥原有的分组决策，不再“劫持”到 `2api`。
- Guard 只做“补全 Claude 标准字段”，不再做客户端类型判定或分组改写。

## 3. 行为变更概览

- **分组决策**：删除 `forcedProviderGroup`，`ProviderSelector` 仅按用户/密钥分组过滤。
- **请求补全**：`ClientGuard` 对 Claude 格式请求补全 `<system-reminder>`、Claude 身份文案、`metadata.user_id`（统一客户端 ID 覆盖逻辑位于 forwarder）。
- **伪装/标记**：移除伪装标记，forwarder 不再依赖标记做伪装。
- **错误类型**：`forced_group_unavailable` 移除，错误提示回归常规“无可用供应商”。

## 4. 代码落点

- `src/app/v1/_lib/proxy/client-guard.ts`
  - 不再读取 `allowedClients` 做判定；只补全 Claude 必需字段。
- `src/app/v1/_lib/proxy/session.ts`
  - 移除 `forcedProviderGroup`、伪装相关字段。
- `src/app/v1/_lib/proxy/provider-selector.ts`
  - 删除强制分支，按用户/密钥分组过滤候选供应商。
- `src/app/v1/_lib/proxy/forwarder.ts`
  - 对 Claude/Claude-auth 供应商补全缺失字段，并支持统一客户端 ID 覆盖。

## 5. 流程（Claude 请求）

```
认证 → ClientGuard 补全 Claude 字段 → 版本/模型等其他 Guard → ProviderSelector（仅按用户/密钥分组过滤）→ Forwarder → 上游
```

## 6. 配置影响

- `allowedClients` 不再影响路由或拦截，保留字段不会产生行为差异。
- 供应商分组：仅使用用户/密钥的 `providerGroup`；无额外“2api”兜底需求。

## 7. 日志关注点

- `ProxyClientGuard: Normalized Claude request defaults`（补全缺失字段时）。
- `ProviderSelector: User group has no providers`（分组下无可用供应商时）。
- 不再出现“forced group”相关日志。

## 8. 测试建议

- 真实 Claude CLI 请求：应保持原分组、不被改写；请求体在服务端补全缺失字段。
- 非 Claude 请求：不再被强制改组，按原分组策略继续。
- 分组缺失场景：返回常规错误类型（如 `no_available_providers` / `all_providers_failed`）。

---

**文档版本**: 2.0（替代旧“强制路由到 2api”方案）  
**维护者**: Team
