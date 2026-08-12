# Agent TUI Manager 开发计划

最后更新：2026-08-12

## 目标

在不改变 Codex、Claude Code、Pi 等 Agent 原生会话数据和使用方式的前提下，提供一个稳定的多 Agent 工作台：多个 Agent 在同一窗口管理，审批、恢复、历史会话、远程控制和审计都可以统一处理。

## 维护规则

- 每完成一个任务，更新本文件的状态、完成日期和验证结果。
- 代码改动前先确认任务属于本计划，避免继续堆叠未收口的 UI 或自动化逻辑。
- Agent 的原生 JSONL、session ID、workspace 和 resume 入口不能被 Manager 私有格式替代。
- 终端正文以原始 PTY 字节流和 xterm 渲染为唯一显示源；JSONL 只用于会话发现、搜索、摘要和审计等辅助能力，不能插入或替代终端正文。
- 正常结束、用户主动中断和异常退出必须严格区分。
- 所有自动批准、远程批准、全自动模式和恢复动作必须写入审计。
- 高风险操作（删除、递归删除、覆盖、提权、工作区外写入）不能通过自动学习或全自动模式放行。

## 当前状态

### 已完成或已实现，待重启验证

- Electron 多 Agent 工作台、工作区选择、原生会话发现和 resume。
- Agent 总览、详情视图、处理中心、批准规则和审计页基础结构。
- 停止、重新启动、删除、异常恢复提示和最大恢复次数配置。
- 原生 Codex/Claude 历史读取、回放缓存、复制和文本粘贴基础能力。
- 分块回放缓存，主进程按会话合并输出，非当前工作区终端不再挂载 Renderer。
- Codex/Claude 工具调用和工具结果的结构化历史解析。
- `start.cmd` 一键启动。

### 当前进行中

- 通知入口和界面收口：已实现右上角通知弹窗、快捷审批、失焦渐隐、添加 Agent/批准规则抽屉真正双击关闭和 Electron 原生菜单栏精简；继续收口终端消息颜色与排版。

### 延期到发布前验收

- 多 Agent 实际压力下的 CPU、IPC、xterm 和内存验证。该项属于发布前稳定性验收，不作为当前功能开发任务；待核心功能收口后统一执行 2、4、6 Agent 压力验证。

### 已收口但未修复

- Codex 终端滚动与历史完整性：新建或恢复 Agent 后只能看到少量历史；即使 Host 与 Renderer 的 scrollback 已提高到 10,000 行，原生完整历史仍未进入 xterm。
- Codex 滚动生命周期：新增 Agent 后，执行一次放大再缩小，scrollbar 可能再次失效，无法继续查看历史。
- 当前仅确认 `conptyInheritCursor` 让 Codex 初始滚动恢复可用，未解决完整历史和放大/缩小后的失效问题。本任务按用户要求暂停，后续必须以真实 Codex 运行态自动化复现为前提继续，不能再让用户代测。

## 实施顺序

### 1. 吞字、输入和排版收口（最高优先级）

- 终端正文只渲染原始 PTY 输出，移除 JSONL 历史插层和角色消息重排。
- 保证 Codex、Claude Code 原生工具调用、工具结果、错误、状态和 ANSI 样式完整进入 xterm。
- JSONL 解析保留为辅助能力，但不参与终端正文渲染。
- 原始输出回放必须保持顺序和完整性，不能静默丢弃可见文本。
- 长文本粘贴、中文输入、控制字符、输入队列和终端卸载后旧输入全部覆盖测试。
- 取消三击放大，保留明确的详情、返回和列表切换操作。

状态：未修复，暂时收口（2026-08-11）。

改造前快照：Git 提交 `ef66249`（`snapshot: save manager before raw terminal refactor`）。

本轮已确认：

- JSONL 历史插层会造成原生 TUI 信息缺失、历史与实时内容割裂，并增加滚动布局开销。
- 详情状态变化存在连续多帧强制滚到底部逻辑。
- 鼠标向上滚动会触发 JSONL 扫描和历史刷新。
- 外层滚动容器与 xterm viewport 同时参与滚动，xterm scrollbar 被 CSS 隐藏。

下一步：

- 移除 Renderer 的 `terminalHistory` 调用和历史 DOM。
- 删除详情切换强制滚动，统一由 xterm viewport 管理滚动。
- 保留纯 xterm 滚轮兼容：在 terminal host 捕获阶段绕过 TUI 鼠标协议，滚轮只调用 `terminal.scrollLines`，不得触发 JSONL 读取、外层容器滚动或自动到底部。
- Codex 使用官方 `--no-alt-screen` 进入 inline TUI，使 xterm 真正拥有可滚动历史；Claude Code 保持原生启动参数。
- 保留输出 IPC 合并、分块 replay 和输入批处理等现有性能修复。
- Codex Host 从启动时持续维护由原始 PTY 解析出的 xterm 状态，并在 Manager 重连时回放压缩后的 ANSI 状态；不再依赖最后 512KB 重绘字节重建 scrollback。
- 状态快照只启用于 Codex；Claude Code、Pi 和通用终端继续使用轻量原始 replay，避免多 Agent 场景增加不必要的解析 CPU。

本轮验证（2026-08-11）：

- `npm run typecheck`：通过。
- 原始 PTY、xterm 滚轮、详情切换、preload、replay、Codex 参数与 Agent adapter 目标测试：通过。
- 完整 controller 测试仍有 6 条旧版自动 continue 预期失败；当前产品策略已改为异常提示和用户采纳后最多尝试一次，后续按第 15 项统一更新旧测试。
- 运行时确认：Claude Code 可滚动，Codex alternate screen 不产生 xterm scrollback；Codex 官方 `--no-alt-screen` 已覆盖新建、resume、异常恢复和手动重启路径。
- 进一步只读诊断确认当前 Codex replay 含 524,288 字符和 12,188 个换行，且没有 alternate-screen/ED(3) 序列，排除了 alternate-screen 清空 scrollback 的早期假设。
- Codex 持续状态重绘可能在用户滚动后立即把 xterm 拉回底部；增加用户浏览锁，新输出写入后恢复用户选中的 scrollback 行，用户滚到底部或输入时才解除。
- 运行态复现进一步确认：最后 512KB Codex replay 含 420 轮 `CSI H`/`CSI 25;1H` 整屏重绘，同版本 xterm 解析结果为 `normal` buffer 但 `baseY=0`、`bufferLength=30`；问题不是滚轮事件，而是环形 raw replay 已丢失更早的真实 scrollback。
- 新增 Codex Host 终端状态快照，50 轮整屏重绘被压缩为小于 2KB 的可恢复 ANSI，恢复后 `baseY > 0`；保留原始 PTY 为唯一数据源和 512KB raw fallback。
- 新建两个 Codex Host 实测排除了构建缓存：状态快照代码已加载，但从启动开始仍只有 30 行、`baseY=0`，说明缺失发生在 Codex 写入终端 scrollback 之前。
- 对照 Codex 0.147.0 与官方 TUI 源码确认 inline viewport 启动依赖 CPR/DSR 光标位置探测；原生终端会立即回复 `CSI 6n`，Manager 的 Renderer 尚未装载时无法可靠回复，Codex 因而回退到原点并持续整屏重绘。
- Codex 持久 Host 现在用同版本 xterm 即时回答终端协议查询；Renderer 丢弃重复的 CPR/DA/键盘增强响应，避免它们在稍后被误送成用户输入。
- 本地协议实验确认 xterm 对 `CSI 6n` 返回 `CSI 1;1R`；TypeScript 类型检查、4 条 DSR/滚动聚焦测试和 Electron production build 均通过。仍需用此改动之后创建的新 Codex Host 做最终运行态验证。
- Windows node-pty 独立 PTY 实验确认：`conptyInheritCursor=false` 时 Codex 不发送光标探测；设为 `true` 后才发送并收到回复。Manager 已对 Codex 开启该选项，其他 Agent 不变。
- Codex Host 与 Renderer 的 scrollback 上限从 1,500 行提升到 10,000 行；仍使用压缩后的 xterm 状态，不恢复大体积 raw replay，避免历史越多越卡。
- `npm run typecheck`、Electron production build、5 条 replay 单元测试、8 条 Host 重连集成测试及 3 条 Renderer 原始 PTY/滚动测试均通过。

剩余运行时验证：

- 新建和重新启动 Codex 后仍只能看到部分原生历史。
- 新增 Agent 后执行放大、缩小，Codex scrollbar 仍可能失效。
- 后续恢复本任务时，先建立真实 Codex Host + Renderer 的可重复自动化验证，再修改滚动实现。

### 2. 终端性能和显示稳定性

- 验证 2、4、6 个 Agent 的持续输出性能。
- 继续减少输出 IPC、React 重渲染、xterm 重排和历史 `<pre>` 布局开销。
- 切换工作区时只挂载当前 Agent，后台会话继续运行并通过 replay 恢复。
- 放大、缩小、审批、状态变化不能触发从头到尾的滚屏。
- Codex 和 Claude Code 都必须支持正常鼠标滚轮、PgUp/PgDn、Home/End、复制和粘贴。

状态：功能开发暂缓；压力验证移至第 15 项发布前验收（2026-08-11）。Codex 历史完整性与放大/缩小后滚动失效仍按“已收口但未修复”记录保留。

### 3. 全局处理中心和审批队列

- 所有工作区和 Agent 共用一个处理中心。
- 审批卡片显示 Agent、工作区、会话 ID、工具名称、命令/参数、reason、文件路径、影响范围和风险等级。
- 支持单条批准、拒绝、一键批准全部。
- 兼容一个 Agent 单轮多工具调用，也兼容多个 Agent 并发请求；批准一条不能隐藏其他待处理项。
- 自动批准、手动批准、拒绝、批量批准、审批失败全部写入审计。
- 解决授权请求识别脆弱问题，优先使用 Codex/Claude 结构化事件或 Hook，而不是只靠文本语义。

状态：已实现，待运行态验收（2026-08-11）。

本轮完成：

- 新增全局 ApprovalRequest 队列，每条请求使用唯一 requestId，不再由 Session 上的一条字段互相覆盖。
- 同一 Agent 单轮多工具请求、多个 Agent 并发请求可以同时保留；批准或拒绝一条只处理对应请求。
- Claude Code 使用 PermissionRequest Hook 的原生结构化 allow/deny 决策；Hook 请求会保留到用户处理，工具、参数、文件路径和目标路径进入详情。
- 处理中心改为全部工作区共享，加入单条批准、拒绝和“批准全部”；批量审批仅跳过命中严重指令黑名单的请求，普通写入、普通工具和未识别工具均可批量批准。
- Agent 卡片继续兼容原有单条批准入口，审批后通过请求队列刷新，不会隐藏其他待处理项。
- 手动批准、原生终端批准、拒绝和批量审批写入审计，并带请求键、工具名、命令和风险信息。
- 加入旧 preload 兼容保护，Renderer 热更新先于 Electron preload 时不会再把 Agent 总览刷空。
- 在“批准这一次”旁加入“作为安全命令批准”：批准当前请求并把完整命令或工具名以精确规则持久化，后续同一请求直接匹配，不再作为待识别工具重复询问。
- 安全命令学习改为高危黑名单边界；普通完整命令和无风险自定义工具可显式学习，删除、提权、下载执行、敏感覆盖、系统破坏及明显风险工具名仍禁止学习，Controller 保留二次校验。
- “批准全部”使用独立且更窄的严重指令黑名单，不复用自动学习规则；主进程逐条重新判定，避免前端状态过期绕过安全边界。

本轮改动文件：

- src/shared/manager-api.ts、src/shared/protocol.ts
- electron/session-controller.ts、electron/session-host-manager.ts、electron/claude-permission-hook.ts、electron/agent-adapters.ts
- electron/main.ts、electron/preload.ts
- src/App.tsx、src/AttentionCenter.tsx、src/styles.css
- tests/unit/session-controller.test.ts、tests/unit/preload.test.ts、tests/unit/app.test.tsx

验证结果：

- npm run typecheck：通过。
- npm run build：通过。
- 审批队列针对性测试：8 条通过，覆盖同 Session 多请求、双 Agent 并发、按请求批准/拒绝和批量审批安全跳过。
- Renderer 与 preload 聚焦测试：20 条通过。
- 本轮安全规则、规则持久化、preload 和 App 交互回归：65 条通过；Controller 审批链路针对性测试 9 条通过。
- 完整 Controller 测试仍有 6 条旧自动 continue 策略断言失败，属于第 15 项已记录的旧测试更新，不是本轮审批回归。

剩余验收：

- 在真实 Claude Code 单轮多工具请求中确认 Hook 队列、拒绝文案和批量批准交互。
- Codex 当前仍以官方终端审批提示的兼容识别进入同一队列；后续若官方暴露稳定结构化事件，再替换文本兼容层。

### 4. 通知入口和界面收口

- 右上角叹号改为通知弹窗，不直接跳转处理中心。
- 通知弹窗显示简要审批信息，并支持直接批准。
- 添加 Agent、设置等右侧抽屉支持空白处第一次提示、第二次关闭，同时保留已填写表单。
- 移除 Electron 顶部无用 Tab 栏，保留 Manager 自己的导航。
- 用户消息、Agent 消息、工具调用、工具结果、错误和状态使用明确但克制的颜色区分。
- 重新整理终端消息分组、间距、代码块和状态栏，严格遵守 `docs/design-system.md`。

状态：进行中（2026-08-11）。

本轮完成：

- 右上角通知弹窗不再直接跳转处理中心，展示最近审批/异常项并支持原位批准。
- 通知失去真实焦点或点击外部时以 160ms 渐隐，重新获得焦点会立即恢复；移除多余的关闭键，鼠标从通知按钮移动到弹窗内容不会误关闭。
- 添加 Agent 和批准规则抽屉均改为浏览器原生双击事件关闭；任意间隔的两次单击不会再累计触发关闭，首次点击提示会在 500ms 后自动解除。
- 添加 Agent 抽屉继续保留已填写表单；批准规则入口沿用既定右侧抽屉视觉和高危命令说明。
- Electron 原生菜单栏已隐藏，Manager 左侧导航始终保留。

验证结果：

- `npm run typecheck`：通过。
- 安全规则、规则持久化、preload 与 App 交互测试：65 条通过。
- Controller 审批队列、安全命令、批量审批与 Claude Hook 针对性测试：9 条通过。

剩余范围：

- 终端正文颜色仍由 Agent 原生 ANSI/xterm 输出决定，不重新引入 JSONL 消息 DOM；后续只在不破坏原始终端和性能的前提下收口状态栏与非终端辅助消息排版。

### 5. Agent 列表模式

- 增加总览模式之外的列表模式。
- 左侧约 10% 到 20% 显示 Agent 列表，右侧约 80% 到 90% 显示当前终端。
- 点击列表切换 Agent，终端主体尺寸保持稳定，减少 resize 引起的重绘和滚屏。
- 列表中显示状态、工作区、待审批和异常恢复提示。
- 列表样式参考B:/AiDemo/AgentTuiManager/.superpowers/brainstorm/windows-1786089989/content/workbench-layouts-v1.html 里的主终端模式

状态：已实现，待运行态验收（2026-08-11）。

本轮完成：

- Section Bar 增加“总览/列表”分段控制，默认保留原有终端墙。
- 列表模式使用约 10%–20% 的 Agent 列表和剩余区域的单一主终端；列表显示 Agent 类型、名称、工作区和状态。
- 总览墙和列表模式默认都展示全部工作区；“按工作区划分”开关开启后，两种模式才按左侧当前工作区筛选。
- 全部工作区模式隐藏左侧工作区分组并在顶部明确显示“全部工作区”，避免造成仍在按工作区筛选的误解。
- 所有 Terminal 实例在总览、列表、Agent 切换和工作区开关之间保持同一 React 层级；非活动或范围外终端只隐藏，不卸载、不重连 PTY、不重新读取 replay。
- 工作区 Rail 的视图导航、顶部栏和 Section Bar 在列表模式中持续保留；窄屏时 Agent 列表收缩为 72px 标识列。

验证结果：

- App 交互测试 24 条通过，其中跨工作区双 Agent 测试确认总览/列表切换、Agent 切换和工作区开关往返后 Terminal 构造次数始终保持为 2。
- `npm run typecheck`：通过。
- `npm run build`：通过。

剩余验收：

- 在真实双 Agent 持续输出场景确认列表切换后的焦点、滚动位置和 ResizeObserver 行为；该项并入第 15 项运行态验收，不阻塞后续功能。

### 6. 每个 Agent 独立配置

- 每个 Agent 可独立保存 Base URL、API Key、Model 和启动参数；默认关闭并继承本机 Codex、Claude Code 或 Pi 配置。
- 独立配置只通过目标 Agent 的 PTY 环境变量和启动参数注入，不读取、写入或覆盖 Agent 的本机配置文件。
- API Key、Base URL、Model 和启动参数使用 Electron `safeStorage` 加密保存；Host 注册表、Session 摘要和审计日志不包含 API Key。
- 安全存储不可用、独立配置丢失或无法解密时拒绝使用该独立配置启动，不静默降级到另一套服务端配置；未开启独立配置的 Agent 仍正常继承本机配置。

状态：Provider 覆盖修复及自动化验证完成（2026-08-12），待用户重启后的运行态验收。

已完成：

- Agent 卡片和详情页可打开与新增 Agent 一致的右侧编辑抽屉。
- 可修改显示名称；工作区、Agent 类型、审批策略和 Executable 仍明确置灰锁定。
- 修改名称只更新 Manager 内的 Session、待审批项和 Host 注册元数据，不停止、不重启 Agent，也不改变原生 session ID 或 recovery 配方。
- 名称会统一去除首尾空白并拒绝空名称、换行和 NUL；审计记录使用最终规范化名称。
- 在“迁移外部会话”之后增加“独立配置”标签页；默认关闭时明确显示“继承本机配置”。
- 新增和编辑 Agent 均支持保存独立 Base URL、API Key、Model 和启动参数；编辑运行中的 Agent 不立即重启，下次启动、恢复或手动重启时生效。
- 已保存 API Key 不回显；留空保留原 Key，也可明确清除。删除 Agent 时同步删除对应加密 Profile。
- Codex 不再写入或依赖 `agent_tui_manager` 临时 Provider；独立配置复用本机已存在的命名 Provider ID，通过子进程级 `-c` 覆盖地址和密钥环境变量。内置 `openai` 使用 `openai_base_url`，不修改本机配置。
- Claude Code 使用其官方 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 隔离开关，阻止本机 `settings.json` 中的 Base URL、认证 Token、云 Provider 和模型变量覆盖当前 Agent；自定义网关使用 `ANTHROPIC_AUTH_TOKEN`，官方 Anthropic 端点使用 `ANTHROPIC_API_KEY`。
- Generic/Pi 继续使用 OpenAI-compatible 环境变量。
- 新建、恢复、手动重启和异常恢复共用同一配置解析链路。
- 修复验证：Codex 0.147.0 官方 CLI 已成功解析临时 Provider（退出码 0）；修复前后 `~/.codex/config.toml` 与 `~/.claude/settings.json` 的 SHA-256 和修改时间均完全不变。
- 独立配置、加密存储、Renderer、preload、Controller 目标测试 38 条通过；Host 配置注入与敏感信息隔离集成测试 2 条通过；production build、typecheck 和 `git diff --check` 通过。
- 停止或删除 Agent 时，针对历史上已写入 `agent_tui_manager` 的 Codex 会话，会在 writer 释放后先修复目标 JSONL 最后一条旧 Provider，再通过官方 `codex app-server` 的 `thread/resume(modelProvider=全局 Provider, excludeTurns=true)` 让 Codex 自己同步 SQLite 线程投影；不会发送消息、启动 turn 或调用工具。失败时停止仍完成，删除会保留 Manager 条目并记录审计。
- 现场修复确认 Codex 0.147.0 同时从 JSONL 和 `state_5.sqlite.threads.model_provider` 读取 Provider；只修 JSONL 不足以恢复原生 `codex resume`。受影响会话 `019f649d-147c-7161-a424-73073c65f441` 已恢复为 `custom`，官方无交互 resume 验证返回 `provider=custom`。
- 编辑 Agent 抽屉提交状态在 `finally` 中复位，保存成功后再次打开不会永久显示“请稍后…”。
- 删除历史 Provider 修复增加前置判定：仅当目标 Codex JSONL 确实仍含 `agent_tui_manager` 时才启动官方 app-server 同步，普通已停止 Agent 删除不再无故等待同步超时。
- 已停止卡片在重新启动或删除期间显示“请稍后…”，失败后直接在卡片内显示可理解的错误；删除失败不会静默无响应。
- 添加 Agent 时选中的原生历史会话会跨“新会话 / 恢复历史 / 迁移外部会话 / 独立配置”标签保留；再次点击同一历史卡片可取消选择并按新会话启动。
- 本轮回归验证：`npm run typecheck` 通过；App 与 Codex Provider 迁移共 35 条目标测试通过。

### 7. CCSwitch 接入

- 参考并研究 CCSwitch 源码：<https://github.com/farion1231/cc-switch>
- 读取 CCSwitch 可用 Provider、Base URL、API Key 和 Model。
- 在添加 Agent 和窗口配置中提供选择器。
- 配置导入失败、Provider 不存在、模型不可用时给出可理解的错误。
- 不改变 CCSwitch 原有配置文件格式；优先读取，必要时通过受控接口写入。

状态：只读 Provider 接入已实现（2026-08-12），待用户重启后的运行态启动验收。

已完成：

- 自动定位并只读打开 `~/.cc-switch/cc-switch.db`，按 Agent 类型读取 Codex 与 Claude Provider；不修改 CCSwitch 数据库和配置。
- Codex 使用结构化 JSON 和 TOML 解析 `auth.OPENAI_API_KEY`、`model_provider`、`model_providers.<id>.base_url` 与 `model`，不假设 Provider ID 固定为 `custom`。
- Claude 使用 CCSwitch 官方字段 `env.ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`。
- 新增和编辑 Agent 的“独立配置”页均可在“手动配置 / CCSwitch”之间切换，并显示 Provider 名称、地址主机、模型、当前标记和密钥是否已配置。
- Renderer 和 preload 只接收非敏感 Provider 摘要；用户保存时仅提交 `providerId`，主进程重新读取完整 Provider 并复制到 Manager 自己的 `safeStorage` 加密 Profile。
- CCSwitch 来源不能由 Renderer 提交 Base URL 或 API Key；缺少 Provider、Base URL、密钥或配置无法解析时给出可理解的错误并拒绝启动。
- 已选择的 Provider 保存为快照，CCSwitch 后续切换或修改不会隐式改变现有 Agent；运行中的 Agent 仍在下次重启或恢复时应用新配置。
- SQLite 使用纯 JavaScript/WASM 依赖，不引入 Electron 原生 ABI；真实本机数据库读取到 11 个 Codex、16 个 Claude Provider，返回摘要不含密钥字段。
- 修复 Electron production bundle 内联 `sql.js` 后 CommonJS `module.exports` 上下文丢失的问题；主进程现在将 `sql.js` 作为运行时依赖原生加载。

验证结果：

- `npm run typecheck`：通过。
- `npm run build`：通过。
- CCSwitch 解析、preload、App 抽屉、加密存储和启动注入聚焦测试：40 条通过；App 单独复跑 29 条通过。
- `git diff --check`：通过。
- 修复前后未写入 `~/.codex/config.toml` 与 `~/.claude/settings.json`；CCSwitch 读取器仅使用 `readFile` 和内存数据库。

剩余验收：

- 用户重启 Manager 后，分别用一个 Codex Provider 和一个 Claude Provider 新建/重启 Agent，确认请求实际命中所选 Base URL、Key 和 Model。
- 正式 Windows 打包时确认 `sql.js/dist/sql-wasm.wasm` 随依赖进入安装包；当前 `start.cmd` 开发启动链路已可解析该资源。

### 8. 全自动模式

- Agent 窗口右上角增加全自动模式入口。
- 处理中心里 Codex和claudeCode的工具调用原因仍需补全，code工具调用里是有原文的 如 Reason: 允许我读取 Git 命令执行器及工作区服务相关方法，以复用其参数化命令和脱敏边界实现只读 Git 工具吗？ Claude Code 需要找下源码是否有相关信息 该原因字段也需要同步更新到审计
- 开启前明确提示风险，必须勾选确认后才能启动。
- 全自动模式默认允许普通读写和已配置工具，但始终禁止删除、递归删除、覆盖、提权和工作区外写入。
- 启动、停止、自动批准、阻止高风险操作和退出全自动模式全部记录审计。
- 两个小细节也在此阶段修正：1、待处理通知没有拒绝按钮 需要加上 2：加入自动审批提示没有加入的命令 需要加入方便用户审阅

状态：已实现，待重启后的真实 Codex/Claude Code 运行态验收（2026-08-12）。

本轮完成：

- 每个 Agent 的卡片和放大详情右上角均增加独立“全自动模式”入口；开启前必须勾选风险确认，关闭时明确说明已执行操作不会撤销。
- 全自动状态写入 Host 元数据，Manager 重开、手动重启和异常 resume 后仍按 Agent 保留；不会修改 Agent 本机配置。
- 普通工作区内读取、写入和完整命令可以自动批准；删除、递归删除、提权、敏感系统覆盖、工作区外写入、缺少目标路径的写工具及缺少完整参数的 Shell 请求始终进入人工处理。
- 开启模式时会立即重判该 Agent 已在队列中的请求：安全请求直接处理，高风险请求继续保留。
- 开启、关闭、自动批准和高风险拦截均写入审计，包含 Agent、工具、完整命令、风险、Reason 和决策来源。
- Claude PermissionRequest Hook 读取结构化 description/reason；Codex 和终端兼容路径从原始审批提示的 Reason/原因行提取理由，并同步到处理中心和审计。
- 待处理通知增加“拒绝”；自动学习绿色提示显示具体命令，总览中严格单行省略，鼠标移入或键盘聚焦显示完整批准次数、命令和作用说明，不会撑出 Agent 卡片。

验证结果：

- `npm run typecheck`：通过。
- 策略、preload 与 Renderer 完整回归 111 条通过。
- Controller 审批、队列、批量批准和全自动模式聚焦回归 8 条通过。
- 全量 Controller 仍有 6 条旧自动 continue 断言与当前第 9 项策略不一致，继续保留到恢复规则阶段统一更新。

### 9. 恢复和 continue 规则

- 正常结束不恢复。
- 用户 `Esc`、`Ctrl+C` 不恢复。
- 异常退出、明确容量错误或用户维护关键词命中，才进入恢复流程。
- 关键词触发必须同时满足 Agent 已停止输出，且未处于 Agent 自身自动重试状态。
- 用户维护关键词列表；每次命中最多尝试一次，避免无限 continue。
- 最大重试次数默认 3 次，间隔默认 3 秒，可配置。
- 恢复失败保留 Agent 和记录，不主动删除窗口。
- 默认关闭 可选开启

状态：关键词 Continue 第一版已实现，待重启后的真实 Codex/Claude Code 运行态验收（2026-08-12）。

本轮完成：

- 新增全局 Continue 关键词规则抽屉，规则默认关闭，关键词逐行维护。
- 用户可配置命中后连续无新输出等待时间，范围 3–60 秒，默认 10 秒。
- 关键词按去除 ANSI 后的文本包含匹配，不使用模糊语义推断；规则统一转为小写并去重持久化。
- 命中后不立即发送：Agent 每次产生新输出都会取消并重新计算静默时间，使 Agent 自带重试优先。
- 等待授权、明确可恢复错误、恢复加载中、正常结束、用户停止、Esc、Ctrl+C 时不触发。
- 同一用户任务中，同一个关键词无论成功失败只发送一次 continue + 回车，不循环重试；用户产生新输入后才允许下一轮命中。
- 命中等待和实际发送分别写入审计，记录关键词、静默秒数和尝试次数。
- Agent 停止、重新启动、退出或删除时清理待执行计时器。

本轮改动文件：

- electron/continue-keyword-store.ts、electron/session-controller.ts、electron/main.ts、electron/preload.ts
- src/shared/manager-api.ts、src/ContinueKeywordDialog.tsx、src/App.tsx、src/styles.css
- tests/unit/continue-keyword-store.test.ts、tests/unit/session-controller.test.ts、tests/unit/app.test.tsx、tests/unit/preload.test.ts

验证：

- 关键词持久化、静默等待、持续输出延后、Esc/Ctrl+C 取消及单次执行：5 项聚焦测试通过。
- Continue 规则抽屉默认关闭及保存交互：通过。
- Preload API 测试：通过。
- npm run typecheck、npm run build、git diff --check：通过。

剩余：

- 运行态用真实 Codex 和 Claude Code 验证常见关键词，并观察不同 TUI 重绘频率下 10 秒默认静默时间是否合适。
- 旧的“自动最多 3 次 Continue”测试与当前保守策略冲突，仍按第 15 项更新测试，不恢复多次自动重试。

### 10. 会话兜底释放

- Manager 崩溃、闪退、窗口被强制关闭时释放 host、PTY、socket、Hook 连接和会话 writer。
- 启动时扫描遗留 host，确认进程是否仍存活后再恢复或清理。
- 不能误杀用户在外部终端中运行的原生会话。
- 验证外部 `codex resume`、`claude --resume` 不再出现 active writer 占用。

### 11. 钉钉远程开发

- 参考机器人实现（先参考新仓库的 如果没找到实现或者实现路径不完全再看老的）：<https://github.com/zhuifengshen/DingtalkChatbot> (该仓库较老) https://github.com/HKUDS/nanobot/tree/3778e7e628d2d67b09ae91d037ec8f325ba94974/nanobot/channels/dingtalk（该仓库较新）
- 第一版只接受固定 `/` 开头命令，并加入签名校验、用户白名单、工作区白名单和频率限制。
- `/help`：查看所有命令。
- `/agents`：查看 Agent 运行列表。
- `/pending`：查看待审批列表。
- `/approve <唯一键>`：批准指定请求。
- `/approve-all`：批准全部请求，但仍逐条经过安全策略和审计。
- `/status <agent>`：查看 Agent 状态和最近错误。
- `/tail <agent>`：查看最近终端输出。
- `/workspace <name>`：查看工作区最近活动。
- `/send <agent> <内容>`：向指定终端发送信息。
- `/stop <agent>`、`/restart <agent>`：停止或恢复指定 Agent。
- `/audit`：查看最近审计活动。
- 后续可增加任务摘要、异常通知、审批超时提醒、远程切换配置和远程查看最近文件变化。
- 钉钉远程能力不能绕过本地批准策略和高风险操作限制。

### 12. 外部终端拖入拖出

- 外部终端拖入 Agent 总览，识别工作区、Agent 类型和原生会话 ID。
- 通过原生 resume 接入 Manager，不复制或改变原生会话数据。
- Agent 从总览拖出后脱离管理，恢复成普通原生终端。
- 迁移过程显示“请稍后…”，失败时回滚，不留下半接管状态。
- Agent窗口在manager中 可以通过拖动 改变排序顺序

### 13. 持久化和工作区

- 保存 Agent 配置、工作区、原生 session ID、布局模式和用户策略。
- Manager 重启后恢复未删除 Agent；删除后不再自动恢复。
- 工作区按真实绝对路径分组，大小写和路径分隔符统一处理。

状态：进行中（2026-08-11）。

本轮完成：

- 总览/列表模式、“按工作区划分”开关和最近选择的工作区使用版本化本地偏好保存，重开 Renderer 后自动恢复。
- 偏好缺失或损坏时安全回退为“总览 + 全部工作区”，读取失败不会影响正在运行的终端。
- 工作区分组键统一大小写、正反斜杠和尾部分隔符，避免同一路径被错误拆成多个工作区。
- Agent、工作区、原生 session ID 和 recovery 配方继续由 Host 注册元数据保存；Manager 不创建替代原生会话的数据格式。

待完成：

- 将后续独立 Agent 配置和布局扩展项并入同一受版本控制的设置模型。
- 运行态验收 Manager 正常关闭、崩溃重开、删除 Agent 后不恢复三条流程。

### 14. 审计和安全验收

- 审计包含会话启动、停止、完成、异常、恢复、工具调用、工具结果、审批、拒绝、规则变更、远程指令和全自动模式。
- 审计可按工作区、Agent、类别、级别和时间筛选。
- 敏感 API Key 不进入审计和终端回放。
- 高风险操作必须可解释、可追溯、不可被批量批准绕过。

状态：进行中（2026-08-11）。

本轮完成：

- 主进程集中为带 sessionId 的新审计事件补充 Agent 名称、Agent 类型和工作区，避免各调用点遗漏上下文。
- 启动请求、启动失败和删除 Agent 事件在 Session 不可用时仍显式保留工作区和 Agent 信息。
- 审计页支持按工作区、Agent、类别、级别和最近 24 小时/7 天/30 天筛选。
- 旧记录若只有 sessionId，会使用当前受管 Session 回填显示名称和工作区；原审计文件无需迁移。
- 列表行显示 action 以及可用的命令、工具、原因或错误摘要。

待完成：

- 远程指令和全自动模式完成后补齐对应审计类别与详情。
- 增加审计详情展开、复制和导出能力，并做敏感字段泄漏专项验收。

### 15. 测试、打包和 v1 验收

- 更新与当前恢复策略不一致的旧测试。
- 修复审计页重复标题测试。
- 【延期验收】做双 Agent、四 Agent、六 Agent 压力测试；核心功能收口前不阻塞开发序列。
- 做长文本、中文输入、多工具审批、全自动模式、崩溃恢复、外部 resume 和会话释放测试。
- 打包 Windows 版本，确认 `start.cmd` 与正式启动流程一致。
- 完成后形成 v1 可用验收清单。

## 每轮更新格式

每次开发结束后，在对应任务下补充：

- 状态：未开始 / 进行中 / 待验证 / 已完成 / 阻塞。
- 本轮改动文件。
- 验证命令和结果。
- 剩余风险和下一步。

## 2026-08-12：Host 重启交接与每 Agent HTTP 代理

状态：已完成（等待用户重启 Manager 后运行态体验验证）。

本轮完成：

- 修复停止后重新启动时 Renderer 仍向旧 Host 写入，短暂显示 `Host ... connection closed` 的竞态；这类切换期连接关闭不再误报为 Claude/Codex 启动失败。
- Host 切换期间最多缓存 64 KiB 用户输入，新 Host 接管后按序发送；终端协议响应不跨 Host 重放。
- 用户在交接期间按 `Esc` 或 `Ctrl+C` 会清空缓存且不在新终端重放。
- 新建 Agent 和编辑 Agent 抽屉加入独立 HTTP 代理：默认关闭；开启时默认 `127.0.0.1:7897`；主机、端口、用户名和密码可配置。
- 代理开关与 Base URL/API Key/Model 独立配置互不绑定；Agent 可继续继承本机模型配置但单独使用代理。
- 代理仅通过目标 Agent 的进程环境注入 `HTTP_PROXY` / `HTTPS_PROXY` 及小写兼容变量，不修改系统代理、Codex 配置或 Claude Code 配置。
- 代理密码使用 Electron 安全存储加密；Host 注册表、Session 摘要和审计只保存安全摘要，不保存密码明文。
- Agent 重启、原生 resume、异常恢复和 Manager 恢复 Host 时继承代理；关闭或删除 Agent 时清理对应加密代理配置。

本轮改动文件：

- `electron/session-controller.ts`、`src/TerminalTile.tsx`
- `electron/agent-proxy-store.ts`、`electron/session-host-manager.ts`、`electron/main.ts`、`electron/preload.ts`
- `src/shared/manager-api.ts`、`src/App.tsx`、`src/styles.css`
- `tests/unit/session-controller.test.ts`、`tests/unit/agent-proxy-store.test.ts`、`tests/unit/app.test.tsx`、`tests/integration/session-host-manager.test.ts`

验证：

- `npm run typecheck`：通过。
- Host 重启交接聚焦测试：4 项通过。
- 代理加密存储测试：3 项通过。
- Agent 代理 UI 测试：通过。
- Host 代理注入和凭据不落盘集成测试：通过。
- Session Host 集成测试：10 项通过。
- `npm run build`：通过。
- `git diff --check`：通过（仅现有 LF/CRLF 提示）。

已知事项：

- 完整 `session-controller.test.ts` 仍有 6 条旧的无限/多次自动 Continue 策略断言，与当前“用户采纳后最多尝试一次”产品策略不一致，继续按计划单独更新，不能为通过旧测试恢复危险行为。
- HTTPS 和 SOCKS5 代理协议按用户要求留到后续；当前“HTTP”表示连接代理服务器使用 HTTP，且同时供 Agent 的 HTTP/HTTPS 外部请求使用。
