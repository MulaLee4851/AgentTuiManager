import { DEFAULT_ATTENTION_AUDIO_SETTINGS, parseAttentionAudioSettings, type AttentionAudioSettings } from '../src/shared/attention-audio-settings'

type DeliveryOutcome = 'renderer_completed' | 'native_fallback' | 'muted'
interface PendingAudio { timer: ReturnType<typeof setTimeout>; preview?: AttentionAudioSettings }

/** Tracks renderer playback receipts so a lost IPC cannot silently eat a reminder. */
export class AttentionAudioDelivery {
  private ready = false
  private sequence = 0
  private pending = new Map<string, PendingAudio>()
  constructor(private readonly port: {
    getSettings?(): AttentionAudioSettings
    send(id: string, settings: AttentionAudioSettings): void
    fallback(settings: AttentionAudioSettings, isAllowed: () => boolean): void
    onDelivery?(outcome: DeliveryOutcome): void
  }) {}

  setReady(ready: boolean): void {
    this.ready = ready
    if (!ready) for (const id of [...this.pending.keys()]) this.acknowledge(id, false)
  }

  settingsChanged(): void {
    // A previously requested preview must not override a newly saved mute later.
    for (const [id, pending] of this.pending) {
      if (!pending.preview) continue
      clearTimeout(pending.timer)
      this.pending.delete(id)
    }
  }

  play(preview?: AttentionAudioSettings): void {
    const settings = parseAttentionAudioSettings(preview ?? this.settings())
    if (settings.volume === 0) { this.diagnostic('muted'); return }
    if (!this.ready) { this.fallback(preview); return }
    const id = String(++this.sequence)
    this.pending.set(id, { timer: setTimeout(() => this.acknowledge(id, false), 2_000), preview: preview ? { ...settings } : undefined })
    try { this.port.send(id, settings) } catch { this.acknowledge(id, false) }
  }

  acknowledge(id: unknown, success: unknown): void {
    if (typeof id !== 'string' || typeof success !== 'boolean') return
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (!success) this.fallback(pending.preview)
    else this.diagnostic('renderer_completed')
  }

  private settings(): AttentionAudioSettings { return this.port.getSettings?.() ?? { ...DEFAULT_ATTENTION_AUDIO_SETTINGS } }

  private fallback(preview?: AttentionAudioSettings): void {
    const settings = preview ?? this.settings()
    if (settings.volume === 0) { this.diagnostic('muted'); return }
    // Recheck saved mute after an asynchronous native player startup as well.
    this.port.fallback(settings, () => (preview ?? this.settings()).volume > 0)
    this.diagnostic('native_fallback')
  }

  private diagnostic(outcome: DeliveryOutcome): void {
    try { this.port.onDelivery?.(outcome) } catch { /* Diagnostics cannot interrupt reminders. */ }
  }

  dispose(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.ready = false
  }
}
