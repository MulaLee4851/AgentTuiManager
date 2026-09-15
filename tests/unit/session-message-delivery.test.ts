import { describe, expect, it, vi } from 'vitest'
import { SessionMessageDelivery } from '../../electron/session-message-delivery'

describe('confirmed terminal message delivery', () => {
  it('submits once without receipt polling and releases its state', async () => {
    const write = vi.fn()
    const delay = vi.fn(async () => undefined)
    const delivery = new SessionMessageDelivery(() => ({ generation: 1 }), write, delay)
    await delivery.send('a', 'continue TASK-DONE', false)
    expect(write.mock.calls).toEqual([['a', '\x1b[200~continue TASK-DONE\x1b[201~'], ['a', '\r']])
    expect(delay).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledWith(600)
    expect(delivery.busy('a')).toBe(false)
  })
  it('still cancels before Enter if approval arrives in no-receipt mode', async () => {
    let approval = false
    const write = vi.fn()
    const delivery = new SessionMessageDelivery(() => {
      if (approval) throw new Error('approval')
      return { generation: 1 }
    }, write, async () => { approval = true })
    await expect(delivery.send('a', 'continue', false)).rejects.toThrow('approval')
    expect(write).toHaveBeenCalledTimes(1)
    expect(delivery.busy('a')).toBe(false)
  })
  it('pastes text and submits separately, awaiting matching native evidence', async () => {
    const write = vi.fn()
    let ticks = 0
    const delivery = new SessionMessageDelivery(() => ({ generation: 1 }), write, async () => {
      if (++ticks === 2) delivery.observe('a', 'continue', Date.now())
    })
    await delivery.send('a', 'continue')
    expect(write.mock.calls).toEqual([['a', '\x1b[200~continue\x1b[201~'], ['a', '\r']])
    expect(ticks).toBe(2)
  })

  it('never claims success or retries Enter without evidence', async () => {
    const write = vi.fn()
    const delivery = new SessionMessageDelivery(() => ({ generation: 1 }), write, async () => {
      delivery.observe('b', 'continue', Date.now())
      delivery.observe('a', 'other', Date.now())
      delivery.observe('a', 'continue', 1)
    })
    await expect(delivery.send('a', 'continue')).rejects.toThrow('未确认')
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('does not press Enter when a new approval appears', async () => {
    const write = vi.fn()
    let approval = false
    const delivery = new SessionMessageDelivery(() => {
      if (approval) throw new Error('approval')
      return { generation: 1 }
    }, write, async () => { approval = true })
    await expect(delivery.send('a', 'continue')).rejects.toThrow('approval')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it.each(['input', 'restart'])('cancels submission after %s', async kind => {
    const write = vi.fn()
    let generation = 1
    const delivery = new SessionMessageDelivery(() => ({ generation }), write, async () => {
      if (kind === 'input') delivery.interrupt('a')
      else generation++
    })
    await expect(delivery.send('a', 'continue')).rejects.toThrow('已取消')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('serializes by session, not by current selected window', async () => {
    let release!: () => void
    const delivery = new SessionMessageDelivery(() => ({ generation: 1 }), vi.fn(),
      () => new Promise<void>(resolve => { release = resolve }))
    const first = delivery.send('a', 'continue')
    await expect(delivery.send('a', 'continue')).rejects.toThrow('正在提交')
    delivery.interrupt('a')
    release()
    await expect(first).rejects.toThrow('已取消')
    expect(delivery.busy('a')).toBe(false)
  })
})
