# Codex CLI 兼容性与请求补全说明

**更新日期**: 2025-01-03
**状态**: 已上线（替代旧"2apiCodex 强制路由 + 伪装"方案）

---

## 1. 背景与问题

- 旧方案：基于 `allowedClients` 和特征判定，把"非 Codex"请求强制路由到 `2apiCodex` 分组并伪装。
- 问题：误判会导致真实请求被错误分组；分组劫持让用户/密钥的分组配置失效。
- 合并冲突：与 Claude 补全逻辑类似，需要统一在 Forwarder 层处理，避免与主分支冲突。

## 2. 新目标

- 保留用户/密钥分组，不再强制改组。
- 统一在转发层补全 Codex 所需指令和会话头，确保上游兼容。
- 继续清洗不支持的 Codex 参数，官方 UA 仍可绕过清洗。
- **职责分离**：Guard 层只做客户端校验，Forwarder 层负责 Codex 字段补全。

## 3. 行为变更概览

- **分组**：删除 `forcedProviderGroup` / 伪装标记，ProviderSelector 仅按用户/密钥分组过滤。
- **指令补全**：按模型调用 `getInstructionsForModel`，缺失或不匹配则替换 instructions。
- **头部补全**：缺失 `session_id` / `conversation_id` 时填充 UUID。
- **清洗**：保留 `sanitizeCodexRequest`，移除不支持参数，设置默认 store/parallel_tool_calls；官方 UA 透传。
- **客户端校验**：与 Claude 共用 `ClientGuard` 的 `allowedClients` 校验逻辑。

## 4. 代码落点

### 4.1 修改的文件

**`src/app/v1/_lib/proxy/forwarder.ts`** ✅ 无需修改
- ✅ 保留 `ensureCodexRequestDefaults()` 函数（271-295 行）
- ✅ 在第 1199 行调用，补全 Codex 请求字段
- ✅ 补全内容：
  1. **instructions** - 替换为官方 prompt
  2. **session_id** - 补充缺失的 session ID
  3. **conversation_id** - 补充缺失的 conversation ID

**`src/app/v1/_lib/codex/constants/codex-instructions.ts`** ✅ 无需修改
- ✅ 复用 `getInstructionsForModel` 选择官方 prompt

**`src/app/v1/_lib/proxy/client-guard.ts`** ✅ 已修改
- ❌ 移除 Codex 相关的分组/伪装标记与分流逻辑
- ✅ 保留 `allowedClients` 校验（与 Claude 共用）

**`src/app/v1/_lib/proxy/session.ts`** ✅ 已在之前移除
- ❌ 移除 `forcedProviderGroup` 字段
- ❌ 移除伪装相关字段

### 4.2 职责分离说明

| 层级 | 职责 | 具体实现 |
|------|------|----------|
| **Guard 层** | 校验和拦截 | `ClientGuard.ensure()` - 校验 `allowedClients` 白名单 |
| **Forwarder 层** | 转换和补全 | `ensureCodexRequestDefaults()` - 补全 Codex 必需字段 |
| **Forwarder 层** | 参数清洗 | `sanitizeCodexRequest()` - 清理不支持的参数 |

## 5. 流程（Codex 请求）

### 5.1 完整请求流程

```
客户端请求
  ↓
ProxyAuthenticator (认证)
  ↓
ProxyClientGuard (校验 allowedClients)
  ├─ 未配置 allowedClients → 跳过校验
  ├─ 配置了且 UA 匹配 → 通过
  └─ 配置了但 UA 不匹配 → 拦截 (return 400)
  ↓
其他 Guards (model, version, session, rateLimit...)
  ↓
ProxyProviderResolver (选择供应商，仅按用户/密钥分组过滤)
  ↓
ProxyForwarder (toFormat = "codex")
  ├─ 格式转换 (如需要)
  ├─ ensureCodexRequestDefaults() ← 补全 instructions、session_id、conversation_id
  ├─ 判断是否为官方客户端
  │   ├─ 官方客户端 → 跳过 sanitizeCodexRequest
  │   └─ 非官方客户端 → 执行 sanitizeCodexRequest (清理不支持参数)
  └─ 转发到上游 Codex 供应商
```

### 5.2 字段补全详情

**在 Forwarder 层补全的字段**（`ensureCodexRequestDefaults`）：
1. **instructions** - 根据模型名称替换为官方 prompt（通过 `getInstructionsForModel`）
2. **session_id** - 缺失时填充 UUID
3. **conversation_id** - 缺失时填充 UUID（与 session_id 使用相同 UUID）

## 6. 日志关注点

### 6.1 Forwarder 相关日志

- ✅ `ProxyForwarder: Codex instructions normalized` - 补全/替换 instructions 时
- ✅ `ProxyForwarder: Added session_id header (Codex)` - 缺失时补齐 session_id
- ✅ `ProxyForwarder: Added conversation_id header (Codex)` - 缺失时补齐 conversation_id
- ✅ `[ProxyForwarder] Normalizing Codex request for upstream compatibility` - 开始处理 Codex 请求
- ✅ `[ProxyForwarder] Bypassing sanitizer for official Codex CLI client` - 官方客户端跳过清洗
- ✅ `[CodexSanitizer] Request sanitized successfully` - 清洗完成（非官方客户端）

### 6.2 ClientGuard 相关日志

- ✅ `ProxyClientGuard: Client allowed` - 客户端通过校验
- ❌ `Client not allowed. User-Agent header is required` - 缺少 UA 头
- ❌ `Client not allowed. Your client is not in the allowed list` - UA 不在白名单

### 6.3 不再出现的日志

- ❌ Codex 相关的强制分组日志 - 已删除强制路由逻辑

## 7. 测试建议

### 7.1 功能测试

1. **instructions 补全测试**
   - 无 instructions 的请求：应被替换为官方 prompt
   - 错误 instructions 的请求：应被替换为官方 prompt
   - 日志中应出现 `ProxyForwarder: Codex instructions normalized`

2. **headers 补全测试**
   - 缺失 session_id：应被自动补齐并记录日志
   - 缺失 conversation_id：应被自动补齐并记录日志
   - 已有 headers：不应被覆盖

3. **官方客户端测试**
   - 官方 Codex UA：应绕过清洗但仍保留必需头部补全
   - 日志中应出现 `Bypassing sanitizer for official Codex CLI client`

4. **非官方客户端测试**
   - 非官方 UA：应执行完整的补全和清洗流程
   - 日志中应出现 `Request sanitized successfully`

### 7.2 回归测试

- **分组验证**：用户/密钥分组应保持生效，不再被改为 `2apiCodex`
- **格式转换**：OpenAI 格式转 Codex 格式应正常工作
- **错误处理**：补全失败不应影响请求继续（Fail-Open 策略）

---

## 8. 合并冲突解决记录

**日期**: 2025-01-03

**冲突原因**：
- 与 Claude 补全逻辑类似，需要统一职责分离
- 避免在 Guard 层做字段补全，减少与主分支冲突

**解决方案**：
- ✅ 保留 `forwarder.ts` 中的 `ensureCodexRequestDefaults()` 函数
- ✅ 保留 `sanitizeCodexRequest()` 清洗逻辑
- ✅ ClientGuard 只做 `allowedClients` 校验（与 Claude 共用）
- ❌ 删除 Guard 层的 Codex 相关分组/伪装逻辑

**优势**：
- 避免重复逻辑
- 减少未来合并冲突
- 职责更清晰（Guard 做校验，Forwarder 做转换和补全）
- 官方客户端和非官方客户端的差异化处理更灵活

---

**文档版本**: 3.0（职责分离版本，与 Claude 补全逻辑保持一致）
**维护者**: Team
**上次更新**: 2025-01-03
