import type { ApprovalRequest, SessionSummary, UnattendedSettings } from '../src/shared/manager-api'
import { approvalEnterCount, approvalEnterDelay, normalizeUnattendedEndWords, selectedRecoveryEndWord } from '../src/shared/unattended-settings'

export interface UnattendedAudit {
  sessionId: string; action: string; message: string
  details?: Record<string, string | number | boolean>
}
interface Mode {
  settings: UnattendedSettings & { endWords: string[] }; startedAt: number; nextAt: number; busy: boolean
  assistant?: { text: string; timestamp: number }; restarts: number[]
  restartFailures?: number
  nextErrorRecoveryAt?: number
  errorRecoveries?: number
  approvalEnter?: { at: number; epoch: number | undefined; requestId: string; remaining: number; total: number }
  inputRevision?: number
}
export interface UnattendedPort {
  session(id: string): SessionSummary | undefined
  approvals(id: string): ApprovalRequest[]
  ready(id: string): boolean
  blockedReason?(id: string): string | undefined
  approve(id: string): Promise<void>
  enter?(id: string): Promise<boolean>
  epoch?(id: string): number | undefined
  send(id: string, text: string): Promise<void>
  restart(id: string): Promise<void>
  changed(id: string, settings: UnattendedSettings): void
  audit(entry: UnattendedAudit): void
}

export function recoveryMessage(settings: UnattendedSettings): string {
  return settings.recoveryWord.trim() + '。继续当前尚未完成的任务；如果没有剩余任务，仅输出 '
    + selectedRecoveryEndWord(settings)
    + '，不要输出其他内容。'
}

export class UnattendedSupervisor {
  private readonly modes = new Map<string, Mode>()
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly port: UnattendedPort, private readonly now = Date.now) {}

  enabled(id: string): boolean { return this.modes.has(id) }

  enable(id: string, settings: UnattendedSettings): void {
    const session = this.port.session(id)
    if (!session || !['codex', 'claude'].includes(session.agentKind)) throw new Error('无监管模式目前仅支持 Codex 和 Claude Code')
    if (session.userStopRequested || ['stopped', 'completed', 'failed'].includes(session.status)) throw new Error('请先启动 Agent，再开启无监管模式')
    const endWords = normalizeUnattendedEndWords(settings)
    if (!settings.recoveryWord?.trim() || settings.recoveryWord.length > 2000 || /[\x00-\x1f\x7f]/.test(settings.recoveryWord)) throw new Error('恢复词必须为一行且不超过 2000 字符')
    const value = { enabled: true, endWord: endWords[0]!, endWords, recoveryEndWord: selectedRecoveryEndWord(settings), recoveryWord: settings.recoveryWord.trim(), approvalEnterDelaySeconds: approvalEnterDelay(settings), approvalEnterCount: approvalEnterCount(settings) }
    this.modes.set(id, { settings: value, startedAt: this.now(), nextAt: this.now() + 5000, busy: false, restarts: [] })
    this.port.changed(id, value)
    this.port.audit({ sessionId: id, action: 'unattended_enabled', message: '已开启无监管：包括高风险在内的全部审批将自动批准', details: { endWord: value.endWord, endWords: JSON.stringify(endWords), recoveryEndWord: value.recoveryEndWord } })
    this.schedule()
  }

  disable(id: string, reason = '已手动关闭无监管模式'): void {
    const mode = this.modes.get(id)
    if (!mode) return
    this.modes.delete(id)
    this.port.changed(id, { ...mode.settings, enabled: false, reason })
    this.port.audit({ sessionId: id, action: 'unattended_disabled', message: reason })
    if (!this.modes.size && this.timer) { clearTimeout(this.timer); this.timer = undefined }
  }

  observe(id: string, text: string, timestamp: number): void {
    const mode = this.modes.get(id)
    if (mode && timestamp >= mode.startedAt && timestamp >= (mode.assistant?.timestamp ?? 0)) {
      // Retain only a completion marker, never a potentially huge answer.
      const candidate = text.trim()
      mode.assistant = { text: mode.settings.endWords.includes(candidate) ? candidate : '', timestamp }
    }
  }

  cancelApprovalEnter(id: string): void {
    const mode = this.modes.get(id)
    if (!mode) return
    mode.inputRevision = (mode.inputRevision ?? 0) + 1
    if (mode.approvalEnter) {
      delete mode.approvalEnter
      this.port.audit({ sessionId: id, action: 'unattended_approval_enter_cancelled', message: '输入或会话变化，已取消审批后补按 Enter' })
    }
  }

  private schedule(): void {
    if (this.timer || !this.modes.size) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const id of this.modes.keys()) void this.tick(id)
      this.schedule()
    }, 1000)
    this.timer.unref?.()
  }

  private waiting(id: string, mode: Mode, reason?: string): void {
    if (mode.settings.reason === reason) return
    mode.settings = { ...mode.settings, reason }
    this.port.changed(id, mode.settings)
    if (reason) this.port.audit({ sessionId: id, action: 'unattended_waiting', message: '无监管暂未发送：' + reason })
  }

  async tick(id: string): Promise<void> {
    const mode = this.modes.get(id)
    if (!mode || mode.busy) return
    const session = this.port.session(id)
    if (!session || session.userStopRequested) { this.disable(id, 'Agent 已移除或手动停止，无监管已关闭'); return }
    if (mode.assistant && mode.settings.endWords.includes(mode.assistant.text)) {
      this.disable(id, 'Agent 已输出结束词 ' + mode.assistant.text + '，无监管已完成')
      return
    }
    if (this.now() < mode.nextAt && !mode.approvalEnter) return
    const current = () => this.modes.get(id) === mode
    mode.busy = true
    try {
      const followup = mode.approvalEnter
      if (followup) {
        if (followup.epoch !== this.port.epoch?.(id) || ['starting', 'recovering', 'stopped', 'completed', 'failed'].includes(session.status)) {
          this.cancelApprovalEnter(id)
        } else {
          if (this.now() < followup.at) return
          delete mode.approvalEnter
          const revision = mode.inputRevision ?? 0
          const sent = await this.port.enter?.(id)
          if (!current()) return
          if (sent && followup.remaining > 1 && revision === (mode.inputRevision ?? 0) && followup.epoch === this.port.epoch?.(id)) {
            mode.approvalEnter = { ...followup, at: this.now() + 1000, remaining: followup.remaining - 1 }
          }
          mode.nextAt = this.now() + 5000
          this.port.audit({ sessionId: id, action: sent ? 'unattended_approval_enter_sent' : 'unattended_approval_enter_skipped',
            message: sent ? '审批延迟补救：已向终端发送一次 Enter（不代表确认审批成功）' : '审批延迟补救已跳过：终端有输入或连接不可用',
            details: { requestId: followup.requestId, index: followup.total - followup.remaining + 1, total: followup.total } })
          return
        }
      }
      if (this.now() < mode.nextAt) return
      const requests = this.port.approvals(id)
      if (requests.length) {
        for (const request of requests) {
          if (!current()) return
          if (!this.port.approvals(id).some(item => item.requestId === request.requestId)) continue
          const revision = mode.inputRevision ?? 0
          const epoch = this.port.epoch?.(id)
          await this.port.approve(request.requestId)
          if (!current()) return
          const delay = mode.settings.approvalEnterDelaySeconds ?? 0
          if (delay > 0 && this.port.enter && revision === (mode.inputRevision ?? 0) && epoch === this.port.epoch?.(id)) {
            // At most one pending timestamp per window; reuse the existing tick.
            const count = mode.settings.approvalEnterCount ?? 1
            mode.approvalEnter = { at: this.now() + delay * 1000, epoch, requestId: request.requestId, remaining: count, total: count }
            this.port.audit({ sessionId: id, action: 'unattended_approval_enter_scheduled', message: '审批后将在 ' + delay + ' 秒后补按一次 Enter', details: { requestId: request.requestId, delaySeconds: delay } })
          }
          this.port.audit({ sessionId: id, action: 'unattended_approved', message: '无监管已批准工具请求（忽略风险限制）',
            details: { requestId: request.requestId, toolName: request.toolName ?? '', command: request.command ?? '', risk: request.risk } })
          if (mode.approvalEnter) break
        }
        mode.nextAt = this.now() + 5000
        return
      }
      // An approval acknowledgement may still be in flight. Never send recovery
      // text just because the UI queue has temporarily become empty.
      if (session.status === 'needs_approval') return
      if (['stopped', 'completed', 'failed'].includes(session.status)) {
        if (!session.nativeSessionId) throw new Error('缺少原生会话 ID，已暂停，不会另开新会话')
        mode.restarts = mode.restarts.filter(time => this.now() - time < 60000)
        if (mode.restarts.length >= 3) {
          mode.nextAt = this.now() + 60000
          this.waiting(id, mode, '连续退出，冷却 60 秒后继续恢复原生会话')
          return
        }
        mode.restarts.push(this.now())
        try {
          await this.port.restart(id)
          mode.restartFailures = 0
        } catch (error) {
          if (!current()) return
          mode.restartFailures = Math.min((mode.restartFailures ?? 0) + 1, 5)
          const seconds = Math.min(30 * 2 ** (mode.restartFailures - 1), 300)
          mode.nextAt = this.now() + seconds * 1000
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
          this.waiting(id, mode, '原生会话恢复失败，' + seconds + ' 秒后重试：' + message)
          return
        }
        if (!current()) return
        mode.nextAt = this.now() + 10000
        this.port.audit({ sessionId: id, action: 'unattended_restarted', message: '无监管已恢复原生会话' })
        return
      }
      if (!['idle', 'completed', 'error'].includes(session.activity ?? '')) {
        this.waiting(id, mode, session.activity === 'running' ? undefined : '界面显示待命，但尚未取得任务活动状态')
        return
      }
      if (!this.port.ready(id)) {
        this.waiting(id, mode, this.port.blockedReason?.(id) ?? '等待 CLI 就绪或输入/审批处理完成')
        return
      }
      if (this.now() - (session.activityUpdatedAt ?? mode.startedAt) < 5000) return
      if (session.activity === 'error') {
        if (this.now() < (mode.nextErrorRecoveryAt ?? 0)) {
          this.waiting(id, mode, '网络或模型异常，退避后继续恢复；无监管保持开启')
          return
        }
        mode.errorRecoveries = Math.min((mode.errorRecoveries ?? 0) + 1, 5)
        mode.nextErrorRecoveryAt = this.now() + Math.min(30 * 2 ** (mode.errorRecoveries - 1), 300) * 1000
      } else {
        mode.errorRecoveries = 0
        mode.nextErrorRecoveryAt = undefined
      }
      this.waiting(id, mode)
      if (!session.nativeSessionId) throw new Error('尚未取得原生会话 ID，无法可靠识别结束词，已暂停')
      mode.assistant = undefined
      await this.port.send(id, recoveryMessage(mode.settings))
      if (!current()) return
      mode.nextAt = this.now() + 10000
      this.port.audit({ sessionId: id, action: 'unattended_recovery_sent', message: 'Agent 待命且未输出结束词，已提交恢复消息（不等待接收回执）' })
    } catch (error) {
      if (current()) this.disable(id, '无监管已暂停：' + (error instanceof Error ? error.message : String(error)))
    } finally { mode.busy = false }
  }
}
