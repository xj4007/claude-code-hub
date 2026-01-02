# 增强 Claude Code 客户端校验与请求伪装功能

**开发日期**: 2025-01-02

**功能版本**: 2.0

**涉及文件**:
- `src/app/v1/_lib/proxy/client-guard.ts`
- `src/app/v1/_lib/proxy/session.ts`
- `src/app/v1/_lib/proxy/forwarder.ts`

---

## 一、功能概述

### 1.1 背景与目标

原有的客户端校验功能仅通过 User-Agent 请求头进行客户端类型识别，存在以下问题：

1. **校验不可靠**：User-Agent 易伪造，无法真正区分 Claude Code 终端
2. **误判率高**：缺少请求体特征校验，容易将非 Claude Code 请求误判为合法请求
3. **缺少伪装能力**：非 Claude Code 请求路由到 2api 分组后，仍保持原始格式，可能被上游供应商拒绝

**新需求**：

- 从 User-Agent 校验升级为**请求体参数校验**
- 为路由到 2api 分组的非 Claude Code 请求**自动添加伪装**
- 集成**统一客户端标识功能**生成 metadata.user_id

### 1.2 核心价值

- **提高校验准确性**：通过多维度请求体特征检测，准确识别 Claude Code 终端
- **完整伪装能力**：自动为非 Claude Code 请求补充所需参数，使其看起来像真实的 Claude Code 请求
- **平滑降级**：非核心客户端可使用备用供应商（2api 分组），而不是直接失败
- **资源隔离**：核心业务（Claude Code CLI）与其他客户端使用不同的供应商池

---

## 二、技术实现

### 2.1 核心机制：请求体参数校验

从单纯的 User-Agent 头部校验改为**请求体参数校验**，检测以下 Claude Code 特征：

#### 特征 1: messages 特征

检查第一个 message 的 content 数组第一项是否包含 `<system-reminder></system-reminder>`：

```typescript
const messages = requestBody.messages as Array<Record<string, unknown>>;
const firstMessage = messages[0];
const content = firstMessage.content as Array<Record<string, unknown>>;
const firstContent = content[0];

if (
  firstContent.type !== "text" ||
  !String(firstContent.text || "").includes("<system-reminder>")
) {
  return false; // 不是 Claude Code 请求
}
```

#### 特征 2: system 特征

检查 system 数组第一项是否包含 `You are Claude Code, Anthropic's official CLI for Claude.`：

```typescript
const system = requestBody.system as Array<Record<string, unknown>>;
const firstSystem = system[0];

if (
  firstSystem.type !== "text" ||
  !String(firstSystem.text || "").includes(
    "You are Claude Code, Anthropic's official CLI for Claude."
  )
) {
  return false; // 不是 Claude Code 请求
}
```

#### 特征 3: metadata.user_id 格式

检查 `metadata.user_id` 是否符合格式 `user_{64位十六进制}_account__session_{uuid}`：

```typescript
const metadata = requestBody.metadata as Record<string, unknown>;
if (metadata && metadata.user_id) {
  const userId = String(metadata.user_id);
  const pattern = /^user_[a-f0-9]{64}_account__session_[a-f0-9-]{36}$/;
  return pattern.test(userId); // 严格校验格式
}

// 即使没有 user_id，前两个特征也足够判断
return true;
```

### 2.2 核心机制：请求体伪装

为被路由到 2api 分组的非 Claude Code 请求，自动添加以下伪装：

#### 伪装 1: messages 伪装

在第一个 content 数组开头插入 `<system-reminder></system-reminder>`：

```typescript
// 如果 content 是字符串，先转换为数组格式
if (typeof content === "string") {
  content = [{ type: "text", text: content }];
  firstMessage.content = content;
}

// 在开头插入 <system-reminder>
content.unshift({
  type: "text",
  text: "<system-reminder></system-reminder>",
});
```

#### 伪装 2: system 伪装

在 system 数组开头插入 Claude Code 标识：

```typescript
// 如果 system 是字符串，转换为数组格式
if (typeof system === "string") {
  system = [{ type: "text", text: system }];
  body.system = system;
}

// 如果 system 不存在，创建数组
if (!system) {
  system = [];
  body.system = system;
}

// 在开头插入 Claude Code 标识
system.unshift({
  type: "text",
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
});
```

#### 伪装 3: metadata.user_id 伪装

生成符合格式的 `user_id`，优先使用供应商的统一客户端标识：

```typescript
let clientId: string;

// 优先使用供应商的统一客户端标识（如已配置）
if (provider.useUnifiedClientId && provider.unifiedClientId) {
  clientId = provider.unifiedClientId;
} else {
  // 使用固定默认值
  clientId = "161cf9dec4f981e08a0d7971fa065ca51550a8eb87be857651ae40a20dd9a5ed";
}

// 生成随机 session UUID
const sessionUuid = crypto.randomUUID();

// 生成符合格式的 user_id
metadata.user_id = `user_${clientId}_account__session_${sessionUuid}`;
```

---

## 三、关键修改点

### 3.1 文件 1: `src/app/v1/_lib/proxy/client-guard.ts`

#### 修改点 A: 添加 Claude Code 特征检测方法（第 22-82 行）

**新增方法**：`isClaudeCodeRequest()`

```typescript
/**
 * 检测请求是否包含 Claude Code 终端特征
 *
 * Claude Code 请求特征：
 * 1. messages 数组第一个元素的 content 第一项是 <system-reminder></system-reminder>
 * 2. system 数组第一个元素包含 "You are Claude Code, Anthropic's official CLI for Claude."
 * 3. metadata.user_id 格式符合 user_{64位十六进制}_account__session_{uuid}
 */
private static isClaudeCodeRequest(requestBody: Record<string, unknown>): boolean {
  try {
    // 检查 messages 特征
    // 检查 system 特征
    // 检查 metadata.user_id 格式
    // ...
    return true;
  } catch (error) {
    logger.debug("ProxyClientGuard: Failed to detect Claude Code request", { error });
    return false;
  }
}
```

**作用**：
- 提供可靠的 Claude Code 终端检测逻辑
- 通过三重特征校验降低误判率
- 错误容忍，检测失败时返回 false

#### 修改点 B: 重写 ensure 方法校验逻辑（第 83-143 行）

**原逻辑**（已移除）：
```typescript
// ❌ 旧逻辑：仅检查 User-Agent
const userAgent = session.userAgent;
if (!userAgent || userAgent.trim() === "") {
  return ProxyResponses.buildError(400, "User-Agent required", "invalid_request_error");
}

const isAllowed = allowedClients.some((pattern) =>
  userAgent.toLowerCase().includes(pattern.toLowerCase())
);

if (!isAllowed) {
  session.forcedProviderGroup = "2api"; // 直接路由
  return null;
}
```

**新逻辑**：
```typescript
// ✅ 新逻辑：先检查请求体是否包含 Claude Code 特征
const isClaudeCode = ProxyClientGuard.isClaudeCodeRequest(session.request.message);

logger.debug("ProxyClientGuard: Client validation", {
  userName: user.name,
  isClaudeCode,
  allowedClients,
});

if (!isClaudeCode) {
  // 非 Claude Code 请求 - 强制路由到 2api 分组
  logger.info("ProxyClientGuard: Non-Claude Code request detected, routing to 2api", {
    userName: user.name,
  });

  session.forcedProviderGroup = "2api";
  session.needsClaudeCodeDisguise = true; // 标记需要伪装

  return null; // 继续管道执行
}

// Claude Code 请求 - 检查 User-Agent 是否在白名单中
const userAgent = session.userAgent || "";
const userAgentLower = userAgent.toLowerCase();
const isAllowed = allowedClients.some((pattern) =>
  userAgentLower.includes(pattern.toLowerCase())
);

if (!isAllowed) {
  logger.warn("ProxyClientGuard: Claude Code request with invalid User-Agent", {
    userName: user.name,
    userAgent,
    allowedClients,
  });

  // 真实的 Claude Code 请求但 User-Agent 不在白名单 - 也路由到 2api
  session.forcedProviderGroup = "2api";
  session.needsClaudeCodeDisguise = false; // 已经是 Claude Code 格式，不需要伪装

  return null;
}

// Client is allowed
return null;
```

**关键变化**：
- **两级校验**：先检查请求体特征，再检查 User-Agent
- **智能标记**：非 Claude Code 请求设置 `needsClaudeCodeDisguise = true`
- **向后兼容**：真实 Claude Code 请求仍然检查 User-Agent 白名单
- **详细日志**：记录完整的决策过程便于调试

---

### 3.2 文件 2: `src/app/v1/_lib/proxy/session.ts`

#### 修改点: 添加伪装标记字段（第 82-83 行）

**位置**：在 `forcedProviderGroup` 字段后添加

```typescript
// Force routing to specific provider group (highest priority)
// Set by guards (e.g., ProxyClientGuard) to override user/key group constraints
forcedProviderGroup?: string;

// 标记此请求是否需要 Claude Code 伪装（用于 2api 分组）
needsClaudeCodeDisguise?: boolean;
```

**作用**：
- 存储 Guard 层设置的伪装需求标记
- 在 `ProxyForwarder` 中使用，决定是否执行伪装
- 可选字段，默认为 undefined（不伪装）

---

### 3.3 文件 3: `src/app/v1/_lib/proxy/forwarder.ts`

#### 修改点 A: 添加 Claude Code 请求体伪装辅助函数（第 111-265 行）

**新增函数**：`disguiseAsClaudeCodeRequest()`

```typescript
/**
 * 为非 Claude Code 请求添加 Claude Code 特征
 *
 * 伪装内容：
 * 1. messages 第一个元素的 content 数组开头插入 <system-reminder>
 * 2. system 数组开头插入 Claude Code 标识
 * 3. 添加 metadata.user_id（使用统一客户端标识或固定值）
 */
function disguiseAsClaudeCodeRequest(
  body: Record<string, unknown>,
  provider: ProxySession["provider"]
): void {
  if (!provider) return;

  try {
    // 1. 处理 messages - 在第一个 content 数组开头插入 <system-reminder>
    // 2. 处理 system - 在开头插入 Claude Code 标识
    // 3. 处理 metadata.user_id
    // ...

    logger.info("ProxyForwarder: Successfully disguised request as Claude Code", {
      providerId: provider.id,
      providerName: provider.name,
    });
  } catch (error) {
    logger.error("ProxyForwarder: Failed to disguise request as Claude Code", {
      providerId: provider.id,
      error,
    });
    // 伪装失败不影响请求继续
  }
}
```

**特性**：
- **智能格式转换**：自动处理字符串/数组格式的 content 和 system
- **幂等性**：检查是否已存在特征，避免重复插入
- **统一客户端标识集成**：优先使用供应商配置的统一客户端 ID
- **错误容忍**：伪装失败不影响请求继续执行
- **详细日志**：记录每个伪装步骤和使用的参数

#### 修改点 B: 在格式转换后调用伪装函数（第 1138-1144 行）

**位置**：在 `doForward()` 方法中，格式转换之后、Cache TTL 处理之前

```typescript
      // ... 格式转换代码 ...
      } catch (error) {
        logger.error("ProxyForwarder: Request transformation failed", {
          from: fromFormat,
          to: toFormat,
          error,
        });
        // 转换失败时继续使用原始请求
      }
    }

    // ⭐ Claude Code 请求伪装（针对 2api 分组的非 Claude Code 请求）
    if (
      session.needsClaudeCodeDisguise &&
      (provider.providerType === "claude" || provider.providerType === "claude-auth")
    ) {
      disguiseAsClaudeCodeRequest(session.request.message, provider);
    }

    if (
      resolvedCacheTtl &&
      (provider.providerType === "claude" || provider.providerType === "claude-auth")
    ) {
      // ... Cache TTL 代码 ...
```

**关键点**：
- **执行时机**：格式转换后，确保请求体已经转换为目标格式
- **条件检查**：仅在 `needsClaudeCodeDisguise = true` 且供应商类型为 claude/claude-auth 时执行
- **不影响后续流程**：伪装后的请求继续正常的 Cache TTL、Codex 清洗等流程

---

## 四、工作流程

### 4.1 请求处理流程（更新后）

```
1. 客户端请求 → ProxyAuthenticator（认证通过）
   ↓
2. ProxyClientGuard 检查请求体参数
   ├─ 包含 Claude Code 特征 → 继续检查 User-Agent 白名单
   │   ├─ User-Agent 在白名单 → 继续（使用用户/密钥分组）
   │   └─ User-Agent 不在白名单 → 设置 forcedProviderGroup = "2api"
   │                                  needsClaudeCodeDisguise = false
   │                                  （真实 Claude Code 但 UA 不对，不需伪装）
   └─ 不包含 Claude Code 特征 → 设置 forcedProviderGroup = "2api"
                                    needsClaudeCodeDisguise = true
                                    （非 Claude Code，需要伪装）
   ↓
3. ProxyProviderResolver 选择供应商
   ├─ 检测到 forcedProviderGroup → 覆盖用户分组
   ├─ 从 "2api" 分组筛选可用供应商
   └─ 若 "2api" 分组无可用供应商 → 返回 503 错误
   ↓
4. ProxyForwarder 格式转换
   ├─ 执行格式转换（如需要）
   ├─ 检测到 needsClaudeCodeDisguise = true
   └─ 调用 disguiseAsClaudeCodeRequest() 添加 Claude Code 特征
   ↓
5. 请求转发到选定的供应商（伪装后的请求体）
```

### 4.2 决策优先级

```
第一优先级: session.forcedProviderGroup (Guard 层设置)
第二优先级: key.providerGroup (密钥级配置)
第三优先级: user.providerGroup (用户级配置)
```

---

## 五、日志追踪

### 5.1 客户端校验检测日志

**位置**：`client-guard.ts` 第 100-104 行

```
DEBUG: ProxyClientGuard: Client validation
{
  userName: "test_user",
  isClaudeCode: false,
  allowedClients: ["claude-code"]
}

INFO: ProxyClientGuard: Non-Claude Code request detected, routing to 2api
{
  userName: "test_user"
}
```

**或者（真实 Claude Code 但 UA 不对）**：

```
DEBUG: ProxyClientGuard: Client validation
{
  userName: "test_user",
  isClaudeCode: true,
  allowedClients: ["claude-code"]
}

WARN: ProxyClientGuard: Claude Code request with invalid User-Agent
{
  userName: "test_user",
  userAgent: "MyApp/1.0",
  allowedClients: ["claude-code"]
}
```

### 5.2 请求伪装执行日志

**位置**：`forwarder.ts` 第 163-257 行

```
DEBUG: ProxyForwarder: Added <system-reminder> to messages
{
  providerId: 2
}

DEBUG: ProxyForwarder: Added Claude Code identity to system
{
  providerId: 2
}

DEBUG: ProxyForwarder: Using provider unified client ID
{
  providerId: 2,
  clientIdPrefix: "a1b2c3d4e5f6789..."
}

INFO: ProxyForwarder: Added metadata.user_id for disguise
{
  providerId: 2,
  userIdPrefix: "user_a1b2c3d4e5f6789012345..."
}

INFO: ProxyForwarder: Successfully disguised request as Claude Code
{
  providerId: 2,
  providerName: "2API Provider"
}
```

**或者（使用默认客户端 ID）**：

```
DEBUG: ProxyForwarder: Using default client ID
{
  providerId: 2
}
```

---

## 六、配置示例

### 6.1 用户表配置

```json
{
  "id": 1,
  "name": "test_user",
  "allowedClients": ["claude-code", "codex"],  // 白名单
  "providerGroup": "cli"                        // 默认分组
}
```

### 6.2 供应商配置

**主供应商（cli 分组）**：

```json
{
  "id": 1,
  "name": "Primary Claude Provider",
  "providerType": "claude",
  "groupTag": "cli",              // 白名单客户端使用
  "isEnabled": true,
  "useUnifiedClientId": false     // 不需要统一客户端标识
}
```

**备用供应商（2api 分组）**：

```json
{
  "id": 2,
  "name": "Backup 2API Provider",
  "providerType": "claude",
  "groupTag": "2api",             // 非白名单客户端使用
  "isEnabled": true,
  "useUnifiedClientId": true,     // 启用统一客户端标识
  "unifiedClientId": "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456"
}
```

### 6.3 请求场景

| 客户端请求类型 | 请求体特征 | User-Agent | 路由分组 | 伪装 | 最终供应商 |
|--------------|-----------|-----------|---------|------|-----------|
| Claude Code CLI | ✅ 完整特征 | `claude-code/1.0` | `cli` (用户分组) | ❌ 不需要 | Provider #1 |
| Claude Code CLI | ✅ 完整特征 | `MyApp/1.0` | `2api` (强制分组) | ❌ 不需要 | Provider #2 |
| Postman | ❌ 无特征 | `postman/7.0` | `2api` (强制分组) | ✅ 需要 | Provider #2 |
| Curl | ❌ 无特征 | `curl/8.0` | `2api` (强制分组) | ✅ 需要 | Provider #2 |

---

## 七、错误处理

### 7.1 错误类型

| 错误类型 | HTTP 状态码 | 触发条件 | 建议操作 |
|---------|-----------|---------|---------|
| `forced_group_unavailable` | 503 | 强制分组内无可用供应商 | 检查 `2api` 分组配置 |
| `all_providers_failed` | 503 | 所有供应商尝试失败 | 检查供应商健康状态 |
| `no_available_providers` | 503 | 无任何可用供应商 | 检查供应商启用状态 |

### 7.2 典型错误响应

**强制分组无可用供应商**：

```json
{
  "type": "error",
  "error": {
    "type": "forced_group_unavailable",
    "message": "Service temporarily unavailable: No providers available in required group \"2api\""
  }
}
```

**伪装失败**（记录错误但请求继续）：

```
ERROR: ProxyForwarder: Failed to disguise request as Claude Code
{
  providerId: 2,
  error: { ... }
}
```

---

## 八、注意事项

### 8.1 必须配置 "2api" 分组

- ⚠️ 在供应商管理中必须创建至少一个 `groupTag` 包含 `2api` 的供应商
- ⚠️ 否则所有非白名单客户端请求都会失败（503 错误）

### 8.2 分组标签匹配规则

- 支持多标签逗号分隔：`groupTag: "cli,2api"` 可同时匹配两个分组
- 匹配规则：供应商标签与目标分组有任意交集即可

### 8.3 兼容性说明

- **向后兼容**：未配置 `allowedClients` 的用户不受影响
- **Fail-Safe**：强制分组失败时返回明确错误，不会静默失败
- **User-Agent 白名单仍生效**：真实 Claude Code 请求仍然检查 User-Agent

### 8.4 伪装时机

- ⚠️ **必须在格式转换之后**：确保请求体已经转换为目标格式
- ⚠️ **必须在发送请求之前**：确保不被后续逻辑覆盖
- ⚠️ **仅对 claude/claude-auth 类型**：其他类型供应商不执行伪装

### 8.5 日志安全

- ⚠️ 不要记录完整的 `user_id`，使用前缀 + "..." 形式
- ⚠️ 不要记录完整的 `unifiedClientId`，使用前缀形式

---

## 九、优势对比

| 对比项 | 原版本（User-Agent 校验） | 增强版本（请求体校验 + 伪装） |
|-------|----------------------|--------------------------|
| **校验可靠性** | 低（易伪造） | 高（三重特征校验） |
| **误判率** | 较高 | 较低 |
| **伪装能力** | 无 | 完整伪装 Claude Code 请求 |
| **统一客户端标识** | 不支持 | 支持（优先使用） |
| **日志可追踪性** | 基础 | 完整（每个步骤都有日志） |
| **错误处理** | 基础 | 完善（区分错误类型） |

---

## 十、技术亮点

### 10.1 核心改动

1. **client-guard.ts**: 新增 `isClaudeCodeRequest()` 方法，改进校验逻辑
2. **session.ts**: 新增 `needsClaudeCodeDisguise` 字段
3. **forwarder.ts**: 新增 `disguiseAsClaudeCodeRequest()` 方法，添加伪装逻辑

### 10.2 技术优势

- **最小侵入**：仅修改 3 个文件，不影响现有流程
- **优先级清晰**：强制分组 > 密钥分组 > 用户分组
- **可观测性强**：完整的日志记录和错误类型
- **易于扩展**：其他 Guard 可复用相同机制
- **向后兼容**：不影响现有功能，平滑升级

### 10.3 设计模式

- **责任链模式**：Guard 层 → Forwarder 层 → Resolver 层
- **策略模式**：根据 `needsClaudeCodeDisguise` 标记选择是否伪装
- **工厂模式**：根据供应商配置生成 `user_id`

---

## 十一、扩展场景

### 11.1 多级分流策略

可在其他 Guard 中使用相同机制实现更复杂的路由策略：

```typescript
// 示例：版本过低路由到降级分组
if (clientVersion < minVersion) {
  session.forcedProviderGroup = "legacy";
  session.needsClaudeCodeDisguise = true;
}

// 示例：特定用户路由到测试分组
if (user.isBetaTester) {
  session.forcedProviderGroup = "beta";
  session.needsClaudeCodeDisguise = false;
}
```

### 11.2 动态分组配置

建议在系统设置中添加配置项：

```typescript
{
  "clientGuard": {
    "fallbackGroup": "2api",       // 可配置的回退分组
    "enableForcedRouting": true,   // 开关控制
    "enableDisguise": true          // 伪装功能开关
  }
}
```

---

## 十二、总结

本次开发实现了从 User-Agent 头部校验到请求体参数校验的升级，并为非 Claude Code 请求提供了完整的伪装能力。通过多维度特征检测和智能伪装，显著提高了客户端校验的准确性和系统的灵活性。

核心改进包括：

1. ✅ **三重特征校验**：messages + system + metadata.user_id
2. ✅ **完整伪装能力**：自动补充所有必需的 Claude Code 特征
3. ✅ **统一客户端标识集成**：优先使用供应商配置的统一 ID
4. ✅ **智能路由**：根据请求特征自动路由到合适的供应商分组
5. ✅ **详细日志追踪**：完整记录决策过程和伪装步骤
6. ✅ **向后兼容**：不影响现有功能，平滑升级

---

**文档版本**: 2.0
**维护者**: Claude Code Hub Team
**最后更新**: 2025-01-02
