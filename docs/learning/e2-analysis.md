# cc-haha E2 相拆解：工具系统

> **本文定位**：Koda 自研执行引擎的设计输入调研。E2 是 9 相拆解（E0–E8）的第三相，拆**工具系统的完整一生**：一个 `tool_use` 块从 assistant 消息里流出来，经过查找、分批、校验、hooks、权限、执行、结果映射、落盘持久化，最终变成 `tool_result` 回填进查询循环的全过程。
>
> **拆解对象**：`/Users/waybi/Desktop/my/cc-haha` —— 同上游 E0/E1。
>
> **证据分级**（与 E0/E1 相同）：
> - **真实代码摘录**：可按 file:line 回查。
> - **基于使用点的重建**：目标类型定义是 stub 时，从工厂 / 消费点 / 返回字面量交叉推断。
> - **可迁移模式**：对 Koda 的设计建议，不是 cc-haha 的事实陈述。
>
> **前置依赖**：E0（类型底座：Tool 胖接口、判别联合）、E1（查询循环：工具阶段在 `while(true)` 中的站位）。E1 只把工具当作「循环的一个阶段」；本文拆开那个阶段内部。
>
> **速览**：§0 工具的一生全景 → §1 静态形态（Tool 接口 / buildTool / 注册表）→ §2 编排层 runTools（分批与并发）→ §3 执行层 runToolUse / checkPermissionsAndCallTool（九段管线）→ §4 权限回调 canUseTool（衔 E3）→ §5 hooks 层 → §6 结果回填与 API 400 防护 → §7 StreamingToolExecutor（流中执行）→ §8 MCP 工具的统一与差异 → §9 进度事件与大结果持久化 → §10 三大设计洞察 → §11 E3 入口指引 → §12 核查清单

---

## 0. 前置：一个 tool_use 的一生

### 0.1 业务痛点

模型在 assistant 消息里发出 `tool_use` 块之后，客户端要回答一串问题：

```text
这个工具存在吗？（模型会调不存在的工具）
输入合法吗？（模型「surprisingly」不擅长生成合法输入——源码原话）
几个工具能一起跑吗？（读安全，写必须独占）
用户允许吗？（配置规则 / hooks / 分类器 / 交互弹窗，四层裁决）
跑挂了怎么办？（错误必须变成 is_error 的 tool_result，绝不能让 API 400）
结果太大怎么办？（持久化到磁盘，给模型一个预览 + 文件路径）
```

cc-haha 的答案是一条**永不抛错、永远产出成对 tool_result** 的管线：任何一步失败（工具不存在、zod 校验失败、权限拒绝、执行抛错、兄弟工具连坐取消），都会被折叠成一条 `is_error: true` 的 `tool_result`，让模型下一轮自己看着办。

### 0.2 分层地图

| 层 | 文件 | 职责 |
|----|------|------|
| 接口 | `src/Tool.ts` | `Tool` 胖接口、`ToolUseContext`、`buildTool` 默认值 |
| 注册表 | `src/tools.ts` | 三层工具池：全量 → 门控/deny 过滤 → 并入 MCP |
| 编排 | `src/services/tools/toolOrchestration.ts` | `runTools`：按 `isConcurrencySafe` 分批，safe 并发 / unsafe 串行 |
| 执行 | `src/services/tools/toolExecution.ts` | `runToolUse` → `checkPermissionsAndCallTool` 九段管线 |
| hooks | `src/services/tools/toolHooks.ts` | Pre/Post/PostFailure hooks 生成器 + hook 权限决议 |
| 权限 | `src/hooks/useCanUseTool.tsx` | `canUseTool` 回调：配置 → 分类器 → 交互弹窗（衔 E3） |
| 流中执行 | `src/services/tools/StreamingToolExecutor.ts` | tool_use 块边流入边执行，兄弟错误连坐 |
| 结果存储 | `src/utils/toolResultStorage.ts` | 大结果持久化到磁盘 + 预览替换 |
| MCP | `src/services/mcp/client.ts` | 把远端 MCP 工具适配成同一个 `Tool` 形状 |

### 0.3 对象站位（读图再读代码）

```text
 assistant 消息（含 tool_use 块）
        │
        ├── 流式路径：StreamingToolExecutor.addTool（块到达即执行）
        │
        └── 批处理路径：runTools(toolUseBlocks, ...)
                 │ partitionToolCalls：连续 safe 合批 / unsafe 单独
                 ▼
        runToolsConcurrently（≤10 并发）│ runToolsSerially
                 │
                 ▼
            runToolUse（单工具一生）
                 │ 找工具（含 alias 兜底）→ abort 检查
                 ▼
     checkPermissionsAndCallTool（九段管线）
       ① zod safeParse         ② tool.validateInput
       ③ PreToolUse hooks      ④ resolveHookPermissionDecision
       ⑤ canUseTool 权限裁决    ⑥ tool.call（onProgress 边跑边冒泡）
       ⑦ mapToolResult + 持久化 ⑧ PostToolUse hooks
       ⑨ 组装 user 消息（tool_result）返回
                 │
                 ▼
      query.ts 消费：yield 消息、normalize 进 toolResults、
      newContext 换 context → 下一轮模型调用
```

---

## 1. 静态形态：Tool 接口、buildTool、注册表

### 1.1 Tool 胖接口：执行 + 权限 + 渲染三合一

**真实代码摘录**（`src/Tool.ts:362-366`，签名部分）

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
```

关键成员分三组（完整定义 `src/Tool.ts:362-695`）：

| 组 | 成员 | 位置 | 作用 |
|----|------|------|------|
| 执行 | `call(args, context, canUseTool, parentMessage, onProgress?)` | 379-385 | 真正干活，返回 `ToolResult<Output>` |
| 执行 | `inputSchema` / `inputJSONSchema?` / `outputSchema?` | 394-400 | zod 校验；MCP 工具可直接给 JSON Schema |
| 并发 | `isConcurrencySafe(input)` | 402 | 编排层分批依据（吃 input：`Bash(ls)` 可并发，`Bash(rm)` 不行） |
| 权限 | `checkPermissions(input, context)` | 500-503 | 工具自有权限逻辑；通用逻辑在 permissions.ts |
| 权限 | `validateInput?(input, context)` | 489-492 | 值级校验（zod 之后），失败信息给模型看 |
| 中断 | `interruptBehavior?(): 'cancel' \| 'block'` | 416 | 用户新消息进来时：砍掉还是等它跑完（默认 block） |
| 结果 | `mapToolResultToToolResultBlockParam(content, toolUseID)` | 557-560 | Output → API `tool_result` 块 |
| 结果 | `maxResultSizeChars` | 466 | 超限落盘；`Infinity` = 永不落盘（Read，防循环） |
| 观察 | `backfillObservableInput?(input)` | 481 | 只给观察者（hooks/transcript）补字段，不动 API 原件 |
| 渲染 | `renderToolUseMessage` / `renderToolResultMessage?` 等 | 566-694 | TUI 渲染（E2 不展开） |

### 1.2 buildTool：fail-closed 默认值

**真实代码摘录**（`src/Tool.ts:757-769`）

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}
```

`buildTool`（783-792）就是 `{ ...TOOL_DEFAULTS, ...def }` 的类型安全版。注意方向性：**并发/读写/破坏性默认按最危险算**（false = 不安全），而 `checkPermissions` 默认 allow——因为它只是「工具自有逻辑」，真正的门在通用权限系统（§4），这里 allow 意为「defer to general permission system」（注释 753）。

### 1.3 ToolUseContext：一次执行的世界

`ToolUseContext`（`src/Tool.ts:158-300`）是工具能看到的全部世界，重点字段：

| 字段 | 位置 | 作用 |
|------|------|------|
| `options.tools` / `options.mcpClients` | 163, 166 | 当前工具池、MCP 连接 |
| `options.refreshTools?` | 178 | 中途 MCP 连上后刷新工具池的回调（§6.3） |
| `abortController` | 180 | 取消信号，贯穿全链 |
| `getAppState` / `setAppState` | 182-183 | 权限模式、MCP 客户端状态等 |
| `setInProgressToolUseIDs` | 227 | UI「正在跑」集合 |
| `toolDecisions?` | 258-265 | 权限决策缓存（OTel 去重用） |
| `requireCanUseTool?` | 249 | hook 批准也必须走 canUseTool（speculation 路径覆写用） |
| `messages` | 250 | 当前对话（buildSchemaNotSentHint 等需要） |

`ToolResult<T>`（321-336）除 `data` 外还能带 `newMessages`（工具追加消息）、`contextModifier`（改 context，**仅 unsafe 工具生效**，注释 329）、`mcpMeta`（MCP 协议透传）。

### 1.4 注册表：三层工具池

**真实代码摘录**（`src/tools.ts:194-203`，节选）

```typescript
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // Ant-native builds have bfs/ugrep embedded in the bun binary (same ARGV0
    // trick as ripgrep). When available, find/grep in Claude's shell are aliased
    // to these fast tools, so the dedicated Glob/Grep tools are unnecessary.
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
```

三层组装：

1. **`getAllBaseTools()`**（194-252）：环境内可能存在的**全集**，大量 `feature()` / env 门控（KAIROS、REPL、cron、coordinator…）。注释（192）强调必须与 Statsig 的 system-prompt 缓存配置同步。
2. **`getTools(permissionContext)`**（272-328）：剔除特殊工具（ListMcpResources 等按需另加），过 `filterToolsByDenyRules`（263-270：blanket deny 直接让模型看不到该工具），REPL 模式隐藏原语工具，最后 `isEnabled()` 过滤。
3. **`assembleToolPool(permissionContext, mcpTools)`**（346-368）：built-in + MCP 去重合并。排序有讲究——**built-in 排前面且各自分区内排序**，因为服务端 prompt-cache 断点打在最后一个 built-in 后：平铺混排会让新 MCP 工具插进 built-in 之间、击穿全部下游缓存（注释 356-362）。

---

## 2. 编排层：runTools 的分批与并发

### 2.1 runTools：safe 并发 / unsafe 串行

**真实代码摘录**（`src/services/tools/toolOrchestration.ts:19-34`，节选）

```typescript
export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(
    toolUseMessages,
    currentContext,
  )) {
    if (isConcurrencySafe) {
      const queuedContextModifiers: Record<
        string,
        ((context: ToolUseContext) => ToolUseContext)[]
      > = {}
```

结构（19-82 全函数）：

- safe 批 → `runToolsConcurrently`（152-177）：`all(generators, N)` 扇出，N 默认 10（`getMaxToolUseConcurrency`，8-12，env `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 可调）。
- unsafe 批 → `runToolsSerially`（118-150）：逐个 `runToolUse`，`contextModifier` 即时应用。
- **并发批的 contextModifier 不即时应用**：先按 `toolUseID` 收进队列（42-48），批结束后**按 block 顺序**重放（54-62），最后补一个纯 `newContext` 的 yield（63）——避免并发改 context 的竞态，且保证 context 演化顺序确定。

### 2.2 partitionToolCalls：fail-closed 分批

**真实代码摘录**（`src/services/tools/toolOrchestration.ts:95-115`）

```typescript
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            // If isConcurrencySafe throws (e.g., due to shell-quote parse failure),
            // treat as not concurrency-safe to be conservative
            return false
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
```

三重 fail-closed：工具不存在 → unsafe；parse 失败 → unsafe；`isConcurrencySafe` 抛错 → unsafe。与 E0 `buildTool` 默认 `false` 一致——**并发是需要证明的特权，不是默认**。合批只合**连续**的 safe（86-90 注释：单 unsafe 独占一批，多个连续 safe 合一批），保持模型发出的顺序语义。

### 2.3 进行中集合的记账

串行与并发路径都在启动时 `setInProgressToolUseIDs(add)`（127-129、160-162），完成时 `markToolUseAsComplete`（179-188）删掉——UI 的「N tools running」与 interruptible 状态由此驱动。

---

## 3. 执行层：runToolUse 与九段管线

### 3.1 runToolUse：找工具 + 两道前置闸

**真实代码摘录**（`src/services/tools/toolExecution.ts:337-356`）

```typescript
export async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  const toolName = toolUse.name
  // First try to find in the available tools (what the model sees)
  let tool = findToolByName(toolUseContext.options.tools, toolName)

  // If not found, check if it's a deprecated tool being called by alias
  // (e.g., old transcripts calling "KillShell" which is now an alias for "TaskStop")
  // Only fall back for tools where the name matches an alias, not the primary name
  if (!tool) {
    const fallbackTool = findToolByName(getAllBaseTools(), toolName)
    // Only use fallback if the tool was found via alias (deprecated name)
    if (fallbackTool && fallbackTool.aliases?.includes(toolName)) {
      tool = fallbackTool
    }
  }
```

三道闸，每道都以 `is_error` tool_result 收尾而不是抛错：

1. **工具不存在**（369-411）：yield `No such tool available` 错误结果。alias 兜底只认「按别名找到」的（老 transcript 里 `KillShell` → `TaskStop`），防止把被过滤掉的工具偷偷复活。
2. **已 abort**（415-453）：yield 取消消息（`createToolResultStopMessage` + `CANCEL_MESSAGE`）。
3. **外层 catch**（469-489）：管线自身抛出的任何错误 → `Error calling tool (X): ...` 错误结果。**编排层因此无需 try/catch**。

### 3.2 streamedCheckPermissionsAndCallTool：进度与结果并轨

`checkPermissionsAndCallTool` 返回 `Promise<MessageUpdateLazy[]>`（终值数组），但进度要边跑边冒。适配器（492-570）用自制 `Stream`：`onToolProgress` 回调把进度包成 `ProgressMessage` 即时 `enqueue`（549-556），Promise resolve 后再把最终结果依次入流（558-562），错误 `stream.error`、finally `stream.done`。源码自嘲这是 hack（504-508）：理想情况进度与结果应是分离机制。

### 3.3 九段管线：checkPermissionsAndCallTool

主体在 `toolExecution.ts:599-1745`，按顺序：

| 段 | 位置 | 行为 | 失败产物 |
|----|------|------|----------|
| ① zod safeParse | 615-680 | `tool.inputSchema.safeParse(input)`；注释吐槽模型不擅长合法输入（614） | `InputValidationError` tool_result；deferred 工具附加 schema-not-sent 提示（§3.4） |
| ② validateInput | 683-733 | 工具自有值校验（文件存在性之类） | `<tool_use_error>` tool_result |
| ③ 投机分类器 | 740-752 | Bash 专属：提早启动 allow-classifier，与 hooks/权限并行 | 无（纯预热） |
| ④ 输入卫生 | 756-793 | 剥离模型伪造的 `_simulatedSedEdit`（纵深防御）；`backfillObservableInput` 在**浅拷贝**上补观察字段 | — |
| ⑤ PreToolUse hooks | 798-891 | 消费 `runPreToolUseHooks`：hook 可给权限决定、改 input（passthrough）、直接 stop | `stop` → 立即返回 stop tool_result（848-860） |
| ⑥ 权限裁决 | 918-1104 | `resolveHookPermissionDecision` → 必要时 `canUseTool`；非 allow 走 deny 分支 | `is_error` tool_result + 可选 PermissionDenied hooks retry 提示（1075-1101） |
| ⑦ tool.call | 1178-1288 | 真执行；`onProgress` 冒泡；OTel span 记账 | 走 catch（§3.6） |
| ⑧ 结果映射+持久化 | 1290-1301, 1403-1479 | `mapToolResultToToolResultBlockParam` 一次映射并缓存；`processToolResultBlock` 决定落盘 | — |
| ⑨ PostToolUse hooks | 1481-1563 | hook 可改 MCP 输出、追加 attachment；>500ms 显示耗时 | hook 错误不阻塞结果 |

**输入的三个身份**（775-793、1181-1205）值得单独说：`callInput`（给 `tool.call` 的）与 `processedInput`（给 hooks/权限观察的）分离。`backfillObservableInput` 只改观察侧克隆；若 hook/权限返回的新 input 的 `file_path` 恰好等于 backfill 展开值，会**还原成模型原始路径**再交给 call——因为工具结果字符串会原样嵌入路径（"File created successfully at: {path}"），路径变了 transcript 序列化与 VCR fixture 哈希全变。

### 3.4 buildSchemaNotSentHint：给模型的自救指南

**真实代码摘录**（`src/services/tools/toolExecution.ts:592-596`）

```typescript
  return (
    `\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. ` +
    `Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${tool.name}", then retry this call.`
  )
```

deferred 工具（ToolSearch 机制）没被 discover 就被调用时，zod 会报「expected array, got string」——裸错误不会告诉模型该先 load 工具，这段 hint 会（578-597）。这是「错误消息为模型而非人写」的范例。

### 3.5 权限决策的遥测归类

`decisionReasonToOTelSource`（207-250）把 `PermissionDecisionReason` 映射进固定 OTel 词表（config / hook / user_permanent / user_temporary / user_reject）；`classifyToolError`（150-171）解决 minified 构建里 `error.constructor.name` 变成 `nJT` 之类三字符乱码的问题——优先 telemetryMessage、errno code、稳定 `.name`，兜底 `'Error'`。

### 3.6 catch/finally：错误的最终归宿

catch（1589-1737）：

- `McpAuthError` → 把该 MCP client 状态改成 `needs-auth`（1601-1629），驱动 `/mcp` UI 提示重授权；
- 非 Abort 错误 → 遥测（tengu_tool_use_error + OTel tool_result success:false）；
- 跑 `runPostToolUseFailureHooks`（1700-1713）；
- 返回 `formatError(error)` 的 `is_error` tool_result（1715-1737）。

finally（1738-1744）：`stopSessionActivity` + 清理 `toolDecisions` 缓存。**无论哪条路，返回值永远是 MessageUpdateLazy[]，管线不上抛。**

---

## 4. 权限回调：canUseTool（衔 E3）

### 4.1 类型契约

**真实代码摘录**（`src/hooks/useCanUseTool.tsx:27`）

```typescript
export type CanUseToolFn<Input extends Record<string, unknown> = Record<string, unknown>> = (tool: ToolType, input: Input, toolUseContext: ToolUseContext, assistantMessage: AssistantMessage, toolUseID: string, forceDecision?: PermissionDecision<Input>) => Promise<PermissionDecision<Input>>
```

这就是 E1 `QueryParams.canUseTool` 的那根线：**执行层不知道 UI 存在**，它只 await 一个返回 `PermissionDecision` 的函数。REPL 注入本 hook 的实现；SDK/headless 注入自己的。

> ⚠️ 注意：本仓库的 `useCanUseTool.tsx` 是 React Compiler 编译后带 sourcemap 的产物（文件头 `react/compiler-runtime`），逻辑行号按编译产物计。

### 4.2 裁决瀑布

`useCanUseTool`（28-191）返回的回调按序裁决：

1. **`hasPermissionsToUseTool`**（37）：规则/模式/分类器的纯配置裁决（general permission system，E3 细节）。`forceDecision` 参数可整体短路。
2. **allow**（39-53）：记录决策、`buildAllow(updatedInput ?? input)` 返回。
3. **deny**（65-92）：记录 reject；auto-mode 分类器拒绝还会 `recordAutoModeDenial` + 发 UI 通知。
4. **ask**（93-169）四级递进：
   - coordinator worker：`awaitAutomatedChecksBeforeDialog` 先等自动检查（95-109）；
   - swarm worker：转发给 leader 裁决（113-125）；
   - **投机分类器宽限赛**（126-159）：Bash 且有 `pendingClassifierCheck` 时，`Promise.race(投机结果, 2s 超时)`——§3.3 提早发车的检查在这里兑现，高置信 match 直接免弹窗 allow；
   - 兜底 `handleInteractivePermission`（160-168）：真正的弹窗（E3 主场）。

每个 await 之后都重查 `ctx.resolveIfAborted`——等待期间用户可能已经 Esc。catch 把 AbortError 折叠成 cancelAndAbort（171-179）。

### 4.3 hook 决定与规则的合成：resolveHookPermissionDecision

**真实代码摘录**（`src/services/tools/toolHooks.ts:332-343`，签名）

```typescript
export async function resolveHookPermissionDecision(
  hookPermissionResult: PermissionResult | undefined,
  tool: Tool,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<{
  decision: PermissionDecision
  input: Record<string, unknown>
}> {
```

优先级语义（332-433）：

- hook **allow** ≠ 无条件放行：交互型工具（`requiresUserInteraction`）除非 hook 给了 `updatedInput`（hook 本身就是那次交互），否则仍走 canUseTool；且 **deny/ask 规则仍然生效**——`checkRuleBasedPermissions` 复查，deny 规则压过 hook 批准；
- hook **deny** → 直接拒；
- hook 无决定 → 正常走 `canUseTool`。

一句话：**hook 能跳过弹窗，跳不过 deny 规则**。

---

## 5. hooks 层：Pre / Post / PostFailure

`src/services/tools/toolHooks.ts` 三个生成器，全部「hook 错误不毁工具结果」：

| 函数 | 位置 | 产出 |
|------|------|------|
| `runPreToolUseHooks` | 435-650 | 消费侧（toolExecution.ts:810-861 的 switch）可见 7 种事件：`message` / `hookPermissionResult` / `hookUpdatedInput`（passthrough 改 input）/ `preventContinuation` / `stopReason` / `additionalContext` / `stop`（立即终止工具） |
| `runPostToolUseHooks` | 39-191 | attachment 消息流；`updatedMCPToolOutput` 仅对 MCP 工具生效（146-151）；`preventContinuation` → `hook_stopped_continuation` attachment（118-130，query.ts 看到它就 `return { reason: 'hook_stopped' }`） |
| `runPostToolUseFailureHooks` | 193-319 | 工具失败后的 hooks，产物追加在错误 tool_result 之后 |

一个防重复细节（90-103）：JSON `{decision:"block"}` hook 会同时产出 `blockingError` 与 attachment 两条，消费侧跳过后者避免 block 原因显示两次（#31301）。

MCP 与内建的**结果时序差**在这里显形（toolExecution.ts:1477-1542）：内建工具先 `addToolResult` 再跑 PostToolUse hooks；MCP 工具**先跑 hooks**（hook 可能改写输出）**再 addToolResult**。源码自己留了 TODO 说要统一（1476）。

---

## 6. 结果回填：与查询循环的咬合

### 6.1 tool_result 是 user 消息

管线产出的每条结果都是 `createUserMessage({ content: [tool_result块, ...], toolUseResult, sourceToolAssistantUUID })`（如 toolExecution.ts:1456-1473）。要点：

- `toolUseResult`（结构化原始输出）对 subagent 默认剥离（1460-1463，省 token）；
- 权限批准时用户给的反馈文本/图片跟在 tool_result 后面（1417-1454），图片生成递增 `imagePasteIds`；
- `is_error` 的 tool_result 内容必须纯文本，图片块提升到消息顶层（1029-1046 注释：API 拒绝 is_error + 非文本）。

### 6.2 query.ts 的消费循环

**真实代码摘录**（`src/query.ts:1388-1390`）

```typescript
    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
```

消费（1392-1416）：每条 `update.message` 先 yield（UI/落盘），再 `normalizeMessagesForAPI` 过滤出 user 消息推进 `toolResults`（下一轮模型输入）；`update.newContext` 覆盖 `updatedToolUseContext`；看到 `hook_stopped_continuation` attachment 置 `shouldPreventContinuation`。

工具跑完后（1491-1528）：abort → `return { reason: 'aborted_tools' }`；hook 阻断 → `return { reason: 'hook_stopped' }`。然后才是 E1 §4.4 的附件注入——注释（1540 附近）强调必须等 tool_result 全部就位，**API 禁止 tool_result 与普通 user 消息交错**。

### 6.3 API 400 防护：孤儿 tool_use 安全网

**真实代码摘录**（`src/query.ts:126-152`，节选）

```typescript
function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // Extract all tool use blocks from this assistant message
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    // Emit an interruption message for each tool use
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
```

调用点覆盖全部「工具没跑完但对话要继续」的路径：模型 fallback（query.ts:907）、模型抛错（992）、流中 abort 无 STE（1033）。**不变式：进入下一次 API 调用前，每个 tool_use 必有同 id 的 tool_result**，否则 API 400。

工具批结束后还有 `refreshTools` 钩子（query.ts:1668-1669）：中途连上的 MCP server 的新工具在下一轮对模型可见。

---

## 7. StreamingToolExecutor：流中执行

### 7.1 动机与状态机

批处理路径要等整条流结束才 `runTools`；STE（Statsig 门控 `tengu_streaming_tool_execution2`，E1 §2.4）让 tool_use 块**边流入边执行**，工具执行与模型继续吐字重叠。

每个工具是一条 `TrackedTool`（`StreamingToolExecutor.ts:21-32`）：`status: 'queued' | 'executing' | 'completed' | 'yielded'`，结果缓冲在 `results`，进度单独放 `pendingProgress`（**进度即时冒、结果按序出**）。

### 7.2 入队与并发闸

`addTool`（76-124）：工具不存在直接造一条 completed 的错误记录；否则 safeParse + isConcurrencySafe（fail-closed，与 §2.2 同款三重兜底，104-113）后入队 `processQueue`。

`canExecuteTool`（129-135）：没人在跑，或「我 safe 且在跑的全 safe」。`processQueue`（140-151）顺序扫描，遇到不能跑的 **unsafe 工具就 break**——unsafe 必须维持顺序，不能被后来的 safe 插队。

### 7.3 兄弟连坐：只有 Bash 会传染

**真实代码摘录**（`src/services/tools/StreamingToolExecutor.ts:354-364`）

```typescript
        if (isErrorResult) {
          thisToolErrored = true
          // Only Bash errors cancel siblings. Bash commands often have implicit
          // dependency chains (e.g. mkdir fails → subsequent commands pointless).
          // Read/WebFetch/etc are independent — one failure shouldn't nuke the rest.
          if (tool.block.name === BASH_TOOL_NAME) {
            this.hasErrored = true
            this.erroredToolDescription = this.getToolDescription(tool)
            this.siblingAbortController.abort('sibling_error')
          }
        }
```

abort 树三层（45-48、294-318 注释）：`toolUseContext.abortController`（父，用户/查询级）→ `siblingAbortController`（STE 级，Bash 连坐用；**abort 它不会终止父**，turn 不会因此结束）→ per-tool child controller。per-tool controller 上挂了 bubble-up 监听（304-318）：权限弹窗拒绝产生的 abort 必须冒回查询控制器，否则 ExitPlanMode 的「clear context + auto」会把 REJECT_MESSAGE 发给模型而不是终止 turn（#21056 回归）。

被连坐/中断的工具拿合成错误（153-205）：`user_interrupted` 用 REJECT_MESSAGE（UI 显示「User rejected」而非「Error」）；`streaming_fallback` 是 fallback 丢弃（`discard()`，69-71，对应 E1 §3.5 重建 STE）；`sibling_error` 带肇事工具描述。`getAbortReason`（210-231）里还有 `interruptBehavior` 的分流：`reason === 'interrupt'`（用户新消息）只砍 `'cancel'` 工具，`'block'` 工具继续跑完。

### 7.4 两个消费口

- `getCompletedResults()`（412-440，同步）：流还在进行时被 query.ts:858 反复调用——先无条件倒空所有 `pendingProgress`，再按队列顺序 yield 已完成工具的结果；遇到「executing 且 unsafe」就 break（保序）。
- `getRemainingResults()`（453-490，异步）：流结束后 query.ts:1389 接管——循环 processQueue + 收割，无果可收时 `Promise.race(执行中 promises, progress 唤醒)`，进度一到立即醒来 yield。

---

## 8. MCP 工具：同一形状，不同来源

### 8.1 适配：MCPTool 基座 + per-tool 覆写

`MCPTool`（`src/tools/MCPTool/MCPTool.ts:27-77`）是个几乎全靠覆写的模板：`inputSchema` 是 `z.object({}).passthrough()`（14），`maxResultSizeChars: 100_000`（35），`mapToolResultToToolResultBlockParam` 直传 content（70-76）。

真正的组装在 `fetchToolsForClient`（`src/services/mcp/client.ts:1737-1826`）：对 server 返回的每个工具 `{ ...MCPTool, ...覆写 }`：

| 覆写 | 位置 | 语义 |
|------|------|------|
| `name` | 1767 | `mcp__server__tool`；SDK no-prefix 模式用原名（可覆盖 builtin） |
| `isConcurrencySafe` / `isReadOnly` | 1789-1794 | 映射 MCP `annotations.readOnlyHint ?? false`——远端不声明只读就当会写 |
| `isDestructive` / `isOpenWorld` | 1798-1803 | `destructiveHint` / `openWorldHint` |
| `inputJSONSchema` | 1807 | **直接用 server 的 JSON Schema**，不经 zod 转换（发给 API 用） |
| `checkPermissions` | 1808-1826 | 返回 `passthrough` + 建议「allow 整个工具」的 suggestions |
| `searchHint` / `alwaysLoad` | 1773-1779 | 读 `_meta['anthropic/...']`；searchHint 压平空白防注入 deferred 列表 |
| `call` | 1827-1903 | `ensureConnectedClient` + 带 URL-elicitation 重试的 RPC；开始/完成各发一次 `mcp_progress`（1839-1850、1878-1889）；返回把 `_meta`/`structuredContent` 装进 `mcpMeta`（1891-1903） |

### 8.2 与内建工具的差异清单

| 维度 | 内建 | MCP |
|------|------|-----|
| 输入校验 | zod schema | `passthrough` zod（形同放行）+ server 侧校验；API 见 `inputJSONSchema` |
| 并发安全 | 各工具按 input 精确判断 | 只看 `readOnlyHint` 注解 |
| 结果时序 | 先 addToolResult 再 PostToolUse hooks | 先 hooks（可改输出）再 addToolResult（toolExecution.ts:1477-1542） |
| 结果元数据 | 无 | `mcpMeta` 透传给 SDK；agentId 下剥离（1464） |
| 认证失败 | — | `McpAuthError` → client 置 `needs-auth`（1601-1629） |
| deny 规则 | 按工具名 | `mcp__server` 前缀规则可整台 server 摘除（tools.ts:259-262 注释） |

其余管线（编排、hooks、权限、持久化）**完全同一条**——这是 Tool 胖接口的回报。

---

## 9. 进度事件与大结果持久化

### 9.1 进度链路

`tool.call` 的第 5 参 `onProgress`（Tool.ts:379-385）→ 管线包装（toolExecution.ts:1216-1221）→ `streamedCheckPermissionsAndCallTool` 里 `createProgressMessage` 入流（549-556）→ STE 场景进 `pendingProgress` 即时 yield（StreamingToolExecutor.ts:366-374）→ query.ts yield 给 UI。进度消息**不进** toolResults（不发给模型），只服务 UI/遥测。

### 9.2 大结果持久化

**真实代码摘录**（`src/utils/toolResultStorage.ts:205-226`，节选）

```typescript
export async function processToolResultBlock<T>(
  tool: {
    name: string
    maxResultSizeChars: number
    mapToolResultToToolResultBlockParam: (
      result: T,
      toolUseID: string,
    ) => ToolResultBlockParam
  },
  toolUseResult: T,
  toolUseID: string,
): Promise<ToolResultBlockParam> {
  const toolResultBlock = tool.mapToolResultToToolResultBlockParam(
    toolUseResult,
    toolUseID,
  )
  return maybePersistLargeToolResult(
    toolResultBlock,
    tool.name,
    getPersistenceThreshold(tool.name, tool.maxResultSizeChars),
  )
}
```

超过阈值的结果写盘，模型收到 `<persisted-output>` 包裹的预览 + 文件路径（PERSISTED_OUTPUT_TAG，29-31）。`getPersistenceThreshold`（55-76）：`Infinity` 是硬退出（Read 工具——把 Read 的输出落盘再让模型 Read 回来是死循环，816 附近注释），有限值可被远端配置 per-tool 覆写。非 MCP 工具用 §3.3 ⑧ 段缓存的 `mappedToolResultBlock` 走 `processPreMappedToolResultBlock`（232-241）免二次映射。

---

## 10. 对 Koda 最重要的 3 个设计洞察

### 洞察 1：工具管线的失败必须「向内折叠」而不是「向上抛出」

cc-haha 全链路（不存在 / 校验失败 / 权限拒绝 / 执行抛错 / 兄弟连坐 / abort）统一折叠成 `is_error: true` 的 tool_result。收益：

- 循环层零 try/catch（E1 §4.2）；
- API 成对不变式永远成立（§6.3 安全网只兜「没跑到」的，不兜「跑挂了」的）；
- 错误文本是**给模型的行动指南**（buildSchemaNotSentHint 是范本），不是给人看的堆栈。

Koda 的工具执行器应该同样定义为 `execute(toolUse): ToolResult`（**全函数、不抛错**），把「谁看到什么错误」当产品问题设计。

### 洞察 2：并发是按 input 证明出来的特权，且 fail-closed 要一路贯彻

`isConcurrencySafe(input)` 吃 input 而非静态标记（`Bash(ls)` 与 `Bash(rm)` 不同命）；buildTool 默认 false、parse 失败当 unsafe、判断函数抛错当 unsafe、MCP 无注解当会写——**四层同一方向**。加上「连续 safe 合批、unsafe 独占、contextModifier 批后按序重放」，得到一个既快（≤10 并发）又不需要锁的模型。Koda 直接抄这个谓词签名即可。

### 洞察 3：权限是「决策函数」不是「UI」，hook 能跳弹窗跳不过 deny

执行层只依赖 `CanUseToolFn` 一个类型；REPL/SDK/coordinator/swarm 各自注入实现。裁决合成规则值得原样保留：

```text
deny 规则 > hook allow > 交互弹窗；
hook allow 只免「问用户」，不免「规则审查」；
交互型工具的 hook allow 需要附带 updatedInput（hook 即交互）才算数。
```

外加两个延迟优化可以二期抄：投机分类器（权限检查与 hooks 并行预热 + ask 时 2s 宽限赛）与 STE（工具执行与流式输出时间重叠）。

---

## 11. E3（权限系统）拆解最该先看的入口

| 顺序 | 文件 | 看什么 |
|:----:|------|--------|
| 1 | `src/utils/permissions/permissions.ts` | `hasPermissionsToUseTool` / `checkRuleBasedPermissions`：规则引擎本体 |
| 2 | `src/utils/permissions/PermissionResult.js`（类型） | `PermissionResult` / `PermissionDecision` / `decisionReason` 全集 |
| 3 | `src/hooks/toolPermission/handlers/*.ts` | interactive / coordinator / swarm 三个 ask 处理器 |
| 4 | `src/hooks/toolPermission/PermissionContext.ts` | 弹窗队列、cancelAndAbort 语义 |
| 5 | `src/tools/BashTool/bashPermissions.ts` | 投机分类器的 start/peek/consume 生命周期 |

E2 把权限当作黑盒决策函数；E3 拆盒子。

---

## 12. 核查清单

> 供第二个 agent 独立验证。标注 ⚠️stub 表示文件本身是占位。

### §1 静态形态

| # | 位置 | 摘要 |
|---|------|------|
| 1 | `src/Tool.ts:362-366` | `Tool<Input, Output, P>` 泛型签名 |
| 2 | `src/Tool.ts:379-385` | `call(args, context, canUseTool, parentMessage, onProgress?)` |
| 3 | `src/Tool.ts:402` | `isConcurrencySafe(input)` 吃 input |
| 4 | `src/Tool.ts:416` | `interruptBehavior?(): 'cancel' \| 'block'` |
| 5 | `src/Tool.ts:466` | `maxResultSizeChars`；Infinity = 永不落盘 |
| 6 | `src/Tool.ts:481` | `backfillObservableInput` 只改观察侧 |
| 7 | `src/Tool.ts:557-560` | `mapToolResultToToolResultBlockParam` |
| 8 | `src/Tool.ts:158-300` | `ToolUseContext` 全集 |
| 9 | `src/Tool.ts:321-336` | `ToolResult`：data + newMessages + contextModifier + mcpMeta |
| 10 | `src/Tool.ts:757-769` | `TOOL_DEFAULTS` fail-closed |
| 11 | `src/Tool.ts:783-792` | `buildTool` 展开 |
| 12 | `src/tools.ts:194-252` | `getAllBaseTools` 全量池 + 门控 |
| 13 | `src/tools.ts:263-270` | `filterToolsByDenyRules` blanket deny |
| 14 | `src/tools.ts:272-328` | `getTools`：simple 模式 / REPL 隐藏 / isEnabled |
| 15 | `src/tools.ts:346-368` | `assembleToolPool`：built-in 前缀分区排序保 prompt cache |

### §2 编排层

| # | 位置 | 摘要 |
|---|------|------|
| 16 | `src/services/tools/toolOrchestration.ts:8-12` | 并发上限默认 10（env 可调） |
| 17 | `src/services/tools/toolOrchestration.ts:19-82` | `runTools`：safe 并发 / unsafe 串行 |
| 18 | `src/services/tools/toolOrchestration.ts:42-63` | 并发批 contextModifier 批后按 block 顺序重放 |
| 19 | `src/services/tools/toolOrchestration.ts:91-116` | `partitionToolCalls` 三重 fail-closed |
| 20 | `src/services/tools/toolOrchestration.ts:118-150` | `runToolsSerially` |
| 21 | `src/services/tools/toolOrchestration.ts:152-177` | `runToolsConcurrently`：`all(..., N)` |
| 22 | `src/services/tools/toolOrchestration.ts:179-188` | `markToolUseAsComplete` |

### §3 执行层

| # | 位置 | 摘要 |
|---|------|------|
| 23 | `src/services/tools/toolExecution.ts:337-356` | `runToolUse`：查找 + alias 兜底 |
| 24 | `src/services/tools/toolExecution.ts:369-411` | 工具不存在 → is_error tool_result |
| 25 | `src/services/tools/toolExecution.ts:415-453` | 已 abort → 取消 tool_result |
| 26 | `src/services/tools/toolExecution.ts:469-489` | 外层 catch 折叠所有管线错误 |
| 27 | `src/services/tools/toolExecution.ts:492-570` | `streamedCheckPermissionsAndCallTool`：Stream 并轨 hack |
| 28 | `src/services/tools/toolExecution.ts:578-597` | `buildSchemaNotSentHint` |
| 29 | `src/services/tools/toolExecution.ts:599-613` | `checkPermissionsAndCallTool` 签名 |
| 30 | `src/services/tools/toolExecution.ts:615-680` | zod safeParse → InputValidationError |
| 31 | `src/services/tools/toolExecution.ts:683-733` | `validateInput` 值校验 |
| 32 | `src/services/tools/toolExecution.ts:740-752` | Bash 投机分类器提早发车 |
| 33 | `src/services/tools/toolExecution.ts:756-793` | `_simulatedSedEdit` 剥离 + backfill 克隆 |
| 34 | `src/services/tools/toolExecution.ts:800-862` | PreToolUse hooks 消费 switch（7 种事件） |
| 35 | `src/services/tools/toolExecution.ts:921-931` | `resolveHookPermissionDecision` 调用点 |
| 36 | `src/services/tools/toolExecution.ts:995-1104` | 权限非 allow 分支：is_error + retry 提示 |
| 37 | `src/services/tools/toolExecution.ts:1189-1205` | callInput 收敛：file_path 还原保 VCR 哈希 |
| 38 | `src/services/tools/toolExecution.ts:1206-1222` | `tool.call` + onProgress 包装 |
| 39 | `src/services/tools/toolExecution.ts:1292-1301` | 结果映射一次并缓存 |
| 40 | `src/services/tools/toolExecution.ts:1403-1474` | `addToolResult`：持久化 + 反馈块 + imagePasteIds |
| 41 | `src/services/tools/toolExecution.ts:1477-1542` | 内建先结果后 hooks；MCP 先 hooks 后结果 |
| 42 | `src/services/tools/toolExecution.ts:1601-1629` | `McpAuthError` → needs-auth |
| 43 | `src/services/tools/toolExecution.ts:1715-1744` | 错误 tool_result + finally 清理 |
| 44 | `src/services/tools/toolExecution.ts:150-171` | `classifyToolError`（minify 防御） |
| 45 | `src/services/tools/toolExecution.ts:207-250` | `decisionReasonToOTelSource` 词表 |

### §4–5 权限与 hooks

| # | 位置 | 摘要 |
|---|------|------|
| 46 | `src/hooks/useCanUseTool.tsx:27` | `CanUseToolFn` 类型契约 |
| 47 | `src/hooks/useCanUseTool.tsx:37` | `hasPermissionsToUseTool` / forceDecision 短路 |
| 48 | `src/hooks/useCanUseTool.tsx:93-169` | ask 分支：coordinator → swarm → 分类器宽限赛 → 弹窗 |
| 49 | `src/hooks/useCanUseTool.tsx:126-159` | 投机分类器 2s `Promise.race` |
| 50 | `src/services/tools/toolHooks.ts:332-433` | `resolveHookPermissionDecision`：hook allow 仍受 deny/ask 规则 |
| 51 | `src/services/tools/toolHooks.ts:435` | `runPreToolUseHooks` 入口 |
| 52 | `src/services/tools/toolHooks.ts:39-191` | `runPostToolUseHooks`：updatedMCPToolOutput / preventContinuation |
| 53 | `src/services/tools/toolHooks.ts:90-103` | block 原因去重（#31301） |
| 54 | `src/services/tools/toolHooks.ts:193-319` | `runPostToolUseFailureHooks` |

### §6 回填与 §7 STE

| # | 位置 | 摘要 |
|---|------|------|
| 55 | `src/query.ts:126-152` | `yieldMissingToolResultBlocks` 孤儿安全网 |
| 56 | `src/query.ts:907, 992, 1033` | 安全网三个调用点（fallback / 模型错误 / abort） |
| 57 | `src/query.ts:1388-1390` | STE vs runTools 分发 |
| 58 | `src/query.ts:1392-1416` | 消费循环：yield + normalize + newContext |
| 59 | `src/query.ts:1491-1528` | `aborted_tools` / `hook_stopped` |
| 60 | `src/query.ts:1668-1669` | `refreshTools`：中途 MCP 工具可见 |
| 61 | `src/services/tools/StreamingToolExecutor.ts:21-32` | `TrackedTool` 状态机 |
| 62 | `src/services/tools/StreamingToolExecutor.ts:76-124` | `addTool`：fail-closed + processQueue |
| 63 | `src/services/tools/StreamingToolExecutor.ts:129-151` | 并发闸 + unsafe 保序 break |
| 64 | `src/services/tools/StreamingToolExecutor.ts:354-364` | 只有 Bash 错误连坐兄弟 |
| 65 | `src/services/tools/StreamingToolExecutor.ts:301-318` | per-tool abort bubble-up（#21056） |
| 66 | `src/services/tools/StreamingToolExecutor.ts:412-440` | `getCompletedResults`：进度即时、结果保序 |
| 67 | `src/services/tools/StreamingToolExecutor.ts:453-490` | `getRemainingResults`：race(执行, 进度唤醒) |

### §8–9 MCP 与持久化

| # | 位置 | 摘要 |
|---|------|------|
| 68 | `src/tools/MCPTool/MCPTool.ts:27-77` | MCPTool 基座：passthrough schema、100k 上限 |
| 69 | `src/services/mcp/client.ts:1737-1826` | `fetchToolsForClient` 覆写组装 |
| 70 | `src/services/mcp/client.ts:1789-1794` | `readOnlyHint ?? false` → 并发/只读 |
| 71 | `src/services/mcp/client.ts:1807` | `inputJSONSchema` 直传 server schema |
| 72 | `src/services/mcp/client.ts:1839-1850` | mcp_progress started 事件 |
| 73 | `src/utils/toolResultStorage.ts:29-31` | `PERSISTED_OUTPUT_TAG` |
| 74 | `src/utils/toolResultStorage.ts:55-76` | `getPersistenceThreshold`：Infinity 硬退出 + 远端覆写 |
| 75 | `src/utils/toolResultStorage.ts:205-226` | `processToolResultBlock` |
| 76 | `src/utils/toolResultStorage.ts:232-241` | `processPreMappedToolResultBlock` 免二次映射 |

---

## 13. 一句话带走

> **E2 = 一条永不抛错的工具管线：分批靠 input 级 `isConcurrencySafe` 且四层 fail-closed；单工具九段（parse → validate → PreHooks → hook 决议 → canUseTool → call → 映射/落盘 → PostHooks → 组消息）任何一段失败都折叠成 `is_error` tool_result；权限是可注入的决策函数（hook 跳得过弹窗跳不过 deny）；MCP 工具靠覆写基座变成同形 Tool 走同一条管线；孤儿 tool_use 由 `yieldMissingToolResultBlocks` 兜底保 API 成对不变式。**

E1 给出「工具是循环的一个阶段」；E2 给出「这个阶段内部是一条全函数管线」。下一相 E3 拆开 `canUseTool` 黑盒里的规则引擎与弹窗队列。
