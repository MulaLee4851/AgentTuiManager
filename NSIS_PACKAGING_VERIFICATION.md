# local.7 NSIS 封装恢复与校验

## 结果

已成功生成 `release/Agent-TUI-Manager-Setup-0.4.12-local.7-x64.exe`。

- 大小：92,870,743 字节。
- SHA-256：`ecca870039a50c8282e28bcb7261428f7dc1f321a9e1075cd5e63ada51ad8cde`。
- electron-builder 25.1.8、Electron 31.7.7、NSIS v3.04（缓存包 nsis-3.0.4.1）。
- 本次未修改应用源码、依赖或 NSIS 编译器；沿用已经构建并测试的 local.7 应用。

## 错误定位

在本次工具会话中，对同一个 `makensis.exe`、同一份最小脚本和相同环境参数进行对比：

| 操作 | 普通工具执行环境 `use_default` | 提权工具执行环境 `require_escalated` |
| --- | --- | --- |
| 查询版本 `-VERSION` | 退出 0，返回 v3.04 | 退出 96，无输出 |
| 帮助 `-V2 -HELP` | 退出 0，正常输出 | 退出 96，无输出 |
| 最小安装脚本编译 | 退出 0，生成文件 | 退出 96，无输出 |
| 当前项目 NSIS 完整封装 | 退出 0，生成安装器及 blockmap | 退出 96 |

原先报错的独立探针（文件和 stdin 输入两种方式）在普通工具执行环境中也均成功。相同编译器无需替换即可工作，故本次封装故障已隔离到工具的提权执行环境，不能归因于 UI 功能修改或 NSIS 脚本。

这不是“Windows 管理员终端普遍无法打包”的结论。该执行环境为什么使进程退出 96，尚未确定到更底层组件；此次通过正常执行环境完成了封装，没有更改系统安全设置。

## 后续构建方法

项目原有 `npm run dist:win` 无须修改。若在自动化工具中构建，应用编译与安装器封装可以分开执行，避免因前一步需要额外权限而让 NSIS 也沿用有问题的执行环境：

```powershell
npm run build
node node_modules/electron-builder/out/cli/cli.js --win nsis --x64
```

本次使用已有的完整 electron-builder 缓存；`ELECTRON_BUILDER_CACHE` 仅为当前命令进程设置，没有更改系统级配置。成功封装的工作目录为 `%TEMP%\agent-tui-free-layout-20261005`，缓存目录为 `%TEMP%\agent-tui-four-modes-20261005\.tmp\builder-cache`。这些是本机临时目录，不是项目依赖或其他机器的必填路径。

`winCodeSign` 归档中 macOS 符号链接的解压权限问题与本次退出 96 是两个不同问题。此次复用了此前已经校验的可用缓存。

## 产物验证

- NSIS 文件头、声明长度和 CRC 校验通过。
- 安装器内嵌应用 7z 归档完整性检查通过；解压的 276 个文件与 `win-unpacked` 文件集合及各文件 SHA-256 全部一致。
- 14 个 `dist-electron` 构建文件与应用内 `app.asar` 对应文件一致。
- `app.asar` SHA-256 为 `39856ed12939cc17eb7e3b6f0dbf7f9440580f20e5af54271cf3ed389f98bd48`，与此前通过完整应用验证的 local.7 产物一致。
- 主应用 PE 架构和节边界检查通过。NSIS 引导程序本身为 x86，内含应用为 x64，这是该 NSIS 工具链的正常产物。
- 辅助 Agent 独立审阅了校验脚本和结果，未发现交付阻碍。

证据位于 `release/verification-local.7/nsis/`，校验值另附于安装器同名 `.sha256` 文件。

本次只封装、静态检查和解压校验最终安装器，没有执行最终安装器，因此安装、卸载、快捷方式和覆盖升级流程未实测。未读取密钥、真实对话或运行中应用的数据，未覆盖或重启当前安装。应用此前的完整回归记录见 `FREE_LAYOUT_VERIFICATION.md`。
