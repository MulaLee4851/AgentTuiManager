# Agent TUI Manager

![Agent TUI Manager](logo/AgentTuiManager.png)

Agent TUI Manager 是一个面向 Windows 的多 Agent 桌面工作台。它把 Codex、Claude Code、Pi 等终端 Agent 放进同一个窗口，集中管理工作区、原生历史会话、审批、审计和异常恢复，同时保留各 Agent 原有的会话文件与命令行工作流。

## 核心能力

- 在总览墙或列表模式中同时管理多个终端 Agent。
- 按本地目录选择工作区，并恢复 Codex、Claude Code 的原生历史会话。
- 过滤不可交互的 Codex subagent 历史线程，只展示可恢复的顶层会话。
- 在公共处理中心统一查看、批准或拒绝工具请求，支持安全规则和全自动模式。
- 记录启动、停止、审批、规则命中、异常和远程操作等审计事件。
- 为单个 Agent 配置独立的 Base URL、API Key、模型、启动参数和 HTTP 代理，不覆盖本机全局配置。
- 检测 Node.js、npm 和 Agent CLI；缺失时可在新建 Agent 面板中安装或选择自定义可执行文件。
- Manager 重启后重新接管保留的 Agent；停止或删除 Agent 时释放原生会话 writer。
- 通过钉钉 Stream 机器人远程查看 Agent、处理审批和发送任务，可选受限自然语言 Agent 模式。
- 支持将受管 Agent 拖出为普通终端；外部终端拖入目前作为 Beta 功能默认关闭。

## 运行要求

- Windows 10/11 x64
- Node.js 20 或更高版本
- npm
- 至少安装一个受支持的 Agent CLI：Codex、Claude Code 或 Pi

Agent CLI 未加入 `PATH` 时，可以在新建 Agent 的高级设置中选择其 `.exe`、`.cmd`、`.bat` 或 `.com` 文件。

## 快速启动

双击项目根目录的 `start.cmd`。首次启动会安装依赖，然后打开开发版桌面应用。

也可以在 PowerShell 中运行：

```powershell
npm install
npm run dev
```

`start.cmd` 在依赖尚未安装时默认使用本机 `127.0.0.1:7897` HTTP 代理下载依赖。如果本机没有该代理，请直接使用 `npm install`，或按自己的网络环境配置 npm。

## 基本使用

1. 点击“新增 Agent”。
2. 选择 Codex、Claude Code 或 Pi。
3. 通过目录选择器指定本地工作区。
4. 新建会话，或从该工作区的原生历史会话中选择一个继续。
5. 确认环境检测通过后启动 Agent。
6. 在总览墙、列表模式和处理中心之间切换，集中处理输入与审批。

停止 Agent 会关闭对应终端进程并释放会话，但保留 Manager 卡片，可重新启动；删除 Agent 会移除 Manager 记录，不会删除 Codex、Claude Code 或 Pi 的原生历史数据。

## 独立配置

Agent 默认继承本机 Codex、Claude Code 或 Pi 配置。只有显式开启“独立配置”后，Manager 才会为该 Agent 注入单独的服务地址、密钥和模型。

- 独立配置不会覆盖本机默认配置。
- API Key、代理密码和钉钉 Client Secret 不写入审计日志。
- 停止或删除 Agent 时，Manager 会清理由其生成的临时配置并恢复原生会话可用性。
- 支持从 CC Switch 读取已有 Provider，也可以手动填写 OpenAI-compatible 配置。

## 审批与安全

- 普通只读命令可以手动加入自动批准规则。
- 重复批准的低风险工具可提示加入学习列表。
- 删除、严重权限变更、下载后执行及其他高危操作不会自动学习。
- 全自动模式仍会阻止删除类和严重危险命令，并留下审计记录。
- 异常退出恢复不会自动发送 `continue`；无响应时先提示用户是否重启 Agent。

全自动模式会放宽大部分操作的人工确认，只建议在明确了解当前任务和工作区内容时临时启用。

## 钉钉远程控制

在设置中填写钉钉 Stream 应用凭据后，Manager 会生成一次性绑定 Key。在钉钉中发送：

```text
/init <key>
```

绑定后可使用 `/help` 查看命令，包括 Agent 列表、待审批列表、指定审批、全部审批、发送消息、停止、重启和审计查询。只有已绑定账号能够操作，具体 Agent 操作仍受工作区白名单和本地风险规则限制。

## 构建 Windows 安装包

```powershell
npm run dist:win
```

安装包默认生成到 `release/`。项目使用 NSIS 构建 x64 安装程序。

## 开发验证

```powershell
npm run typecheck
npm test
npm run build
```

## 数据与兼容性

Agent TUI Manager 只负责管理终端进程和交互状态，不替代原生会话存储。即使 Manager 不可用，仍可在对应工作区使用原生命令恢复会话，例如：

```powershell
codex resume <session-id>
claude --resume <session-id>
```

为了避免 active writer 冲突，请先在 Manager 中停止或删除仍占用该会话的 Agent，再从外部终端恢复。

## 当前限制

- 当前仅支持 Windows。
- 外部终端拖入功能仍处于 Beta，默认关闭；拖出功能可正常使用。
- HTTPS 和 SOCKS5 代理配置尚未开放，目前支持 HTTP 代理。
