# cc-haha E1 相拆解：查询循环（心脏）

> **本文定位**：Koda 自研执行引擎的设计输入调研。E1 是 9 相拆解（E0–E8）的第二相，拆**查询循环的运行逻辑**：谁驱动一轮对话、状态如何跨迭代传递、流式模型调用如何与工具执行咬合、错误如何被 withhold 再恢复、循环何时终止。
>
> **拆解对象**：`/Users/waybi/Desktop/my/cc-haha` —— 同上游 E0。
>
> **证据分级**（与 E0 相同）：
> - **真实代码摘录**：可按 file:line 回查。
> - **基于使用点的重建**：目标类型定义是 stub 时，从工厂 / 消费点 / 返回字面量交叉推断。
> - **可迁移模式**：对 Koda 的设计建议，不是 cc-haha 的事实陈述。
>
> **前置依赖**：E0（类型底座）。循环产出的判别联合、Tool 胖接口、`isConcurrencySafe` 分批策略，全部由 E0 约束。
>
> **速览**：§0 心脏全景 → §1 `query` / `queryLoop` 骨架与 State → §2 单次迭代流水线 → §3 流式 API 层 → §4 工具阶段 → §5 恢复与终止 → §6 QueryEngine 驱动器 → §7 三大设计洞察 → §8 E2 入口指引 → §9 核查清单

---

## 0. 前置：为什么查询循环是「心脏」

### 0.1 业务痛点

一个 coding agent 的一次用户发言，不是「调一次 LLM 就结束」。真实链路是：

```text
用户消息
  → 压缩/裁剪上下文
  → 调模型（流式）
  → 若有 tool_use：执行工具、把 tool_result 塞回对话
  → 再调模型
  → … 直到模型不再要工具，或被 abort / 预算 / maxTurns 截断
```

如果没有统一的「心脏」：

1. **UI / SDK / headless** 各自发明循环 → 权限、compact、abort 语义漂移；
2. **工具结果与 assistant 消息交错** 无固定顺序 → API 400（tool_use 无对应 tool_result）；
3. **可恢复错误**（prompt-too-long、max_output_tokens）若立刻抛给 SDK → 上层会话被误杀，恢复路径永远跑不完。

### 0.2 cc-haha 的堵法：双层生成器 + 显式 State 重赋

| 层 | 文件 | 职责 |
|----|------|------|
| 驱动器 | `QueryEngine.ts` | 会话生命周期、落盘、SDK 消息适配、预算/轮次硬顶 |
| 心脏 | `query.ts` | 单次 `query()` 内的 while 循环：压缩 → 调模型 → 工具 → 续转 |
| 模型 | `services/api/claude.ts` | 流式 SSE 装配、双看门狗、usage 写回 |
| 工具 | `toolOrchestration.ts` + `toolExecution.ts` | 并发分批 + 单工具权限/执行管线 |
| 测试缝 | `query/deps.ts` + `query/config.ts` | 可注入 I/O、入口快照配置 |

**核心手法**：`query` / `queryLoop` 是 **async generator**——边跑边 `yield` 事件；跨迭代状态不是 9 个散落变量，而是整份 `State` 对象在 continue 点整体重赋（为将来抽 pure reducer 铺路）。

### 0.3 对象站位（读图再读代码）

```text
                    ┌─────────────────────────────────────┐
  用户/SDK ──►      │  QueryEngine.submitMessage()         │
                    │   recordTranscript / normalizeMessage │
                    └──────────────┬──────────────────────┘
                                   │ for await
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  query()  ──yield*──►  queryLoop()   │
                    │     while (true) {                   │
                    │       compact / snip / collapse      │
                    │       callModel (streaming)          │
                    │       if tool_use → runTools / STE   │
                    │       attachments / memory prefetch  │
                    │       state = next; continue         │
                    │       or return Terminal             │
                    │     }                                │
                    └──────────────┬──────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
     claude.ts              toolOrchestration      stopHooks /
     queryModelWithStreaming   runTools / STE       compact*
```

---

## 1. 入口与状态：`query` / `queryLoop` / `State`

### 1.1 生成器签名（产出封闭集合）

**真实代码摘录**（`src/query.ts:222-231`）

```typescript
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
>
```

这与 E0 §3.1 的契约一致：消费者（`QueryEngine`）可以用 `switch (message.type)` 穷举。

`query()` 本身是薄壳（`222-242`）：

1. 建 `consumedCommandUuids`；
2. `yield* queryLoop(...)`；
3. **仅在正常 return** 时对每个已消费命令发 `notifyCommandLifecycle(uuid, 'completed')`——throw / `.return()` 不会走到这里，形成「started 无 completed」的不对称信号（与 `print.ts` 的 drain 语义对齐）。

### 1.2 `QueryParams`：一次调用的不变输入

**真实代码摘录**（`src/query.ts:184-202`）

| 字段 | 作用 |
|------|------|
| `messages` / `systemPrompt` / `userContext` / `systemContext` | 对话与提示 |
| `canUseTool` | 权限回调（E3 挂载点） |
| `toolUseContext` | 工具执行上下文（abort、tools、agentId…） |
| `fallbackModel?` | 模型 fallback |
| `querySource` | 调用来源（主线程 / agent / compact…） |
| `maxOutputTokensOverride?` / `maxTurns?` / `skipCacheWrite?` | 轮次与输出上限 |
| `taskBudget?` | API 侧 task_budget beta（**不是**内部 TOKEN_BUDGET 续跑） |
| `deps?` | 测试注入：`callModel` / `microcompact` / `autocompact` / `uuid` |

### 1.3 `State`：跨迭代可变全集

**真实代码摘录**（`src/query.ts:207-220`）

| 字段 | 含义 |
|------|------|
| `messages` | 带入下一轮的对话历史 |
| `toolUseContext` | 工具上下文（迭代内也会局部更新） |
| `autoCompactTracking` | compact 后 turnId / 连续失败计数 |
| `maxOutputTokensRecoveryCount` | max_output_tokens 多轮恢复计数（上限 3） |
| `hasAttemptedReactiveCompact` | 反应式 compact 单次护栏（防死循环） |
| `maxOutputTokensOverride` | 单次请求输出 token 上限覆盖（escalation） |
| `pendingToolUseSummary` | 上一轮异步生成的工具摘要 Promise |
| `stopHookActive` | stop hook 是否已在阻塞路径上 |
| `turnCount` | 当前轮次 |
| `transition` | **为何**继续：`Continue` 标签，测试可断言恢复路径 |

初始化在 `271-282`。注释 `268-270`：每次 continue 写整份 `state = { ... }`，而不是 9 个赋值。

> **注意**：`src/query/transitions.ts` 在本仓库是 **stub**（`// @generated stub from scan-missing-imports`）。`Terminal` / `Continue` 的真实定义缺失；形状只能从 `return { reason: '...' }` 与 `transition: { reason: '...' }` 使用点重建（见 §5）。

### 1.4 依赖注入与配置快照

**`QueryDeps`**（`src/query/deps.ts:21-39`）——有意收窄为 4 项：

```typescript
callModel: typeof queryModelWithStreaming
microcompact: typeof microcompactMessages
autocompact: typeof autoCompactIfNeeded
uuid: () => string
```

生产工厂 `productionDeps()` 直接绑真实实现。注释写明：为测试去掉 spyOn-per-module 样板；后续可扩 `runTools` / `handleStopHooks` 等。

**`QueryConfig`**（`src/query/config.ts:15-45`）——入口一次快照：

- `sessionId`
- `gates.streamingToolExecution`（Statsig `tengu_streaming_tool_execution2`）
- `gates.emitToolUseSummaries`（env `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`）
- `gates.isAnt`（`USER_TYPE === 'ant'`）
- `gates.fastModeEnabled`（`!CLAUDE_CODE_DISABLE_FAST_MODE`）

**刻意排除** `feature()`：那是 bun:bundle 的 DCE 边界，必须留在调用点 inline。

---

## 2. 单次迭代流水线（`while (true)` 体内）

循环从 `query.ts:310` 开始，**从不靠条件 break**——退出全部是显式 `return Terminal`；续转是 `state = next; continue`。

### 2.1 阶段总表

| 序 | 阶段 | 位置 | 产出 / 副作用 |
|:--:|------|------|----------------|
| 0 | 解构 `state`；启动 skill 预取 | 314-338 | 后台 prefetch |
| 1 | `yield { type: 'stream_request_start' }` | 340 | UI「请求开始」 |
| 2 | query chain 深度 +1 | 349-366 | 分析用 chainId/depth |
| 3 | `getMessagesAfterCompactBoundary` | 368 | 截到 compact 之后 |
| 4 | `applyToolResultBudget` | 382-397 | 工具结果体积预算 |
| 5 | HISTORY_SNIP（feature） | 404-413 | 剪历史；yield boundary |
| 6 | microcompact | 417-429 | 微压缩 |
| 7 | CONTEXT_COLLAPSE 投影 | 443-450 | 读时折叠视图 |
| 8 | autocompact | 457-546 | 成功则 yield 摘要消息并替换 `messagesForQuery` |
| 9 | 硬阻塞上限检查 | 634-655 | 可能 `return blocking_limit` |
| 10 | **流式 `callModel`** | 661-961 | StreamEvent / AssistantMessage / tombstone |
| 11 | post-sampling hooks | 1008-1017 | fire-and-forget |
| 12 | abort-during-stream | 1023-1060 | 可能 `return aborted_streaming` |
| 13 | 兑现上一轮 tool-use summary | 1063-1068 | yield summary |
| 14a | **无 tool_use** → 恢复 / stop hooks / 结束 | 1070-1366 | 多数 `return completed` |
| 14b | **有 tool_use** → 执行工具 | 1368-1417 | yield tool_result 等 |
| 15 | attachments / 队列 / memory / skill | 1546-1636 | 注入下一轮上下文 |
| 16 | maxTurns 检查；`state = next` | 1712-1735 | `transition: next_turn` |

### 2.2 压缩层的顺序是正确性契约

注释明确要求顺序（不能随便调）：

1. **Tool-result budget 先于 microcompact**——MC 只按 `tool_use_id` 操作，不看 content（372-378）。
2. **snip 先于 autocompact**——`snipTokensFreed` 要喂给阈值判断（399-402）。
3. **collapse 先于 autocompact**——若折叠已够阈值，autocompact 应 no-op，保留细粒度上下文（431-434）。
4. **autocompact 成功后** 用 `buildPostCompactMessages` 替换 `messagesForQuery` 并 yield 边界消息（531-538）。

### 2.3 `needsFollowUp`：唯一的「还要不要跑工具」信号

**真实代码摘录意图**（557-561、837-841）：

- 流式过程中只要看到 `tool_use` 块 → `needsFollowUp = true`。
- **不信任** API 的 `stop_reason === 'tool_use'`（注释写明不可靠）。
- `!needsFollowUp` 才走 stop hooks / 正常结束分支。

### 2.4 流中工具执行 vs 批处理

当 `config.gates.streamingToolExecution` 为真：

- 建 `StreamingToolExecutor`（564-571）；
- 每个 `tool_use` 块到达即 `addTool`（844-851）；
- 中途 `getCompletedResults()` 可提前 yield（854-869）；
- 流结束后 `getRemainingResults()` 收尾（1388-1390）。

否则：流结束后一次性 `runTools(toolUseBlocks, ...)`。

---

## 3. 流式 API 层（`claude.ts` + 重试）

### 3.1 入口包装

**真实代码摘录**（`src/services/api/claude.ts:765-797`）

```typescript
export async function* queryModelWithStreaming(...): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage | SystemStreamingFallbackMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* withStreamRetry(
      () => queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options),
      options.model,
      messages,
    )
  })
}
```

三层：VCR（回放/录制）→ **中流瞬态重试** → 真实 `queryModel`。

### 3.2 流式装配：一块一消息 + mutation 写回

与 E0 一致，关键行为：

| 事件 | 行为 | 位置 |
|------|------|------|
| `content_block_stop` | 构造并 **yield** 一条 `AssistantMessage`（每 content block 一条） | ~2334-2352 |
| `message_delta` | **直接 mutation** 已 yield 消息的 `usage` / `stop_reason` | ~2371-2390 |
| 每个 SSE part | 再 yield `{ type: 'stream_event', event, ttftMs? }` | ~2441-2445 |

**为什么 mutation 而不是替换对象**：转录写队列持有 `message.message` 引用，100ms 惰性 `JSON.stringify`；对象替换会断开引用，落盘丢最终 usage（E0 §3.3 / QueryEngine 注释 740-748）。

**为什么每 block 一条 AssistantMessage**：便于 UI 渐进渲染；完整 stop_reason 晚到 `message_delta`，由 mutation 补齐。

### 3.3 双看门狗（防 hang）

**真实代码摘录**（`claude.ts:1957-1981` 一带）：

| 定时器 | 默认 | 重置？ | 抓什么 |
|--------|------|--------|--------|
| Idle（首 token 可用更长预算） | `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 默认 **90s**；首 token 可用 `CLAUDE_STREAM_FIRST_TOKEN_TIMEOUT_MS` | 每收到 chunk **重置** | 流彻底卡死 |
| Max duration | `CLAUDE_STREAM_MAX_DURATION_MS` 默认 **0=关闭** | **永不重置** | 上游 trickle 刚好喂饱 idle 但永不 `message_stop`（#766） |

Idle 触发后走非流式 fallback / 中止路径，而不是假装「流正常结束」。

### 3.4 中流瞬态重试（`withStreamRetry`）

**真实代码摘录**（`streamRetry.ts:48-93` + `withRetry.ts:221-223`）：

- 仅捕获 `RetriableStreamError`；
- 默认最多 **2** 次（`CLAUDE_STREAM_TRANSIENT_RETRY_MAX`）；
- **安全前提**：仅当该次尝试 **0 条 assistant 消息** 时才抛可重试错误——避免工具已执行再重放（#766 / double-tool-execution）。

### 3.5 模型 fallback（query 内层）

`FallbackTriggeredError` + `fallbackModel`（`query.ts:900-957`）：

1. 切换 `currentModel`；
2. `yieldMissingToolResultBlocks` 闭合孤儿 tool_use；
3. 丢弃并重建 `StreamingToolExecutor`；
4. ant 用户 strip thinking signature（模型绑定）；
5. yield warning system 消息；
6. `continue` 内层 `attemptWithFallback` 循环。

中流 streaming fallback 标志（`onStreamingFallback`）则 **tombstone** 已 yield 的 partial assistant（含 thinking），避免签名非法（716-748）。

---

## 4. 工具阶段（编排层，细节留给 E2/E3）

### 4.1 `runTools`：按 `isConcurrencySafe` 分批

**真实代码摘录**（`toolOrchestration.ts:19-116`）：

1. `partitionToolCalls`：连续 concurrency-safe 的 tool_use 合成一批；unsafe 单独一批。
2. Safe 批：`runToolsConcurrently`，上限 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 默认 **10**。
3. Unsafe 批：`runToolsSerially`。
4. 并发批的 `contextModifier` **批结束后按 block 顺序**应用——避免并发改 context 竞态。

`isConcurrencySafe` 抛错或 parse 失败 → **当作 unsafe**（fail-closed，与 E0 `buildTool` 默认一致）。

### 4.2 单工具管线（E2/E3 锚点，此处只钉顺序）

`checkPermissionsAndCallTool`（`toolExecution.ts:599+`）顺序：

```text
zod safeParse → validateInput? → PreToolUse hooks → canUseTool/权限
  → tool.call → mapToolResult → PostToolUse(hooks) → yield user/tool_result
```

编排层 **无 try/catch**：工具错误在 `runToolUse` 内吞掉并变成 `is_error` 的 tool_result，后续 batch 继续。

### 4.3 孤儿 tool_use 的安全网

`yieldMissingToolResultBlocks`（`query.ts:126-152`）在 fallback / 模型抛错 / abort（无 STE）时，为每个未完成 tool_use 合成 `is_error: true` 的 tool_result——保证 API 对话永远成对。

### 4.4 工具后附件注入

工具跑完后、进入下一轮前（1546+）：

- 队列命令（主线程 vs 子 agent 分流）；
- memory prefetch（不阻塞：只消费已 settled）；
- skill discovery prefetch；
- `refreshTools`（新 MCP 工具可见）。

**故意不**在 tool_result 中间插入普通 user 消息——API 禁止 tool_result 与普通 user 交错（注释 1543-1544）。

---

## 5. 恢复路径、Continue 标签、Terminal 全集

### 5.1 Withhold-then-recover（先扣住再恢复）

可恢复错误在流内 **不立刻 yield**（`withheld`，806-832）：

- prompt-too-long（collapse / reactive compact）；
- media size（reactive compact strip）；
- max_output_tokens（escalation + 多轮 recovery）。

**业务原因**（169-176）：SDK/桌面客户端看到带 `error` 的消息就杀会话；若恢复前泄漏中间错误，监听者已死、恢复空转。

### 5.2 Continue 原因（循环继续）

| `transition.reason` | 触发 |
|---------------------|------|
| `collapse_drain_retry` | 413 后先排空 staged collapse |
| `reactive_compact_retry` | 反应式 compact 成功后重试 |
| `max_output_tokens_escalate` | 同请求升到 `ESCALATED_MAX_TOKENS` |
| `max_output_tokens_recovery` | 注入 meta user「接着写」，最多 3 次 |
| `stop_hook_blocking` | stop hook 阻塞错误注入后重试 |
| `token_budget_continuation` | TOKEN_BUDGET 未用尽，nudge 续跑 |
| `next_turn` | 工具跑完进入下一轮 |

模型 fallback 用内层 `continue`，不写 `State.transition`。

### 5.3 Terminal 原因（循环结束）

**基于使用点的重建**（`query.ts` 全部 `return { reason: ... }`）：

| reason | 行号 | 含义 |
|--------|------|------|
| `blocking_limit` | 653 | 硬 token 上限，且无 compact 所有权 |
| `image_error` | 985, 1183 | 图片过大 / 媒体错误不可恢复 |
| `model_error` | 1004 | 模型调用抛错 |
| `aborted_streaming` | 1059 | 流式阶段 abort |
| `prompt_too_long` | 1183, 1190 | 413 恢复失败 |
| `completed` | 1272, 1365 | 正常结束（含「最后是 API 错误消息」的软完成） |
| `stop_hook_prevented` | 1287 | stop hook 禁止继续 |
| `aborted_tools` | 1523 | 工具阶段 abort |
| `hook_stopped` | 1528 | hook_stopped_continuation 附件 |
| `max_turns` | 1719 | 超过 maxTurns |

### 5.4 Stop hooks

`handleStopHooks`（`query/stopHooks.ts`）在 **无 tool_use** 且最后一条不是 API error 时运行。可：

- `preventContinuation` → `stop_hook_prevented`；
- `blockingErrors` → 注入消息并 `stop_hook_blocking` 续转。

API error 路径 **故意不跑** stop hooks（1266-1272），防止「error → hook 加 token → 再 error」死亡螺旋。

---

## 6. QueryEngine：SDK/headless 驱动器

### 6.1 职责边界

`QueryEngine`（`QueryEngine.ts:187+`）**拥有会话**，`query()` **拥有一轮 agentic loop**：

| 关注点 | QueryEngine | queryLoop |
|--------|-------------|-----------|
| 多 turn 消息累积 | `mutableMessages` | 单次 `State.messages` |
| 落盘 JSONL | `recordTranscript` | 不直接写 |
| SDK 线格式 | `normalizeMessage` / result 对象 | 内部 Message/StreamEvent |
| maxBudgetUsd / structured output 重试 | 有 | 无 |
| compact / tool / 流式细节 | 消费事件 | 执行 |

### 6.2 消费 switch（E0 已列，E1 补行为）

`for await (const message of query(...))`（697+）+ `switch`（779-1010）：

| type | 行为摘要 |
|------|----------|
| `tombstone` | 跳过（控制信号） |
| `assistant` / `user` / `progress` | 入 `mutableMessages`；normalize yield；progress/attachment 另 inline 落盘 |
| `stream_event` | 累计 usage / stop_reason；可选透传 partial |
| `attachment` | 处理 max_turns / structured_output 等 |
| `stream_request_start` | **不** yield 给 SDK |
| `system` | compact_boundary / api_error / streaming_fallback 等子集外发 |
| `tool_use_summary` | 外发 summary |

### 6.3 落盘与 mutation 的咬合

- assistant：**fire-and-forget** `void recordTranscript`（749-750），依赖 100ms 惰序列化吸收 `message_delta` mutation。
- user / compact_boundary：**await** 写入。
- 进程可能在 `result` 后被桌面杀掉 → 各 result 出口前 `flushSessionStorage`。

### 6.4 取消

`interrupt()` → `abortController.abort()`；信号经 `toolUseContext` 进入 `query` / 工具层。QueryEngine 的 switch **不**自己轮询 abort。

---

## 7. 对 Koda 最重要的 3 个设计洞察

### 洞察 1：心脏必须是「事件生成器」，不是「返回最终字符串」

`AsyncGenerator<封闭联合, Terminal>` 同时服务：

- UI 流式渲染；
- SDK 订阅；
- 落盘侧车；
- 测试对 `transition.reason` 的断言。

Koda 若做 `runAgent(prompt): Promise<string>`，后续所有流式/权限/进度都要打补丁。应一开始就是：

```text
for await (const ev of engine.turn(input)) { ... }
const terminal = /* generator return */
```

### 洞察 2：可恢复错误要 withhold，Terminal 与 Continue 要显式

把「中间失败」和「最终失败」分开：

- 中间：不 yield 给会杀会话的消费者，先 compact / escalate / retry；
- 最终：带稳定 `reason` 的 Terminal。

Continue 标签（`transition`）是测试与可观测性的一等公民，不是日志边角料。

### 洞察 3：State 整份重赋 + Config 快照 + Deps 注入 = 可测的循环

三分离：

| 部件 | 变吗 | 作用 |
|------|------|------|
| `QueryConfig` | 入口冻结 | 门控/会话 id |
| `State` | 每轮新对象 | 可 replay / 可测 |
| `QueryDeps` | 可替换 | 单测假模型/假 compact |

Koda 应抵制「循环里直接 `import` 打 API」；至少 `callModel` 必须可注入。

**附：工具与模型的时间重叠**（StreamingToolExecutor）和 **prefetch 不阻塞**（memory/skill）是延迟优化，可二期做，但 withhold/Terminal/State 三件套是一期必选项。

---

## 8. E2（工具系统）拆解最该先看的入口

| 顺序 | 文件 | 看什么 |
|:----:|------|--------|
| 1 | `src/services/tools/toolExecution.ts` | `runToolUse` / `checkPermissionsAndCallTool` 全管线 |
| 2 | `src/services/tools/toolOrchestration.ts` | 分批与并发 |
| 3 | `src/services/tools/StreamingToolExecutor.ts` | 流中执行 |
| 4 | `src/Tool.ts` + `src/tools.ts` | 接口与三层工具池（E0 已铺） |
| 5 | `src/hooks/useCanUseTool.tsx` + permissions | 权限回调（衔 E3） |

E1 只把工具当作「循环的一个阶段」；E2 拆工具池、结果映射、MCP、进度。

---

## 9. 核查清单

> 供第二个 agent 独立验证。标注 ⚠️stub 表示文件本身是占位。

### §1 入口与状态

| # | 位置 | 摘要 |
|---|------|------|
| 1 | `src/query.ts:184-202` | `QueryParams` 字段全集 |
| 2 | `src/query.ts:207-220` | `State` 类型 |
| 3 | `src/query.ts:222-231` | `query` 产出联合 + `Terminal` |
| 4 | `src/query.ts:232-241` | 正常 return 才 `notifyCommandLifecycle(completed)` |
| 5 | `src/query.ts:244-254` | `queryLoop` 同构生成器 |
| 6 | `src/query.ts:271-282` | 初始 `state` |
| 7 | `src/query.ts:298` | `buildQueryConfig()` 一次快照 |
| 8 | `src/query.ts:310` | `while (true)` |
| 9 | `src/query/deps.ts:21-39` | `QueryDeps` 四依赖 + `productionDeps` |
| 10 | `src/query/config.ts:15-45` | `QueryConfig` gates；排除 `feature()` |
| 11 | `src/query/transitions.ts:1` | ⚠️stub：`Terminal`/`Continue` 无真实定义 |

### §2 迭代流水线

| # | 位置 | 摘要 |
|---|------|------|
| 12 | `src/query.ts:340` | `yield { type: 'stream_request_start' }` |
| 13 | `src/query.ts:368` | `getMessagesAfterCompactBoundary` |
| 14 | `src/query.ts:382-397` | `applyToolResultBudget` |
| 15 | `src/query.ts:404-413` | HISTORY_SNIP |
| 16 | `src/query.ts:417-429` | microcompact |
| 17 | `src/query.ts:443-450` | context collapse 投影 |
| 18 | `src/query.ts:457-546` | autocompact 成功/失败 |
| 19 | `src/query.ts:557-561` | `needsFollowUp` / 不信任 stop_reason |
| 20 | `src/query.ts:564-571` | `StreamingToolExecutor` 门控 |
| 21 | `src/query.ts:634-655` | `blocking_limit` |
| 22 | `src/query.ts:126-152` | `yieldMissingToolResultBlocks` |

### §3 流式 API

| # | 位置 | 摘要 |
|---|------|------|
| 23 | `src/services/api/claude.ts:765-797` | `queryModelWithStreaming` → VCR + streamRetry |
| 24 | `src/services/api/streamRetry.ts:48-93` | 中流重试；0 assistant 才安全 |
| 25 | `src/services/api/withRetry.ts:221-223` | 默认 max transient retries = 2 |
| 26 | `src/services/api/claude.ts:1957-1981` | idle 90s + max duration 双看门狗 |
| 27 | `src/services/api/claude.ts:2334-2352` | content_block_stop → AssistantMessage |
| 28 | `src/services/api/claude.ts:2371-2390` | message_delta mutation usage/stop_reason |
| 29 | `src/services/api/claude.ts:2441-2445` | yield stream_event + ttftMs |
| 30 | `src/query.ts:716-748` | streaming fallback → tombstone + 重建 STE |
| 31 | `src/query.ts:900-957` | `FallbackTriggeredError` 换模型重试 |

### §4 工具

| # | 位置 | 摘要 |
|---|------|------|
| 32 | `src/query.ts:1388-1390` | STE.getRemainingResults vs `runTools` |
| 33 | `src/services/tools/toolOrchestration.ts:8-12` | 并发上限默认 10 |
| 34 | `src/services/tools/toolOrchestration.ts:19-82` | `runTools` |
| 35 | `src/services/tools/toolOrchestration.ts:91-116` | `partitionToolCalls` fail-closed |
| 36 | `src/services/tools/toolExecution.ts:337` | `runToolUse` |
| 37 | `src/services/tools/toolExecution.ts:599` | `checkPermissionsAndCallTool` |
| 38 | `src/services/tools/toolExecution.ts:615` | zod `safeParse` |
| 39 | `src/query.ts:1419-1490` | 异步 tool-use summary，下轮 yield |

### §5 恢复与终止

| # | 位置 | 摘要 |
|---|------|------|
| 40 | `src/query.ts:169-176` | withhold 动机注释（SDK 杀会话） |
| 41 | `src/query.ts:806-832` | withheld 不 yield |
| 42 | `src/query.ts:1097-1174` | collapse drain → reactive compact |
| 43 | `src/query.ts:1196-1264` | max_output_tokens escalate + recovery≤3 |
| 44 | `src/query.ts:1275-1314` | stop hooks |
| 45 | `src/query.ts:1316-1363` | TOKEN_BUDGET 续跑 |
| 46 | `src/query.ts:653` 等 | Terminal reasons 全集见 §5.3 |
| 47 | `src/query/stopHooks.ts:67-70` | `StopHookResult` 形状 |

### §6 QueryEngine

| # | 位置 | 摘要 |
|---|------|------|
| 48 | `src/QueryEngine.ts:178-186` | 类职责注释 |
| 49 | `src/QueryEngine.ts:212-215` | `submitMessage` 生成器 |
| 50 | `src/QueryEngine.ts:697-708` | `for await (query(...))` |
| 51 | `src/QueryEngine.ts:740-753` | assistant fire-and-forget 落盘 |
| 52 | `src/QueryEngine.ts:779-1010` | 消费 switch 9 分支 |
| 53 | `src/QueryEngine.ts:1199-1201` | `interrupt()` → abort |

### §7–8 交棒

| # | 位置 | 摘要 |
|---|------|------|
| 54 | `src/query/config.ts:8-11` | 未来 pure reducer `(state, event, config)` 意图 |
| 55 | `src/query.ts:1722-1735` | `next_turn` State 重赋（注释仍称 recursive call） |

---

## 10. 一句话带走

> **E1 = 事件生成器心脏：Config 冻结 + State 整份重赋 + 流式模型与工具咬合 + 可恢复错误 withhold + 显式 Terminal/Continue；QueryEngine 只负责会话与 SDK 外壳，不负责循环内决策。**

E0 给出「管道里流什么类型」；E1 给出「类型如何在时间上被泵出」。下一相 E2 拆开 `runTools` 之后的工具宇宙。
