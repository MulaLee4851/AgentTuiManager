import { execFile, type ChildProcess } from 'node:child_process'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attentionAudioTones, ATTENTION_ENVELOPE, parseAttentionAudioSettings, type AttentionAudioSettings } from '../src/shared/attention-audio-settings'

/** 16-bit mono PCM using the same frequencies, envelope and volume as Web Audio. */
export function attentionAudioWav(value: AttentionAudioSettings): Buffer {
  const settings = parseAttentionAudioSettings(value)
  const tones = attentionAudioTones(settings.sound)
  const sampleRate = 44100
  const frames = Math.ceil((Math.max(...tones.map(tone => tone.offset)) + ATTENTION_ENVELOPE.duration) * sampleRate)
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40)
  const { attack, decay, duration, peak, floor } = ATTENTION_ENVELOPE
  for (let frame = 0; frame < frames; frame++) {
    let sample = 0
    for (const tone of tones) {
      const elapsed = frame / sampleRate - tone.offset
      if (elapsed < 0 || elapsed >= duration) continue
      const amplitude = elapsed < attack ? peak * elapsed / attack
        : elapsed < decay ? peak * Math.pow(floor / peak, (elapsed - attack) / (decay - attack)) : floor
      sample += Math.sin(2 * Math.PI * tone.frequency * elapsed) * amplitude * settings.volume / 100
    }
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + frame * 2)
  }
  return wav
}

// Fixed code only; the generated PCM arrives over stdin and never becomes shell code.
const WINDOWS_PLAYER = "$ErrorActionPreference='Stop'; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $stream=[IO.MemoryStream]::new($bytes,$false); $player=[System.Media.SoundPlayer]::new($stream); try { $player.Load(); $player.PlaySync() } finally { $player.Dispose(); $stream.Dispose() }"

export class NativeAttentionAudio {
  private children = new Set<ChildProcess>()
  private generation = 0

  async play(settings: AttentionAudioSettings, isAllowed: () => boolean = () => true): Promise<void> {
    if (settings.volume === 0 || !isAllowed()) return
    const generation = this.generation
    const allowed = (): boolean => generation === this.generation && isAllowed()
    const wav = attentionAudioWav(settings)
    if (process.platform === 'win32') {
      const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      await this.run(executable, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PLAYER], allowed, wav.toString('base64'))
      return
    }
    const directory = await mkdtemp(join(tmpdir(), 'agent-tui-chime-'))
    const file = join(directory, 'chime.wav')
    try {
      await writeFile(file, wav)
      await this.run(process.platform === 'darwin' ? '/usr/bin/afplay' : 'aplay', [file], allowed)
    } finally {
      await unlink(file).catch(() => undefined)
      await rmdir(directory).catch(() => undefined)
    }
  }

  private run(executable: string, args: string[], allowed: () => boolean, input?: string): Promise<void> {
    if (!allowed()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const child = execFile(executable, args, { windowsHide: true, timeout: 5000, maxBuffer: 4096 }, error => {
        this.children.delete(child)
        if (error && allowed()) reject(new Error('Native audio output unavailable'))
        else resolve()
      })
      this.children.add(child)
      child.stdin?.on('error', () => { /* execFile reports player failures. */ })
      child.stdin?.end(input)
    })
  }

  stop(): void {
    this.generation++
    for (const child of this.children) child.kill()
    this.children.clear()
  }
}
