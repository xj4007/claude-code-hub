# 增强 Claude Code 客户端校验与请求伪装实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标**: 增强非 Claude Code 终端请求的识别能力，改进校验逻辑从请求头校验升级为请求体参数校验，并为路由到 2api 分组的非 Claude Code 请求添加请求体伪装，使其看起来像真实的 Claude Code 终端请求。

**架构**:
1. 改进 `ProxyClientGuard` 的校验逻辑，从单纯的 User-Agent 校验改为检查请求体中的 Claude Code 特征参数
2. 在 `ProxyForwarder` 中为被路由到 2api 分组的非 Claude Code 请求添加请求体伪装逻辑
3. 使用已有的统一客户端标识功能生成 `metadata.user_id`

**技术栈**: TypeScript, Next.js 15, Hono

---

## Task 1: 改进客户端校验逻辑 - 从请求头到请求体参数

**Files:**
- Modify: `src/app/v1/_lib/proxy/client-guard.ts:19-62`

**Step 1: 添加 Claude Code 特征检测辅助函数**

在 `ProxyClientGuard` 类中添加静态方法来检测请求体中的 Claude Code 特征：

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
    const messages = requestBody.messages as Array<Record<string, unknown>>;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return false;
    }

    const firstMessage = messages[0];
    const content = firstMessage.content as Array<Record<string, unknown>>;
    if (!content || !Array.isArray(content) || content.length === 0) {
      return false;
    }

    const firstContent = content[0];
    if (
      firstContent.type !== "text" ||
      !String(firstContent.text || "").includes("<system-reminder>")
    ) {
      return false;
    }

    // 检查 system 特征
    const system = requestBody.system as Array<Record<string, unknown>>;
    if (!system || !Array.isArray(system) || system.length === 0) {
      return false;
    }

    const firstSystem = system[0];
    if (
      firstSystem.type !== "text" ||
      !String(firstSystem.text || "").includes(
        "You are Claude Code, Anthropic's official CLI for Claude."
      )
    ) {
      return false;
    }

    // 检查 metadata.user_id 格式
    const metadata = requestBody.metadata as Record<string, unknown>;
    if (metadata && metadata.user_id) {
      const userId = String(metadata.user_id);
      const pattern = /^user_[a-f0-9]{64}_account__session_[a-f0-9-]{36}$/;
      return pattern.test(userId);
    }

    // 即使没有 user_id，前两个特征也足够判断
    return true;
  } catch (error) {
    logger.debug("ProxyClientGuard: Failed to detect Claude Code request", { error });
    return false;
  }
}
```

**Step 2: 修改 ensure 方法使用新的校验逻辑**

替换现有的 User-Agent 校验逻辑：

```typescript
static async ensure(session: ProxySession): Promise<Response | null> {
  const user = session.authState?.user;
  if (!user) {
    // No user context - skip check (authentication should have failed already)
    return null;
  }

  // Check if client restrictions are configured
  const allowedClients = user.allowedClients ?? [];
  if (allowedClients.length === 0) {
    // No restrictions configured - skip all checks
    return null;
  }

  // 检查请求体是否包含 Claude Code 特征
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
    // 标记此请求需要伪装（在 forwarder 中使用）
    session.needsClaudeCodeDisguise = true;

    return null; // Continue pipeline with forced routing
  }

  // Claude Code 请求 - 检查是否在白名单中
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
    // 已经是 Claude Code 格式，不需要伪装
    session.needsClaudeCodeDisguise = false;

    return null;
  }

  // Client is allowed
  return null;
}
```

**Step 3: 在 ProxySession 中添加伪装标记字段**

修改 `src/app/v1/_lib/proxy/session.ts`，在 `forcedProviderGroup` 字段后添加：

```typescript
// 标记此请求是否需要 Claude Code 伪装（用于 2api 分组）
needsClaudeCodeDisguise?: boolean;
```

**Step 4: 提交 Task 1**

```bash
git add src/app/v1/_lib/proxy/client-guard.ts src/app/v1/_lib/proxy/session.ts
git commit -m "feat: enhance client validation from User-Agent to request body parameters"
```

---

## Task 2: 实现请求体伪装逻辑

**Files:**
- Modify: `src/app/v1/_lib/proxy/forwarder.ts:980-1062`

**Step 1: 添加 Claude Code 请求体伪装辅助函数**

在 `ProxyForwarder` 类中添加静态私有方法：

```typescript
/**
 * 为非 Claude Code 请求添加 Claude Code 特征
 *
 * 伪装内容：
 * 1. messages 第一个元素的 content 数组开头插入 <system-reminder>
 * 2. system 数组开头插入 Claude Code 标识
 * 3. 添加 metadata.user_id（使用统一客户端标识或固定值）
 */
private static disguiseAsClaudeCodeRequest(
  body: Record<string, unknown>,
  provider: Provider
): void {
  try {
    // 1. 处理 messages - 在第一个 content 数组开头插入 <system-reminder>
    const messages = body.messages as Array<Record<string, unknown>>;
    if (messages && Array.isArray(messages) && messages.length > 0) {
      const firstMessage = messages[0];
      let content = firstMessage.content;

      // 如果 content 是字符串，转换为数组格式
      if (typeof content === "string") {
        content = [
          {
            type: "text",
            text: content,
          },
        ];
        firstMessage.content = content;
      }

      // 确保 content 是数组
      if (Array.isArray(content)) {
        // 检查是否已经有 <system-reminder>
        const hasSystemReminder = content.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "text" &&
            "text" in item &&
            String(item.text || "").includes("<system-reminder>")
        );

        if (!hasSystemReminder) {
          // 在开头插入 <system-reminder>
          content.unshift({
            type: "text",
            text: "<system-reminder></system-reminder>",
          });

          logger.debug("ProxyForwarder: Added <system-reminder> to messages", {
            providerId: provider.id,
          });
        }
      }
    }

    // 2. 处理 system - 在开头插入 Claude Code 标识
    let system = body.system;

    // 如果 system 是字符串，转换为数组格式
    if (typeof system === "string") {
      system = [
        {
          type: "text",
          text: system,
        },
      ];
      body.system = system;
    }

    // 如果 system 不存在，创建数组
    if (!system) {
      system = [];
      body.system = system;
    }

    // 确保 system 是数组
    if (Array.isArray(system)) {
      // 检查是否已经有 Claude Code 标识
      const hasClaudeCodeIdentity = system.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          String(item.text || "").includes(
            "You are Claude Code, Anthropic's official CLI for Claude."
          )
      );

      if (!hasClaudeCodeIdentity) {
        // 在开头插入 Claude Code 标识
        system.unshift({
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        });

        logger.debug("ProxyForwarder: Added Claude Code identity to system", {
          providerId: provider.id,
        });
      }
    }

    // 3. 处理 metadata.user_id
    let metadata = body.metadata as Record<string, unknown> | undefined;
    if (!metadata) {
      metadata = {};
      body.metadata = metadata;
    }

    if (!metadata.user_id) {
      // 生成 user_id：优先使用供应商的统一客户端标识
      let clientId: string;

      if (provider.useUnifiedClientId && provider.unifiedClientId) {
        clientId = provider.unifiedClientId;
        logger.debug("ProxyForwarder: Using provider unified client ID", {
          providerId: provider.id,
          clientIdPrefix: clientId.substring(0, 16) + "...",
        });
      } else {
        // 使用固定默认值
        clientId =
          "161cf9dec4f981e08a0d7971fa065ca51550a8eb87be857651ae40a20dd9a5ed";
        logger.debug("ProxyForwarder: Using default client ID", {
          providerId: provider.id,
        });
      }

      // 生成随机 session UUID
      const sessionUuid = crypto.randomUUID();

      metadata.user_id = `user_${clientId}_account__session_${sessionUuid}`;

      logger.info("ProxyForwarder: Added metadata.user_id for disguise", {
        providerId: provider.id,
        userIdPrefix: String(metadata.user_id).substring(0, 30) + "...",
      });
    }

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

**Step 2: 在格式转换后调用伪装函数**

在 `doForward` 方法中，格式转换逻辑之后、构建请求头之前调用伪装函数。

找到约 980 行附近的格式转换代码块，在其后添加伪装逻辑：

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
      ProxyForwarder.disguiseAsClaudeCodeRequest(session.request.message, provider);
    }

    if (
      resolvedCacheTtl &&
      (provider.providerType === "claude" || provider.providerType === "claude-auth")
    ) {
      // ... Cache TTL 代码 ...
```

**Step 3: 提交 Task 2**

```bash
git add src/app/v1/_lib/proxy/forwarder.ts
git commit -m "feat: add Claude Code request disguise for 2api group routing"
```

---

## Task 3: 测试与验证

**Files:**
- Test: Manual testing via API requests

**Step 1: 准备测试环境**

启动开发服务器：

```bash
bun run dev
```

**Step 2: 测试场景 1 - 真实 Claude Code 请求（应通过）**

发送包含完整 Claude Code 特征的请求：

```bash
curl -X POST http://localhost:23000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-test-key" \
  -H "User-Agent: claude-code/1.0" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [{
      "role": "user",
      "content": [{
        "type": "text",
        "text": "<system-reminder></system-reminder>"
      }, {
        "type": "text",
        "text": "hi"
      }]
    }],
    "system": [{
      "type": "text",
      "text": "You are Claude Code, Anthropic'\''s official CLI for Claude."
    }],
    "metadata": {
      "user_id": "user_a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456_account__session_550e8400-e29b-41d4-a716-446655440000"
    },
    "max_tokens": 1024
  }'
```

预期结果：请求正常路由到用户配置的分组，日志显示 "Client validation: isClaudeCode=true"

**Step 3: 测试场景 2 - 非 Claude Code 请求（应路由到 2api 并伪装）**

发送普通请求（缺少 Claude Code 特征）：

```bash
curl -X POST http://localhost:23000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-test-key" \
  -H "User-Agent: MyApp/1.0" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "messages": [{
      "role": "user",
      "content": "Hello, how are you?"
    }],
    "max_tokens": 1024
  }'
```

预期结果：
1. 日志显示 "Non-Claude Code request detected, routing to 2api"
2. 日志显示 "Successfully disguised request as Claude Code"
3. 请求成功转发到 2api 分组的供应商

**Step 4: 检查日志输出**

查看日志确认以下内容：

```bash
# 检查客户端校验日志
grep "ProxyClientGuard" logs/app.log | tail -20

# 检查请求伪装日志
grep "disguised request as Claude Code" logs/app.log | tail -10
```

**Step 5: 测试场景 3 - 已有统一客户端标识的供应商**

1. 在后台创建一个 Claude 类型供应商
2. 启用"使用统一的客户端标识"并生成 ID
3. 将此供应商加入 2api 分组
4. 发送非 Claude Code 请求，查看日志确认使用了供应商的统一客户端 ID

预期结果：日志显示 "Using provider unified client ID"

**Step 6: 提交 Task 3**

```bash
# 测试通过后记录测试结果
echo "✅ Task 3 测试完成：
- 真实 Claude Code 请求正常路由
- 非 Claude Code 请求成功路由到 2api 并伪装
- 统一客户端标识功能正常工作
" > docs/plans/test-results-2025-01-02.txt

git add docs/plans/test-results-2025-01-02.txt
git commit -m "test: verify enhanced Claude Code validation and disguise"
```

---

## Task 4: 文档更新

**Files:**
- Modify: `docs/my-changes/client-guard-forced-routing-feature.md`

**Step 1: 更新功能文档**

在原有文档末尾添加新的章节：

```markdown

---

## 十一、增强版本：请求体参数校验与伪装（2025-01-02 更新）

### 11.1 背景

原版本仅通过 User-Agent 校验客户端类型，存在以下问题：
- User-Agent 易伪造，无法真正区分 Claude Code 终端
- 缺少请求体特征校验，误判率较高

### 11.2 改进内容

#### 11.2.1 校验逻辑升级

从 User-Agent 头部校验升级为**请求体参数校验**，检测以下 Claude Code 特征：

1. **messages 特征**：第一个 message 的 content 数组第一项包含 `<system-reminder></system-reminder>`
2. **system 特征**：system 数组第一项包含 `You are Claude Code, Anthropic's official CLI for Claude.`
3. **metadata 特征**：`metadata.user_id` 格式符合 `user_{64位十六进制}_account__session_{uuid}`

#### 11.2.2 请求体伪装功能

对被路由到 2api 分组的非 Claude Code 请求，自动添加以下伪装：

1. **messages 伪装**：在第一个 content 数组开头插入 `<system-reminder></system-reminder>`
2. **system 伪装**：在 system 数组开头插入 Claude Code 标识
3. **metadata 伪装**：生成符合格式的 `user_id`
   - 优先使用供应商的"统一客户端标识"（如已配置）
   - 否则使用固定默认值

### 11.3 工作流程（更新后）

```
1. 客户端请求 → ProxyAuthenticator（认证通过）
   ↓
2. ProxyClientGuard 检查请求体参数
   ├─ 包含 Claude Code 特征 → 继续检查 User-Agent 白名单
   │   ├─ User-Agent 在白名单 → 继续（使用用户/密钥分组）
   │   └─ User-Agent 不在白名单 → 设置 forcedProviderGroup = "2api"，needsClaudeCodeDisguise = false
   └─ 不包含 Claude Code 特征 → 设置 forcedProviderGroup = "2api"，needsClaudeCodeDisguise = true
   ↓
3. ProxyForwarder 格式转换后
   ├─ 检测到 needsClaudeCodeDisguise = true
   └─ 调用 disguiseAsClaudeCodeRequest() 添加 Claude Code 特征
   ↓
4. ProxyProviderResolver 选择供应商
   ├─ 检测到 forcedProviderGroup → 覆盖用户分组
   ├─ 从 "2api" 分组筛选可用供应商
   └─ 若 "2api" 分组无可用供应商 → 返回 503 错误
   ↓
5. 请求转发到选定的供应商（伪装后的请求体）
```

### 11.4 涉及文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/app/v1/_lib/proxy/client-guard.ts` | 修改 | 新增 `isClaudeCodeRequest()` 方法，改进校验逻辑 |
| `src/app/v1/_lib/proxy/session.ts` | 修改 | 新增 `needsClaudeCodeDisguise` 字段 |
| `src/app/v1/_lib/proxy/forwarder.ts` | 修改 | 新增 `disguiseAsClaudeCodeRequest()` 方法，添加伪装逻辑 |

### 11.5 日志追踪（新增）

**1. 客户端校验检测**（client-guard.ts）
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

**2. 请求伪装执行**（forwarder.ts）
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

### 11.6 优势对比

| 对比项 | 原版本（User-Agent 校验） | 增强版本（请求体校验） |
|-------|----------------------|---------------------|
| 校验可靠性 | 低（易伪造） | 高（多重特征） |
| 误判率 | 较高 | 较低 |
| 伪装能力 | 无 | 完整伪装 Claude Code 请求 |
| 统一客户端标识 | 不支持 | 支持（优先使用） |

---

**文档版本**: 2.0
**最后更新**: 2025-01-02
```

**Step 2: 提交文档更新**

```bash
git add docs/my-changes/client-guard-forced-routing-feature.md
git commit -m "docs: update client guard feature documentation with enhanced validation"
```

---

## 验证清单

完成所有任务后，确认以下内容：

- [ ] `ProxyClientGuard.isClaudeCodeRequest()` 正确检测 Claude Code 特征
- [ ] 非 Claude Code 请求被正确标记 `needsClaudeCodeDisguise = true`
- [ ] `ProxyForwarder.disguiseAsClaudeCodeRequest()` 正确添加伪装内容
- [ ] 伪装后的请求包含完整的 Claude Code 特征（messages、system、metadata）
- [ ] 优先使用供应商的统一客户端标识（如已配置）
- [ ] 所有日志输出清晰可追踪
- [ ] TypeScript 编译通过（`bun run typecheck`）
- [ ] 代码格式检查通过（`bun run lint`）
- [ ] 文档已更新

---

## 注意事项

1. **伪装时机**：必须在格式转换之后、发送请求之前执行，确保不被后续逻辑覆盖
2. **provider 类型限制**：仅对 `claude` 和 `claude-auth` 类型供应商执行伪装
3. **错误容忍**：伪装失败不应中断请求，记录错误日志后继续
4. **user_id 格式**：必须严格符合 `user_{64位十六进制}_account__session_{uuid}` 格式
5. **日志安全**：不要记录完整的 user_id，使用前缀 + "..." 形式
6. **向后兼容**：确保已有的 User-Agent 白名单功能仍然有效（针对真实 Claude Code 请求）
