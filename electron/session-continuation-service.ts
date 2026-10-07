import { approvalModeOf } from '../src/shared/approval-mode'
import type { AgentConfigSummary, SessionSummary } from '../src/shared/manager-api'
import type { AgentConfigurationStore } from './agent-configuration-store'
import type { AgentProxyStore } from './agent-proxy-store'
import type { SessionController } from './session-controller'
import { continuationPrompt, freshSessionArgs, nextContinuationName } from './session-continuation'
import { findNativeSessionTranscriptPath } from './native-session-transcript'

export interface ContinuationResult { session: SessionSummary; warning?: string }

export class SessionContinuationService {
  private busy = false

  constructor(
    private readonly controller: Pick<SessionController, 'continuationSource' | 'listSessions' | 'startSession' | 'setFullAutoMode' | 'setApprovalMode' | 'saveUnattendedSettings' | 'setUnattendedMode' | 'flushCatalog'>,
    private readonly configs: Pick<AgentConfigurationStore, 'get' | 'save' | 'remove'>,
    private readonly proxies: Pick<AgentProxyStore, 'get' | 'save' | 'remove'>,
    private readonly findTranscript = findNativeSessionTranscriptPath,
  ) {}

  async create(sourceId: string): Promise<ContinuationResult> {
    if (this.busy) throw new Error('正在创建续写窗口，请稍后再试')
    this.busy = true
    let configId: string | undefined
    let proxyId: string | undefined
    let created: SessionSummary | undefined
    try {
      const { summary, request } = this.controller.continuationSource(sourceId)
      const args = freshSessionArgs(summary.agentKind, request.args)
      const path = await this.findTranscript(summary.agentKind, summary.nativeSessionId!)
      if (!path) throw new Error('找不到旧会话的原生历史文件，未创建续写窗口，也未修改旧窗口')
      const prompt = continuationPrompt(summary, path)
      const displayName = nextContinuationName(summary.displayName, this.controller.listSessions().map(item => item.displayName))
      let agentConfig: AgentConfigSummary | undefined
      if (summary.agentConfig?.enabled) {
        const stored = summary.agentConfig.profileId ? this.configs.get(summary.agentConfig.profileId) : undefined
        if (!stored) throw new Error('旧窗口的独立配置不可用，已取消续写，未回退默认配置')
        agentConfig = await this.configs.save({
          ...stored, enabled: true,
          extraArgs: [...stored.extraArgs],
          networkRetry: summary.agentConfig.networkRetry,
          autoCompactTokens: summary.agentConfig.autoCompactTokens,
        })
        configId = agentConfig.profileId
      } else if (summary.agentConfig) agentConfig = structuredClone(summary.agentConfig)
      let agentProxy: SessionSummary['agentProxy']
      if (summary.agentProxy?.enabled) {
        const stored = this.proxies.get(summary.agentProxy.proxyId)
        if (!stored) throw new Error('旧窗口的代理配置不可用，已取消续写，未回退直连')
        agentProxy = await this.proxies.save({ ...stored, enabled: true })
        proxyId = agentProxy?.proxyId
      }
      created = await this.controller.startSession({
        displayName, agentKind: summary.agentKind, workspace: summary.workspace,
        executable: request.executable, args, cols: request.cols, rows: request.rows,
        ...(request.maxContinueRetries === undefined ? {} : { maxContinueRetries: request.maxContinueRetries }),
        ...(agentConfig ? { agentConfig } : {}), ...(agentProxy ? { agentProxy } : {}),
      }, prompt)
      if (summary.unattended) await this.controller.saveUnattendedSettings(created.sessionId, { ...summary.unattended, enabled: false })
      if (summary.unattended?.enabled) await this.controller.setUnattendedMode(created.sessionId, structuredClone(summary.unattended))
      else await this.controller.setApprovalMode(created.sessionId, approvalModeOf(summary))
      await this.controller.flushCatalog()
      return { session: this.controller.listSessions().find(item => item.sessionId === created!.sessionId) ?? created }
    } catch (error) {
      // 新 Agent 已经启动时必须保持可见，避免复制自动模式或持久化失败后，
      // 用户重试又静默创建重复窗口，也不能再提示删除旧窗口。
      if (created) return { session: created, warning: `新窗口已启动，但配置继承或保存未全部完成：${error instanceof Error ? error.message : String(error)}。请保留旧窗口并检查新窗口设置。` }
      if (configId) await this.configs.remove(configId).catch(() => undefined)
      if (proxyId) await this.proxies.remove(proxyId).catch(() => undefined)
      throw error
    } finally {
      this.busy = false
    }
  }
}
