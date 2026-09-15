import type { UnattendedSettings } from './manager-api'

export function approvalEnterCount(settings: Pick<UnattendedSettings, 'approvalEnterCount'>): number {
  const count = settings.approvalEnterCount === undefined ? 1 : settings.approvalEnterCount
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Enter 发送次数必须为 1～20 的整数')
  return count
}

// Shared by both IPC handlers. Do not drop numeric settings when crossing IPC.
export function parseUnattendedSettings(value: unknown): UnattendedSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无监管配置无效')
  const input = value as UnattendedSettings
  if (typeof input.enabled !== 'boolean') throw new Error('无监管开关无效')
  const endWords = normalizeUnattendedEndWords(input)
  if (typeof input.recoveryWord !== 'string' || !input.recoveryWord.trim() || input.recoveryWord.length > 2000 || /[\x00-\x1f\x7f]/.test(input.recoveryWord)) throw new Error('恢复词必须为一行且不超过 2000 字符')
  return { enabled: input.enabled, endWord: endWords[0], endWords,
    recoveryEndWord: selectedRecoveryEndWord(input), recoveryWord: input.recoveryWord.trim(),
    approvalEnterDelaySeconds: approvalEnterDelay(input), approvalEnterCount: approvalEnterCount(input) }
}

export function approvalEnterDelay(settings: Pick<UnattendedSettings, 'approvalEnterDelaySeconds'>): number {
  const seconds = settings.approvalEnterDelaySeconds === undefined ? 0 : settings.approvalEnterDelaySeconds
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 60) throw new Error('审批后补按 Enter 延迟必须为 0～60 的整数秒，0 表示关闭')
  return seconds
}

export function normalizeUnattendedEndWords(settings: Pick<UnattendedSettings, 'endWord' | 'endWords'>): string[] {
  const input = settings.endWords === undefined ? [settings.endWord] : settings.endWords
  if (!Array.isArray(input) || input.some(word => typeof word !== 'string')) throw new Error('结束词必须为文本列表')
  const words = [...new Set((input as string[]).map(word => word.trim()).filter(Boolean))]
  if (!words.length || words.length > 20) throw new Error('请填写 1～20 个结束词，每行一个')
  if (words.some(word => word.length > 100 || /[\s\x00-\x1f\x7f]/.test(word))) throw new Error('每个结束词必须为不含空白的 1～100 字符')
  if (words.join('').length > 1000) throw new Error('结束词总长度不能超过 1000 字符')
  return words
}

export function selectedRecoveryEndWord(settings: Pick<UnattendedSettings, 'endWord' | 'endWords' | 'recoveryEndWord'>): string {
  const words = normalizeUnattendedEndWords(settings)
  if (settings.recoveryEndWord === undefined) return words[0]!
  if (typeof settings.recoveryEndWord !== 'string' || !words.includes(settings.recoveryEndWord.trim())) {
    throw new Error('请选择结束词列表中的一个词拼接到恢复提示')
  }
  return settings.recoveryEndWord.trim()
}
