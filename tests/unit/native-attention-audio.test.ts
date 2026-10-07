import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const player = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: player.execFile }))
import { attentionAudioWav, NativeAttentionAudio } from '../../electron/native-attention-audio'

describe('native attention audio', () => {
  beforeEach(() => { player.execFile.mockReset(); vi.stubGlobal('process', { ...process, platform: 'win32' }) })
  afterEach(() => vi.unstubAllGlobals())

  it('writes a standard PCM WAV and preserves volume scaling through the native fallback', () => {
    const original = attentionAudioWav({ sound: 'classic', volume: 100 })
    const quieter = attentionAudioWav({ sound: 'classic', volume: 25 })
    const silent = attentionAudioWav({ sound: 'classic', volume: 0 })
    expect(original.toString('ascii', 0, 4)).toBe('RIFF')
    expect(original.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect(original.readUInt32LE(24)).toBe(44100)
    expect(original.readUInt16LE(34)).toBe(16)
    expect(original.readUInt32LE(40)).toBe(original.length - 44)
    let audible = false
    for (let offset = 44; offset < original.length; offset += 2) {
      const sample = original.readInt16LE(offset)
      audible ||= Math.abs(sample) > 3000
      expect(Math.abs(quieter.readInt16LE(offset) - sample / 4)).toBeLessThanOrEqual(1)
      expect(silent.readInt16LE(offset)).toBe(0)
    }
    expect(audible).toBe(true)
  })

  it('launches a hidden player with fixed code and sends only generated audio over stdin', async () => {
    const child = { stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn() }
    player.execFile.mockImplementation((_file, _args, _options, callback) => { queueMicrotask(() => callback(null)); return child })
    await new NativeAttentionAudio().play({ sound: 'soft', volume: 30 })
    const [file, args, options] = player.execFile.mock.calls[0]!
    expect(file).toMatch(/powershell\.exe$/)
    expect(options).toMatchObject({ windowsHide: true, timeout: 5000 })
    expect(args).toContain('-NonInteractive')
    const encoded = child.stdin.end.mock.calls[0]![0]
    expect(args.join(' ')).not.toContain(encoded)
    expect(Buffer.from(encoded, 'base64').toString('ascii', 0, 4)).toBe('RIFF')
  })

  it('does not start a helper for muted or canceled audio', async () => {
    const audio = new NativeAttentionAudio()
    await audio.play({ sound: 'bell', volume: 0 })
    await audio.play({ sound: 'bell', volume: 60 }, () => false)
    expect(player.execFile).not.toHaveBeenCalled()
  })

  it('stops a pending native player when settings change without reporting a playback failure', async () => {
    let finish: (error: Error) => void = () => undefined
    const child = { stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn(() => { finish(new Error('terminated')); return true }) }
    player.execFile.mockImplementation((_file, _args, _options, callback) => { finish = callback; return child })
    const audio = new NativeAttentionAudio()
    const playback = audio.play({ sound: 'classic', volume: 100 })
    audio.stop()
    await expect(playback).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
