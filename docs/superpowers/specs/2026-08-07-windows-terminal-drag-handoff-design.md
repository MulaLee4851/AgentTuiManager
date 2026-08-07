# Windows Terminal 双向拖拽交接设计规格

日期: 2026-08-07

## 1. 目标

Agent TUI Manager 支持在 Windows Terminal 与 Agent 总览之间直接拖动 Agent 终端:

- 把 Windows Terminal 拖进 Agent 总览，会在网格中新增一块完全受管的 Agent 终端。
- 把 Agent 卡片拖出总览，会创建真正的原生 Windows Terminal，并让该 Agent 彻底脱离 Manager 管理。
- 两个方向都通过 Agent 原生会话恢复完成所有权转移，并用连续的视觉过渡隐藏短暂重启。

这项能力必须服从现有会话所有权约束。Codex、Claude Code 等 Agent 的原生会话存储仍是唯一权威数据源；Manager 的数据库、Session Host 和过渡画面都不能成为恢复会话的必要条件。

## 2. 不可违反的产品边界

### 2.1 拖入必须完全受管

拖入只有两种最终结果:

1. 成功: Agent 已在 Manager 的 Session Host 中通过原生命令恢复，可以使用审批、异常判断、自动恢复和终端墙功能。
2. 失败: 原生终端保留或恢复，Agent 不加入总览。

不允许存在看似加入总览、实际仍由外部 Windows Terminal 持有 PTY 的半管理卡片。

### 2.2 拖出必须彻底脱管

拖出成功后:

- Agent 运行在用户安装的原生 Windows Terminal 中。
- Manager 的 Session Host 不再持有该 Agent 的 PTY，也不再代理输入输出。
- Manager 不再执行审批、监控、自动 Continue 或异常恢复。
- 总览中的活跃卡片消失。

拖出的终端不能依赖 `atm attach` 一类中继才能继续运行。Manager 可以保留一个不具备控制能力的会话关联提示，以便以后识别拖回操作，但该提示不能用于轮询进程、读取输出、发送输入或触发恢复。删除该提示或全部 Manager 数据不得影响原生终端和原生恢复。

`committing` 是唯一管理边界。拖入只有提交完成后才启用 Manager 能力；拖出一旦提交完成就立即禁用全部 Manager 能力，不存在延迟脱管或后台观察期。

### 2.3 单活跃进程不变量

同一个原生会话在任何时刻最多有一个活跃 Agent 进程:

- 来源没有确认保存并退出，目标绝不执行 `resume`。
- 目标没有确认恢复成功并可交互，来源窗口或卡片绝不移除。
- 任一步失败都优先恢复来源一侧，不能留下两个同时写入同一会话的进程。

### 2.4 正常结束语义不变

拖拽交接是明确的用户迁移意图，不是异常恢复。正常完成的 Agent 仍不触发 Continue；用户停止仍标记为 `stopped`；只有适配器确认的异常才进入既有自动恢复流程。

## 3. 首版范围

首版支持:

- Windows Terminal 顶层窗口和原生标签撕出行为。
- Codex 和 Claude Code 的双向拖拽。
- 单标签、单 Pane、单 Agent 的全自动交接。
- 由 Windows Terminal 从多标签窗口撕出的单个标签。撕出后形成的临时顶层窗口继续参与同一次拖拽。
- 多显示器、常见 DPI 缩放、普通窗口、最大化窗口和最小化后恢复。

首版不支持:

- 一次拖动整个多标签或多 Pane 窗口并批量迁移所有 Agent。
- WezTerm、ConEmu、传统独立控制台或其他终端模拟器。
- 未验证原生会话发现和恢复契约的 Pi 或自定义 Agent。
- 跨用户、跨登录会话或不同完整性级别的自动输入注入。
- 对正在运行的任意外部 PTY 做实时重新挂接。

Pi 和自定义 Agent 只有在适配器通过本规格的恢复、识别和失败回滚契约后才能声明支持。未声明 `nativeHandoff` 能力的适配器在拖放时直接拒绝，不创建半管理状态。

## 4. 研究结论与技术约束

### 4.1 可以可靠检测真实窗口拖放

Win32 `SetWinEventHook` 可以监听 `EVENT_SYSTEM_MOVESIZESTART` 和 `EVENT_SYSTEM_MOVESIZEEND`。本机实验已经捕获真实 Windows Terminal 顶层窗口的开始位置、结束位置、窗口句柄和标题，因此检测窗口拖到 Manager 上方是可行的。

Electron 的 HTML5 拖放事件不能观察外部顶层窗口移动，必须使用原生 Win32 辅助进程。

### 4.2 Windows Terminal 原生合并不能由 Electron 直接调用

Windows Terminal 的标签跨窗口移动依赖同一 Windows Terminal 应用进程内的机制:

- 来源标签调用 `BuildStartupActions(BuildStartupKind::Content)` 生成携带内部内容 ID 的动作。
- 来源窗口执行 `Detach`。
- `AppHost::_handleMoveContent` 或 `_handleReceiveContent` 通过内部 Window Manager 找到另一个 Windows Terminal 窗口。
- 目标调用 `AttachContent`，并从同一进程的 `ContentManager` 中按 ID 找回 `ControlInteractivity`。

`ContentManager` 的官方源码明确说明它是 Windows Terminal 应用各线程共享的单例。第三方 Electron 进程不在该单例和内部 Window Manager 中，不能成为 `AttachContent` 的原生接收方。

### 4.3 ConPTY handoff 不是运行中标签的抽取接口

当前 Windows Terminal 包含 `ITerminalHandoff3` 和 `ConptyConnection::InitializeFromHandoff`。该 COM 路径用于 Windows 默认终端接收一个已经由系统控制台基础设施启动、正在等待终端 UX 的 ConPTY。`wt.exe -Embedding` 也服务于这个接收场景。

它不是一个让第三方从已运行 Windows Terminal 标签中抽取 PTY 的公开 API，也不能把任意运行中标签交给 Electron。最新的 5 秒 handoff 超时提交只处理未收到 inbound handoff 时退出，不改变该边界。

### 4.4 HWND 嵌入不等于管理

使用 `SetParent`、DWM 缩略图或窗口裁剪可以制造外部终端位于总览卡片中的视觉效果，但 PTY 和 Agent 仍归 Windows Terminal 所有。Manager 无法据此获得结构化审批、可靠退出语义和自动恢复能力，因此不能作为正式交接方案。

## 5. 总体架构

### 5.1 Native Drag Bridge

独立的 Windows 原生辅助进程，职责仅包括:

- 监听 Windows Terminal 窗口移动开始和结束。
- 在移动期间跟踪窗口矩形、鼠标位置、Manager 命中区域和 DPI。
- 识别 Windows Terminal 顶层窗口、标签撕出产生的新顶层窗口和完整性级别。
- 向 Handoff Coordinator 报告窗口事实，不自行停止 Agent 或执行恢复。

Bridge 不解析终端屏幕决定会话，不拥有 Agent 数据，也不能绕过适配器直接批准命令。

### 5.2 Handoff Coordinator

每次拖放创建一个独立的交接事务。Coordinator 运行在 Electron Renderer 之外，并在 UI 崩溃时继续完成或回滚当前事务。

职责包括:

- 串联识别、来源退出、目标恢复、就绪验证、提交和回滚。
- 持久化最小、可丢弃的事务进度。
- 强制执行单活跃进程不变量和幂等操作。
- 驱动过渡画面和总览占位的状态投影。

Coordinator 不能成为 Agent 会话所有者。事务日志最多保存窗口标识、Agent 类型、工作区、原生会话 ID、阶段、时间和错误摘要。

### 5.3 Native Handoff Agent Adapter

Codex 和 Claude Code 适配器新增 handoff 能力契约:

- `discoverCandidates(windowFacts)`: 只读发现可能的工作区和原生会话。
- `buildGracefulStop(source)`: 描述支持的正常退出动作。
- `confirmPersisted(sessionId)`: 确认原生会话已经可恢复。
- `buildManagedResume(sessionId, workspace)`: 构造 Session Host 恢复请求。
- `buildNativeResume(sessionId, workspace)`: 构造传给原生 Windows Terminal 的恢复命令。
- `confirmReady(target)`: 用结构化或版本验证过的证据确认目标可交互。

所有命令使用结构化参数构造和 Windows 参数引用规则，不能拼接未经处理的 Shell 字符串。

### 5.4 Transition Surface

Electron Main 和原生窗口层共同提供:

- 来源窗口的 DWM 缩略图或 Windows Graphics Capture 过渡画面。
- Agent 网格中的稳定尺寸占位。
- 拖出时跟随鼠标的窗口预览。
- 成功后的交叉淡入和失败后的原位回弹。

过渡画面不是终端输出日志，不参与恢复，并在事务结束或超时后清理。

### 5.5 Session Host 与原生 Windows Terminal

- 拖入目标是既有的独立 Session Host 架构。恢复成功后，Manager 获得 PTY 和完整管理能力。
- 拖出目标由系统安装的 `wt.exe` 创建。Windows Terminal 使用适配器给出的工作区和原生恢复命令启动 Agent。
- 拖出成功后来源 Session Host 停止并释放 PTY；目标不连接 Manager 中继。

## 6. 交接事务状态机

交接状态包括:

- `probing`: 识别窗口、Agent、工作区和原生会话候选。
- `awaiting_choice`: 有多个候选，需要用户选择；尚未改变来源进程。
- `previewing`: 已创建目标占位或窗口预览，来源仍完全可恢复。
- `stopping_source`: 输入被临时锁定，正在正常停止来源 Agent。
- `waiting_for_persistence`: 等待来源进程退出且原生会话可恢复。
- `resuming_target`: 在目标侧执行原生恢复。
- `verifying_target`: 验证目标进程、会话 ID和交互就绪证据。
- `committing`: 移除来源显示端并提交所有权变化。
- `completed`: 交接成功。
- `rolling_back`: 目标失败，正在恢复来源侧。
- `failed`: 自动回滚也失败，但原生会话引用仍可供人工恢复。
- `cancelled`: 用户在来源退出前取消。

状态转换必须幂等。Coordinator 重启后读取事务阶段，先检查事实再继续，不重复发送停止或启动第二个目标进程。

## 7. 拖入流程

1. Native Drag Bridge 检测 Windows Terminal 窗口进入 Agent 总览边界。
2. 总览整体轻量高亮，并按鼠标位置插入一块与 Agent 卡片等尺寸的占位。现有卡片平滑让位，不改变卡片固定格式。
3. Adapter 进行只读预检。来源是单标签、单 Pane 且只有一个明确会话候选时自动继续。
4. 如果有多个候选，显示简短选择框；选择前不发送任何按键、不停止进程。
5. 用户释放窗口后，Transition Surface 保留来源画面，占位只显示“请稍后…”。
6. Coordinator 在立即重新验证前台窗口、活动标签和进程匹配后，使用适配器声明的正常退出动作。对于验证过的单 Agent Windows Terminal，可以自动发送一次 `Ctrl+C`；焦点或身份变化时立即中止。
7. 来源 Agent 退出后，Adapter 确认原生会话 ID 已持久化且可恢复。
8. Coordinator 在独立 Session Host 中执行 `codex resume <session-id>`、`claude --resume <session-id>` 或适配器等价命令。
9. Adapter 确认目标恢复到同一个原生会话并可交互。
10. 占位交叉淡入为真实 xterm.js Agent 卡片，来源 Windows Terminal 窗口才被关闭或保留为用户原有的其他内容。
11. 事务提交，Agent 进入既有 Manager 会话状态机。

如果来源是多标签窗口，用户应直接拖动目标标签。Windows Terminal 先把标签撕成独立顶层窗口；Bridge 识别新窗口并继续同一手势。直接拖动整个多标签窗口时首版回弹，并提示拖动具体标签。

## 8. 拖出流程

1. 用户从 Agent 卡片标题区域拖出卡片。终端内容继续由来源 Session Host 运行。
2. 网格保留原卡位置，桌面侧显示原生 Windows Terminal 尺寸的跟随预览。
3. 用户在 Manager 外释放后，目标预览只显示“请稍后…”。
4. Coordinator 请求来源 Session Host 使用适配器的正常退出流程，等待原生会话持久化。
5. Coordinator 通过 `wt.exe` 在原工作区启动适配器生成的原生恢复命令。
6. Adapter 确认新的原生 Agent 进程恢复到同一会话并可交互。
7. 原生 Windows Terminal 交叉淡入为真实内容，来源卡片从网格缩回，其他卡片平滑补位。
8. 来源 Session Host 终止并释放运行时资源。Manager 把该会话从活跃管理列表移除，不再审批、监控或恢复。

拖出后的可选关联提示不包含控制通道，也不允许 Manager 用它轮询或观察 Agent。它只用于以后把同一原生窗口拖回时减少识别歧义；删除 Manager 数据不影响该窗口和原生会话。

## 9. 文案与视觉规则

交接过程中只使用面向用户的简短文案:

- 进行中: `请稍后…`
- 成功: 不保留多余提示，直接呈现目标终端。
- 拖入失败: `恢复失败，已返回原终端`
- 拖出失败: `恢复失败，Agent 仍在总览中`

不在主界面展示 `PTY`、`Session Host`、`handoff`、“正在交接”或恢复命令等实现词汇。诊断详情仅放在错误详情和日志中。

视觉要求:

- 外部窗口命中 Manager 后 100ms 内出现边界反馈或网格占位。
- 交接全过程保留来源画面或目标预览，不出现空白终端。
- 占位与真实 Agent 卡片尺寸一致，动态内容不能导致网格跳动。
- 拖入成功表现为占位变成真实卡片；拖出成功表现为卡片收回且原生窗口稳定在释放位置。
- 失败时使用原路径回弹，不瞬移到其他位置。
- 2 到 6 个 Agent 的总览布局继续遵守主规格的固定网格和放大/返回交互。

## 10. 识别、输入与权限安全

### 10.1 会话识别

Manager 来源的原生终端可以携带不可控制 Agent 的一次性关联提示。任意外部终端则综合以下只读事实:

- Windows Terminal 窗口、活动标签和 Pane 数量。
- 同用户 Agent 进程、命令行、启动时间和可验证环境标识。
- Codex 或 Claude 原生历史中的工作区、最近更新时间和会话 ID。
- 用户最近使用的 Manager 工作区索引。

只有唯一高置信度候选才自动迁移。多个候选必须选择，零候选直接回弹。

### 10.2 自动输入

对外部 Windows Terminal 发送 `Ctrl+C` 前必须同时满足:

- 适配器版本声明支持该退出动作。
- 窗口为同用户、相同完整性级别。
- 单标签、单 Pane、单 Agent 已验证。
- 目标 HWND 已成为前台窗口，并在发送前再次确认未变化。
- 用户刚刚完成了明确的拖入动作，事务请求未过期。

不满足任一条件时禁止注入。首版不通过提权绕过 UIPI，也不对未知终端发送按键。

### 10.3 敏感信息

事务日志不得记录完整终端画面、Agent 对话或敏感命令参数。会话 ID、窗口标识和错误摘要按 Manager 本地数据策略保存并限制为当前用户访问。

## 11. 失败、取消和崩溃恢复

### 11.1 用户取消

来源 Agent 退出前，用户可以按 `Esc` 取消。占位或预览消失，来源恢复输入。

来源已经退出后不能简单取消。Coordinator 必须完成目标恢复或在来源侧执行回滚恢复，避免会话停在无人承载的中间状态。

### 11.2 识别失败

不停止来源，不创建真实卡片。窗口原位回弹，并提供拖动具体标签或选择会话的操作提示。

### 11.3 来源退出失败

撤销目标预览，恢复来源输入。不得启动目标 Agent。

### 11.4 目标恢复失败

关闭失败的目标进程，在来源侧通过同一原生会话恢复。拖入回滚到原生 Windows Terminal；拖出回滚到 Manager Session Host。

### 11.5 Electron 崩溃

Handoff Coordinator 和 Session Host 不依赖 Renderer 存活。Renderer 重启后从 Coordinator 读取事务投影并重新显示“请稍后…”、完成或失败状态。

### 11.6 Coordinator 崩溃

独立守护入口读取最小事务记录并根据进程、窗口和原生会话事实恢复。恢复逻辑必须幂等，并优先维持或重建来源一侧。

### 11.7 电脑断电或 Manager 数据损坏

原生 Agent 会话仍可从原工作区使用 `codex resume` 或 `claude --resume` 恢复。过渡画面、Manager SQLite 和事务日志都不是恢复前提。

## 12. 与现有规格的关系

本规格延续 `2026-08-07-agent-tui-manager-design.md` 的全部会话所有权、安全审批和正常结束规则。

它对主规格 5.3 节“外部会话迁移”做窄范围扩展:

- 仅对本规格验证过的 Windows Terminal、Agent 适配器和单 Agent 条件，允许在用户明确拖入后自动执行受约束的正常退出动作。
- 其他终端、未知版本、多标签整体窗口和证据不足的情况仍遵守原流程，不自动注入输入。
- 底层仍采用停止来源后原生恢复，不声称重新挂接任意外部 PTY。

## 13. 测试与发布阻断条件

### 13.1 单元测试

- 交接事务状态机的合法、非法和幂等转换。
- 来源未退出时禁止目标恢复。
- 目标未就绪时禁止删除来源。
- 每个阶段重启 Coordinator 后只继续一次。
- 单候选自动处理、多候选等待选择、零候选回弹。
- 不满足输入安全条件时永不发送 `Ctrl+C`。

### 13.2 Adapter 契约测试

- 受支持 Codex 和 Claude 版本的发现、持久化确认、Managed Resume、Native Resume 和 Ready 证据。
- 原生会话 ID和工作区在双向交接前后一致。
- 未知版本和未声明 handoff 能力的适配器可靠拒绝。

### 13.3 Windows 原生集成测试

- `SetWinEventHook` 对移动开始、移动结束和标签撕出新窗口的检测。
- 多显示器、负坐标、100%/125%/150%/200% DPI、最大化和最小化恢复。
- 前台窗口在输入前发生变化时中止注入。
- 提权 Windows Terminal 被非提权 Manager 拒绝。
- DWM 或 Graphics Capture 过渡画面非空且窗口关闭后正确释放。

### 13.4 真实端到端测试

对 Codex 和 Claude Code 分别执行:

1. 原生 Windows Terminal 拖入 Manager。
2. Manager 拖出到原生 Windows Terminal。
3. 拖出后再次拖回。
4. 多标签中撕出一个标签后拖入。
5. 在每个事务阶段模拟 Renderer、Electron Main、Coordinator 和目标进程崩溃。
6. 模拟识别歧义、恢复超时、来源退出失败和用户取消。
7. 删除 Manager SQLite、事务日志和 Session Host 运行时数据后使用原生 CLI 恢复。

### 13.5 性能与稳定性

- 拖放命中后 100ms 内出现视觉反馈。
- 正常本机环境争取在 1 到 3 秒完成恢复；超过时持续显示来源画面和“请稍后…”，不能假成功。
- 连续至少 50 次双向交接，不得出现会话错配、双进程、残留窗口、残留卡片或无法恢复的会话。
- 2 到 6 个 Agent 的网格在占位、成功和回滚过程中尺寸稳定。

以下任一项失败时禁止发布:

- 同一原生会话出现两个活跃 Agent 进程。
- 拖入后无法使用完整 Manager 能力。
- 拖出后仍依赖 Manager Session Host 或中继。
- Manager 数据丢失导致原生 CLI 无法恢复。
- 交接失败后来源和目标两侧都无法继续。

## 14. 官方参考

- Win32 `SetWinEventHook`: https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setwineventhook
- WinEvent move/size constants: https://learn.microsoft.com/windows/win32/winauto/event-constants
- Windows Pseudoconsole creation: https://learn.microsoft.com/windows/console/creating-a-pseudoconsole-session
- Windows Terminal command-line arguments: https://learn.microsoft.com/windows/terminal/command-line-arguments
- Windows Terminal `ContentManager`: https://github.com/microsoft/terminal/blob/b888cb7e4c3b0b21b7ed66c224bcdf7fa9ef6d9a/src/cascadia/TerminalApp/ContentManager.h
- Windows Terminal tab content movement: https://github.com/microsoft/terminal/blob/b888cb7e4c3b0b21b7ed66c224bcdf7fa9ef6d9a/src/cascadia/WindowsTerminal/AppHost.cpp
- Windows Terminal `ITerminalHandoff3`: https://github.com/microsoft/terminal/blob/b888cb7e4c3b0b21b7ed66c224bcdf7fa9ef6d9a/src/host/proxy/ITerminalHandoff.idl
- ConPTY handoff timeout commit: https://github.com/microsoft/terminal/commit/b888cb7e4c3b0b21b7ed66c224bcdf7fa9ef6d9a
