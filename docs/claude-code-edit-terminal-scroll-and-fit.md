# Codex 终端滚动 与 终端黑边 修复记录

> 本文记录 `claude code edit:` 前缀提交所做的改动，供后续 agent 接手。
> 相关提交：`claude code edit: 忽略 .tmp 临时目录`、`claude code edit: 修复 Codex 终端无法滚动`、
> `claude code edit: 终端按容器实际尺寸铺满`。

---

## 一、Codex 终端无法滚动

### 结论

**不是渲染层的问题，是 Windows 自带的 ConPTY 吞掉了 Codex 产生 scrollback 所依赖的机制。**

### 根因链

1. Codex inline 模式（`--no-alt-screen`，由 `electron/session-host.ts` 的 `codexArgs()` 注入）
   写历史的方式见官方源码 `codex-rs/tui/src/insert_history.rs`（`InsertHistoryMode::Standard`）：

   ```
   \x1b[1;{area.top()}r      SetScrollRegion —— 只把 viewport 上方设为滚动区
   \x1b[{cursor_top};1H      光标移到滚动区底部
   \r\n + 内容               靠从滚动区顶部溢出，把老行挤进终端 scrollback
   \x1b[r                    ResetScrollRegion
   ```

2. xterm.js **支持**这个模式。`BufferService.scroll()` 只要 `scrollTop === 0` 就写 scrollback
   （`node_modules/@xterm/xterm/src/common/services/BufferService.ts:75`）。

3. **但 Windows 系统 ConPTY 会剥离 DECSTBM 滚动区**，并把整屏改成原地重绘。
   于是这些行永远不会以 scrollback 形式到达消费端。

4. 结果：`TerminalTile` 的滚轮处理里 `buffer.baseY` 恒为 0，
   `if (buffer.type !== 'normal' || buffer.baseY <= 0) return` 直接返回，滚轮完全没反应。

### 实测数据

同一段字节流，三种路径对比：

| 路径 | 滚动区序列 | baseY | bufLen |
|---|---|---|---|
| 不经 PTY（基线） | 30 | 90 | 102 |
| 系统 ConPTY | **0** | **0** | **12** |
| winpty | 0 | 90 | 102 |
| **node-pty bundled conpty.dll** | **30** | **90** | **102** |

真实 codex 0.147.0（生产同款 wiring）：系统 ConPTY 下 `baseY=0`；换 bundled dll 后 `baseY>0`，
且输出字节数下降约 **7 倍**（整屏重绘大幅减少）。

### 为什么 Claude Code 不受影响

Claude Code 不用滚动区 inline viewport，就是顺序打印普通行、从满屏底部自然溢出。
ConPTY 对这种普通滚动**会**转成真实滚动（实测普通行 20 行 → baseY +20）。

### 采用的修复

`electron/session-host.ts` 新增 `spawnAgentTerminal()`：对 Codex 使用 node-pty 自带的
`conpty.dll`（`useConptyDll: true`）。

```ts
if (agentKind !== 'codex') return pty.spawn(executable, args, options)
try {
  return pty.spawn(executable, args, { ...options, useConptyDll: true })
} catch {
  return pty.spawn(executable, args, options)   // 该选项为实验性，加载失败时回退
}
```

**保留 `--no-alt-screen` 不变**，渲染层滚轮逻辑一行都没改 —— scrollback 一旦真的产生，
原有代码就能正常工作。

### 曾经评估但放弃的方案

| 方案 | 放弃原因 |
|---|---|
| 回到 alt-screen，滚轮转发按键 | Codex **没有启用鼠标捕获**，且主聊天视图**没有任何滚动键位**；历史只在 `Ctrl+T` transcript overlay 里，需要代管 overlay 开关状态，UX 很差 |
| 改用 winpty 后端 | 实测能保住 scrollback，但 winpty 已废弃，宽字符/CJK 和 resize 有坑 |
| 设 `ZELLIJ` 环境变量走 `InsertHistoryMode::ZellijRaw`（不用滚动区） | 该路径只在 `wrap_policy == Terminal` 时启用，而正常历史走的是 `PreWrap`，没用 |
| Host 侧从重绘流自建历史 | 重绘流不含"哪些是新历史"的语义，不可靠 |

### 后续注意

- `useConptyDll` 在 node-pty 1.1.0 中标记为 **EXPERIMENTAL**。升级 node-pty 时需回归验证。
- 目前只对 Codex 开启。Claude Code 现状可用，未改动以缩小影响面；
  若想让所有 agent 都受益于更少的重绘流量，可以考虑扩大到全部，但要单独验证。

---

## 二、终端黑边 / 没铺满容器

### 根因

`src/TerminalTile.tsx` 原来的 `resizeFontOnly()` 把终端网格**固定在 100×30**，只缩放字号：

```ts
const fontSize = Math.max(8, Math.min(18, Math.floor(Math.min(fitByWidth, fitByHeight))))
```

两个后果：

1. 100×30 的宽高比固定（约 1.65），容器宽高比不同就必然上下或左右留黑边（letterboxing）。
2. 字号被钳在 **最大 18**。全屏/大屏时 `fitByWidth` 早就超过 18，字号涨不上去，
   终端只占 `100 × 0.62 × 18 ≈ 1116px` 宽，剩下全是黑边 —— 这就是"全屏黑边特别明显、样式乱掉"。

### 采用的修复

改为**真正的 fit**：字号仍按"一屏想要多宽"来选，但**行列数按容器实际尺寸铺满**。

- 新增 `terminalCellSize()`：读取 xterm 自己测量的 cell 尺寸
  （官方 fit addon 读的是同一个字段），做了防御性 guard，xterm 升级后取不到就保持当前尺寸不炸。
- `fitTerminal()` 用 `getComputedStyle` 扣掉 padding、预留 9px 滚动条宽度，
  再算 `cols/rows` 并 `terminal.resize()`。
- 字号变化时 xterm 会异步重新测量 cell，所以改字号后 `return` 并让下一帧重算，避免用到旧尺寸。
- 行列上下界（`24..500` / `8..200`）与 `electron/main.ts` 的 `dimensions()` 校验一致，
  fit 出来的尺寸不会被主进程拒绝。

### PTY resize 是防抖的

agent 收到 SIGWINCH 会重排整个 TUI，所以 `sendPtyResize()` 有 **180ms 防抖**，
拖动窗口过程中不会每帧都通知 PTY。

### 顺带修好的死代码

`resizeRedrawActive` / `resizeCoverFailsafeTimer` 之前**从来没有被置位**
（真实 resize 被移除后遗留），resize 遮罩机制实际只在挂载时生效过一次。
现在真实 resize 会重新走遮罩 + 同步重绘路径，并加了 900ms 兜底防止遮罩卡住。

---

## 三、版本控制与回滚

- `.tmp/` 已加入 `.gitignore`（里面是 codex 源码副本和诊断脚本，体积很大）。
- 提交 `8d6a35e chore: 快照` 是改动前的工作区基线。
  **注意**：当时另一个 agent 也在改同一批文件，该快照连同对方的在途工作一起提交了。
  撤销该快照恢复为未提交状态：`git reset --soft <该提交>`。
- `claude code edit: 修复 Codex 终端无法滚动` 这个提交里，`electron/session-host.ts`
  同时带上了另一个 agent 在同一文件的 manager-lease 在途代码（`managerSocket`、
  `ensureManagerLeaseTimer`、`HostExitFact.reason`）—— git 按整文件提交，无法拆分。

---

## 四、验证状态

- `npm run typecheck`（renderer + node 两个 tsconfig）：通过。
- `electron-vite build`（`pretest`）：通过。
- `npm test`：**239 passed / 6 failed**。
  这 6 条全部在 `tests/unit/session-controller.test.ts`，是 `development-plan.md`
  第 81/150/308/480 行已记录的**旧自动 continue 策略断言**，与本次改动无关
  （该测试文件不 import `session-host.ts` 或 `TerminalTile.tsx`）。

### 仍需真机验证

1. 新建 Codex agent，产生超过一屏的历史后，确认滚轮可以向上翻。
2. 总览 2×2 与全屏详情两种布局下，确认终端四边都铺满、无黑边。
3. 拖动窗口大小时确认没有出现"从第一条滚到最后一条"的滚屏。

### 复现脚本

诊断脚本在 `.tmp/`（已 gitignore），可直接 `node` 运行：

- `.tmp/conpty-test3.cjs` —— 对比 系统 ConPTY / winpty 的滚动区行为
- `.tmp/conpty-test4.cjs` —— 对比 系统 ConPTY / bundled conpty.dll
- `.tmp/codex-dll-test.cjs` —— 真实 codex 两种后端的 `baseY` 对比
- `.tmp/roundtrip.cjs` —— Host serialize → Renderer replay 的 scrollback 往返验证
