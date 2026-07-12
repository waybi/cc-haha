# cc-haha 施工序列（按 Koda 方法论映射）

> 将 Koda 分层施工法映射到 cc-haha 的模块结构上。不是真的要重建 cc-haha，而是**通过"如果要重做，应该按什么顺序"来理解依赖拓扑**。

## 依赖拓扑

```
Phase 0: 类型基础 + 常量 + 轻量 store   ← 零内部依赖，所有人依赖它
Phase 1: 工具契约 + AppState 定义       ← 依赖 Phase 0 类型
Phase 2: 工具实现 + MCP/LSP 协议层      ← 依赖 Phase 1 工具契约
Phase 3: TUI 组件 + 命令 + Hooks        ← 依赖 Phase 2 工具
Phase 4: Server + API 路由壳            ← 依赖 Phase 0-2 核心类型
Phase 5: Desktop 壳 + Adapters 侧车     ← 依赖 Phase 4 API 端点
```

**规矩**：下一层不完、上一层不动。每层独立可验证。

---

## Phase 0: 类型基础 + 常量 + 轻量 store

### 依赖
无。

### 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 保留 | `src/types/ids.ts` | SessionId/AgentId 品牌化类型 + asSessionId/asAgentId/toAgentId |
| 保留 | `src/types/permissions.ts` | 权限模式、行为、规则类型（250行纯类型） |
| 保留 | `src/types/connectorText.ts` | 纯类型定义 |
| 保留 | `src/constants/common.ts` | 日期工具函数 |
| 保留 | `src/constants/files.ts` | 二进制扩展名常量 + hasBinaryExtension() |
| 保留 | `src/constants/apiLimits.ts` | API 限制常量 |
| 保留 | `src/constants/betas.ts` | 实验性功能标志 |
| 保留 | `src/constants/businessErrors.ts` | 业务错误码 |
| 保留 | `src/constants/errorIds.ts` | 错误ID枚举 |
| 保留 | `src/constants/figures.ts` | 数字常量 |
| 保留 | `src/constants/keys.ts` | key 常量 |
| 保留 | `src/constants/messages.ts` | 消息常量 |
| 保留 | `src/constants/outputStyles.ts` | 输出样式常量 |
| 保留 | `src/constants/spinnerVerbs.ts` | 加载动画文案 |
| 保留 | `src/constants/toolLimits.ts` | 工具调用限制 |
| 保留 | `src/constants/turnCompletionVerbs.ts` | 轮次完成文案 |
| 保留 | `src/constants/xml.ts` | XML 标签常量 |
| 保留 | `src/constants/prompts.ts` | 提示词常量 |
| 保留 | `src/constants/system.ts` | 系统常量 |
| 保留 | `src/constants/systemPromptSections.ts` | 系统提示词分段名 |
| 保留 | `src/state/store.ts` | 通用 pub/sub Store<T>（15行） |
| 保留 | `src/utils/array.ts` | 纯数组工具 |
| 保留 | `src/utils/abortController.ts` | AbortController 工具 |
| 保留 | `src/utils/agentId.ts` | AgentId 工具 |
| 保留 | `src/utils/CircularBuffer.ts` | 循环缓冲区 |
| 保留 | `src/utils/Cursor.ts` | 游标类型 |

### 验收标准
- [ ] `bun run build` 通过（无循环依赖）
- [ ] `createStore<T>()` 可实例化，基本 pub/sub 正常工作
- [ ] SessionId / AgentId 类型编译时互斥验证
- [ ] 所有 constants 文件零内部 import

### 禁止事项
- ❌ Phase 0 不 import 任何 Phase 1+ 模块
- ❌ 不能在 types/ 中引入运行时行为
- ❌ 不能在 constants/ 中引入 tools/ 或 services/ 依赖

---

## Phase 1: 工具契约 + AppState 定义

### 依赖
Phase 0（类型 + 常量 + store）

### 文件清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 保留 | `src/Tool.ts` | **最核心文件** — buildTool / ToolUseContext / ValidationResult / CompactProgressEvent |
| 保留 | `src/state/AppStateStore.ts` | 全局应用状态类型定义 + helper 函数 |
| 保留 | `src/state/AppState.tsx` | React Provider + useAppState/useSetAppState hooks |
| 保留 | `src/types/logs.ts` | SerializedMessage + LogOption 类型（JSONL 持久化格式） |
| 保留 | `src/types/messageQueueTypes.ts` | 消息队列类型 |
| 保留 | `src/types/notebook.ts` | Notebook 类型 |
| 保留 | `src/types/textInputTypes.ts` | 文本输入类型 |
| stub | `src/types/command.ts` | Command 接口定义（去掉 hooks/services import） |
| stub | `src/types/hooks.ts` | Hook 事件 schema（去掉 lazySchema import） |
| stub | `src/types/plugin.ts` | Plugin 接口（去掉 lsp/mcp/skills import） |
| 保留 | `src/constants/tools.ts` | 工具名称常量 + ALLOWED/DISALLOWED 集合（依赖各工具 constants/） |
| 保留 | `src/constants/querySource.ts` | QuerySource 类型 |
| 保留 | `src/types/tools.ts` | 工具进度类型（stub 需处理） |

### 处理规则

**保留** = 完整保留现有代码，这些文件已经满足 Phase 1 的依赖约束。

**Stub** = 提取纯接口部分，暂时移除对 hooks/services/tools 实现的依赖。例如 `command.ts` 目前 import 了 `useCanUseTool`、`compact`、`mcp/types` 等——这些需要在 Phase 1 中去掉，换成纯接口定义。

### 验收标准
- [ ] `buildTool()` 工厂函数可调用不抛异常
- [ ] `ToolUseContext` 类型编译通过
- [ ] `AppStateStore` 可创建初始状态
- [ ] Tool 名称常量注册集合正确

### 禁止事项
- ❌ Tool.ts 不能 import 具体的工具实现（如 BashTool、FileReadTool）
- ❌ AppState 不能引用 Ink 组件类型

---

## Phase 2: 工具实现 + MCP/LSP 协议层

### 依赖
Phase 0 + Phase 1

### 文件清单

**核心工具（必须保留完整实现）**：

| 操作 | 文件 | 说明 |
|------|------|------|
| 保留 | `src/tools/BashTool/` | Shell 命令执行 — agent 核心能力 |
| 保留 | `src/tools/FileReadTool/` | 文件读取 — agent 核心能力 |
| 保留 | `src/tools/FileWriteTool/` | 文件写入 — agent 核心能力 |
| 保留 | `src/tools/FileEditTool/` | 文件编辑 — agent 核心能力 |
| 保留 | `src/tools/GrepTool/` | 代码搜索 — agent 核心能力 |
| 保留 | `src/tools/GlobTool/` | 文件模式匹配 — agent 核心能力 |
| 保留 | `src/tools/TaskTool/` 系列 | TaskCreate/TaskGet/TaskList/TaskUpdate/TaskOutput/TaskStop |
| 保留 | `src/tools/SendMessageTool/` | 子 agent 间通信 |
| 保留 | `src/tools/SkillTool/` | 技能调用 |
| stub | `src/tools/AgentTool/` | 子 agent 启动 — stub（依赖 coordinator） |
| stub | `src/tools/EnterPlanModeTool/` | 计划模式 — stub（依赖完整的计划系统） |
| stub | `src/tools/ExitPlanModeTool/` | 退出计划模式 — stub |
| stub | `src/tools/WebFetchTool/` | HTTP 调用 — stub |
| stub | `src/tools/WebSearchTool/` | 搜索 — stub（依赖外部 API） |
| stub | `src/tools/MCPTool/` | MCP 工具代理 — stub |

**服务层（API 客户端 + MCP + LSP）**：

| 操作 | 文件 | 说明 |
|------|------|------|
| 保留 | `src/services/api/client.ts` | Anthropic API 客户端 |
| 保留 | `src/services/api/claude.ts` | Claude 消息创建 |
| 保留 | `src/services/api/bootstrap.ts` | API 启动 |
| 保留 | `src/services/mcp/types.ts` | MCP 类型定义 |
| stub | `src/services/mcp/MCPConnectionManager.ts` | MCP 连接管理 — stub |
| stub | `src/services/lsp/` | LSP 集成 — stub |

### 验收标准
- [ ] 8 个核心工具全部通过 `buildTool()` 注册
- [ ] BashTool 可执行简单命令（echo hello）
- [ ] FileReadTool 可读取测试文件
- [ ] API client 可发送请求（mock 模式）

### 禁止事项
- ❌ 工具实现不能 import Ink 组件
- ❌ API client 不能 import commands/
- ❌ MCP 协议层不能 import server/

---

## Phase 3: TUI 组件 + 命令 + Hooks

### 依赖
Phase 0 + Phase 1 + Phase 2

### 文件清单

**Ink 渲染器（约 60 个文件）**：

| 操作 | 核心文件 | 说明 |
|------|---------|------|
| 保留 | `src/ink/ink.tsx` | Ink 核心类 — 管理 React reconciler + Yoga 布局 |
| 保留 | `src/ink/renderer.ts` | 渲染器 — 从 DOM 节点到屏幕输出 |
| 保留 | `src/ink/render-node-to-output.ts` | 节点到输出行转换 |
| 保留 | `src/ink/render-to-screen.ts` | 帧差分 + 屏幕输出 |
| 保留 | `src/ink/screen.ts` | 屏幕缓冲区 |
| 保留 | `src/ink/terminal.ts` | 终端写入 |
| 保留 | `src/ink/log-update.ts` | 终端更新节流 |
| 保留 | `src/ink/selection.ts` | 文本选择 |
| 保留 | `src/ink/searchHighlight.ts` | 搜索高亮 |
| 保留 | `src/ink/optimizer.ts` | 输出优化 |
| 保留 | `src/ink/hit-test.ts` | 点击坐标转组件 |
| 保留 | `src/ink/reconciler.ts` | React 自定义调和器 |
| 保留 | `src/ink/root.ts` | createRoot/render API |
| 保留 | 其余 ~47 个 ink 文件 | 布局、样式、组件转换 |

**TUI 组件（核心消息渲染）**：

| 操作 | 文件 | 说明 |
|------|------|------|
| 保留 | `src/components/MessageList.tsx` | 消息列表 |
| 保留 | `src/components/ToolUseBlock.tsx` | 工具调用块渲染 |
| 保留 | `src/components/permissions/` | 权限对话框（12个类型） |
| 保留 | `src/components/Spinner.tsx` | 加载动画 |
| 保留 | `src/components/messages/` | 各类消息气泡 |
| stub | `src/components/settings/` | 设置面板 — stub |
| stub | `src/components/mcp/` | MCP 配置UI — stub |

**命令（约 90 个命令）**：

| 操作 | 文件 | 说明 |
|------|------|------|
| 保留 | `src/commands/config.ts` | 配置命令 |
| 保留 | `src/commands/resume.ts` | 恢复会话 |
| 保留 | `src/commands/model.ts` | 模型切换 |
| 保留 | `src/commands/compact.ts` | 上下文压缩 |
| 保留 | `src/commands/mcp.ts` | MCP 管理 |
| 保留 | `src/commands/permissions.ts` | 权限管理 |
| stub | 其余 ~84 个命令 | 按需 stub |

**Hooks（约 80 个 React hooks）**：

| 操作 | 核心文件 | 说明 |
|------|---------|------|
| 保留 | `src/hooks/useInput.ts` | 输入捕获 |
| 保留 | `src/hooks/useCanUseTool.ts` | 工具权限检查 |
| 保留 | `src/hooks/useMessages.ts` | 消息管理 |
| 保留 | `src/hooks/useSettings.ts` | 设置管理 |
| 保留 | `src/hooks/useSession.ts` | 会话管理 |
| stub | 其余 ~75 个 hooks | 按需 stub |

### 验收标准
- [ ] `Ink.render(<App/>)` 可在终端渲染空状态
- [ ] 消息输入循环工作（输入 → 渲染 → 输入）
- [ ] 权限对话框可弹出/关闭
- [ ] 至少 20 个核心命令可注册执行

### 禁止事项
- ❌ Ink 渲染器不能直接 import server/ 模块
- ❌ Hooks 不能 import desktop/ 模块
- ❌ 命令不能直接 import adapters/

---

## Phase 4: Server + API 路由壳

### 依赖
Phase 0 + Phase 1 + Phase 2

### 路由清单（按域分组）

| API 域 | 端点数 | 处理方式 |
|--------|--------|---------|
| `/api/sessions` | 10 | 薄 delegate 保留 |
| `/api/conversations` | 6 | 薄 delegate 保留 |
| `/api/providers` | 6 | 薄 delegate 保留 |
| `/api/models` | 3 | 薄 delegate 保留 |
| `/api/agents` | 5 | 薄 delegate 保留 |
| `/api/teams` | 5 | 薄 delegate 保留 |
| `/api/settings` | 12 | 薄 delegate 保留 |
| `/api/mcp` | 6 | 薄 delegate 保留 |
| `/api/memory` | 4 | 薄 delegate 保留 |
| `/api/skills` | 4 | 薄 delegate 保留 |
| `/api/plugins` | 3 | 薄 delegate 保留 |
| `/api/traces` | 4 | 薄 delegate 保留 |
| `/api/adapters` | 3 | 薄 delegate 保留 |
| `/api/computer-use` | 4 | 薄 delegate 保留 |
| `/api/desktop-ui` | 2 | 薄 delegate 保留 |
| `/api/health` | 1 | 原样保留（无依赖） |
| `/api/h5-access` | 3 | 薄 delegate 保留 |
| `/api/search` | 2 | 薄 delegate 保留 |
| `/api/status` | 2 | 薄 delegate 保留 |
| `/api/scheduled-tasks` | 5 | 薄 delegate 保留 |
| `/api/activityStats` | 1 | 薄 delegate 保留 |
| `/api/doctor` | 1 | 薄 delegate 保留 |
| `/api/diagnostics` | 2 | 薄 delegate 保留 |
| `/api/localFile` | 2 | 薄 delegate 保留 |
| `/api/previewFs` | 1 | 薄 delegate 保留 |
| `/api/filesystem` | 3 | 薄 delegate 保留 |
| `/api/oauth` | 4 | 薄 delegate 保留 |
| 其余 | ~10 | 薄 delegate 保留 |

### WebSocket 处理

| 操作 | 文件 | 说明 |
|------|------|------|
| 保留 | `src/server/ws/handler.ts` | WebSocket 事件循环 |
| 保留 | `src/server/ws/events.ts` | WS 事件定义 |

### Server 中间件

| 操作 | 文件 | 说明 |
|------|------|------|
| 保留 | `src/server/middleware/cors.ts` | CORS |
| 保留 | `src/server/middleware/auth.ts` | Auth |
| 保留 | `src/server/middleware/errorHandler.ts` | 错误处理 |

### 验收标准
- [ ] `bun run src/server/index.ts` 启动，监听 3456 端口
- [ ] `GET /health` 返回 `{ status: "ok" }`
- [ ] WebSocket 连接可建立/断开
- [ ] API 端点编译通过，无 500 错误
- [ ] 参数校验逻辑保留（缺失参数返回 400）

### 禁止事项
- ❌ API 路由不直接 import tools/ 或 components/
- ❌ 不直接 import Ink 渲染器
- ❌ Server 不写 CLI 的 JSONL 日志文件

---

## Phase 5: Desktop 壳 + Adapters 侧车

### 依赖
Phase 4（所有 API 端点就绪）

### Desktop 桌面应用

**完整保留**：Electron + React + Vite 桌面壳。

| 分类 | 文件 | 处理 |
|------|------|------|
| `desktop/electron/main.ts` | 1 | **原样保留** — Electron 主进程入口 |
| `desktop/electron/preload.ts` | 1 | **原样保留** — 预加载脚本 |
| `desktop/electron/ipc/` | 4 | **原样保留** — IPC 通道 + 能力 |
| `desktop/electron/services/` | 5 | **原样保留** — App 身份、对话框、Keychain、菜单 |
| `desktop/src/App.tsx` | 1 | **原样保留** — React 根组件 |
| `desktop/src/main.tsx` | 1 | **原样保留** — React 入口 |
| `desktop/src/api/` | ~35 | **全部保留** — REST + WebSocket API 客户端 |
| `desktop/src/stores/` | ~40 | **全部保留** — Zustand 状态存储 |
| `desktop/src/components/` | ~20 目录 | **全部保留** — React UI 组件 |
| `desktop/src/pages/` | ~28 | **全部保留** — 路由页面 |
| `desktop/src/hooks/` | — | **全部保留** — 桌面端特定 hooks |
| `desktop/src/i18n/` | — | **全部保留** — 国际化 |
| `desktop/src/theme/` | — | **全部保留** — 主题系统 |

### Adapters 适配器

| 操作 | 文件 | 说明 |
|------|------|------|
| 保留 | `adapters/common/ws-bridge.ts` | WebSocket 桥接 |
| 保留 | `adapters/common/session-store.ts` | 会话映射持久化 |
| 保留 | `adapters/common/chat-queue.ts` | 消息队列 |
| 保留 | `adapters/common/session-recovery.ts` | 断线恢复 |
| 保留 | `adapters/common/pairing.ts` | 配对协议 |
| 保留 | `adapters/common/permission.ts` | 权限处理 |
| 保留 | `adapters/common/config.ts` | 适配器配置 |
| 保留 | `adapters/common/format.ts` | 格式化工具 |
| 保留 | `adapters/common/http-client.ts` | HTTP 客户端 |
| 保留 | `adapters/common/message-buffer.ts` | 消息缓冲 |
| 保留 | `adapters/common/message-dedup.ts` | 消息去重 |
| 保留 | `adapters/telegram/` | Telegram Bot |
| 保留 | `adapters/feishu/` | 飞书 Bot |
| 保留 | `adapters/wechat/` | 微信 Bot |
| 保留 | `adapters/dingtalk/` | 钉钉 Bot |
| 保留 | `adapters/whatsapp/` | WhatsApp Bot |

### 验收标准
- [ ] `cd desktop && bun run dev` 启动，桌面应用连接到 localhost:3456
- [ ] 会话列表可加载（通过 API 获取）
- [ ] WebSocket 实时消息正常
- [ ] Telegram/飞书 Bot 可接收/回复消息
- [ ] 所有桌面页面渲染无崩溃

### 禁止事项
- ❌ Desktop 不直接 import `src/tools/` 或 `src/components/`
- ❌ Adapter 不直接 import `src/` CLI 内部模块
- ❌ Desktop 不自己写 JSONL 日志

---

## 总览

| Phase | 模块 | 文件数（约） | 关键约束 |
|-------|------|------------|---------|
| 0 | 类型基础 + 常量 + store | ~25 | 零内部依赖，所有人依赖它 |
| 1 | 工具契约 + AppState | ~15 | 只依赖 Phase 0，定义所有接口契约 |
| 2 | 工具实现 + MCP/LSP | ~120 | 实现 buildTool 契约，不碰 UI |
| 3 | TUI 组件 + 命令 + Hooks | ~250 | 依赖工具层，不碰 Server |
| 4 | Server + API 壳 | ~100 | 依赖核心类型，HTTP/WS 为 Desktop/Adapter 服务 |
| 5 | Desktop + Adapters | ~200 | 依赖 API 端点，独立进程 |

**总计**：~710 个文件纳入分析。

## 施工纪律

1. **一 Phase 一 commit** — 每个 Phase 完成后独立提交
2. **先编译，后功能** — 每个 Phase 完成时 `bun run build` 必须通过
3. **不跳 Phase** — 下一层依赖不完，上一层不动
4. **接口即栅栏** — `buildTool()`、`ToolUseContext`、`Store<T>` 一旦在 Phase 0-1 中确定，后续 Phase 不能改签名
5. **feature() 不能有副作用** — 编译时 DCE 会消除条件内代码，不能依赖副作用

## cc-haha 与 Koda 的关键差异

| 差异点 | 说明 |
|--------|------|
| **没有独立 Store 接口层** | cc-haha 直接用 JSONL 文件做持久化，没有 `TaskStore`/`AgentStore` 抽象。数据库切换比 Koda 更轻量（只改 JSONL 读写模块），但缺乏类型安全的查询接口 |
| **没有防腐层** | cc-haha 的 `services/api/client.ts` 直接消费 Anthropic SDK 类型。没有 `IProviderAdapter.normalize()`。好处是代码更短，坏处是换 LLM 提供商时需要改 API client |
| **双 UI 层** | cc-haha 有 CLI (Ink TUI) 和 Desktop (Electron React) 两个独立的前端，Koda 只有 Next.js。这要求 Server 层提供一致的 REST/WS 接口 |
| **多进程架构** | cc-haha 4 个进程（CLI + Server + Desktop + Adapters），Koda 单进程。JSONL 文件充当进程间数据库 |
| **feature() 门控** | cc-haha 独有，Koda 没有。编译时 DCE + 自动 stub 占位是 cc-haha 处理内外版本差异的核心机制 |
| **终端渲染器是深度 Fork** | cc-haha 的 Ink (60文件) 无法替换，Koda 没有等价的单体依赖 |

---

> 本文基于 2026-07-04 的 cc-haha 代码库分析。施工序列是按照依赖拓扑的理论推导，不反映实际开发顺序。
