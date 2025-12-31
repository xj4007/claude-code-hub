# 客户端限制智能路由功能文档

**功能名称**: 非 Claude Code 终端智能路由到 2api 分组

**开发日期**: 2025-01-XX

**涉及文件**:
- `src/app/v1/_lib/proxy/client-guard.ts`
- `src/app/v1/_lib/proxy/provider-selector.ts`
- `src/app/v1/_lib/proxy/session.ts`

---

## 一、功能概述

### 1.1 背景与目标

当用户配置了 `allowedClients`（允许的客户端白名单）时，系统原有逻辑是直接返回 400 错误拒绝非白名单客户端的请求。

**新需求**: 不直接拒绝非白名单客户端，而是将其请求智能路由到特定的供应商分组（默认为 `2api` 分组），实现灵活的分流策略。

### 1.2 核心价值

- **灵活分流**: 允许将不同类型客户端路由到不同供应商分组
- **平滑降级**: 非核心客户端可使用备用供应商，而不是直接失败
- **资源隔离**: 核心业务（如 Claude Code CLI）与其他客户端使用不同的供应商池

---

## 二、技术实现

### 2.1 核心机制：强制分组路由（Forced Group Routing）

在 `ProxySession` 类中新增字段：

```typescript
// Force routing to specific provider group (highest priority)
// Set by guards (e.g., ProxyClientGuard) to override user/key group constraints
forcedProviderGroup?: string;
```

**优先级说明**:
```
forcedProviderGroup (最高优先级)
  ↓
key.providerGroup
  ↓
user.providerGroup
```

---

## 三、关键修改点

### 3.1 文件 1: `src/app/v1/_lib/proxy/session.ts`

**位置**: 第 65-69 行

**修改内容**:
```typescript
// 新增字段：强制供应商分组
forcedProviderGroup?: string;
```

**作用**: 
- 存储 Guard 层设置的强制路由目标分组
- 可被 `ProxyClientGuard`、`ProxyVersionGuard` 等任何 Guard 设置
- 在供应商选择器中具有最高优先级

---

### 3.2 文件 2: `src/app/v1/_lib/proxy/client-guard.ts`

**位置**: 第 52-58 行

**原逻辑**（已移除）:
```typescript
// ❌ 旧逻辑：直接返回 400 错误
if (!isAllowed) {
  return ProxyResponses.buildError(
    400,
    `Client not allowed. Your client is not in the allowed list.`,
    "invalid_request_error"
  );
}
```

**新逻辑**:
```typescript
// ✅ 新逻辑：设置强制路由到 "2api" 分组
if (!isAllowed) {
  session.forcedProviderGroup = "2api";
  return null; // 继续管道执行，不中断请求
}
```

**关键变化**:
- 从"直接拒绝"改为"强制路由"
- 返回 `null` 表示继续管道执行（不中断请求）
- 后续的 `ProxyProviderResolver` 会识别 `forcedProviderGroup` 并优先使用

---

### 3.3 文件 3: `src/app/v1/_lib/proxy/provider-selector.ts`

#### 修改点 A: 供应商选择逻辑（第 622-640 行）

**位置**: `pickRandomProvider()` 方法内，Step 1 分组预过滤

**原逻辑**:
```typescript
const effectiveGroupPick = getEffectiveProviderGroup(session);
```

**新逻辑**:
```typescript
let effectiveGroupPick = getEffectiveProviderGroup(session);
const keyGroupPick = session?.authState?.key?.providerGroup;

// 检查强制分组（最高优先级）
const forcedGroup = session?.forcedProviderGroup;
if (forcedGroup) {
  logger.info("ProviderSelector: Forced provider group detected (highest priority)", {
    forcedGroup,
    originalGroup: effectiveGroupPick,
    userName: session?.userName,
  });

  // 覆盖有效分组为强制分组
  effectiveGroupPick = forcedGroup;
}
```

**作用**:
- 检测 `session.forcedProviderGroup` 字段
- 如果存在，覆盖用户/密钥的分组配置
- 记录详细日志便于追踪路由决策

---

#### 修改点 B: 错误日志增强（第 674-688 行）

**位置**: 分组内无可用供应商时的错误处理

**新增逻辑**:
```typescript
if (forcedGroup) {
  // 强制分组无可用供应商 - 这是严重错误
  logger.error("ProviderSelector: Forced provider group has no providers", {
    forcedGroup,
    originalGroup: session?.authState?.key?.providerGroup || session?.authState?.user?.providerGroup,
    userName: session?.userName,
  });
} else {
  logger.error("ProviderSelector: User group has no providers", {
    effectiveGroup: effectiveGroupPick,
  });
}
```

**作用**:
- 区分"强制分组失败"和"用户分组失败"
- 记录原始分组配置和用户信息，便于问题排查

---

#### 修改点 C: 错误响应优化（第 417-428 行）

**位置**: `ensure()` 方法末尾，无可用供应商错误处理

**新增逻辑**:
```typescript
// 特殊处理强制分组路由失败
if (session.forcedProviderGroup) {
  message = `Service temporarily unavailable: No providers available in required group "${session.forcedProviderGroup}"`;
  errorType = "forced_group_unavailable";
  logger.error("ProviderSelector: Forced provider group has no available providers", {
    forcedGroup: session.forcedProviderGroup,
    excludedProviders,
    totalAttempts: attemptCount,
  });
} else if (excludedProviders.length > 0) {
  // 原有逻辑：所有供应商尝试失败
  message = `All providers unavailable (tried ${excludedProviders.length} providers)`;
  errorType = "all_providers_failed";
}
```

**作用**:
- 为强制分组失败提供专用错误消息
- 新错误类型 `forced_group_unavailable` 便于监控告警
- 详细记录失败上下文用于故障分析

---

## 四、工作流程

### 4.1 请求处理流程

```
1. 客户端请求 → ProxyAuthenticator（认证通过）
   ↓
2. ProxyClientGuard 检查 User-Agent
   ├─ 在白名单内 → 继续（使用用户/密钥分组）
   └─ 不在白名单内 → 设置 session.forcedProviderGroup = "2api"
   ↓
3. ProxyProviderResolver 选择供应商
   ├─ 检测到 forcedProviderGroup → 覆盖用户分组
   ├─ 从 "2api" 分组筛选可用供应商
   └─ 若 "2api" 分组无可用供应商 → 返回 503 错误
   ↓
4. 请求转发到选定的供应商
```

### 4.2 决策优先级

```
第一优先级: session.forcedProviderGroup (Guard 层设置)
第二优先级: key.providerGroup (密钥级配置)
第三优先级: user.providerGroup (用户级配置)
```

---

## 五、配置示例

### 5.1 用户表配置

```json
{
  "id": 1,
  "name": "test_user",
  "allowedClients": ["claude-code", "codex"],  // 白名单
  "providerGroup": "cli"                        // 默认分组
}
```

### 5.2 供应商配置

```json
[
  {
    "id": 1,
    "name": "Primary Claude Provider",
    "groupTag": "cli",           // 白名单客户端使用
    "isEnabled": true
  },
  {
    "id": 2,
    "name": "Backup 2API Provider",
    "groupTag": "2api",          // 非白名单客户端使用
    "isEnabled": true
  }
]
```

### 5.3 请求场景

| 客户端 User-Agent | 是否在白名单 | 路由分组 | 最终供应商 |
|------------------|------------|---------|-----------|
| `claude-code/1.0` | ✅ 是 | `cli` (用户分组) | Provider #1 |
| `postman/7.0` | ❌ 否 | `2api` (强制分组) | Provider #2 |
| `curl/8.0` | ❌ 否 | `2api` (强制分组) | Provider #2 |

---

## 六、错误处理

### 6.1 错误类型

| 错误类型 | HTTP 状态码 | 触发条件 | 建议操作 |
|---------|-----------|---------|---------|
| `forced_group_unavailable` | 503 | 强制分组内无可用供应商 | 检查 `2api` 分组配置 |
| `all_providers_failed` | 503 | 所有供应商尝试失败 | 检查供应商健康状态 |
| `no_available_providers` | 503 | 无任何可用供应商 | 检查供应商启用状态 |

### 6.2 典型错误响应

```json
{
  "type": "error",
  "error": {
    "type": "forced_group_unavailable",
    "message": "Service temporarily unavailable: No providers available in required group \"2api\""
  }
}
```

---

## 七、日志追踪

### 7.1 关键日志点

**1. 强制分组触发**（client-guard.ts 第 55 行）
```typescript
session.forcedProviderGroup = "2api";
// 日志隐式记录在 provider-selector.ts
```

**2. 供应商选择检测**（provider-selector.ts 第 632 行）
```
INFO: ProviderSelector: Forced provider group detected (highest priority)
{
  forcedGroup: "2api",
  originalGroup: "cli",
  userName: "test_user"
}
```

**3. 分组无供应商错误**（provider-selector.ts 第 677 行）
```
ERROR: ProviderSelector: Forced provider group has no providers
{
  forcedGroup: "2api",
  originalGroup: "cli",
  userName: "test_user"
}
```

---

## 八、注意事项

### 8.1 必须配置 "2api" 分组

- 在供应商管理中必须创建至少一个 `groupTag` 包含 `2api` 的供应商
- 否则所有非白名单客户端请求都会失败（503 错误）

### 8.2 分组标签匹配规则

- 支持多标签逗号分隔：`groupTag: "cli,2api"` 可同时匹配两个分组
- 匹配规则：供应商标签与目标分组有任意交集即可

### 8.3 兼容性说明

- **向后兼容**: 未配置 `allowedClients` 的用户不受影响
- **Fail-Safe**: 强制分组失败时返回明确错误，不会静默失败

---

## 九、扩展场景

### 9.1 多级分流策略

可在其他 Guard 中使用相同机制实现更复杂的路由策略：

```typescript
// 示例：版本过低路由到降级分组
if (clientVersion < minVersion) {
  session.forcedProviderGroup = "legacy";
}

// 示例：特定用户路由到测试分组
if (user.isBetaTester) {
  session.forcedProviderGroup = "beta";
}
```

### 9.2 动态分组配置

建议在系统设置中添加配置项：

```typescript
{
  "clientGuard": {
    "fallbackGroup": "2api",      // 可配置的回退分组
    "enableForcedRouting": true   // 开关控制
  }
}
```

---

## 十、总结

### 10.1 核心改动

1. **session.ts**: 新增 `forcedProviderGroup` 字段
2. **client-guard.ts**: 从"拒绝"改为"强制路由"
3. **provider-selector.ts**: 识别强制分组并优先使用

### 10.2 技术亮点

- **最小侵入**: 仅修改 3 个文件，不影响现有流程
- **优先级清晰**: 强制分组 > 密钥分组 > 用户分组
- **可观测性强**: 完整的日志记录和错误类型
- **易于扩展**: 其他 Guard 可复用相同机制

---

**文档版本**: 1.0  
**维护者**: [您的名字]  
**最后更新**: 2025-01-XX
