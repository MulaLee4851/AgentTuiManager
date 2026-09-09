# Agent TUI Manager

> **AI Coding Agent Control Center**
>
> 同时跑多个 Claude Code / Codex，
> 不再 Alt+Tab 找哪个 Agent 在等你，也不用回来才发现它卡在 `Please approve` 半小时。

**多 Agent 总览 · 集中审批 · 安全自动放行 · 异常恢复 · 钉钉远程值班**

Windows / macOS · MIT Open Source

---

## 你是不是也开始变成 Agent 监工了？

以前写代码：

> 自己写。

开始 Vibe Coding：

> 看着一个 Claude Code 写。

现在：

> Claude 改前端
> Codex 改后端
> 另一个 Agent Review
> 再开一个跑测试

代码确实写快了。

但你开始不停地：

- Alt+Tab 看哪个 Agent 做完了
- 找哪个终端正在等 Approval
- 同一个低风险命令重复点批准
- Agent 异常退出后判断能不能继续
- 吃个饭回来发现它 40 分钟前就停了

**Agent TUI Manager 就是为这个阶段做的。**

它不是新的 AI Coding Agent。

它是你现有 Claude Code / Codex 的 **控制台和值班室**。

---

## 一个窗口，看住所有 Agent

### 不再 Alt+Tab

一个总览墙或列表同时查看多个 Claude Code / Codex，并按状态多选筛选。

谁在工作、谁完成、谁异常、谁在等你，一眼就能看到。

### 不再重复点 Approve

集中处理所有 Agent 的工具审批。

重复出现的低风险操作可以学习为自动批准规则。

**删除、严重权限修改等高风险命令不会被自动学习。**

### 人不在电脑前也能处理

可选钉钉 Stream 远程值班：

- 查看 Agent 状态
- 查看待审批
- 批准 / 拒绝
- 给 Agent 继续发任务
- 停止 / 重启
- 查看审计记录

普通远程批准遵循本地风险限制；`/approve-all-force` 是显式忽略风险的强制操作，请谨慎使用。

### 不接管你的 Claude / Codex Session

Agent TUI Manager 只是管理进程和交互。

你的 Session 仍然属于官方 CLI。

卸载 Manager 后依然可以：

`claude --resume`

或

`codex resume`

继续原来的会话。

**No lock-in. No private session format.**

---

## 适合谁？

如果你：

- 已经每天使用 Claude Code / Codex
- 经常同时开 2～5 个 Agent
- 开始觉得终端窗口越来越乱
- 经常被 Approval 打断
- 希望 Agent 能真正跑一段时间而不用一直盯着

你可能正是这个工具想解决的人。

---

## Download

**Windows 10 / 11**

**macOS Intel / Apple Silicon**

→ [下载最新版](https://github.com/MulaLee4851/AgentTuiManager/releases/latest)

目前仍处于早期版本。

如果你正在重度使用 Claude Code / Codex，非常欢迎试一下。

**不用帮忙刷 Star。**

如果不好用，请直接提 Issue 告诉我哪里难用。

如果哪天你发现：

> “没有它以后反而不习惯了。”

再回来给个 ⭐ 就很好。

---

## 为什么不是直接用多个 Terminal？

| 场景 | 多个 Terminal | Agent TUI Manager |
|---|---|---|
| 同时看多个 Agent | ❌ Alt+Tab | ✅ 总览墙 |
| 待审批集中处理 | ❌ 分散 | ✅ |
| 低风险自动审批 | ❌ | ✅ |
| 高危命令拦截 | 取决于 Agent | ✅ Manager 再加一道 |
| 异常退出识别 | ❌ 人工判断 | ✅ |
| 原生 Session Resume | ✅ | ✅ |
| 手机远程值班 | ❌ | ✅ |
| Session 被工具锁定 | - | ❌ 不锁定 |

---

## 截图

![终端墙总览](media/overview-wall.png)
![卡片内审批](media/approval-inline.png)
![详情全屏终端](media/detail-fullscreen.png)
![新建与恢复原生会话](media/launcher-resume.png)
![处理中心与审计](media/audit-center.png)
![钉钉远程设置](media/dingtalk-remote.png)
![钉钉侧远程命令与审批消息](media/dingtalk-message.png)

## 核心能力

- **多 Agent 总览**：网格墙或列表模式同时管理多个终端 Agent；状态支持多选并记住筛选条件
- **任务状态**：区分已停止、运行中、待命、待审批、异常，不把“窗口开着”直接当成任务运行中
- **Token 用量**：按窗口查看输入、输出、缓存读取和缓存写入；支持今天、最近 7 / 30 个自然日和逐条明细
- **工作区与原生历史**：按本地目录选 workspace；恢复 Codex / Claude Code 原生会话
- **会话过滤**：过滤不可交互的 Codex subagent 线程，只展示可恢复的顶层会话
- **审批中心**：统一查看、批准、拒绝；安全规则与全自动模式
- **LLM 安全审查**：可选运行时审查、手动/定时规则集合审查，可配置超时，结果与审计可回看
- **审计**：启动、停止、审批、规则命中、异常、远程操作可回看
- **独立配置**：可为单个 Agent 配 Base URL、API Key、模型、启动参数和 HTTP 代理，**不覆盖**本机全局配置
- **环境检测**：检测 Node.js / npm / Agent CLI；可在新建面板安装或自选可执行文件
- **生命周期**：Manager 重启后可重新接管保留的 Agent；停止/删除时释放原生会话 writer
- **钉钉远程**：Stream 机器人查看 Agent、处理审批、发送任务；可选受限自然语言模式
- **拖出终端**：受管 Agent 可拖出为普通终端；外部拖入仍为 Beta 且默认关闭

### 跨平台

- **Windows**：提供 NSIS 安装包，使用 Windows ConPTY 和原生命令环境
- **macOS**：提供 DMG / ZIP，支持 Intel 与 Apple Silicon，使用 macOS PTY 和登录 Shell 环境
- 两个平台各自读取本机 Agent 配置；Manager 的独立配置只作用于对应实例，不会改写系统全局配置

---

## 运行要求

- Windows 10 / 11 x64，或 macOS 12+（Intel / Apple Silicon）
- Node.js 20+ 与 npm（开发或从源码运行时）
- 至少一个本机 Agent CLI：`Codex` 或 `Claude Code`；Pi 新建入口暂时置灰，接入仍在优化
- macOS 使用一键安装 Node.js / ripgrep 时需要 Homebrew；已自行安装则不需要

CLI 未进 `PATH` 时，可在新建 Agent 的高级设置里选择完整可执行文件；Windows 支持 `.exe` / `.cmd` / `.bat` / `.com`，macOS 支持 POSIX 可执行文件。

---

## 安装与启动

### 安装包（推荐）

从 [Releases](https://github.com/MulaLee4851/AgentTuiManager/releases) 下载与你的平台对应的产物：

```text
Windows: Agent-TUI-Manager-Setup-<version>-x64.exe
macOS:   Agent-TUI-Manager-<version>-<arch>.dmg 或 .zip
```

Windows 运行安装程序后启动应用。macOS 优先打开 DMG 并把应用拖入“应用程序”；ZIP 可解压后直接运行。若 macOS 因未签名应用拦截启动，请在“系统设置 → 隐私与安全性”中确认允许打开。

安装完成后准备好至少一个本机 Agent CLI，即可新建或恢复会话。

### 开发模式

双击仓库根目录 [`start.cmd`](start.cmd)。首次运行会安装依赖并打开开发版。

或在 PowerShell 中：

```powershell
npm install
npm run dev
```

> `start.cmd` 在依赖未安装时默认走本机 `127.0.0.1:7897` HTTP 代理下载。若没有该代理，请直接 `npm install`，或按自己的网络配置 npm。

macOS 从源码运行：

```bash
npm install
npm run dev
```

从 Finder 启动时，Manager 会读取登录 Shell 的 `PATH`，兼容 Homebrew 的 `/opt/homebrew/bin` 和 `/usr/local/bin`。

---

## 基本使用

1. 点击 **新增 Agent**
2. 选择 Codex 或 Claude Code（也可使用通用终端；DeepSeek Harness 通过官方 Web 运行）
3. 用目录选择器指定本地工作区
4. **新建会话**，或从该工作区的**原生历史**里选一个继续
5. 环境检测通过后启动
6. 在总览墙、列表模式、处理中心之间切换，处理输入与审批

- **停止**：关掉终端进程并释放会话，Manager 卡片保留，可再启动
- **删除**：只移除 Manager 记录，**不会**删除 Codex / Claude Code / Pi 的原生历史

### 状态与多选筛选

| 状态 | 含义 |
| --- | --- |
| 已停止 | 手动停止，或进程正常退出 |
| 运行中 | 正在执行任务，或进入恢复流程 |
| 待命 | 已启动但未执行任务；任务完成后窗口仍保持打开 |
| 待审批 | 存在等待处理的权限请求，独立于运行中显示 |
| 异常 | 任务报错、启动/运行失败或需要人工介入的异常状态 |

打开总览顶部的状态下拉菜单，可同时勾选多个状态，例如“运行中＋待审批”。匹配任意一项即显示；不勾选或点击“显示全部状态”恢复全部。筛选适用于总览与列表，兼容旧版单选偏好，不重新创建终端或强制滚动到底部。

状态依赖 CLI 事件和原生会话记录，不是仅靠有没有输出判断。不同 CLI 版本的信息完整性存在差异。

### Token 用量

在侧栏打开 **Token 用量**，查看各窗口及其模型/配置对应的用量，点击窗口查看原生 usage 明细。

- 包含输入、输出、缓存读取、缓存写入和总计；只使用 CLI 提供的数据，不按终端文字长度估算。
- “今天”从本地时区 00:00 开始；最近 7 / 30 个自然日包含今天。汇总与明细使用相同时间范围。
- Manager 记录配置切换时间。同一窗口从 A 切到 B、再切到 C 时，按用量事件时间匹配配置快照，不将旧记录全部归到当前配置。
- 统计能力取决于原生记录提供的字段及 Manager 可追踪的配置历史，不等同于服务商账单；缺失或无法追溯的信息不能保证补全。

---

## 独立配置

默认继承本机各 Agent 的已有配置。只有显式打开「独立配置」后，Manager 才会为该实例注入单独的服务地址、密钥和模型。

- 不覆盖本机默认配置
- API Key、代理密码、钉钉 Client Secret **不写**进审计正文
- 停止或删除时清理临时配置，并恢复原生会话可用性
- 支持从 CC Switch 读 Provider，或手动填 OpenAI-compatible 配置

---

## 审批与安全

- 普通只读命令可手动加入自动批准规则
- 重复批准的低风险工具会提示加入学习列表
- **删除、严重权限变更、下载后执行等其它高危操作不会自动学习**
- 全自动模式仍会拦截删除类与严重危险命令，并写审计
- 关键词续跑仅依据用户维护的规则触发；正常完成本身不作为自动续跑条件

Claude Code / Codex 优先通过权限 Hook 接入；部分版本或工具仍需终端审批兼容。Hook 控制的是对应工具请求，**不保证整个 Agent 暂停模型请求或所有并行任务**。本版没有实现“待审批时全局冻结 Agent”。

### LLM 安全审查与规则维护

- 高危规则可查看、维护；命中原因和审批处理结果可追溯。
- 运行时 LLM 审查在全自动模式下按所选等级生效：**低**审查高危命中，**中**覆盖写入/删除，**高**覆盖未命中确定性安全规则的请求。
- 硬性高危规则仍需人工处理，LLM 不能覆盖；请求失败、不确定结论进入处理中心。
- 可手动审查批准规则集合，也可启用定时审查（1–720 小时）；请求超时可设为 5–600 秒。
- 审查任务状态不会因关闭侧栏而丢失；结果提供独立详情，可删除发现有风险的规则，审计页也支持查询审查记录。

全自动会放宽大量人工确认，只建议在清楚当前任务与工作区内容时**临时**打开。

---

## 钉钉远程控制

在设置里填入钉钉 Stream 应用凭据后，Manager 会生成一次性绑定 Key。在钉钉发送：

```text
/init <key>
```

绑定后用 `/help` 查看命令（列表、待审批、指定/全部批准、发送、停止、重启、审计等）。

- 仅已绑定账号可操作
- 已取消工作区远程白名单和勾选限制，绑定账号可操作 Manager 内所有工作区的 Agent
- 普通批准受本地风险限制；`/approve-all-force` 会忽略风险限制批准当前全部待审批，请确认影响后再用

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/agents`、`/status <Agent>` | 列表、状态和最近错误 |
| `/pending`、`/approve <审批ID>` | 查看待审批、批准指定请求 |
| `/send <Agent> <内容>` | 向指定窗口发送消息 |
| `/send-status 待命 continue` | 给当前处于待命状态的窗口批量发消息 |
| `/auto <Agent> on` / `off` | 切换指定 Agent 的全自动模式 |
| `/stop <Agent>`、`/restart <Agent>` | 停止或重启 |
| `/tail <Agent>`、`/audit` | 查看最近输出、审计 |

按状态批量发送会逐个报告成功或跳过原因；不会替代审批，也不会自动重启已退出窗口。自然语言模式支持一条消息中的多个明确指令；无法执行时会说明原因。

---

## 构建 Windows 安装包

```powershell
npm run dist:win
```

默认产物在 `release/`（NSIS x64）。打包在编辑 EXE 资源后检查 x64 PE 结构，损坏或截断时中止。请预留充足磁盘空间，并在发布前校验安装包内程序及实际启动；构建退出码不等于安装可用。


## 构建 macOS 安装包

在 macOS 机器上安装依赖后执行：

```bash
npm run dist:mac
```

默认生成 DMG 和 ZIP。由于 `node-pty` 包含原生模块，macOS 包必须在对应架构的 Mac 上安装依赖并构建；不支持直接复用 Windows 的 `node_modules` 交叉打包。macOS 打包与发布流程已可用；当前配置未包含 Apple Developer 签名和公证，正式对外分发前仍需配置证书与 notarization。

---

## 开发验证

```powershell
npm run typecheck
npm test
npm run build
```

---

## 数据与兼容性

Manager 只管理进程与交互状态，**不替代**原生会话存储。应用不可用时，仍可在对应工作区用原生命令恢复，例如：

```powershell
codex resume <session-id>
claude --resume <session-id>
```

为避免 active writer 冲突：请先在 Manager 里**停止或删除**仍占用该会话的 Agent，再从外部终端 resume。

### 产品不变量（贡献时请遵守）

1. 不把 Agent 会话转成 Manager 私有格式
2. 终端正文以原始 PTY 为唯一显示源
3. 高风险操作不可被自动学习；强制批准必须是用户明确选择的独立操作，并留痕
4. 正常完成 / 用户停止 / 异常退出必须可区分

---

## 当前限制

- macOS 已可安装和打包；由于当前发布包未签名、公证，首次启动可能需要在系统安全设置中手动允许
- 外部终端**拖入**仍为 Beta，默认关闭；**拖出**可用
- 代理目前支持 **HTTP**；HTTPS / SOCKS5 配置尚未开放
- Pi 新建入口暂不可用；DeepSeek Harness 使用官方 Web，不是与 Claude Code / Codex 同等粒度的终端集成
- 各平台产物以对应 Release 的附件为准；本次 0.3.5 发布 Windows x64 包，不提供新构建的 macOS 包

---

## 技术栈

Electron · React · TypeScript · xterm.js · node-pty（Windows ConPTY / macOS PTY）· 本地 Session Host IPC · Electron safeStorage · 钉钉 Stream SDK

---

## 贡献

欢迎 Issue / PR：适配器与版本兼容、终端保真与测试、文档与安装体验、真实多 Agent 负载下的性能反馈。
安全相关改动请附复现步骤与影响说明。

---

## License

[MIT](LICENSE) © 2026 MulaLee
