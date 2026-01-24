# 模拟缓存功能总结文档

> **创建时间**: 2026-01-24
> **功能版本**: v4.1
> **开发依据**: `docs/plans/simulate-cache-implementation-plan-simple.md`

---

## 📋 功能概述

### 核心目标
在 Claude Code Hub 中实现 Claude API 兼容的"模拟缓存" usage 字段注入功能，确保下游客户端能够获得完整的缓存字段信息，用于计费展示和统计分析。

### 关键特性
- ✅ **计费隔离**：模拟缓存不影响本项目的真实成本计算
- ✅ **智能识别**：自动识别主代理和子代理请求，子代理不模拟缓存
- ✅ **会话缓存**：基于 Redis 存储上一次请求的 token 状态
- ✅ **增量拆分**：根据上游返回的 `usage.input_tokens` 进行智能拆分
- ✅ **完整字段**：生成符合 Claude API 规范的完整缓存字段结构

---

## 🏗️ 架构设计

### 核心模块

```
src/lib/cache/
├── cache-simulator.ts      # 核心模拟逻辑
└── cache-signals.ts         # 请求特征识别

src/app/v1/_lib/proxy/
└── response-handler.ts      # 响应处理集成

src/drizzle/
└── schema.ts                # 数据库 schema 扩展

src/types/
└── provider.ts              # 类型定义扩展
```

### 数据流程

```
客户端请求
    ↓
[1] 请求特征提取 (cache-signals.ts)
    ├─ 检测 <system-reminder> 标签
    ├─ 检测标题提示词
    ├─ 检测 assistant brace
    └─ 识别模型类型
    ↓
[2] 上游 API 调用
    ↓
[3] 获取真实 usage (input_tokens, output_tokens)
    ↓
[4] 判断是否模拟缓存
    ├─ 检查 provider.simulate_cache_enabled
    ├─ 检查是否为子代理
    └─ 生成会话键 (metadata.user_id)
    ↓
[5] 计算模拟 usage (cache-simulator.ts)
    ├─ 首次请求：估算最后 user 消息 token
    ├─ 增量请求：拆分 delta 为 input + cache_creation
    ├─ 压缩场景：current < last 时特殊处理
    └─ 更新 Redis 缓存状态
    ↓
[6] 响应输出
    ├─ 数据库存储：模拟 usage 字段
    ├─ 成本计算：使用真实 usage
    └─ 客户端响应：返回模拟 usage
```

---

## 🔧 实现细节

### 1. 数据库扩展

**providers 表新增字段**：
```sql
ALTER TABLE providers
  ADD COLUMN simulate_cache_enabled boolean NOT NULL DEFAULT false;
```

**字段说明**：
- `simulate_cache_enabled`: 是否对该供应商启用模拟缓存注入
- 默认值：`false`（需手动开启）
- 仅影响响应 usage，不影响成本计算

### 2. 请求特征识别 (cache-signals.ts)

**识别维度**：

| 特征 | 说明 | 用途 |
|------|------|------|
| `hasSystemReminder` | 包含非空 `<system-reminder>` 标签 | 主代理标识 |
| `hasEmptySystemReminder` | 包含空 `<system-reminder>` 标签 | 子代理标识 |
| `hasTitlePrompt` | 包含 "Please write a 5-10 word title" | 子代理标识 |
| `hasAssistantBrace` | 最后 assistant 消息为 `{` | 子代理标识 |
| `modelFamily` | haiku/sonnet/opus/other | 模型类型 |
| `isDisguised` | 是否需要伪装为 CLI | 伪装标识 |

**子代理判定规则**：
```typescript
// 满足任一条件即为子代理（不模拟缓存）
const isSubAgent =
  signals.hasTitlePrompt ||           // 标题提示词
  signals.hasAssistantBrace ||        // assistant brace
  signals.hasEmptySystemReminder;     // 空 system-reminder
```

**会话键生成**：
```typescript
// 仅使用 metadata.user_id（不回退 sessionId）
function resolveCacheSessionKey(request: Record<string, unknown>): string | null {
  const metadata = request.metadata;
  return metadata?.user_id || null;
}
```

### 3. 缓存模拟算法 (cache-simulator.ts)

#### 核心常量
```typescript
const MIN_CACHE_CREATION = 50;        // 最小缓存创建 token 数
const SESSION_TTL_SECONDS = 300;      // 会话缓存 TTL（5分钟）
const LAST_INPUT_KEY_PREFIX = "cache:sim:last_input";
```

#### Redis 存储结构
```typescript
// Key: cache:sim:last_input:{user_id}
// Value: JSON
{
  "input_tokens": 1000,                    // 上次请求的 input_tokens
  "cache_creation_input_tokens": 950,      // 上次累计的 cache_creation
  "updatedAt": 1706083200000               // 更新时间戳
}
// TTL: 300 秒
```

#### 算法流程

**场景 1：首次请求（无历史状态）**
```typescript
// 输入：
upstreamUsage = { input_tokens: 1000, output_tokens: 50 }
lastState = null

// 计算：
userTokens = countLastUserTextTokens(request)  // 估算最后 user 消息：100
cacheCreation = 1000 - 100 = 900

// 输出：
{
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 900,
  cache_creation_5m_input_tokens: 900,
  cache_creation_1h_input_tokens: 0,
  cache_creation: {
    ephemeral_5m_input_tokens: 900,
    ephemeral_1h_input_tokens: 0
  }
}

// Redis 存储：
{ input_tokens: 1000, cache_creation_input_tokens: 900 }
```

**场景 2：正常增量请求（current >= last）**
```typescript
// 输入：
upstreamUsage = { input_tokens: 1150, output_tokens: 60 }
lastState = { lastCacheCreationTokens: 900 }

// 计算：
delta = 1150 - 900 = 250
// 随机拆分（保证 cache_creation >= 50）
cacheCreation = randomInt(50, 250)  // 假设 = 120
inputTokens = 250 - 120 = 130

// 输出：
{
  input_tokens: 130,
  output_tokens: 60,
  cache_read_input_tokens: 900,      // 上次的 cache_creation
  cache_creation_input_tokens: 120,
  cache_creation_5m_input_tokens: 120,
  cache_creation_1h_input_tokens: 0,
  cache_creation: {
    ephemeral_5m_input_tokens: 120,
    ephemeral_1h_input_tokens: 0
  }
}

// Redis 更新：
{ input_tokens: 1150, cache_creation_input_tokens: 1020 }  // 900 + 120
```

**场景 3：压缩场景（current < last）**
```typescript
// 输入：
upstreamUsage = { input_tokens: 800, output_tokens: 40 }
lastState = { lastCacheCreationTokens: 1020 }

// 计算：
cacheCreation = floor(800 * 0.1) = 80
cacheRead = 800 - 80 = 720

// 输出：
{
  input_tokens: 0,                   // 压缩场景不计新 input
  output_tokens: 40,
  cache_read_input_tokens: 720,
  cache_creation_input_tokens: 80,
  cache_creation_5m_input_tokens: 80,
  cache_creation_1h_input_tokens: 0,
  cache_creation: {
    ephemeral_5m_input_tokens: 80,
    ephemeral_1h_input_tokens: 0
  }
}

// Redis 更新：
{ input_tokens: 800, cache_creation_input_tokens: 800 }  // 720 + 80
```

**场景 4：delta < 50（全部归入 cache_creation）**
```typescript
// 输入：
upstreamUsage = { input_tokens: 930, output_tokens: 45 }
lastState = { lastCacheCreationTokens: 900 }

// 计算：
delta = 930 - 900 = 30  // < MIN_CACHE_CREATION

// 输出：
{
  input_tokens: 0,                   // delta 太小，全部归入 cache_creation
  output_tokens: 45,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 30,
  cache_creation_5m_input_tokens: 30,
  cache_creation_1h_input_tokens: 0,
  cache_creation: {
    ephemeral_5m_input_tokens: 30,
    ephemeral_1h_input_tokens: 0
  }
}

// Redis 更新：
{ input_tokens: 930, cache_creation_input_tokens: 930 }
```

#### Token 估算方法
```typescript
// 仅计算最后一个 role: "user" 的 text 块
function countLastUserTextTokens(request: Record<string, unknown>): number {
  // 1. 找到最后一个 user 消息
  // 2. 提取所有 text 块（支持 string 和 content array）
  // 3. 计算总字符长度
  // 4. 估算：tokens ≈ length / 4
  return Math.ceil(textLength / 4);
}
```

### 4. 响应处理集成 (response-handler.ts)

**非流式响应**：
```typescript
// 1. 提取真实 usage
const realUsage = await response.json();

// 2. 提取请求特征（伪装前）
const cacheSignals = extractCacheSignals(request, session);
const sessionKey = resolveCacheSessionKey(request);

// 3. 计算模拟 usage
let finalUsage = realUsage.usage;
if (provider.simulateCacheEnabled) {
  const simulated = await CacheSimulator.calculate(
    request,
    sessionKey,
    session,
    realUsage.usage,
    cacheSignals
  );
  if (simulated) {
    finalUsage = simulated;  // 使用模拟 usage
  }
}

// 4. 数据库存储（模拟字段）+ 成本计算（真实 usage）
await updateMessageRequestDetails({
  ...finalUsage,  // 存储模拟字段
  cost_usd: calculateCost(realUsage.usage)  // 真实成本
});

// 5. 响应输出（模拟 usage）
return new Response(JSON.stringify({
  ...realUsage,
  usage: finalUsage
}));
```

**流式响应（SSE）**：
```typescript
// 在 message_start 和 message_delta 事件中注入模拟 usage
const transformedStream = originalStream.pipeThrough(
  new TransformStream({
    async transform(chunk, controller) {
      const event = parseSSEData(chunk);

      if (event.type === 'message_start' || event.type === 'message_delta') {
        // 注入模拟 usage
        if (simulatedUsage) {
          event.usage = simulatedUsage;
        }
      }

      controller.enqueue(formatSSE(event));
    }
  })
);
```

---

## 📊 示例数据

### 示例 1：完整会话流程

**请求 1（首次）**：
```json
// 客户端请求
{
  "model": "claude-sonnet-4-20250212",
  "messages": [
    {
      "role": "user",
      "content": "请帮我写一个 Python 函数计算斐波那契数列"
    }
  ],
  "metadata": {
    "user_id": "user_alice"
  }
}

// 上游返回（真实）
{
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 350
  }
}

// 模拟计算
// - 最后 user 消息估算：25 tokens（100 字符 / 4）
// - cache_creation = 1200 - 25 = 1175

// 客户端收到（模拟）
{
  "usage": {
    "input_tokens": 25,
    "output_tokens": 350,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 1175,
    "cache_creation_5m_input_tokens": 1175,
    "cache_creation_1h_input_tokens": 0,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 1175,
      "ephemeral_1h_input_tokens": 0
    }
  }
}

// Redis 存储
// Key: cache:sim:last_input:user_alice
{
  "input_tokens": 1200,
  "cache_creation_input_tokens": 1175,
  "updatedAt": 1706083200000
}
```

**请求 2（增量）**：
```json
// 客户端请求
{
  "model": "claude-sonnet-4-20250212",
  "messages": [
    {
      "role": "user",
      "content": "请帮我写一个 Python 函数计算斐波那契数列"
    },
    {
      "role": "assistant",
      "content": "好的，我来帮你写一个..."
    },
    {
      "role": "user",
      "content": "请添加单元测试"
    }
  ],
  "metadata": {
    "user_id": "user_alice"
  }
}

// 上游返回（真实）
{
  "usage": {
    "input_tokens": 1580,
    "output_tokens": 420
  }
}

// 模拟计算
// - delta = 1580 - 1175 = 405
// - 随机拆分：cache_creation = 180, input = 225

// 客户端收到（模拟）
{
  "usage": {
    "input_tokens": 225,
    "output_tokens": 420,
    "cache_read_input_tokens": 1175,
    "cache_creation_input_tokens": 180,
    "cache_creation_5m_input_tokens": 180,
    "cache_creation_1h_input_tokens": 0,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 180,
      "ephemeral_1h_input_tokens": 0
    }
  }
}

// Redis 更新
{
  "input_tokens": 1580,
  "cache_creation_input_tokens": 1355,  // 1175 + 180
  "updatedAt": 1706083260000
}
```

**请求 3（压缩场景）**：
```json
// 客户端请求（上下文被压缩）
{
  "model": "claude-sonnet-4-20250212",
  "messages": [
    {
      "role": "user",
      "content": "总结一下我们的对话"
    }
  ],
  "metadata": {
    "user_id": "user_alice"
  }
}

// 上游返回（真实）
{
  "usage": {
    "input_tokens": 800,  // < 上次的 1355
    "output_tokens": 150
  }
}

// 模拟计算（压缩场景）
// - cache_creation = floor(800 * 0.1) = 80
// - cache_read = 800 - 80 = 720

// 客户端收到（模拟）
{
  "usage": {
    "input_tokens": 0,
    "output_tokens": 150,
    "cache_read_input_tokens": 720,
    "cache_creation_input_tokens": 80,
    "cache_creation_5m_input_tokens": 80,
    "cache_creation_1h_input_tokens": 0,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 80,
      "ephemeral_1h_input_tokens": 0
    }
  }
}

// Redis 更新
{
  "input_tokens": 800,
  "cache_creation_input_tokens": 800,
  "updatedAt": 1706083320000
}
```

### 示例 2：子代理请求（不模拟）

**子代理请求（标题生成）**：
```json
// 客户端请求
{
  "model": "claude-haiku-4-20250116",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Please write a 5-10 word title for this conversation"
        }
      ]
    }
  ],
  "metadata": {
    "user_id": "user_bob"
  }
}

// 特征识别
{
  "hasSystemReminder": false,
  "hasEmptySystemReminder": false,
  "hasTitlePrompt": true,           // ✓ 子代理标识
  "hasAssistantBrace": false,
  "modelFamily": "haiku",
  "isDisguised": false
}

// 判定：子代理，不模拟缓存

// 上游返回（真实）
{
  "usage": {
    "input_tokens": 50,
    "output_tokens": 10
  }
}

// 客户端收到（原样透传）
{
  "usage": {
    "input_tokens": 50,
    "output_tokens": 10
  }
}

// Redis：不存储
```

### 示例 3：多用户隔离

**用户 A 的会话**：
```json
// Redis Key: cache:sim:last_input:user_alice
{
  "input_tokens": 1580,
  "cache_creation_input_tokens": 1355,
  "updatedAt": 1706083260000
}
```

**用户 B 的会话**：
```json
// Redis Key: cache:sim:last_input:user_bob
{
  "input_tokens": 2200,
  "cache_creation_input_tokens": 2100,
  "updatedAt": 1706083280000
}
```

**隔离保证**：
- 不同 `user_id` 使用不同的 Redis Key
- 会话状态完全独立，互不影响
- TTL 独立计时（300 秒）

---

## 🎯 关键决策点

### 1. 为什么不使用前缀哈希匹配？
**原因**：
- 前缀哈希需要完整 tokenize 所有消息，计算成本高
- 消息顺序变化会导致哈希失效
- 上游 `input_tokens` 已经包含了所有信息

**方案**：
- 直接使用上游 `usage.input_tokens` 做增量拆分
- 首次请求估算最后 user 消息 token
- 后续请求基于 delta 拆分

### 2. 为什么会话键只用 user_id？
**原因**：
- `sessionId` 是平台内部标识，不稳定
- `user_id` 是客户端提供的稳定标识
- 符合 Claude API 的缓存语义（同一用户的上下文）

**方案**：
- 仅使用 `metadata.user_id` 作为会话键
- 无 `user_id` 时不模拟缓存（返回 null）

### 3. 为什么子代理不模拟缓存？
**原因**：
- 子代理是平台内部调用（如标题生成、工具调用）
- 这些请求不应该影响用户的缓存状态
- 保持上游 usage 原样，避免混淆

**识别规则**：
- 标题提示词：`"Please write a 5-10 word title"`
- Assistant brace：最后 assistant 消息为 `{`
- 空 system-reminder：`<system-reminder></system-reminder>`

### 4. 为什么压缩场景特殊处理？
**原因**：
- `current < last` 表示上下文被压缩或重置
- 无法用增量逻辑处理（delta 为负）
- 需要重新建立缓存基线

**方案**：
- 10% 作为 cache_creation（重建缓存）
- 90% 作为 cache_read（复用部分上下文）
- `input_tokens` 置 0（无新增输入）

---

## 🧪 测试覆盖

### 单元测试 (cache-simulator.test.ts)

| 测试场景 | 验证点 |
|---------|--------|
| 首次请求 | 使用最后 user 文本估算 input_tokens |
| 增量请求 | delta 正确拆分为 input + cache_creation |
| delta < 50 | 全部归入 cache_creation |
| 压缩场景 | current < last 时特殊处理 |
| 会话隔离 | 不同 sessionKey 不互串 |
| Redis 失败 | 降级为不模拟（返回 null） |
| 子代理识别 | 标题提示词不模拟 |
| 子代理识别 | assistant brace 不模拟 |

### 集成测试

| 测试场景 | 验证点 |
|---------|--------|
| 非流式响应 | usage 字段完整，数据库存储正确 |
| 流式响应 | message_start 和 message_delta 包含模拟 usage |
| 计费隔离 | cost_usd 基于真实 usage |
| 供应商开关 | simulate_cache_enabled=false 时不模拟 |

---

## ⚠️ 注意事项

### 1. 计费隔离
- ✅ **数据库存储**：模拟 usage 字段（用于展示）
- ✅ **成本计算**：真实 usage（用于计费）
- ✅ **响应输出**：模拟 usage（客户端看到）

### 2. Redis 依赖
- Redis 不可用时自动降级（不模拟缓存）
- 不影响请求正常处理
- 日志记录降级事件

### 3. 误差范围
- Token 估算基于 `length / 4`，误差 5-15%
- 随机拆分保证 `cache_creation >= 50`
- 不要求完全可复现（每次拆分可能不同）

### 4. TTL 管理
- 会话缓存 TTL：300 秒（与 SESSION_TTL 一致）
- 超时后自动清理，下次请求视为首次
- 符合 Claude 5m 缓存语义

### 5. 伪装请求
- 伪装请求（`needsClaudeDisguise=true`）不使用 `<system-reminder>` 规则
- 避免伪装注入后误判为主代理
- 仍然检查其他子代理特征（标题提示词、assistant brace）

---

## 🔄 回滚方案

### 快速关闭
1. 在供应商管理页面关闭 `simulate_cache_enabled` 开关
2. 立即生效，不影响已有请求

### 完全回滚
1. 数据库迁移回滚：
   ```sql
   ALTER TABLE providers DROP COLUMN simulate_cache_enabled;
   ```
2. 删除相关代码文件：
   - `src/lib/cache/cache-simulator.ts`
   - `src/lib/cache/cache-signals.ts`
3. 恢复 `response-handler.ts` 的修改

---

## 📚 相关文档

- **实施计划**：`docs/plans/simulate-cache-implementation-plan-simple.md`
- **数据库迁移**：`drizzle/0055_noisy_squadron_sinister.sql`
- **单元测试**：`tests/unit/lib/cache/cache-simulator.test.ts`
- **类型定义**：`src/types/provider.ts`

---

## 🎓 学习要点

### 核心算法理解
1. **首次请求**：估算最后 user 消息 → 剩余归入 cache_creation
2. **增量请求**：delta 拆分 → cache_read 使用上次 cache_creation
3. **压缩场景**：10% cache_creation + 90% cache_read
4. **子代理识别**：特征匹配 → 不模拟缓存

### Redis 存储策略
- Key 格式：`cache:sim:last_input:{user_id}`
- Value 格式：`{ input_tokens, cache_creation_input_tokens, updatedAt }`
- TTL：300 秒（自动过期）

### 计费隔离原则
- **存储**：模拟字段（展示用）
- **计算**：真实 usage（计费用）
- **响应**：模拟 usage（客户端用）

---

**文档维护者**: Claude Code Hub Team
**最后更新**: 2026-01-24
