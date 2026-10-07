# 自动审批策略参考（2026-10-05）

本地版本参考公开资料的设计原则，未引入 OpenAI Guardian 服务或 Anthropic 分类器。实际使用的仍是用户配置的审核模型；第三方模型的判断质量不能由提示词或模拟测试保证。

## 核对的官方来源

1. [OpenAI：Auto-review](https://developers.openai.com/codex/sandboxing/auto-review)：独立审核器接管已触发的审批，使用相关上下文与确切动作；拒绝返回理由，执行 Agent 应寻找实质更安全的方案。解析等失败不放行；超时不等于动作本身危险。
2. [OpenAI 公开 Guardian 提示词模板](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/guardian/policy_template.md)及[风险策略](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/guardian/policy.md)：当前源码位置已从文档链接里的 `core/src/guardian` 迁移至 `prompts/templates/guardian`，本次读取了迁移后的文件。
3. [Anthropic：Permission modes](https://code.claude.com/docs/en/permission-modes)：固定权限判定顺序、后台分类器、失败与连续拒绝的处理、PowerShell 删除检查，以及要求执行 Agent 重写危险路径命令的例子。
4. [Anthropic：Configure auto mode](https://code.claude.com/docs/en/auto-mode-config)：区分可信环境、允许与拒绝规则；提供 `claude auto-mode defaults` 查看版本对应的默认规则，组织配置来自可信设置来源。此次未运行读取本机配置的 CLI 子命令。

OpenAI 提示词中两条相关原文：

> Missing context should make you more cautious, but it does not increase the intrinsic risk of an action by itself.

> High risk requires evidence of significant risk of irreversible damage.

Anthropic 本次参考的是官方行为及默认规则文档；没有将第三方提取的提示词当作官方完整分类器提示词。

## 如何应用到本地版本

| 方面 | 本地实现 |
| --- | --- |
| 审核范围 | 普通完整请求直接批准；规则提示高风险的请求才调用审核器。规则命中是待核查提示，不等于真实危险已经成立。 |
| 风险定义 | 根据完整命令、路径、参数和数据流判断实际损害；长度、沙箱升级、工作区外路径或缺少整段历史本身不是高风险证据。 |
| 缺失信息 | 缺失项必须与已经存在的具体风险机制有关，例如真实递归删除的变量目标不可解析，才能作为风险拒绝理由。格式损坏、命令截断则由输入完整性检查拒绝，不冒充模型危险结论。 |
| 预览 | 正确的内置 PowerShell `-WhatIf` 按真实预览语义判断；注释、字符串、禁用开关、子表达式及其他命令的副作用不因此放行。 |
| 输出 | 新提示词只允许 `allow` 或 `deny`；兼容解析旧 `manual/uncertain` 时，控制器也返回拒绝，不要求人工。风险分数仅展示，不暗设通过阈值。 |
| 拒绝反馈 | 返回具体原因与实质修改方向，要求补全参数、缩小范围、改为只读或移除危险副作用。禁止换壳绕过、原样重试或等待人工。 |
| 审核故障 | 请求不执行，报告审核不可用并拒绝；故障不能被包装成危险证据。审批传输无法确认时停止对应会话，防止无限挂起。 |
| 凭据 | 保留本任务更严格的约束：审核不读取真实密钥内容，不接受密钥输出或外传。正常客户端认证与读取/展示密钥区别处理。 |

## 没有照搬的部分

- OpenAI 能使用可信用户消息及工具上下文；本项目 API 审核只发送筛选后的本次工具参数、命令、工作区/cwd、Agent 理由与规则提示，不发送整个对话。Agent 的理由不是可信用户授权。
- 官方部分模式保留人工覆盖或连续拒绝后人工兜底；本项目按用户要求，Agent 审核与规则自动不转人工。普通模式仍保留手动审批。
- 没有照搬任何读取真实凭据的默认许可，也没有自动将任意第三方目标加入可信列表。
- 纯终端兼容路径只能发送 CLI 的拒绝按键，无法像结构化 Hook 一样可靠携带拒绝理由；应优先使用受支持的 Codex/Claude Hook。未确认自动操作成功的终端会话会停止，而不是转人工。
- 提示词与规则不是操作系统隔离层，也无法使未知程序、不可见模块或恶意混淆的任意行为具有绝对安全保证。
