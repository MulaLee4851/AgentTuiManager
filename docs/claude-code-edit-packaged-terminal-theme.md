# 打包 EXE 终端白底黑字 / 无颜色

> `claude code edit:` 前缀提交。供后续 agent 接手。
> 不要再假扮 Windows Terminal，也不要把 `useConptyDll` 开给 Claude。

## 现象

- `start.cmd`（electron-vite dev）正常：暗色、有颜色、排版正确。
- 资源管理器启动的正式包 EXE：终端白底黑字，排版乱。
- 另一窗口曾用假 `WT_SESSION` / `TERM_PROGRAM=WindowsTerminal` + 全员 `useConptyDll` 去修，排版回来了，颜色没有，随后 Claude 审批消失。那些改动已回滚。

## 根因

两条独立的链路，不要混在一起改。

### 1. 主题 / 颜色（这次修的）

Session Host 把 `process.env` 原样传给 Agent（`environmentForAgent` 以前只剥 Codex 父进程标记）。

| | start.cmd | 正式包 EXE |
|---|---|---|
| 启动方式 | 在 Windows Terminal 里跑 npm | 资源管理器，无控制台 |
| 继承到的身份 | `WT_SESSION`、`TERM=xterm-256color`、`COLORTERM=truecolor` | 这些都没有 |
| Session Host | `ELECTRON_RUN_AS_NODE=1` 会再传给 Agent | 同左 |
| ConPTY 默认属性 | 跟着 WT 的暗色控制台 | 跟着系统 conhost，中文 Windows 经常是白底黑字 |

node-pty 的 `name: 'xterm-256color'` **不会**在 Windows 上写成环境变量 `TERM`（见 `node-pty/lib/windowsTerminal.js`，`name` 只存成标签，`env` 原样 `_parseEnv`）。

TUI 看到「没有现代终端身份 + 默认浅色控制台」就会：

- 走老 conhost 布局（排版乱）
- 用浅色主题 **主动画出** 白底黑字（不是 xterm.css 丢了）

判断依据：xterm 主题是 `#0b1011`。Agent 若完全不发 ANSI，屏幕应是暗色。出现白底，说明 Agent 在发浅色 SGR。

`src/main.tsx` 把 `@xterm/xterm/css/xterm.css` 和 `styles.css` 打进同一个 renderer 包。Manager 外壳是暗色时，CSS 没丢。

### 2. Codex 滚屏（已有修复，不要动）

`useConptyDll: true` **只给 Codex**。系统 ConPTY 会剥 DECSTBM，bundled `conpty.dll` 不会。

正式包里 dll 在：

`resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll`

加载失败会 throw，`spawnAgentTerminal` 再回退到系统 ConPTY，滚屏就会消失。不要把这个开关开给 Claude——ConPTY DLL 的 cursor/OSC 行为和 Claude 审批 TUI 不兼容。

## 错误修法（已验证会出事）

| 做法 | 结果 |
|---|---|
| 伪造 `WT_SESSION` / `TERM_PROGRAM=WindowsTerminal` | Claude 走 WT 专用输入和审批路径，本应用没有实现，审批消失 |
| 全员 `useConptyDll` | Codex 滚屏路径被套到 Claude 上，审批 TUI 再坏一截 |
| `TERM_PROGRAM=xterm.js` + xterm `windowsPty` | 非标准身份，光标/焦点行为乱 |
| 把 `.cmd` 解成 `.exe` 并连同上面一起改 | 和身份伪造绑在一起，无法单独判断；审批回滚时一并撤了 |

## 正确修法

只在 `electron/agent-environment.ts` 给每个 Agent 补**诚实的 xterm 能力**，不改 PTY 后端，不改渲染层：

- 设置：`TERM=xterm-256color`、`COLORTERM=truecolor`、`FORCE_COLOR=3`、`CLICOLOR=1`、`CLICOLOR_FORCE=1`、`COLORFGBG=15;0`（白字黑底，对应 `NATIVE_TERMINAL_THEME`）
- 删除：`NO_COLOR`、`NODE_DISABLE_COLORS`、`ELECTRON_RUN_AS_NODE` 等宿主泄漏
- 不设置：`WT_SESSION`、`TERM_PROGRAM=WindowsTerminal`
- 保留：父进程若真正继承了 `WT_SESSION`（start.cmd 在 WT 里），原样留下

`COLORFGBG` 方向不要写反。`0;15` 是黑字白底，等于把 conhost 浅色默认写死。

## 生效方式

改的是主进程 / Session Host 给 **新启动** Agent 的环境。需要重启 Manager，再新开 Agent。已经在跑的窗口不会崩，但也不会变，必须新开。

## 若打包后滚屏仍坏

先确认当前 EXE 是否包含 `session-host.js` 里的 `useConptyDll: true`（Codex only）。另一窗口打过的包或更早的包没有这行。不要用「全员 OpenConsole」去修。
