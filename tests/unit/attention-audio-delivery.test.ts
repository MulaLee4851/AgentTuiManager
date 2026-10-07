import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttentionAudioDelivery } from '../../electron/attention-audio-delivery'

describe('attention audio delivery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  const fixture = () => {
    const port = { send: vi.fn(), fallback: vi.fn(), onDelivery: vi.fn() }
    return { port, delivery: new AttentionAudioDelivery(port) }
  }
  it('uses fallback before the renderer subscribes and after a renderer crash', () => {
    const { port, delivery } = fixture()
    delivery.play()
    expect(port.fallback).toHaveBeenCalledTimes(1)
    delivery.setReady(true); delivery.play(); delivery.setReady(false)
    expect(port.fallback).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(3000)
    expect(port.fallback).toHaveBeenCalledTimes(2)
  })
  it('does not play fallback after a confirmed renderer success', () => {
    const { port, delivery } = fixture()
    delivery.setReady(true); delivery.play()
    const id = port.send.mock.calls[0]![0]
    delivery.acknowledge(id, true)
    vi.advanceTimersByTime(3000)
    delivery.acknowledge(id, false)
    expect(port.fallback).not.toHaveBeenCalled()
    expect(port.onDelivery.mock.calls).toEqual([['renderer_completed']])
  })
  it('falls back once for missing or failed receipts, ignoring invalid receipt data', () => {
    const { port, delivery } = fixture()
    delivery.setReady(true); delivery.play()
    delivery.acknowledge('unknown', false)
    delivery.acknowledge(port.send.mock.calls[0]![0], 'yes')
    vi.advanceTimersByTime(2000)
    expect(port.fallback).toHaveBeenCalledTimes(1)
    delivery.play()
    delivery.acknowledge(port.send.mock.calls[1]![0], false)
    vi.advanceTimersByTime(2000)
    expect(port.fallback).toHaveBeenCalledTimes(2)
    expect(port.onDelivery.mock.calls).toEqual([['native_fallback'], ['native_fallback']])
  })
  it('ignores diagnostic failures without losing fallback delivery', () => {
    const { port, delivery } = fixture()
    port.onDelivery.mockImplementation(() => { throw new Error('Audit unavailable') })
    expect(() => delivery.play()).not.toThrow()
    expect(port.fallback).toHaveBeenCalledOnce()
  })
  it('handles a closed send channel and releases timers on shutdown', () => {
    const { port, delivery } = fixture()
    delivery.setReady(true)
    port.send.mockImplementationOnce(() => { throw new Error('closed') })
    delivery.play()
    expect(port.fallback).toHaveBeenCalledOnce()
    delivery.play(); delivery.dispose()
    vi.advanceTimersByTime(3000)
    expect(port.fallback).toHaveBeenCalledOnce()
  })
  it('does not dispatch or fall back when saved settings are muted', () => {
    const port = { getSettings: () => ({ sound: 'bell' as const, volume: 0 }), send: vi.fn(), fallback: vi.fn(), onDelivery: vi.fn() }
    const delivery = new AttentionAudioDelivery(port)
    delivery.play(); delivery.setReady(true); delivery.play()
    vi.advanceTimersByTime(3000)
    expect(port.send).not.toHaveBeenCalled()
    expect(port.fallback).not.toHaveBeenCalled()
    expect(port.onDelivery.mock.calls).toEqual([['muted'], ['muted']])
  })
  it('honors settings saved while waiting for an audio receipt and keeps previews independent', () => {
    let volume = 30
    const port = { getSettings: () => ({ sound: 'soft' as const, volume }), send: vi.fn(), fallback: vi.fn() }
    const delivery = new AttentionAudioDelivery(port)
    delivery.setReady(true); delivery.play()
    expect(port.send).toHaveBeenCalledWith('1', { sound: 'soft', volume: 30 })
    volume = 0
    vi.advanceTimersByTime(2000)
    expect(port.fallback).not.toHaveBeenCalled()
    delivery.play({ sound: 'pulse', volume: 20 })
    vi.advanceTimersByTime(2000)
    expect(port.fallback).toHaveBeenCalledWith({ sound: 'pulse', volume: 20 }, expect.any(Function))
  })
  it('rechecks saved mute before an asynchronous native fallback can start', () => {
    let volume = 30
    const port = { getSettings: () => ({ sound: 'soft' as const, volume }), send: vi.fn(), fallback: vi.fn() }
    const delivery = new AttentionAudioDelivery(port)
    delivery.play()
    const isAllowed = port.fallback.mock.calls[0]![1]
    expect(isAllowed()).toBe(true)
    volume = 0
    expect(isAllowed()).toBe(false)
  })
  it('cancels stale preview retries on save while preserving pending reminder delivery', () => {
    const { port, delivery } = fixture()
    delivery.setReady(true)
    delivery.play({ sound: 'bell', volume: 100 })
    delivery.play()
    delivery.settingsChanged()
    vi.advanceTimersByTime(2000)
    expect(port.fallback).toHaveBeenCalledOnce()
    expect(port.fallback).toHaveBeenCalledWith({ sound: 'classic', volume: 100 }, expect.any(Function))
  })
})
