# cc-haha E0 相拆解：类型底座

> **本文定位**：Koda 自研执行引擎的设计输入调研。E0 是 9 相拆解（E0–E8）的第一相，只拆**类型与接口定义及其设计意图**，不拆运行逻辑。后续相（E1 查询循环、E2 工具系统、E3 权限、E4 上下文…）都建立在本相的类型拆解之上。
>
> **拆解对象**：`/Users/waybi/Desktop/my/cc-haha` —— Claude Code 桌面工作台（Bun + Electron，本地改造版，上游为泄露的 Claude Code 源码 zip，见 git log `f5a40b86 init: add source code from src.zip`、`124912c7 feat: fix leaked source to be locally runnable`）。
>
> **证据分级**（本文每条论断标注其一）：
> - **真实代码摘录**：该行在仓库中真实存在，可按 file:line 回查。
> - **基于使用点的重建**：目标类型定义文件是 stub（见 §0），类型形状从工厂函数、Zod schema、消费点三方交叉推断。这类论断给出的是**多个独立证据点**，而不是单一权威定义。
> - **可迁移模式**：对 Koda 的设计建议，不是 cc-haha 的事实陈述。
>
> **速览**：§0 方法论前置 → §1 消息类型体系（信封模式） → §2 Tool 接口（胖接口 + 默认值） → §3 架构锚点（E1/E3/E4） → §4 三大设计洞察 → §5 E1 入口指引 → §6 核查清单（87 条）

---

## 0. 前置事实：这份源码的类型底座有一半是 stub，必须先知道去哪找真相

**业务痛点（对拆解者而言）**：拆开 `src/types/message.ts` 想看消息类型定义，会发现它只有 34 行——一个 `Proxy` 占位符。

```typescript
// src/types/message.ts:1-2
// @generated stub from scan-missing-imports
// 该文件自动生成，对应 ant-internal 的 feature() gated 模块。
```

上游泄露的 zip 缺了一批文件（多为 Anthropic 内部 feature-gated 模块），本地改造者用 `scan-missing-imports` 脚本生成了 Proxy stub 补齐 import，让 `bun build` 能解析、运行时靠 Proxy 兜底。

**src 下共 144 个 stub 文件**（统计口径：`grep -rl "scan-missing-imports" src --include='*.ts' --include='*.tsx'`；不加 `--include` 过滤为 173，多出 29 个 `.txt` 等资源类 stub）。E0 最关心的两个类型文件都在 stub 之列：

| 文件 | 状态 | 本应定义 | 重建证据来源 |
|------|------|---------|-------------|
| `src/types/message.ts` | **stub** | `Message` / `UserMessage` / `AssistantMessage` / `SystemMessage` / `ProgressMessage` / `StreamEvent` 等全部消息类型 | 工厂函数 `src/utils/messages.ts`、SDK Zod schema `src/entrypoints/sdk/coreSchemas.ts`、消费点 `src/query.ts` / `src/QueryEngine.ts` |
| `src/types/tools.ts` | **stub** | 联合 `ToolProgressData` 及 7 种具体工具进度类型 | 进度产生点（`BashTool.tsx:668`、`AgentTool.tsx:800`、`services/mcp/client.ts:1844`）、`src/types/hooks.ts:234` |
| `src/types/permissions.ts` | **真实**（441 行） | 权限类型全家桶 | 直接可读 |
| `src/types/logs.ts` | **真实**（330 行） | 持久化条目 `Entry` / `TranscriptMessage` / `SerializedMessage` | 直接可读 |
| `src/types/ids.ts` | **真实**（44 行） | `SessionId` / `AgentId` 品牌类型 | 直接可读 |
| `src/Tool.ts` | **真实**（792 行） | `Tool` 接口、`ToolUseContext`、`buildTool` | 直接可读 |
| `src/types/hooks.ts` | **真实**（290 行） | Hook 类型、`HookProgress` | 直接可读 |
| `src/entrypoints/sdk/coreSchemas.ts` | **真实**（1905 行） | 全部 `SDK*Message` 的 Zod schema | 直接可读 |

**这对拆解方法论的影响**：类型-only import 在 Bun 构建时被擦除，所以 stub 不影响运行；但也意味着「消息类型长什么样」没有单一权威文件。

本文采用**三方交叉验证**：

- **工厂函数**（构造点）——展示全部字段
- **Zod schema**（线格式契约）——展示线上形状
- **消费点 switch**——展示判别字段的合法值集合

三方一致的形状才写入本文。

**对 Koda 的启示**：这不是 cc-haha 的设计意图，而是泄露源码的考古现实。但它意外地证明了一件事——**这套类型设计的信息冗余度很高**：即使核心定义文件丢失，三方仍能完整重建类型形状。判别联合 + 集中工厂的设计让类型知识散布在多个可互相印证的位置。

---

## 1. 消息与事件类型体系

### 1.1 业务痛点：一个 agentic loop 里流动的远不止「对话消息」

执行引擎的主循环里同时流动着至少六类东西：

1. 要发给模型的对话（user/assistant，含 tool_use/tool_result 块）；
2. 模型流式输出的增量事件（SSE delta）；
3. 工具执行的实时进度（bash 输出了几行、agent 跑到第几步）；
4. 系统自身的告示（compact 边界、权限重试、API 重试）；
5. 不发给模型但要渲染的附件（todo 提醒、文件上下文注入）；
6. 控制信号（删除某条消息的 tombstone、工具使用摘要）。

如果没有统一的类型体系，每个消费者（渲染层、持久化层、API 序列化层、SDK 适配层）都要各自发明「这是什么」的判断逻辑，字段名和判别值必然漂移—— Routa phase0 拆解里的「词汇不统一」问题在这里同样成立。

### 1.2 cc-haha 的堵法：判别联合信封 + 内嵌线格式载荷

**核心手法：每条消息是一个带 `type` 判别字段的信封（envelope），线格式载荷原样内嵌在 `message` 字段里，内部扩展字段平铺在信封上。**

**基于使用点的重建**（构造点：`src/utils/messages.ts:361-418`）

```typescript
// AssistantMessage 的信封形状 —— 由 baseCreateAssistantMessage 的返回对象重建
{
  type: 'assistant',              // 判别字段（信封层）
  uuid: randomUUID(),             // 内部：持久化主键 / parentUuid 链
  timestamp: new Date().toISOString(),
  message: {                      // 线格式层：与 Anthropic API BetaMessage 对齐
    id, container, model,
    role: 'assistant',
    stop_reason, stop_sequence,
    type: 'message',
    usage,                        // token 用量，线格式字段
    content,                      // BetaContentBlock[] —— 线格式 ContentBlock 谱系
    context_management,
  },
  // 以下为内部扩展（永不发往 API）：
  requestId, apiError, error, errorDetails, businessErrorCode,
  isApiErrorMessage, isVirtual,
}
```

**真实代码摘录**（`src/utils/messages.ts:394-417`，`baseCreateAssistantMessage` 的 return 语句完整列出了信封字段）

```typescript
return {
  type: 'assistant',
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
  message: {
    id: randomUUID(), container: null, model: SYNTHETIC_MODEL,
    role: 'assistant', stop_reason: 'stop_sequence', stop_sequence: '',
    type: 'message', usage, content, context_management: null,
  },
  requestId: undefined,
  apiError, error, errorDetails, businessErrorCode, isApiErrorMessage, isVirtual,
}
```

**UserMessage 同构**（`src/utils/messages.ts:514-534`）：`type: 'user'` + `message: { role: 'user', content }` + 内部扩展 `isMeta / isVisibleInTranscriptOnly / isVirtual / isCompactSummary / summarizeMetadata / toolUseResult / mcpMeta / imagePasteIds / sourceToolAssistantUUID / permissionMode / origin`。

**这个设计的精妙处**：

- `message` 字段就是 API 请求体里的 `MessageParam`——序列化发往 API 时几乎零转换。
- `uuid`、`isMeta`、`toolUseResult` 这些内部字段长在信封上，天然不会被误发。
- 线格式与内部扩展的边界是**结构性的**（嵌套层级），不是靠命名约定或注释维系的。

### 1.3 Message 联合的 7 个变体：判别字段 `type` 的合法值

**基于使用点的重建**（三方交叉：query 循环的产出类型、QueryEngine 的消费 switch、工厂函数族）

`src/query.ts:222-231` 给出了 query 生成器的产出联合——这是全仓对「主循环里流动什么」最权威的声明：

**真实代码摘录**

```typescript
// src/query.ts:222-231
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

`src/QueryEngine.ts:779-1010` 的消费 switch 逐个处理：`tombstone`（控制信号，跳过）、`assistant`、`progress`、`user`、`stream_event`、`attachment`、`stream_request_start`、`system`、`tool_use_summary` 共 9 个 case。

综合工厂函数族（`src/utils/messages.ts`）与消费点，`Message` 的判别联合为：

| `type` 值 | 变体 | 构造点（file:line） | 发给 API？ | 落盘？ |
|-----------|------|---------------------|-----------|--------|
| `'user'` | `UserMessage`（含 tool_result 载体） | `messages.ts:472` `createUserMessage` | ✅ | ✅ |
| `'assistant'` | `AssistantMessage` | `messages.ts:420` `createAssistantMessage` | ✅ | ✅ |
| `'system'` | `SystemMessage`（subtype 二级判别：`informational`/`compact_boundary`/`permission_retry`/`api_retry`/`bridge_status` 等十余种） | `messages.ts:4452` `createSystemMessage` 及同族 | 仅 `local_command` 子型（`normalizeMessagesForAPI` 转为 user 消息，`messages.ts:2106-2120`） | ✅ |
| `'attachment'` | `AttachmentMessage` | `src/utils/attachments.ts:3197-3206` `createAttachmentMessage` | 经重排后作为上下文注入（`reorderAttachmentsForAPI`） | ✅ |
| `'progress'` | `ProgressMessage<P>` | `messages.ts:615-632` `createProgressMessage` | ❌ | ❌（见 §4 洞察 3） |
| `'tombstone'` | `TombstoneMessage` | 控制信号，QueryEngine 直接跳过（`QueryEngine.ts:780-782`） | ❌ | 语义上用于删除 |
| `'tool_use_summary'` | `ToolUseSummaryMessage` | `messages.ts:5247` `createToolUseSummaryMessage` | ❌ | ❌（仅 SDK 发射，非 `Message` 联合成员） |

**注意两个不在 `Message` 联合里、但与消息同通道流动的事件类型**：

- **`StreamEvent`**：流式增量。形状为 `{ type: 'stream_event', event: BetaRawMessageStreamEvent, ttftMs? }`。构造点 `src/services/api/claude.ts:2441-2445`：

  **真实代码摘录**

  ```typescript
  yield {
    type: "stream_event",
    event: part,        // part 是 SDK 原始 SSE 事件：message_start / content_block_start /
                        // content_block_delta / content_block_stop / message_delta / message_stop
    ...(part.type === "message_start" ? { ttftMs } : undefined),
  };
  ```

  内部 `StreamEvent` 与 SDK 线格式 `SDKPartialAssistantMessage`（`coreSchemas.ts:1496-1504`）一一对应，适配器 `src/remote/sdkMessageAdapter.ts:45-50` 的 `convertStreamEvent` 只有两行——这就是「线格式对齐」的红利。

- **`RequestStartEvent`**：`{ type: 'stream_request_start' }`，每次 API 请求开始发一次（`src/query.ts:340`），用于 UI 的「请求已开始」信号。

### 1.4 ContentBlock 谱系：不自建，直接复用 SDK 类型

cc-haha **没有**自定义 ContentBlock 类型。全部直接 import 自 `@anthropic-ai/sdk`：

- `BetaContentBlock`（assistant 侧内容块：text / thinking / redacted_thinking / tool_use）——`src/utils/messages.ts:101-107`；
- `ContentBlockParam`（user 侧输入块：text / image / document / tool_result）——`messages.ts:488`；
- `ToolUseBlock` / `ToolResultBlockParam`（工具调用与结果）——`src/Tool.ts:1-4`。

工具结果在对话里的载体是 **user 消息里的 `tool_result` 块**（API 契约如此），构造示例见 `src/query.ts:138-149`（`yieldMissingToolResultBlocks` 为每个未完成的 tool_use 合成 `is_error: true` 的 tool_result）。

同时信封上的 `toolUseResult` 字段保存**结构化**的工具输出（`messages.ts:493`），与 `tool_result` 块的文本化内容分离——模型看文本，UI/SDK 看结构化数据。

**desktop 本地的归一化视角**（本地改造者新增）：`desktop/src/lib/trace/types.ts:1-11` 定义了 5 变体的 `NormalizedBlock`（text / thinking / tool_use / tool_result / image）和 4 角色的 `NormalizedMessage`——可以视为对 ContentBlock 谱系的最小化投影，证明其本质就是这五类。

### 1.5 线格式与内部扩展的强制边界：`normalizeMessagesForAPI`

信封模式让内部字段「结构上发不出去」，但还有一层**主动过滤**在 API 边界上：`normalizeMessagesForAPI`（`src/utils/messages.ts:2004`）在每次请求前执行：

**真实代码摘录**（`src/utils/messages.ts:2014-2016`、`2084-2103`，关键过滤逻辑）

```typescript
// 剥离 isVirtual 消息（展示专用，如 REPL 内层工具调用）
const reorderedMessages = reorderAttachmentsForAPI(messages).filter(
  m => !((m.type === 'user' || m.type === 'assistant') && m.isVirtual),
)
// …
// progress、非 local_command 的 system、合成 API 错误消息，全部不进 API
if (
  _.type === 'progress' ||
  (_.type === 'system' && !isSystemLocalCommandMessage(_)) ||
  isSyntheticApiErrorMessage(_)
) { return false }
```

另外它还把连续的 user 消息合并（Bedrock 不支持多条 user，`messages.ts:2122-2125` 注释）、按需剥离 tool_reference 块（`messages.ts:2132-2133`）。

**类型的架构作用在此显形**：`isVirtual`、`isMeta`、`type: 'progress'` 这些信封字段就是过滤器的判定依据——E0 定义的信封字段，直接决定了 E4（上下文管理）能在 API 边界上做什么手术。

### 1.6 可迁移模式

> 信封模式和判别联合值得全盘吸收；stub 容忍和双轨存储是历史包袱，需规避。

#### 值得吸收

1. **信封 + 内嵌线格式载荷**

   信封形状：`{ type, uuid, timestamp, message: <wire>, ...内部字段 }`。Koda 若对齐 OpenAI/Anthropic 任一 API，内部消息类型应是「线格式的超集包装」而非平行的新类型——适配成本趋零（`sdkMessageAdapter.ts:45-50` 两行代码就是证据）。

2. **判别字段用字符串字面量联合**

   `type: 'user' | 'assistant' | ...`，system 类消息用二级判别（`type: 'system'` + `subtype: 'compact_boundary' | ...`）。二级判别让「系统告示」这个开放集合可以无限扩展而不污染主联合。

3. **集中工厂**

   `createUserMessage` / `createAssistantMessage` / `createProgressMessage` / `createSystemMessage`——默认值（usage 全零、`NO_CONTENT_MESSAGE` 防空串）只写一次。cc-haha 甚至没有 `interface` 定义文件可查（stub 了），工厂函数实际上**就是**类型定义的权威载体。

#### 需要规避

1. **让类型定义文件的缺失能被容忍**

   cc-haha 的 stub 是考古事故不是设计。但它暴露了 `src/Tool.ts` 里大量 `import type ... from './types/message.js'` 的注释「Import from centralized location to break import cycles」（`Tool.ts:41-48`）——类型集中文件的初衷是破循环依赖，这个动机是真实的。Koda 应保留「纯类型、零运行时依赖」的类型层文件（`permissions.ts:1-7` 的头注释明确写了这个原则）。

2. **结构化结果与文本结果双轨**

   `toolUseResult`（信封）vs `tool_result` 块（线格式）双写是历史包袱，resume/compact 都要小心维护两者一致性。Koda 可以考虑只存结构化结果，文本化在 API 边界惰性生成。

---

## 2. Tool 接口

### 2.1 业务痛点：60+ 个工具，每个都要回答同一组问题

一个 agentic 执行引擎对每个工具都要问：你叫什么、入参合法吗、只读吗、能并发吗、会破坏数据吗、需要用户批准吗、结果怎么渲染、结果太大怎么办、提示词怎么写。如果没有统一接口，query loop 里就是 60 个 if-else；有了统一接口但全靠可选方法，每个消费点又要写 `tool.foo?.() ?? default` 的防御链，默认值散落各处（Routa phase0 的「默认值散落」问题）。

### 2.2 cc-haha 的堵法：胖接口 + `buildTool` 默认值收口

**`Tool` 是一个泛型胖接口**（`src/Tool.ts:362-695`），三个泛型参数：

- `Input extends AnyObject`——Zod schema 类型
- `Output`——结构化输出
- `P extends ToolProgressData`——进度事件类型

约 40 个成员，按职责分六组：

| 组 | 成员（file:line 在 `src/Tool.ts` 内） | 服务的后续相 |
|----|--------------------------------------|-------------|
| 身份与契约 | `name`（456）、`aliases`（371）、`inputSchema`（394，**Zod schema 即入参类型**）、`inputJSONSchema`（397，MCP 工具直通 JSON Schema）、`outputSchema`（400）、`searchHint`（378）、`shouldDefer`/`alwaysLoad`（442/449） | E2 |
| 执行 | `call(args, context, canUseTool, parentMessage, onProgress)`（379-385）、`validateInput`（489）、`maxResultSizeChars`（466）、`interruptBehavior`（416） | E1/E2 |
| 权限与安全 | `checkPermissions`（500-503）、`isReadOnly`（404）、`isDestructive`（406）、`isConcurrencySafe`（402）、`isOpenWorld`（434）、`preparePermissionMatcher`（514）、`toAutoClassifierInput`（556） | E3 |
| 提示词 | `description`（386）、`prompt`（518）、`userFacingName`（524） | E2 |
| 进度与结果 | `mapToolResultToToolResultBlockParam`（557）、`renderToolResultMessage`（566）、`renderToolUseMessage`（605）及 8 个 render* 方法 | E1/E7 |
| 观测 | `backfillObservableInput`（481）、`extractSearchText`（599）、`getToolUseSummary`（539）、`getActivityDescription`（546） | E7 |

关键签名：

**真实代码摘录**（`src/Tool.ts:379-385`，执行签名；`src/Tool.ts:500-503`，权限钩子）

```typescript
call(
  args: z.infer<Input>,           // 入参类型从 Zod schema 推导，schema 即类型
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
  onProgress?: ToolCallProgress<P>,
): Promise<ToolResult<Output>>

checkPermissions(
  input: z.infer<Input>,
  context: ToolUseContext,
): Promise<PermissionResult>
```

**`ToolResult<Output>`**（`Tool.ts:321-336`）：`{ data: Output, newMessages?, contextModifier?, mcpMeta? }`——工具不只返回数据，还能追加消息、修改后续工具的上下文。

**`buildTool` 工厂把 7 个常用方法填上 fail-closed 默认值**（`Tool.ts:757-769`、`783-792`）：

**真实代码摘录**

```typescript
// src/Tool.ts:757-769 —— 注意默认值的方向：宁严勿宽
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,  // 默认不可并发
  isReadOnly: (_input?: unknown) => false,         // 默认会写
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (input, _ctx) =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }), // 放行给通用权限系统
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}
```

`ToolDef = Omit<Tool, DefaultableToolKeys> & Partial<Pick<Tool, DefaultableToolKeys>>`（`Tool.ts:721-726`）——工具作者可以省略这 7 个方法，消费方永远看到完整 `Tool`，不需要 `?.() ?? default`。`BashTool` 就是范例：`buildTool({...})`（`src/tools/BashTool/BashTool.tsx:420`），自定义 `isConcurrencySafe(input) { return this.isReadOnly?.(input) ?? false }`（434-435）、`checkPermissions`（539）、`call`（624）。

### 2.3 内置工具注册与三层工具池

注册不是装饰器/扫描，而是**显式的中心清单 + 条件装配**，分三步：

| 步骤 | 函数 | 位置 | 作用 |
|:----:|------|------|------|
| 1 | `getAllBaseTools()` | `tools.ts:194-252` | 全量清单（数组字面量，60+ 工具）。门禁工具用 `feature('XXX') ? require(...) : null` DCE 模式条件引入。 |
| 2 | `getTools(permissionContext)` | `tools.ts:272-328` | 权限过滤。先 `filterToolsByDenyRules`（263-270）整工具剔除，再 `isEnabled()` 实例级过滤。 |
| 3 | `assembleToolPool(ctx, mcpTools)` | `tools.ts:346-368` | 合并装配。内置 + MCP 去重，**且为 prompt cache 稳定性排序**——内置前缀连续，MCP 排后，避免插入导致 cache key 失效。 |

**类型层面约束的「三层工具池」**（E2 拆解时的分层依据）：

| 层 | 类型标记 | 证据 |
|----|---------|------|
| 内置工具 | 普通 `Tool`，`isMcp` 为 falsy | `getAllBaseTools()`，`tools.ts:194` |
| MCP 工具 | `isMcp?: boolean` + `mcpInfo?: { serverName, toolName }` | `Tool.ts:436`、`455`；`MCPTool.ts:27` 用 `buildTool` 构造；`inputJSONSchema` 直通（`Tool.ts:395-397` 注释） |
| 延迟加载工具 | `shouldDefer?: boolean` / `alwaysLoad?: boolean`，模型需先经 ToolSearch 发现 | `Tool.ts:438-449`；`ToolSearchTool` 在 `tools.ts:250` 条件注入 |

三层池对 query loop 完全透明——循环只认 `Tool` 接口。`findToolByName`（`Tool.ts:358-360`，含 alias 匹配）是唯一查找入口。

### 2.4 进度事件类型：`ToolProgressData` 谱系（基于使用点的重建）

`src/types/tools.ts` 是 stub，但 `Tool.ts:49-58` 的 re-export 列出了 7 个具体进度类型：`AgentToolProgress / BashProgress / MCPProgress / REPLToolProgress / SkillToolProgress / TaskOutputProgress / WebSearchProgress`，外加联合类型 `ToolProgressData`（共 8 个导出名）。产生点证实了判别字段：

- `{ type: 'bash_progress', ... }` —— `src/tools/BashTool/BashTool.tsx:668`
- `{ type: 'agent_progress', ... }` —— `src/tools/AgentTool/AgentTool.tsx:800`
- `{ type: 'mcp_progress', ... }` —— `src/services/mcp/client.ts:1844`
- `{ type: 'hook_progress', hookEvent, hookName, command, ... }` —— `src/types/hooks.ts:234-241`（真实文件，唯一直接可读的进度类型）
- `{ type: 'skill_progress', message, prompt, agentId, ... }` —— `src/tools/SkillTool/SkillTool.ts:254`
- `{ type: 'query_update' | 'search_results_received', ... }` —— `src/tools/WebSearchTool/WebSearchTool.ts:263-266`、`510-515`（`WebSearchProgress` 的两种子事件）
- `{ type: 'waiting_for_task', taskDescription, taskType, ... }` —— `src/tools/TaskOutputTool/TaskOutputTool.tsx:244-249`（`TaskOutputProgress`）
- `REPLToolProgress` —— 仅在 stub `src/types/tools.ts` 中声明，仓库中无实际产生点（疑为上游 feature-gated 模块）

进度经 `createProgressMessage`（`messages.ts:615-632`）包装成 `ProgressMessage`（`type: 'progress'` + `toolUseID` + `parentToolUseID` + `data`）进入消息流。`Progress = ToolProgressData | HookProgress`（`Tool.ts:305`）——工具进度和 hook 进度走同一通道。

### 2.5 可迁移模式

> schema 即类型、fail-closed 默认值、cache 亲和排序值得全盘吸收；胖接口耦合 UI 和环境变量条件分支需规避。

#### 值得吸收

1. **schema 即类型**

   `inputSchema: Input`（Zod），`call(args: z.infer<Input>)`——入参校验、类型推导、给模型的 JSON Schema 描述，一份 Zod schema 三处消费。运行时第一道防线就是 `inputSchema.safeParse`（`toolExecution.ts:615`），模型生成非法入参时在类型系统之外再兜一层。

2. **`buildTool` 式默认值收口 + fail-closed 默认方向**

   不可并发、会写、需检查。Koda 的 Tool 接口应区分「默认安全值可省略」与「必须显式声明」两组方法。

3. **工具池装配考虑 prompt cache 亲和性**

   `tools.ts:355-362`——工具列表顺序影响 API 缓存命中，这是类型/装配层极少有人注意的运行时约束。Koda 的 `assembleToolPool` 等价物应把「内置稳定前缀」写成不变量。

#### 需要规避

1. **胖接口耦合 UI 渲染**

   cc-haha 的 `Tool` 有 ~40 个成员，其中 8+ 个是 React 渲染方法（`renderToolUseMessage` 等）——UI 框架（Ink/React）直接耦合进工具契约，这是 CLI 出身的历史包袱。Koda 若目标是多宿主（CLI/桌面/SDK），建议把渲染方法拆成可选的 `ToolUI` 配套接口，核心 `Tool` 只保留契约/执行/权限三组。

2. **中心清单里的环境变量条件分支**

   `process.env.USER_TYPE === 'ant'`（`tools.ts:16-24` 等）是单仓库双发行版的妥协。Koda 新产品应一开始就用显式的工具集 profile 而不是环境变量分支。

---

## 3. 类型的架构作用：E0 如何约束后续相

### 3.1 query loop 消费什么事件类型（E1 锚点）

query 循环的类型契约在 `src/query.ts:222-231`（产出联合）和 `src/services/api/claude.ts:765-798`（`queryModelWithStreaming` 产出联合）。

循环内的消费顺序：

| 阶段 | 产出 | 位置 | 说明 |
|:----:|------|------|------|
| 1 | `RequestStartEvent` | `query.ts:340` | 每次迭代起始信号 |
| 2 | `StreamEvent` | `claude.ts:2441` | 逐 SSE 事件转发，**边流边拼** |
| 2a | `AssistantMessage` | `claude.ts:2334-2352` | `content_block_stop` 时构造完整消息产出（一条 assistant 可能按 block 拆多条） |
| 2b | mutation 写回 | `claude.ts:2386-2390` | `message_delta` 时直接 mutation 写回 usage/stop_reason（转录队列持引用，对象替换会断引用） |
| 3 | `MessageUpdate` | `toolOrchestration.ts:19-24` | `runTools` 消费 `ToolUseBlock[]`，产出 tool_result 载体的 user 消息 |

**E0 对 E1 的约束**：循环的消费者可以用一个 `switch (message.type)` 穷举所有产出（`QueryEngine.ts:779-869` 正是这么做的）——判别联合让「循环能产出什么」成为封闭集合，这是 query loop 可测试性的前提。

**工具并发调度也由 E0 类型决定**：

- `partitionToolCalls`（`toolOrchestration.ts:91-116`）按 `tool.isConcurrencySafe(parsedInput.data)` 把 tool_use 分批
- 连续的安全批并发跑（上限 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 默认 10，`toolOrchestration.ts:8-12`），不安全批串行
- 调度策略完全挂在 Tool 接口的一个方法上

### 3.2 权限系统挂在 Tool 接口的哪个字段上（E3 锚点）

权限不是独立子系统，而是**挂在 Tool 接口 + 一个回调类型上**：

| 挂载点 | 类型 | 位置 | 职责 |
|--------|------|------|------|
| 1 | `Tool.checkPermissions` | `Tool.ts:500-503` | 工具特定的权限逻辑（如 Bash 的命令解析） |
| 2 | `CanUseToolFn` | `useCanUseTool.tsx:27` | `call()` 的第三个参数，执行前必经的通用权限回调 |
| 3 | `ToolPermissionContext` | `Tool.ts:123-138` | 权限上下文：mode + allow/deny/ask 三组规则 + 附加工作目录 |

执行管线顺序：zod 校验（`toolExecution.ts:615`）→ `validateInput`（683）→ 权限 → `tool.call`（1207）。

**决策类型是判别联合**（`src/types/permissions.ts`）：

- `PermissionBehavior = 'allow' | 'deny' | 'ask'`（44）
- `PermissionResult` = allow / ask / deny / passthrough 四变体（251-266）
- `PermissionDecisionReason` = 11 变体联合（271-324：`rule` / `mode` / `hook` / `classifier` / `safetyCheck` …）

**每个决策都强制携带机器可读的理由**，这让权限 UI、审计日志、遥测共用同一份事实。

**E0 对 E3 的约束**：权限系统改不动 `Tool` 接口的消费方——所有决策经 `PermissionResult` 联合流动，`ask` 决策携带 `suggestions?: PermissionUpdate[]`（`permissions.ts:206`）让「允许并记住」成为类型内建能力而非 UI 层 hack。

### 3.3 会话持久化序列化哪些类型（E4/E5 锚点）

持久化契约在**真实文件** `src/types/logs.ts` 里，三层嵌套：

1. **`SerializedMessage = Message & { cwd, userType, sessionId, timestamp, version, gitBranch?, ... }`**（`logs.ts:8-17`）——落盘的消息 = 信封 + 会话元数据。
2. **`TranscriptMessage = SerializedMessage & { parentUuid, isSidechain, agentId?, ... }`**（`logs.ts:221-231`）——再加 `parentUuid` 链（支持分支/回放）和 sidechain 标记（子 agent 转录与主转录同文件共存）。
3. **`Entry`**（`logs.ts:297-317`）——JSONL 每行的判别联合，共 20 个变体：除 `TranscriptMessage` 外还有 `summary` / `custom-title` / `ai-title` / `file-history-snapshot` / `attribution-snapshot` / `worktree-state` / `content-replacement` / compact 相关条目等。

**落盘过滤规则**（`src/utils/sessionStorage.ts`）：

| 守卫函数 | 位置 | 职责 | 排除谁 |
|---------|------|------|--------|
| `isTranscriptMessage` | 139-146 | 转录链准入 | 只放行 user/assistant/attachment/system |
| `isChainParticipant` | 154-156 | parentUuid 链准入 | progress 不进链（#14373/#23537 教训：入链致链分叉、真实消息成孤儿） |
| `isLoggableMessage` | 4380-4381 | **写路径的真正守卫** | `type === 'progress'` 全部排除（非 ant 时还排除多数 attachment） |
| `EPHEMERAL_PROGRESS_TYPES` | 186-196 | REPL 原地替换渲染 | `bash_progress`/`mcp_progress` 等高频 tick，**不是落盘守卫** |

- `isLoggableMessage` 经 `cleanMessagesForLogging`（4479、4483 行）成为 `recordTranscript`（1437、1443 行）的统一漏斗，所有落盘必经此过滤。
- `EPHEMERAL_PROGRESS_TYPES` 服务于 REPL 渲染（`REPL.tsx:2609`，同工具调用的新 tick 替换旧 tick 而非追加）和旧转录加载时的跳过。
- 路径：`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`（202-205）。

**写入侧**：`QueryEngine` 在消费循环里就地落盘（`QueryEngine.ts:749-753`），assistant 消息 fire-and-forget（依赖 100ms 惰序列化吸收 `message_delta` 的 mutation，`QueryEngine.ts:740-748` 注释）。

**E0 对持久化的约束**：`Message.uuid`（信封字段）是整个持久化体系的锚：

- `parentUuid` 链——对话分支与回放
- compact boundary 的 `preservedSegment`（`coreSchemas.ts:1513-1519`）——压缩保留段
- tombstone 删除、resume 恢复——全部以 uuid 为键

Koda 若改信封，uuid 是最后一个能动的东西。

---

## 4. 对 Koda 自研引擎最重要的 3 个设计洞察

**洞察 1：「信封 + 内嵌线格式」是整套系统的轴**

`Message` 不是平行于 API 类型的新抽象，而是「API 消息 + 内部字段」的包装：

- **发 API** 时取 `message` 字段
- **持久化** 时序列化整个信封
- **UI 渲染** 读内部字段

这一刀切下去，SDK 适配器只有两行（`sdkMessageAdapter.ts:45-50`），`normalizeMessagesForAPI` 的过滤规则全部以信封字段为判定依据。Koda 第一条类型决策就应该是这个信封的形状——判别联合（含 system 二级判别）、uuid 锚点、线格式载荷内嵌、内部扩展平铺。

**洞察 2：Tool 接口的默认值必须 fail-closed 且收口于工厂**

`buildTool` 的 7 个默认值（`Tool.ts:757-769`）方向全是宁严勿宽：默认不可并发、默认会写、默认交给通用权限系统。60+ 工具的作者只需要声明「我有什么特殊性」，消费方永远面对完整接口。这把「忘记声明 → 安全事故」变成了「忘记声明 → 行为保守」。

**洞察 3：进度事件是一等公民，但生命周期严格隔离于对话**

`ProgressMessage` 与对话消息同通道流动（query 联合的一员），但在三个独立守卫处被排除：

| 隔离层 | 守卫 | 位置 |
|--------|------|------|
| API 边界 | `normalizeMessagesForAPI` 过滤 `type: 'progress'` | `messages.ts:2095` |
| 持久化链 | `isChainParticipant` 排除 progress | `sessionStorage.ts:154` |
| 落盘写路径 | `isLoggableMessage` 排除 progress | `sessionStorage.ts:4380` |

「可见、可渲染、但从不进入模型上下文和磁盘」——这个三重隔离分散在三处各自强制。Koda 应把这写成进度类型上的单一标记（如 `ephemeral: true`），让三处消费同一个事实，而不是复制三份判断。

---

## 5. E1（查询循环）拆解最该先看的入口文件

按阅读顺序排列，从主干到分支：

| 顺序 | 文件 | 行数 | 看什么 |
|:----:|------|:----:|--------|
| 1 | `src/query.ts` | 1737 | 主循环本体。入口 `query()`（222）→ `queryLoop`（244）→ `State` 类型（207-220）→ while 循环（310 起）。E1 的骨架。 |
| 2 | `src/services/api/claude.ts` | 3619 | API 层。`queryModelWithStreaming`（765）→ 流式装配循环（`content_block_stop` 构造 AssistantMessage 2334；`stream_event` 产出 2441；usage 写回 2386）。 |
| 3 | `src/services/tools/toolOrchestration.ts` + `toolExecution.ts` | 188 + 1745 | 工具阶段。`runTools`（19）并发分批 → `runToolUse`（337）→ `checkPermissionsAndCallTool`（599）。 |
| 4 | `src/QueryEngine.ts` | 1376 | SDK/headless 驱动器。`query()` 的产出如何被消费、转 SDK 消息、落盘（697-869）。 |
| 5 | `src/query/deps.ts` + `config.ts` | — | 辅助。循环的可注入依赖（测试缝）、循环入口快照的配置。 |

---

## 6. 核查清单

> 供第二个 agent 独立验证（共 87 条）。每条一行：文件、行号、该行内容摘要。标注 ⚠️stub 的条目表示目标文件本身是占位 stub，该引用用于证明 stub 存在性。

**§0 stub 事实**

| # | 位置 | 摘要 |
|---|------|------|
| 1 | `src/types/message.ts:1` | `// @generated stub from scan-missing-imports` —— 消息类型文件是 stub ⚠️stub |
| 2 | `src/types/tools.ts:1` | 同上，工具进度类型文件是 stub ⚠️stub |
| 3 | `src/types/permissions.ts:1-7` | 头注释：纯类型定义、为零依赖破循环而提取 |
| 4 | `src/types/ids.ts:10` | `export type SessionId = string & { readonly __brand: 'SessionId' }` |
| 5 | `src/types/ids.ts:17` | `export type AgentId = string & { readonly __brand: 'AgentId' }` |

**§1 消息与事件**

| # | 位置 | 摘要 |
|---|------|------|
| 6 | `src/utils/messages.ts:361` | `function baseCreateAssistantMessage({` —— AssistantMessage 信封构造 |
| 7 | `src/utils/messages.ts:394-417` | return 语句：`type: 'assistant'` + 内嵌 `message:{role:'assistant',...}` + 内部字段平铺 |
| 8 | `src/utils/messages.ts:420` | `export function createAssistantMessage({` |
| 9 | `src/utils/messages.ts:472` | `export function createUserMessage({` |
| 10 | `src/utils/messages.ts:514-534` | UserMessage 构造体：`type: 'user'` + `message:{role:'user',content}` + isMeta/toolUseResult/origin 等 |
| 11 | `src/utils/messages.ts:493` | `toolUseResult?: unknown // Matches tool's Output type` —— 结构化结果双轨 |
| 12 | `src/utils/messages.ts:615-632` | `createProgressMessage`：`type: 'progress'` + toolUseID + parentToolUseID + data |
| 13 | `src/utils/messages.ts:4452-4469` | `createSystemMessage`：`type: 'system'` + `subtype: 'informational'` + level |
| 14 | `src/utils/messages.ts:101-107` | import `BetaContentBlock / BetaMessage / BetaThinkingBlock / BetaToolUseBlock` 自 SDK |
| 15 | `src/utils/messages.ts:2004` | `export function normalizeMessagesForAPI(` |
| 16 | `src/utils/messages.ts:2014-2016` | 过滤 `isVirtual` 消息 |
| 17 | `src/utils/messages.ts:2084-2103` | 过滤 progress / 非 local_command 的 system / 合成 API 错误 |
| 18 | `src/utils/messages.ts:2106-2120` | local_command system 消息转为 user 消息进 API |
| 19 | `src/utils/attachments.ts:3197` | `export function createAttachmentMessage(` → `{ attachment, type: 'attachment', uuid, timestamp }` |
| 20 | `src/query.ts:138-149` | tool_result 块构造：`{ type: 'tool_result', content, is_error: true, tool_use_id }` |
| 21 | `src/query.ts:222-231` | query() 产出联合：StreamEvent \| RequestStartEvent \| Message \| TombstoneMessage \| ToolUseSummaryMessage |
| 22 | `src/query.ts:340` | `yield { type: 'stream_request_start' }` |
| 23 | `src/services/api/claude.ts:2441-2445` | `yield { type: "stream_event", event: part, ...(ttftMs) }` |
| 24 | `src/services/api/claude.ts:2334-2352` | content_block_stop 时构造并 yield AssistantMessage |
| 25 | `src/services/api/claude.ts:2386-2390` | message_delta 时 mutation 写回 usage/stop_reason |
| 26 | `src/remote/sdkMessageAdapter.ts:45-50` | `convertStreamEvent`：单向 SDK→internal 转换（函数本体 6 行，返回对象仅 `type`/`event` 两个字段） |
| 27 | `src/entrypoints/sdk/coreSchemas.ts:1496-1504` | SDKPartialAssistantMessageSchema：`type: 'stream_event'` + event + uuid + session_id |
| 28 | `src/entrypoints/sdk/coreSchemas.ts:1347-1356` | SDKAssistantMessageSchema：`type: 'assistant'` + message + parent_tool_use_id + uuid + session_id |
| 29 | `src/entrypoints/sdk/coreSchemas.ts:1290-1295` | SDKUserMessageSchema |
| 30 | `src/entrypoints/sdk/coreSchemas.ts:1869-1897` | SDKMessageSchema：25 变体 Zod union |
| 31 | `desktop/src/lib/trace/types.ts:1-11` | 本地新增 NormalizedBlock（5 变体）/ NormalizedMessage（4 角色） |
| 32 | `src/QueryEngine.ts:779-1010` | 消费 switch：tombstone/assistant/progress/user/stream_event/attachment/stream_request_start/system/tool_use_summary 共 9 个 case |

**§2 Tool 接口**

| # | 位置 | 摘要 |
|---|------|------|
| 33 | `src/Tool.ts:362-366` | `export type Tool<Input extends AnyObject, Output, P extends ToolProgressData>` |
| 34 | `src/Tool.ts:379-385` | `call(args: z.infer<Input>, context, canUseTool, parentMessage, onProgress)` |
| 35 | `src/Tool.ts:394` | `readonly inputSchema: Input` —— Zod schema 即入参类型 |
| 36 | `src/Tool.ts:397` | `readonly inputJSONSchema?: ToolInputJSONSchema` —— MCP 直通 |
| 37 | `src/Tool.ts:402-406` | `isConcurrencySafe` / `isEnabled` / `isReadOnly` / `isDestructive` |
| 38 | `src/Tool.ts:438-449` | `shouldDefer` / `alwaysLoad` —— ToolSearch 延迟加载标记 |
| 39 | `src/Tool.ts:455` | `mcpInfo?: { serverName: string; toolName: string }` |
| 40 | `src/Tool.ts:466` | `maxResultSizeChars: number` |
| 41 | `src/Tool.ts:500-503` | `checkPermissions(input, context): Promise<PermissionResult>` |
| 42 | `src/Tool.ts:321-336` | `ToolResult<T>`：data + newMessages? + contextModifier? + mcpMeta? |
| 43 | `src/Tool.ts:305-310` | `Progress = ToolProgressData \| HookProgress`；`ToolProgress<P>` |
| 44 | `src/Tool.ts:123-138` | `ToolPermissionContext = DeepImmutable<{ mode, additionalWorkingDirectories, alwaysAllowRules, ... }>` |
| 45 | `src/Tool.ts:721-726` | `ToolDef = Omit<Tool, DefaultableToolKeys> & Partial<...>` |
| 46 | `src/Tool.ts:757-769` | `TOOL_DEFAULTS`：fail-closed 默认值 |
| 47 | `src/Tool.ts:783-792` | `export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D>` |
| 48 | `src/tools.ts:194-252` | `getAllBaseTools()`：中心清单，feature()/env 条件装配 |
| 49 | `src/tools.ts:263-270` | `filterToolsByDenyRules`：deny 规则整工具剔除 |
| 50 | `src/tools.ts:272-328` | `getTools(permissionContext)`：deny 过滤 + isEnabled 过滤 |
| 51 | `src/tools.ts:346-368` | `assembleToolPool`：内置前缀 + MCP 后缀，cache 亲和排序 |
| 52 | `src/tools/BashTool/BashTool.tsx:420` | `export const BashTool = buildTool({` |
| 53 | `src/tools/BashTool/BashTool.tsx:434-435` | `isConcurrencySafe(input) { return this.isReadOnly?.(input) ?? false }` |
| 54 | `src/tools/MCPTool/MCPTool.ts:27` | `export const MCPTool = buildTool({` |
| 55 | `src/tools/BashTool/BashTool.tsx:668` | `type: 'bash_progress'` 进度产生点 |
| 56 | `src/tools/AgentTool/AgentTool.tsx:800` | `type: 'agent_progress'` |
| 57 | `src/services/mcp/client.ts:1844` | `type: 'mcp_progress'` |
| 58 | `src/types/hooks.ts:234-241` | `HookProgress = { type: 'hook_progress', hookEvent, hookName, command, ... }` |
| 58a | `src/tools/SkillTool/SkillTool.ts:254` | `type: 'skill_progress'` 进度产生点 |
| 58b | `src/tools/WebSearchTool/WebSearchTool.ts:263-266` | `type: 'query_update'` —— WebSearchProgress 子事件产生点 |
| 58c | `src/tools/WebSearchTool/WebSearchTool.ts:510-515` | `type: 'search_results_received'` —— WebSearchProgress 子事件产生点 |
| 58d | `src/tools/TaskOutputTool/TaskOutputTool.tsx:244-249` | `type: 'waiting_for_task'` —— TaskOutputProgress 产生点 |

**§3 架构作用**

| # | 位置 | 摘要 |
|---|------|------|
| 59 | `src/services/api/claude.ts:765-780` | `queryModelWithStreaming` 产出联合：StreamEvent \| AssistantMessage \| SystemAPIErrorMessage \| SystemStreamingFallbackMessage |
| 60 | `src/services/tools/toolOrchestration.ts:19-24` | `runTools(toolUseMessages, assistantMessages, canUseTool, toolUseContext)` |
| 61 | `src/services/tools/toolOrchestration.ts:91-116` | `partitionToolCalls`：按 `isConcurrencySafe` 分批 |
| 62 | `src/services/tools/toolOrchestration.ts:8-12` | 并发上限 env `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，默认 10 |
| 63 | `src/services/tools/toolExecution.ts:599` | `async function checkPermissionsAndCallTool(` |
| 64 | `src/services/tools/toolExecution.ts:615` | `tool.inputSchema.safeParse(input)` —— 运行时第一道防线 |
| 65 | `src/services/tools/toolExecution.ts:683` | `tool.validateInput?.(...)` |
| 66 | `src/services/tools/toolExecution.ts:1207` | `const result = await tool.call(` |
| 67 | `src/hooks/useCanUseTool.tsx:27` | `export type CanUseToolFn<...> = (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision?) => Promise<PermissionDecision<Input>>` |
| 68 | `src/hooks/useCanUseTool.tsx:37` | `hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID)` |
| 69 | `src/types/permissions.ts:16-36` | `EXTERNAL_PERMISSION_MODES`（5 种）+ feature-gated `'auto'` |
| 70 | `src/types/permissions.ts:44` | `PermissionBehavior = 'allow' \| 'deny' \| 'ask'` |
| 71 | `src/types/permissions.ts:251-266` | `PermissionResult`：allow/ask/deny/passthrough 联合 |
| 72 | `src/types/permissions.ts:271-324` | `PermissionDecisionReason`：11 变体判别联合 |
| 73 | `src/types/permissions.ts:206` | ask 决策携带 `suggestions?: PermissionUpdate[]` |
| 74 | `src/types/logs.ts:8-17` | `SerializedMessage = Message & { cwd, userType, sessionId, version, ... }` |
| 75 | `src/types/logs.ts:221-231` | `TranscriptMessage = SerializedMessage & { parentUuid, isSidechain, agentId?, ... }` |
| 76 | `src/types/logs.ts:297-317` | `Entry`：20 变体 JSONL 行联合 |
| 77 | `src/utils/sessionStorage.ts:139-146` | `isTranscriptMessage`：user/assistant/attachment/system 才进转录 |
| 78 | `src/utils/sessionStorage.ts:154-156` | `isChainParticipant`：progress 不进 parentUuid 链（含事故注释 134-137） |
| 79 | `src/utils/sessionStorage.ts:186-196` | `EPHEMERAL_PROGRESS_TYPES`：高频 tick 子集，服务 REPL 原地替换与旧转录跳过（非落盘守卫） |
| 79a | `src/utils/sessionStorage.ts:4380-4381` | `isLoggableMessage`：`if (m.type === 'progress') return false` —— 落盘写路径守卫，排除全部 progress |
| 79b | `src/utils/sessionStorage.ts:4479,4483` | `cleanMessagesForLogging`：`messages.filter(isLoggableMessage)` 统一漏斗 |
| 79c | `src/utils/sessionStorage.ts:1437,1443` | `recordTranscript` 调用 `cleanMessagesForLogging` |
| 79d | `src/screens/REPL.tsx:2609` | `isEphemeralToolProgress(newMessage.data.type)` —— 同 toolUseID 新 tick 原地替换旧 tick |
| 80 | `src/utils/sessionStorage.ts:202-205` | 转录路径 `projects/<dir>/<sessionId>.jsonl` |
| 81 | `src/QueryEngine.ts:697-708` | `for await (const message of query({...}))` —— SDK 驱动点 |
| 82 | `src/QueryEngine.ts:740-753` | assistant 消息 fire-and-forget 落盘，依赖惰序列化吸收 mutation |
| 83 | `src/entrypoints/sdk/coreSchemas.ts:1513-1519` | compact `preservedSegment`：head/anchor/tail uuid 三元组 |
