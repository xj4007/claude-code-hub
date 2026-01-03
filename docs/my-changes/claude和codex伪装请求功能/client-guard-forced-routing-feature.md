# Client Guard 行为调整说明（移除 2api 强制路由）

**更新时间**: 2025-01-03
**状态**: 已上线
**适用范围**: Claude 请求路径（/v1/messages 等）

---

## 1. 背景与问题

- 旧方案：当 `allowedClients` 不满足时，将请求强制路由到 `2api` 分组，并在 forwarder 做伪装。
- 问题：真实 Claude CLI 请求可能因校验缺失被误判并被错误分组；强制路由带来不可控的跨分组行为。
- 合并冲突：主分支引入了 `allowedClients` 校验逻辑，与本地的字段补全逻辑产生冲突。

## 2. 新目标

- 保留用户/密钥原有的分组决策，不再"劫持"到 `2api`。
- **职责分离**：Guard 层只做客户端校验，Forwarder 层负责字段补全。
- **避免冲突**：删除 Guard 层的补全逻辑，减少与主分支的合并冲突。

## 3. 行为变更概览

- **分组决策**：删除 `forcedProviderGroup`，`ProviderSelector` 仅按用户/密钥分组过滤。
- **请求补全**：字段补全逻辑从 `ClientGuard` 移至 `ProxyForwarder`，统一在转发层处理。
- **客户端校验**：`ClientGuard` 保留主分支的 `allowedClients` 校验功能（User-Agent 白名单）。
- **伪装/标记**：移除伪装标记，forwarder 不再依赖标记做伪装。
- **错误类型**：`forced_group_unavailable` 移除，错误提示回归常规"无可用供应商"。

## 4. 代码落点

### 4.1 修改的文件

**`src/app/v1/_lib/proxy/client-guard.ts`** ✅ 已修改
- ❌ 删除了 `ensureClaudeDefaults()` 方法（原 12-117 行）
- ❌ 删除了 `crypto` 导入（不再需要）
- ✅ 保留主分支的 `allowedClients` 校验逻辑
- ✅ 添加 `ProxyResponses` 导入用于错误响应
- 📝 更新类注释，明确职责为"客户端校验"

**`src/app/v1/_lib/proxy/forwarder.ts`** ✅ 无需修改
- ✅ 保留 `ensureClaudeRequestDefaults()` 函数（121-264 行）
- ✅ 在第 1175-1177 行调用，补全 Claude 请求字段
- ✅ 支持 `useUnifiedClientId` 功能

**`src/app/v1/_lib/proxy/session.ts`** ✅ 已在之前移除
- ❌ 移除 `forcedProviderGroup` 字段
- ❌ 移除伪装相关字段

**`src/app/v1/_lib/proxy/provider-selector.ts`** ✅ 已在之前修改
- ❌ 删除强制分组逻辑
- ✅ 仅按用户/密钥分组过滤候选供应商

### 4.2 职责分离说明

| 层级 | 职责 | 具体实现 |
|------|------|----------|
| **Guard 层** | 校验和拦截 | `ClientGuard.ensure()` - 校验 `allowedClients` 白名单 |
| **Forwarder 层** | 转换和补全 | `ensureClaudeRequestDefaults()` - 补全 Claude 必需字段 |

## 5. 流程（Claude 请求）

### 5.1 完整请求流程

```
客户端请求
  ↓
ProxyAuthenticator (认证)
  ↓
ProxyClientGuard (校验 allowedClients)
  ├─ 未配置 allowedClients → 跳过校验 (return null)
  ├─ 配置了且 UA 匹配 → 通过 (return null)
  └─ 配置了但 UA 不匹配 → 拦截 (return 400)
  ↓
其他 Guards (model, version, session, rateLimit...)
  ↓
ProxyProviderResolver (选择供应商，仅按用户/密钥分组过滤)
  ↓
ProxyForwarder
  ├─ 格式转换 (如需要)
  ├─ ensureClaudeRequestDefaults() ← 补全 system-reminder、Claude identity、metadata.user_id
  └─ applyCacheTtlOverride (如配置)
  ↓
转发到上游 Claude 供应商
```

### 5.2 字段补全详情

**在 Forwarder 层补全的字段**（`ensureClaudeRequestDefaults`）：
1. **messages[0].content** - 插入 `<system-reminder></system-reminder>`
2. **system** - 插入 `"You are Claude Code, Anthropic's official CLI for Claude."`
3. **metadata.user_id** - 补充用户标识
   - 优先使用供应商的 `unifiedClientId`（如配置）
   - 否则使用默认 client ID

## 6. 配置影响

- **`allowedClients`**：现在用于客户端白名单校验，不影响路由或字段补全。
  - 未配置：跳过校验，所有客户端都可访问
  - 已配置：仅允许 User-Agent 匹配的客户端
- **供应商分组**：仅使用用户/密钥的 `providerGroup`；无额外"2api"兜底需求。
- **`useUnifiedClientId`**：在 Forwarder 层生效，覆盖 `metadata.user_id`。

## 7. 日志关注点

### 7.1 ClientGuard 相关日志

- ✅ `ProxyClientGuard: Client allowed` - 客户端通过校验
- ❌ `Client not allowed. User-Agent header is required` - 缺少 UA 头
- ❌ `Client not allowed. Your client is not in the allowed list` - UA 不在白名单

### 7.2 Forwarder 相关日志

- ✅ `ProxyForwarder: Normalized Claude request defaults` - 补全 Claude 字段
- ✅ `ProxyForwarder: Added <system-reminder> to messages` - 添加 system-reminder
- ✅ `ProxyForwarder: Added Claude Code identity to system` - 添加 Claude 身份
- ✅ `ProxyForwarder: Applied provider unified client ID` - 使用统一客户端 ID

### 7.3 不再出现的日志

- ❌ `ProxyClientGuard: Normalized Claude request defaults` - 已移至 Forwarder
- ❌ "forced group" 相关日志 - 已删除强制路由逻辑

## 8. 测试建议

### 8.1 功能测试

1. **未配置 allowedClients 的场景**
   - 所有客户端都应能正常访问
   - 字段补全在 Forwarder 层正常工作
   - 日志中应出现 `ProxyForwarder: Normalized Claude request defaults`

2. **配置了 allowedClients 的场景**
   - UA 匹配的客户端：正常访问，字段正常补全
   - UA 不匹配的客户端：返回 400 错误
   - 缺少 UA 头：返回 400 错误

3. **字段补全验证**
   - 检查请求体是否包含 `<system-reminder>`
   - 检查 system 是否包含 Claude Code 身份标识
   - 检查 metadata.user_id 是否正确生成

### 8.2 回归测试

- 真实 Claude CLI 请求：应保持原分组、不被改写；请求体在 Forwarder 层补全缺失字段。
- 非 Claude 请求：不再被强制改组，按原分组策略继续。
- 分组缺失场景：返回常规错误类型（如 `no_available_providers` / `all_providers_failed`）。
- `useUnifiedClientId` 功能：验证供应商配置的统一客户端 ID 是否正确覆盖。

---

## 9. 合并冲突解决记录

**日期**: 2025-01-03

**冲突原因**：
- 主分支引入了 `allowedClients` 校验逻辑
- 本地分支在 `ClientGuard` 中实现了字段补全逻辑
- 两者在 `ensure()` 方法中产生冲突

**解决方案**：
- ✅ 保留主分支的 `allowedClients` 校验逻辑
- ❌ 删除本地的 `ensureClaudeDefaults()` 方法
- ✅ 依赖 `forwarder.ts` 中已有的补全逻辑
- 📝 更新文档说明职责分离

**优势**：
- 避免重复逻辑
- 减少未来合并冲突
- 职责更清晰（Guard 做校验，Forwarder 做转换）
- Forwarder 层的实现更完整（支持 `useUnifiedClientId`）

---

**文档版本**: 3.0（职责分离版本，解决主分支合并冲突）
**维护者**: Team
**上次更新**: 2025-01-03
