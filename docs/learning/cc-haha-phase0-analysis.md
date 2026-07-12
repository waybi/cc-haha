# cc-haha Phase 0 设计拆解

> **本文定位**：教学设计 / 解剖笔记，目标是解释「为什么这样设计」并提取可迁移模式，适合学习者和新加入的开发者阅读。
>
> 按「业务场景 → 为什么这样设计 → 代码怎么落地 → 如果不管它会怎样」的顺序，每个设计决策自闭环。
>
> **符号约定**：`k` = 变更传播比（Change Propagation Ratio）—— 一项设计决策变化时需要连锁修改的文件数。k = 1 代表改一处即可（理想），k = N 代表霰弹式修改（Shotgun Surgery）。

---

## 「你在这里」锚点

```
cc-haha 全局拓扑图:

                    ┌──────────────────────────────────────────┐
                    │          entrypoints/                     │
                    │  cli.tsx  mcp.ts  sdk/  init.ts          │
                    │  (动态导入分发，快速路径零模块加载)          │
                    └──────────────┬───────────────────────────┘
                                   │ fallback
                    ┌──────────────▼───────────────────────────┐
                    │           main.tsx                        │
                    │  Commander.js 命令注册 + Ink.render()     │
                    └──────┬──────────────────┬────────────────┘
                           │                  │
              ┌────────────▼──────┐  ┌────────▼────────────────┐
              │   Ink TUI 层      │  │    server/ 层            │
              │  components/      │  │  REST API + WebSocket    │
              │  screens/         │  │  services/ (服务)        │
              │  commands/        │  │  middleware/             │
              │  hooks/           │  │  proxy/                  │
              └────────┬─────────┘  └────────┬─────────────────┘
                       │                     │
              ┌────────▼─────────────────────▼─────────────────┐
              │              共享核心层                         │
              │  tools/  (65个agent工具)                       │
              │  services/ (API客户端, MCP, LSP, OAuth...)     │
              │  coordinator/ (多agent协调)                    │
              │  assistant/ (会话历史, 对话循环)               │
              │  state/AppStateStore.ts (全局应用状态)         │
              └────────┬───────────────────────────────────────┘
                       │
              ┌────────▼───────────────────────────────────────┐
              │              Tool.ts 工具契约层                 │
              │  buildTool / ToolUseContext / 工具接口定义      │
              │  → 所有工具、命令、service 的共同契约           │
              └────────┬───────────────────────────────────────┘
                       │
              ┌────────▼───────────────────────────────────────┐
              │             Phase 0 基础层                      │
              │  types/ids.ts         (品牌化字符串类型)        │
              │  types/permissions.ts (权限类型+常量)           │
              │  types/connectorText.ts                        │
              │  constants/*.ts       (纯常量, ~20个文件)       │
              │  state/store.ts       (通用 pub/sub store)     │
              │  utils/array.ts, CircularBuffer.ts, Cursor.ts  │
              └────────────────────────────────────────────────┘

你现在在 Phase 0。这一层零项目内部依赖，但几乎所有人依赖它。

本课进度    Phase 0 / 5。cc-haha 全栈已完成。
真实文件    ~/Desktop/my/cc-haha/src/  49个顶级目录, ~800+ 文件
             ~/Desktop/my/cc-haha/desktop/  Electron + React 桌面壳
             ~/Desktop/my/cc-haha/adapters/  5个IM机器人适配器
```

---

## 总体业务场景

cc-haha 是一个 AI 编程助手的桌面工作台。一个典型的使用场景：

用户在终端输入 `claude-haha`，进入 TUI界面。输入「帮我写一个用户登录页面」。

1. CLI入口 (`cli.tsx`) 快速路径判断，无特殊flag → 加载 `main.tsx`
2. `main.tsx` 注册所有 Commander.js 命令，调用 `Ink.render()` 启动终端UI
3. 用户输入消息，`useInput()` hook 捕获，通过 QueryEngine 发送到 Anthropic API
4. API 返回流式响应（tool_use blocks），在组件树中渲染为 React 组件
5. AI 调用 `BashTool` 执行命令、`FileWriteTool` 写文件、`FileEditTool` 改代码
6. 权限系统检查是否需要用户确认（AcceptEdits/BypassPermissions/Default/Plan）
7. 结果通过 `ToolUseBlock` 渲染在终端中，带语法高亮和内联 diff

同时，`server/index.ts` 在后台运行（端口3456），提供 REST API 和 WebSocket，供桌面应用和IM适配器使用。

在这个场景里，Phase 0 作为地基，要回答几个基础问题。以下逐个拆解。

---

## 问题 1：品牌化ID — 同一个"字符串"，三个子系统各自由解释

### 业务场景：一条消息穿过三个子系统

用户发送消息 → TUI 捕获 → API 调用 → 返回响应。这个过程中，`sessionId` 和 `agentId` 作为字符串在三个子系统间传递：

```
TUI组件 (React hooks) → services/api/client.ts → Anthropic API
                              ↓
                        server/ws/handler.ts → desktop WebSocket
                              ↓
                        adapters/common/ws-bridge.ts → IM机器人
```

### 如果不管它：SessionId 和 AgentId 互相传错不会报错

```typescript
// ❌ 危险 — 两个都是 string，编译器不管
function sendMessage(sessionId: string, message: string) { ... }
function createAgent(agentId: string, parentSession: string) { ... }

// 调用方不小心把 agentId 当成 sessionId 传入 — 编译通过，运行时爆炸
sendMessage(agentId, "你好")  // 静默接受，消息发到错误会话
```

### 设计决策：品牌化类型（Branded Types）

```typescript
// ✅ src/types/ids.ts — Phase 0 零依赖
export type SessionId = string & { readonly __brand: 'SessionId' }
export type AgentId = string & { readonly __brand: 'AgentId' }
```

**为什么不是 enum 或 class**：Branded type 在运行时就是 string，零开销。不需要序列化/反序列化适配。但编译期把 `SessionId` 和 `AgentId` 区分开。

**辅助函数**：`asSessionId()` / `asAgentId()` 做类型断言，`toAgentId()` 做运行时校验（正则匹配 `a(?:.+-)?[0-9a-f]{16}`）。

**k 值分析**：如果不用品牌化类型，每次新增一个接受 ID 的函数都可能因为参数顺序错误而 bug。品牌化后，TypeScript 编译器在调用处就能发现类型不匹配 → k = 1（改工厂函数即可）。

---

## 问题 2：权限类型循环依赖 — 6个模块互相 import

### 业务场景：权限检查链路穿过 6 个模块

一条权限检查链路：

```
Tool (BashTool) → useCanUseTool (hook) → PermissionClassifier (utils)
     ↓                                              ↓
  ToolPermissionContext                          PermissionRule
     ↓                                              ↓
  types/permissions.ts ←──────────────────────────┘
     ↓
  utils/permissions/denialTracking.ts
```

6 个模块全部需要"权限规则长什么样"。如果各自定义 → 类型漂移。

### 设计决策：提取纯类型到 types/permissions.ts 打破循环

```typescript
// src/types/permissions.ts — 文件注释直接说明意图
/**
 * Pure permission type definitions extracted to break import cycles.
 * This file contains only type definitions and constants with no runtime dependencies.
 */
```

这个文件的 250+ 行全部是：
- 类型定义（`PermissionMode`, `PermissionBehavior`, `PermissionRule`）
- 常量数组（`EXTERNAL_PERMISSION_MODES`, `INTERNAL_PERMISSION_MODES`）
- 纯函数（`getDefaultPermissionRules`）

**不包含**：
- 运行时行为（`PermissionClassifier` 留在 `utils/permissions/`）
- UI 组件
- 数据库操作

**k 值分析**：如果没有这个单一真相源 → 新增一个权限模式 `auto` → 要在 6 个模块各自更新类型定义 → k ≥ 6。提取后 → 改一处 → k = 1。

**为什么不是 Phase 1 的 Service**：权限类型需要在工具层（Phase 2）就被引用，如果放在 Service 层，工具层会违反依赖方向。放在 Phase 0 → 所有人零代价引用。

---

## 问题 3：全局状态管理 — 100+ 个 React 组件需要共享状态

### 业务场景：一次消息发送需要 12+ 个组件感知状态变化

用户按下回车发送消息：

```
useInput() → onSend() → setState(messages) → 
  12+ 个组件重新渲染：
  ├── MessageList (新消息气泡)
  ├── StatusLine (token计数更新)
  ├── PermissionDialog (可能弹出)
  ├── Spinner (加载动画)
  ├── CostDisplay (费用更新)
  ├── ToolUseBlock (工具调用渲染)
  └── ... 6 个其他组件
```

### 如果不管它：React Context 的渲染风暴

每个状态字段一个 Context → 12 个 Context Provider 嵌套 → 任何一个更新都会触发整个子树重新渲染。或者用 Redux → 引入 30KB+ 的库依赖。

### 设计决策：15 行 pub/sub store

```typescript
// src/state/store.ts — 零项目依赖
export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return  // 同值不触发更新
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

**为什么不是 Zustand/Redux**：
- 零外部依赖（Phase 0 约束）
- 配合 `useSyncExternalStore` 实现 React 18 并发模式安全的订阅
- 通过 `Object.is` 做同值短路，避免无意义渲染
- `AppStateStore.ts` 通过 selector 模式实现细粒度订阅

**k 值分析**：如果状态管理方案需要更换 → 只有 `AppStateStore.ts` + `AppState.tsx` 需要改，所有消费方通过 `useAppState(selector)` 消费，不受影响 → k ≈ 2。

---

## 问题 4：工具契约 — 65 个工具，如何避免各自为政

### 业务场景：新增一个工具需要满足的契约

如果你想加一个 `WebBrowserTool`：
- 需要定义 input schema（zod）
- 需要定义 prompt 描述（给 AI 看的）
- 需要处理 tool_use → 执行 → tool_result 的完整生命周期
- 需要渲染进度（终端UI）
- 需要权限检查
- 需要判断"这个 Agent 能不能用这个工具"

### 设计决策：buildTool 工厂函数

```typescript
// src/Tool.ts — 工具系统的单一入口契约
export type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    customSystemPrompt?: string
    appendSystemPrompt?: string
    refreshTools?: () => Tools
  }
  // ... 运行时方法
}
```

`buildTool()` 强制每个工具实现统一接口：
- `async *call(...)` — 异步生成器，逐块产出 tool_result
- `isEnabled()` / `isReadOnly()` — 权限分类
- `userFacingName()` — 人类可读名称
- `renderToolUseBlock()` — 终端UI渲染

**k 值分析**：如果没有统一契约 → 新增一个 tool_use 消息处理路径 → 需要在 QueryEngine、MessageList、PermissionDialog 等 8+ 个文件中添加 `if (toolName === 'newTool')` 分支 → k ≥ 8。统一契约后 → 只需实现 `buildTool()` 接口 → k ≈ 2（工具文件 + 常量注册）。

---

## 问题 5：feature() 门控 — 内外版本共享代码库

### 业务场景：内部版和开源版从同一个仓库构建

cc-haha 源自 Anthropic 内部代码，通过 `feature()` 宏在编译期做死代码消除（DCE）：

```typescript
// src/constants/tools.ts
import { feature } from 'bun:bundle'

export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = new Set([
  // ... 
  ...(feature('AGENT_TRIGGERS')
    ? [CRON_CREATE_TOOL_NAME, CRON_DELETE_TOOL_NAME, CRON_LIST_TOOL_NAME]
    : []),
])
```

**编译时**：`bun build` 的 `feature()` 在 DCE 阶段把 `feature('AGENT_TRIGGERS')` 替换为 `true` 或 `false`，bundle 中死分支被完全移除。

### 配合机制：自动生成 stub 占位符

```typescript
// src/types/message.ts — @generated stub
// 所有外部 build 的代码路径在 DCE 后都不会真的执行这里的代码
const __handler: ProxyHandler<any> = {
  get(_t, prop) {
    if (prop === '__esModule') return true
    if (prop === 'default') return new Proxy(__target, __handler)
    // ...
    return new Proxy(__target, __handler)
  },
  apply() { return new Proxy(__target, __handler) },
}
```

当 `feature()` 移除某个模块时，这个 stub 通过 Proxy 提供 null-safe 的占位，不会因 import 丢失而报错。

**k 值分析**：如果没有 feature-gate → 需要维护两个分支 → 每次改一行代码要同步两个仓库 → k ≥ 2（还可能遗漏）。feature-gate 后 → 单仓库，`bun build` 时自动消除 → k = 1（只改一处）。

---

## 问题 6：日志持久化 — 会话数据的读写分离

### 业务场景：CLI 进程和 Server 进程共享会话数据

```
CLI 进程 (TUI)                   Server 进程 (端口3456)
     │                                  │
     │ 写入 ~/.claude/projects/          │ 读取相同的 JSONL 文件
     │ <project>/xxx.jsonl               │ 通过 REST API 暴露给桌面端
     │                                  │
     └────────── 文件系统 ───────────────┘
```

### 设计决策：JSONL 文件作为进程间通信媒介

`src/types/logs.ts` 定义 `SerializedMessage` 类型（包含 `sessionId`, `timestamp`, `version`, `gitBranch`, `slug` 等 30+ 字段）。CLI 写入，Server 读取，不需要进程间 RPC。

**为什么不是 SQLite/Postgres**：
- JSONL 可以直接 `tail`、`grep`、`cat` — 调试友好
- 零依赖（不需要数据库驱动）
- 每个项目一个文件，天然隔离
- Server 只需要 `fs.readFileSync` + `JSON.parse`

**k 值分析**：如果换存储方案 → 只需要改 `services/sessionTranscript.ts` 和 `server/services/sessionService.ts` → k ≈ 2。消费方不感知底层存储。

---

## 依赖拓扑：cc-haha 对应 Koda Phase 映射

cc-haha 不是六边形架构，但可以通过**按耦合度分层**的方式映射到类似的 Phase 模型：

| Phase | cc-haha 模块 | 文件数 | 对应 Koda | 关键差异 |
|-------|-------------|--------|-----------|---------|
| **0** | `types/ids.ts`, `types/permissions.ts`, `constants/*`, `state/store.ts`, `utils/array.ts`, `utils/CircularBuffer.ts`, `utils/Cursor.ts` | ~25 | Phase 0 (types + EventBus) | cc-haha **没有领域模型工厂函数**，类型是松散的品牌化字符串 + interface |
| **1** | `types/logs.ts`, `types/command.ts`, `types/hooks.ts`, `types/plugin.ts`, `utils/settings/types.ts`, `constants/tools.ts` | ~30 | Phase 1 (Store接口) | cc-haha **没有 Store 接口层**，数据直接读写 JSONL 文件。`types/` 承担了部分接口契约职责 |
| **2** | **`Tool.ts`** (工具契约), `state/AppStateStore.ts`, `services/mcp/types.ts`, `tasks/` | ~20 | Phase 2 (Task + Worker) | cc-haha 的 Task 是 agent task 概念（LocalAgent/LocalShell/Workflow），不是 Kanban card |
| **3** | `tools/*` (65个工具实现), `services/api/` (Anthropic客户端), `services/mcp/` (MCP协议), `services/lsp/` | ~120 | Phase 3 (ACP Adapter) + Phase 5 (MCP) | 工具层 *同时* 承担了 ACP适配 和 MCP 的职责，没有独立的防腐层 |
| **4** | `commands/` (90个命令), `components/` (TUI组件), `hooks/` (80+ hooks), `ink/` (终端渲染器), `coordinator/` | ~250 | Phase 5 (Kanban + Orchestrator) | TUI 组件和命令在 cc-haha 中占主导，对应看板+编排 |
| **5** | `server/` (REST+WS), `desktop/` (Electron壳), `adapters/` (IM侧车), `entrypoints/` | ~200 | Phase 6+7 (API + 前端) | Server 和 Desktop 是独立进程，通过 HTTP/WS 通信 |

### 核心差异总结

| 维度 | Routa (Koda) | cc-haha |
|------|-------------|---------|
| **架构风格** | 六边形（端口-适配器） | 分层单体 + 独立 Server + 独立 Desktop |
| **领域模型** | 14 个 `createXxx()` 工厂函数 | 松散的类型定义，无统一工厂 |
| **EventBus** | 中心化发布订阅引擎 | 无。状态通过 `createStore()` 变更通知 |
| **持久化** | Postgres + SQLite 双后端 | JSONL 文件（单数据库等价物） |
| **防腐层** | `IProviderAdapter` → normalize() | 无。Anthropic API 客户端直接使用 |
| **UI 层** | Next.js 页面 | Ink TUI + Electron React SPA（双UI） |
| **进程模型** | 单进程 Web 服务 | 多进程（CLI + Server + Desktop + Adapters） |
| **门控** | 无 | `feature()` + DCE + 自动 stub |
| **子代理** | Agent/BgWorker 通过 Store 调度 | `coordinator/` 协调 + `AgentTool` 嵌套调用 |

---

## cc-haha 特有的设计模式

### 模式 1：feature() DCE + 自动 stub 占位

这是 cc-haha 最独特的设计。传统开源项目用 `if (process.env.X)` 做运行时切换，cc-haha 在编译期就决定了哪些代码进 bundle：

```typescript
// 编译时消除
if (feature('TRANSCRIPT_CLASSIFIER')) {
  // 这段代码在开源版 bundle 中完全不存在
} else {
  // 只有这段保留
}
```

**配合自动生成的 stub**：编译工具扫描所有 `feature()` gated 的 import，为缺失的模块生成 Proxy stub。Proxy 的 `get` handler 返回自身，形成无限链式的 null-safe 访问——任何 `.foo.bar.baz()` 都不会抛异常，只是返回 undefined。

### 模式 2：多进程文件系统桥接

CLI 和 Server 通过 JSONL 文件共享状态，不需要 RPC：

```
CLI:  writeToLogFile(message) → ~/.claude/projects/<project>/<date>.jsonl
Server: readLogFiles(project) → 解析 JSONL → REST API 返回
Desktop: fetch(/api/sessions) → 渲染会话列表
```

**优势**：进程崩溃/重启不影响数据。Server 可以独立重启。CLI 不需要 Server 在线。

### 模式 3：Ink 自定义 Fork

cc-haha 的 `src/ink/` (约60个文件) 是对 `vadimdemedes/ink` 的深度定制。关键改动：

- **`render-to-screen.ts`** — 帧差分系统，只更新变化的终端行
- **`log-update.ts`** — 管理终端更新的节流（防闪烁）
- **`selection.ts`** — 文本选择叠加层（原生 Ink 不支持）
- **`searchHighlight.ts`** — 搜索高亮（原生 Ink 不支持）

**为什么 fork 而不是上游贡献**：这些改动与 cc-haha 的渲染需求深度耦合（消息气泡、diff 高亮、权限对话框），不适合通用的终端UI框架。

### 模式 4：Coordinator 多 Agent 协调

```typescript
// src/coordinator/coordinatorMode.ts
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,        // Coordinator 可以创建子 Agent
  TASK_STOP_TOOL_NAME,    // 可以停止子 Agent
  SEND_MESSAGE_TOOL_NAME, // 可以在子 Agent 间传递消息
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
```

Coordinator 模式是一个特殊 Agent，它的工具集被严格限制为 4 个：它只能"调度"子 Agent，不能自己写代码。子 Agent 的工具集通过 `ASYNC_AGENT_ALLOWED_TOOLS` 定义（约 20 个工具），被禁止使用 `AgentTool`（防止递归）、`TaskOutputTool`、`ExitPlanModeTool` 等。

---

## 行为规约（从 cc-haha 代码中提取的设计约束）

以下约束来自 cc-haha 真实代码模式，每条对应一个可验证的规则：

### 规则 1：`feature()` 条件内不能有副作用

`feature()` 在编译时由 `bun build` 的 DCE 阶段消除。条件内的代码可能在 bundle 中完全不存在，所以不能依赖"条件里的代码被执行了"这个假设：

```typescript
// ❌ 禁止 — 副作用在 feature() 内
if (feature('TRANSCRIPT_CLASSIFIER')) {
  globalThis.__classifierReady = true  // 开源版永远不会执行
}

// ✅ 安全 — 副作用在 feature() 外
const isEnabled = feature('TRANSCRIPT_CLASSIFIER')
globalThis.__classifierReady = isEnabled
```

### 规则 2：类型文件不能 import 运行时模块

`src/types/permissions.ts` 是刻意提取的纯类型/常量子集。它只能 import `@anthropic-ai/sdk` 的类型（`import type`）和 `bun:bundle`。如果从这里 import `utils/permissions/classifier.ts` → 循环依赖复活。

### 规则 3：Server 不直接写 CLI 的日志文件

Server 通过 `server/services/sessionService.ts` → `services/sessionTranscript.ts` 读取日志。写入权只在 CLI 进程。违反这条 → 并发写 JSONL 文件 → 日志损坏。

### 规则 4：工具通过 `buildTool()` 注册，不在 QueryEngine 里硬编码

QueryEngine 的 tool_use 处理路径是泛型的，不针对特定工具名做 `if/else`。新增工具 → 只需 `buildTool({...})` → 自动注册到 `Tools` 集合 → QueryEngine 通过 `tools.get(name)` 动态分发。

### 规则 5：Adapter 不 import CLI 内部模块

`adapters/` 目录通过 WebSocket 与 Server 通信，不直接 import `src/` 下的任何文件。违反这条 → 适配器和 CLI 进程耦合 → 升级 CLI 可能破坏适配器。

### 规则 6：getEmptyToolPermissionContext() 是唯一创建默认权限上下文的方式

```typescript
// ✅ src/Tool.ts
export const getEmptyToolPermissionContext: () => ToolPermissionContext = () => ({
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
})
```

禁止消费方手写 `{ mode: 'default', ... }` 对象字面量 → 新增字段时遗漏默认值 → 运行时 `undefined` 行为不一致。

---

## 未解决的问题（cc-haha 的技术债）

按照 Koda 标准审视，cc-haha 有以下设计缺口：

1. **没有领域模型工厂函数**：`Task`、`Message`、`Agent` 等核心概念没有统一的 `createXxx()` 入口。消费方各自手写对象字面量 → k 值高。

2. **types/ 目录不纯**：`command.ts`、`hooks.ts`、`plugin.ts` 大量 import 运行时模块。只有 `ids.ts`、`permissions.ts`、`connectorText.ts` 是真正的 Phase 0。

3. **没有 EventBus**：状态变更通过 `store.setState()` 通知，但事件是隐式的（"state 变了"），不是语义化的（"Agent 完成了"）。消费方需要轮询 state 差值，而不是订阅 `AGENT_COMPLETED` 事件。

4. **没有 IProviderAdapter 防腐层**：Anthropic API 类型（`ToolUseBlockParam`）直接穿透到工具层。如果要支持 OpenAI function calling → 需要大量重写。

5. **Server 和 CLI 的文件系统耦合**：虽然进程独立，但共享同一个 JSONL 格式。格式变更需要两边同步。

6. **Ink Fork 无法独立升级**：60 个文件深度定制，上游 Ink 的任何 bug fix 都需要手动 backport。

---

## 总结：cc-haha 架构下的 k 值

| 变更场景 | 需要修改的文件 | k 值 | 如果用了 Koda 模式 |
|---------|-------------|------|-------------------|
| 新增 Tool 类型字段 | Tool.ts + AppStateStore + 65个工具文件 | ~67 | buildTool 自动处理 → k=1 |
| 新增权限模式 | permissions.ts + classifier + denialTracking + 12个权限组件 | ~16 | 集中类型+策略 → k≈5 |
| 新增 Session 字段 | logs.ts + sessionTranscript + server/services + desktop API | ~8 | 工厂函数+共享类型 → k≈3 |
| 换 LLM 提供商 | api/client.ts + bootstrap + 配置 | ~5 | 防腐层adapter → k≈2 |
| 换终端渲染器 | ink/ (60个文件) + components/ (200+文件) | ~260 | 无解（这是核心耦合） |

**核心洞察**：cc-haha 最大的耦合点不是数据（JSONL 已经解耦），不是 UI（两个独立前端），而是 **终端渲染器（Ink）**。Ink fork 的 60 个文件是全局最大的单体依赖，更换它将重写整个 TUI 层。

---

> 本文分析基于 2026-07-04 的 cc-haha 代码库（`main` 分支, commit eddaec54）。设计决策的解释来自代码阅读和架构推断，可能不完全反映原始设计者意图。
