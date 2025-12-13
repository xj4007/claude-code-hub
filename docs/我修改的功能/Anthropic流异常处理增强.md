# Anthropic 流异常处理增强（2025-12-09）

## 背景
- Anthropic 流式请求在上游未返回终止包（`message_stop` / `[DONE]`）或长时间仅心跳时，代理仍以 HTTP 200 结束，客户端误判为成功并提示扣费。
- 需要让客户端收到明确的失败信号，同时将请求标记失败并触发熔断，避免计费和成功状态。

## 改动范围
- 文件：`src/app/v1/_lib/proxy/response-handler.ts`
- 仅作用于 `providerType = claude | claude-auth` 的流式请求。

## 核心改进
- **终止包缺失判定**：读取完流后检查是否收到终止事件；缺失则：
  - 发送 SSE `event: error`，payload `{type:"error", error:{code:"stream_incomplete", status:502, message}}`
  - `streamController.error(...)` 关闭客户端流，持久化失败、计入熔断（502），跳过计费/成功标记。
- **总时长保护**：首块到达即启动 180s 计时；超时则：
  - 发送 SSE `event: error`（code `stream_total_timeout`，status 504），错误关闭流，持久化失败并熔断。
- **终止标记跟踪**：逐 chunk 检测 `message_stop` / `[DONE]`，用于完成判定和日志。
- **日志增强**：记录 `chunksCollected`、`lastChunkPreview`，便于排查。

## 客户端影响（针对 new-api）
- 流内收到 `event: error` 或 reader 抛错时应走异常分支，不计费、不记成功日志（已有逻辑可直接利用）。
- 无需改动 new-api 代码；依赖于本次代理输出的错误事件。

## 验证建议
1) 模拟 Anthropic 心跳后不收尾包：应收到 SSE error，new-api 记失败、不扣费，供应商熔断计数+1。
2) 模拟长时间仅 ping 超 180s：同上，status=504。
3) 正常完成：收到终止包，正常计费，日志显示 hasTerminalChunk=true。

## 已知限制
- 仍保持使用 usage 解析结果；若上游完全无 usage，将跳过成本更新（与旧逻辑一致）。
- 其他供应商（OpenAI/Gemini 等）不受影响。

## 代码触点（便于回溯）
- `src/app/v1/_lib/proxy/response-handler.ts:707` 首块流读入位置，新增 Anthropic 终止标记/总时长跟踪变量。
- `src/app/v1/_lib/proxy/response-handler.ts:725` `startTotalTimer` 180s 总时长 watchdog，超时发 SSE error（504）并熔断。
- `src/app/v1/_lib/proxy/response-handler.ts:735` `emitClientStreamError` 将错误作为 `event: error` 推送给客户端。
- `src/app/v1/_lib/proxy/response-handler.ts:945` `detectAnthropicTerminalChunk` 识别终止事件（`message_stop` / `[DONE]`）。
- `src/app/v1/_lib/proxy/response-handler.ts:985` 流结束若无终止包，发 SSE error（502）、熔断并持久化失败，跳过计费。
- `src/app/v1/_lib/proxy/response-handler.ts:993` `summarizeChunkForLog` 截断最后一包用于日志。
