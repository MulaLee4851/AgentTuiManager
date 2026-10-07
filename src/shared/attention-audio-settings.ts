export const ATTENTION_SOUNDS = ['classic', 'soft', 'bell', 'pulse'] as const
export type AttentionSoundKind = typeof ATTENTION_SOUNDS[number]

export interface AttentionAudioSettings {
  sound: AttentionSoundKind
  /** Percentage of the original chime's amplitude; 0 is silent. */
  volume: number
}

export const DEFAULT_ATTENTION_AUDIO_SETTINGS: Readonly<AttentionAudioSettings> = { sound: 'classic', volume: 100 }

export function parseAttentionAudioSettings(value: unknown): AttentionAudioSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('提示音设置格式不正确')
  const { sound, volume } = value as Record<string, unknown>
  if (!ATTENTION_SOUNDS.includes(sound as AttentionSoundKind)) throw new Error('请选择有效的声音类型')
  if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('音量必须为 0 到 100 的整数')
  return { sound: sound as AttentionSoundKind, volume }
}

export interface AttentionTone { offset: number; frequency: number }

/** Shared by Web Audio and the native PCM fallback. Classic exactly preserves the original envelope. */
export function attentionAudioTones(sound: AttentionSoundKind): AttentionTone[] {
  const notes: Record<AttentionSoundKind, number[][]> = {
    classic: [[0, 660], [0.14, 880]],
    soft: [[0, 440], [0.16, 554.37]],
    bell: [[0, 1046.5], [0.12, 1318.51], [0.24, 1567.98]],
    pulse: [[0, 740], [0.22, 740]],
  }
  return notes[sound].map(([offset, frequency]) => ({ offset: offset!, frequency: frequency! }))
}

export const ATTENTION_ENVELOPE = { attack: 0.012, decay: 0.16, duration: 0.18, peak: 0.12, floor: 0.001 } as const
