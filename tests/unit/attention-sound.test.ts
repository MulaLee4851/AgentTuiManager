import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttentionSound } from '../../electron/attention-sound'
import { isAttentionSessionActive } from '../../electron/attention-focus'
import { TerminalQuestionSignal } from '../../electron/terminal-question-signal'
import type { ApprovalMode, ApprovalRequest, SessionSummary } from '../../src/shared/manager-api'

function fixture(mode: ApprovalMode = 'manual') {
  const sessions = new Map<string, SessionSummary>(['one', 'two'].map(sessionId => [sessionId, {
    sessionId, displayName: sessionId, workspace: 'C:/project', agentKind: 'codex', status: 'running',
    activity: 'running', approvalMode: mode, recoveryAttempts: 0, userStopRequested: false,
  }]))
  const requests: ApprovalRequest[] = []
  const focus = { active: 'one' as string | undefined, foreground: true, visible: true, minimized: false, destroyed: false }
  const play = vi.fn()
  const onDecision = vi.fn()
  const sounds = new AttentionSound({ session: id => sessions.get(id), approvals: id => requests.filter(item => item.sessionId === id),
    isActive: id => isAttentionSessionActive(id, focus.active, {
      isFocused: () => focus.foreground, isVisible: () => focus.visible,
      isMinimized: () => focus.minimized, isDestroyed: () => focus.destroyed,
    }), play, onDecision })
  sounds.seed([...sessions.values()])
  const approval = (id = 'two', requestId = 'request-1') => {
    const request: ApprovalRequest = { sessionId: id, requestId, displayName: id, workspace: 'C:/project', agentKind: 'codex',
      source: 'codex-hook', risk: 'unknown', toolName: 'Bash', command: 'npm test', reason: 'test', createdAt: Date.now(), canBulkApprove: false }
    requests.push(request)
    sounds.sessionChanged(id)
    return request
  }
  return { sounds, sessions, requests, focus, play, approval, onDecision }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
const settle = () => vi.advanceTimersByTimeAsync(1600)

describe('inactive Agent attention sounds', () => {
  it.each(['approval', 'native-question', 'terminal-question', 'completion'] as const)(
    'only suppresses %s when the owning Agent is selected and the window is foreground', async kind => {
      for (const selected of [false, true]) for (const foreground of [false, true])
      for (const visible of [false, true]) for (const minimized of [false, true]) {
        const f = fixture()
        Object.assign(f.focus, { active: selected ? 'two' : 'one', foreground, visible, minimized })
        if (kind === 'approval') f.approval()
        else if (kind === 'native-question') f.sounds.observeQuestions('two', [{ id: 'question', timestamp: Date.now() }])
        else if (kind === 'terminal-question') f.sounds.terminalQuestion('two', 'menu', () => true)
        else {
          f.sessions.get('two')!.activity = 'completed'
          f.sessions.get('two')!.activityUpdatedAt = Date.now()
          f.sounds.sessionChanged('two')
        }
        await settle()
        expect(f.play).toHaveBeenCalledTimes(selected && foreground && visible && !minimized ? 0 : 1)
        f.sounds.dispose()
      }
    },
  )
  it('treats missing, destroyed and inaccessible windows as not being viewed', () => {
    expect(isAttentionSessionActive('one', 'one', undefined)).toBe(false)
    const window = { isDestroyed: () => true, isVisible: () => true, isMinimized: () => false, isFocused: () => true }
    expect(isAttentionSessionActive('one', 'one', window)).toBe(false)
    window.isDestroyed = () => { throw new Error('Window closed') }
    expect(isAttentionSessionActive('one', 'one', window)).toBe(false)
  })
  it('reports safe decisions once without including question or approval content', async () => {
    const f = fixture()
    f.approval('one', 'private-request-id')
    f.sounds.sessionChanged('one')
    f.sounds.observeQuestions('two', [{ id: 'private-question-id', timestamp: Date.now() }])
    f.sounds.observeQuestions('two', [{ id: 'private-question-id', timestamp: Date.now() }])
    await settle()
    f.approval('two', 'cancelled'); f.requests.length = 0
    await settle()
    expect(f.onDecision.mock.calls.map(([decision]) => decision)).toEqual([
      { sessionId: 'one', kind: 'approval', outcome: 'suppressed-active' },
      { sessionId: 'two', kind: 'question', outcome: 'queued' },
      { sessionId: 'two', kind: 'question', outcome: 'played' },
      { sessionId: 'two', kind: 'approval', outcome: 'queued' },
      { sessionId: 'two', kind: 'approval', outcome: 'invalidated' },
    ])
    f.onDecision.mockImplementation(() => { throw new Error('diagnostics unavailable') })
    f.approval('two', 'another'); await settle()
    expect(f.play).toHaveBeenCalledTimes(2)
  })
  it('notifies an unanswered question from a restored live run even if it predates window startup', async () => {
    const f = fixture()
    f.sessions.get('two')!.activitySince = Date.now() - 60_000
    f.sounds.sessionChanged('two')
    f.sounds.observeQuestions('two', [{ id: 'still-waiting', timestamp: Date.now() - 30_000 }])
    await settle(); expect(f.play).toHaveBeenCalledOnce()
    f.sounds.observeQuestions('two', [{ id: 'previous-run', timestamp: Date.now() - 120_000 }])
    await settle(); expect(f.play).toHaveBeenCalledOnce()
  })
  it.each([false, true])('requeues a split redraw only if its earlier ticket was never heard (played: %s)', async played => {
    const f = fixture(); const signal = new TerminalQuestionSignal()
    const menu = 'Question 1/1\r\nWhich target?\r\n1. Local\r\nEnter to select'
    const observe = (text: string): void => {
      const token = signal.observe(text)
      if (token) f.sounds.terminalQuestion('two', token, () => signal.current === token)
    }
    observe(menu)
    if (played) await settle()
    observe('\x1b[2J')
    await settle()
    observe(menu)
    await settle()
    expect(f.play).toHaveBeenCalledOnce()
  })
  it('sounds for another Agent while Manager is focused, but not the active Agent', async () => {
    const f = fixture()
    f.approval('one', 'active'); await settle(); expect(f.play).not.toHaveBeenCalled()
    f.approval('two', 'other'); await settle(); expect(f.play).toHaveBeenCalledOnce()
  })
  it('sounds for the selected Agent when Manager is in the background or minimized', async () => {
    const f = fixture(); f.focus.foreground = false
    f.approval('one'); await settle(); expect(f.play).toHaveBeenCalledOnce()
  })
  it('does not replay active-Agent events after switching away', async () => {
    const f = fixture(); f.approval('one'); f.focus.active = 'two'
    f.sounds.sessionChanged('one'); await settle(); expect(f.play).not.toHaveBeenCalled()
  })
  it('rechecks focus and cancels a pending chime once the Agent is viewed', async () => {
    const f = fixture(); f.approval('two'); f.focus.active = 'two'; f.sounds.acknowledge('two')
    f.focus.active = 'one'; await settle(); expect(f.play).not.toHaveBeenCalled()
  })
  it('does not notify a request already answered during the debounce', async () => {
    const f = fixture(); f.approval(); f.requests.length = 0
    await settle(); expect(f.play).not.toHaveBeenCalled()
  })
  it.each(['rules-auto', 'agent-review', 'unattended'] as const)('cancels a manual chime when switching to %s before processing', async mode => {
    const f = fixture(); const request = f.approval()
    f.sessions.get('two')!.approvalMode = mode; f.sounds.sessionChanged('two')
    await settle(); expect(f.play).not.toHaveBeenCalled()
    if (mode !== 'unattended') {
      f.sounds.approvalNeedsUser(request); await settle(); expect(f.play).toHaveBeenCalledOnce()
    }
  })
  it.each(['rules-auto', 'agent-review', 'unattended'] as const)('%s does not sound for requests handled automatically', async mode => {
    const f = fixture(mode); f.approval(); await settle(); expect(f.play).not.toHaveBeenCalled()
  })
  it.each(['rules-auto', 'agent-review'] as const)('%s sounds when a request actually falls back to the user', async mode => {
    const f = fixture(mode); const request = f.approval()
    f.sounds.approvalNeedsUser(request); await settle(); expect(f.play).toHaveBeenCalledOnce()
  })
  it('stays quiet during AI review, then sounds once if the reviewer fails', async () => {
    const f = fixture('agent-review'); const request = f.approval(); request.llmReviewStatus = 'pending'
    f.sounds.approvalNeedsUser(request); await settle(); expect(f.play).not.toHaveBeenCalled()
    request.llmReviewStatus = 'failed'; f.sounds.approvalNeedsUser(request); await settle()
    f.sounds.approvalNeedsUser(request); await settle(); expect(f.play).toHaveBeenCalledOnce()
  })
  it.each(['manual', 'agent-review', 'rules-auto', 'unattended'] as const)('%s sounds for real questions independently of the approval mode', async mode => {
    const f = fixture(mode); const question = { id: 'question-1', timestamp: Date.now() }
    f.sounds.observeQuestions('two', [question]); await settle()
    f.sounds.observeQuestions('two', [question]); await settle(); expect(f.play).toHaveBeenCalledOnce()
    f.sounds.observeQuestions('two', [{ id: 'question-2', timestamp: Date.now() }]);
    f.sounds.observeQuestions('two', []); await settle(); expect(f.play).toHaveBeenCalledOnce()
  })
  it('ignores historical questions and startup completion snapshots', async () => {
    const f = fixture(); f.sounds.observeQuestions('two', [{ id: 'old', timestamp: 1 }])
    f.sessions.set('old', { ...f.sessions.get('two')!, sessionId: 'old', activity: 'completed', activityUpdatedAt: 1 })
    f.sounds.sessionChanged('old'); await settle(); expect(f.play).not.toHaveBeenCalled()
  })
  it('sounds once for completion, not for initial idle, repaint or later process exit', async () => {
    const f = fixture(); const session = f.sessions.get('two')!
    session.activity = 'idle'; f.sounds.sessionChanged('two'); await settle(); expect(f.play).not.toHaveBeenCalled()
    session.activity = 'completed'; session.activityUpdatedAt = Date.now(); f.sounds.sessionChanged('two'); await settle()
    f.sounds.sessionChanged('two'); session.status = 'completed'; f.sounds.sessionChanged('two'); await settle()
    expect(f.play).toHaveBeenCalledOnce()
  })
  it('waits for unattended to finish instead of sounding for every automatic continuation', async () => {
    const f = fixture('unattended'); const session = f.sessions.get('two')!
    session.unattended = { enabled: true, recoveryWord: 'continue' }; f.sounds.sessionChanged('two')
    session.activity = 'completed'; session.activityUpdatedAt = Date.now(); f.sounds.sessionChanged('two'); await settle()
    expect(f.play).not.toHaveBeenCalled()
    session.unattended = { enabled: false, recoveryWord: 'continue', reason: 'Agent 已输出结束词 DONE，无监管已完成' }
    session.approvalMode = 'manual'; f.sounds.sessionChanged('two'); await settle(); expect(f.play).toHaveBeenCalledOnce()
  })
  it('coalesces a burst across Agents, and stopping/removing a session cancels pending sounds', async () => {
    const f = fixture(); f.focus.foreground = false
    f.approval('one', 'first'); f.approval('two', 'second'); await settle(); expect(f.play).toHaveBeenCalledOnce()
    f.approval('two', 'third'); f.sessions.delete('two'); f.sounds.sessionChanged('two'); await settle()
    expect(f.play).toHaveBeenCalledOnce(); f.sounds.dispose()
  })
  it('a transient terminal question is cancelled after its menu disappears', async () => {
    const f = fixture(); let visible = true
    f.sounds.terminalQuestion('two', 'prompt-1', () => visible); visible = false
    await settle(); expect(f.play).not.toHaveBeenCalled()
  })
  it('still alerts when the reviewer decided but sending the automatic response failed', async () => {
    const f = fixture('agent-review'); const request = f.approval()
    request.llmReviewStatus = 'completed'
    request.llmReview = { verdict: 'allow', summary: 'Safe', requiresHumanApproval: false,
      riskScore: 0, reasons: [], hazards: [], assumptions: [], model: 'test', reviewedAt: Date.now() }
    f.sounds.approvalNeedsUser(request); await settle(); expect(f.play).toHaveBeenCalledOnce()
  })
  it.each([true, false])('transfers a terminal question to native capture without a second sound (already played: %s)', async played => {
    const f = fixture(); const timestamp = Date.now()
    f.sounds.terminalQuestion('two', 'menu', () => true)
    if (played) await settle()
    f.sounds.observeQuestions('two', [{ id: 'native-call', timestamp }]); await settle()
    expect(f.play).toHaveBeenCalledOnce()
    f.sounds.observeQuestions('two', [{ id: 'next-call', timestamp: Date.now() }]); await settle()
    expect(f.play).toHaveBeenCalledTimes(2)
  })
  it('an empty native snapshot does not cancel an on-screen question before its call is flushed', async () => {
    const f = fixture()
    f.sounds.terminalQuestion('two', 'menu', () => true)
    f.sounds.observeQuestions('two', []); await settle(); expect(f.play).toHaveBeenCalledOnce()
  })
  it('a new run cancels old question tickets', async () => {
    const f = fixture()
    f.sounds.observeQuestions('two', [{ id: 'old-run', timestamp: Date.now() }])
    f.sessions.get('two')!.activitySince = Date.now(); f.sounds.sessionChanged('two')
    await settle(); expect(f.play).not.toHaveBeenCalled()
  })
  it('native-first detection suppresses a later terminal menu and confirmed answers close the fallback', async () => {
    const f=fixture(); const question={id:'native-first',timestamp:Date.now()}
    f.sounds.observeQuestions('two',[question]);await settle()
    f.sounds.terminalQuestion('two','menu',()=>true);await settle()
    expect(f.play).toHaveBeenCalledOnce()
    expect(f.sounds.observeQuestions('two',[])).toBe(true)
    f.sounds.terminalQuestion('two','menu',()=>true);await settle()
    expect(f.play).toHaveBeenCalledOnce()
  })

  it.each(['answered-first', 'overlapping', 'old-snapshot-repeated'] as const)(
    'does not acknowledge the next terminal question using a stale native question: %s', async sequence => {
      const f = fixture()
      const first = { id: 'native-a', timestamp: Date.now() }
      f.sounds.observeQuestions('two', [first]); await settle()
      expect(f.play).toHaveBeenCalledOnce()
      const second = { id: 'native-b', timestamp: Date.now() }
      f.sounds.terminalQuestion('two', 'menu-b', () => true)
      if (sequence === 'old-snapshot-repeated') f.sounds.observeQuestions('two', [first])
      f.sounds.observeQuestions('two', sequence === 'overlapping' ? [first, second] : [second])
      await settle()
      expect(f.play).toHaveBeenCalledTimes(2)
      f.sounds.observeQuestions('two', [second]); await settle()
      expect(f.play).toHaveBeenCalledTimes(2)
    },
  )

  it('keeps a native-first question quiet when its own terminal menu is observed again', async () => {
    const f = fixture()
    const question = { id: 'native-a', timestamp: Date.now() }
    f.sounds.observeQuestions('two', [question]); await settle()
    f.sounds.terminalQuestion('two', 'menu-a', () => true)
    f.sounds.observeQuestions('two', [question]); await settle()
    expect(f.play).toHaveBeenCalledOnce()
  })

  it('sounds for a distinct next menu even while native capture keeps returning the previous question', async () => {
    const f = fixture()
    const first = { id: 'native-a', timestamp: Date.now() }
    f.sounds.terminalQuestion('two', 'menu-a', () => true)
    f.sounds.observeQuestions('two', [first]); await settle()
    expect(f.play).toHaveBeenCalledOnce()
    const second = { id: 'native-b', timestamp: Date.now() }
    f.sounds.terminalQuestion('two', 'menu-b', () => true)
    f.sounds.observeQuestions('two', [first]); await settle()
    f.sounds.observeQuestions('two', [first]); await settle()
    expect(f.play).toHaveBeenCalledTimes(2)
    f.sounds.observeQuestions('two', [second]); await settle()
    expect(f.play).toHaveBeenCalledTimes(2)
  })

  it('still acknowledges a next-round menu actually viewed before its native call arrives', async () => {
    const f = fixture()
    f.sounds.observeQuestions('two', [{ id: 'native-a', timestamp: Date.now() }]); await settle()
    const question = { id: 'native-b', timestamp: Date.now() }
    f.focus.active = 'two'
    f.sounds.terminalQuestion('two', 'menu-b', () => true)
    f.focus.active = 'one'
    f.sounds.observeQuestions('two', [question]); await settle()
    expect(f.play).toHaveBeenCalledOnce()
  })
})

describe('terminal question fallback', () => {
  it('requires a question-menu marker and input footer, handles split/repainted frames', () => {
    const signal = new TerminalQuestionSignal()
    expect(signal.observe('Which approach do you want?')).toBeUndefined()
    signal.reset()
    expect(signal.observe('Question 1/1\r\nWhich target?\r\n1. Local\r\nEnter to ')).toBeUndefined()
    const token = signal.observe('select'); expect(token).toBeTruthy()
    expect(signal.observe(' · Esc to cancel\r\n')).toBeUndefined()
    expect(signal.observe('\x1b[2JQuestion 1/1\r\nWhich target?\r\n1. Local\r\nEnter to select')).toBeUndefined()
    expect(signal.current).toBe(token)
    signal.observe('\x1b[2JWorking...'); expect(signal.current).toBeUndefined()
    signal.reset()
    expect(signal.observe('Question 1/1\r\nWhich target?\r\n1. Local\r\nEnter to select')).not.toBe(token)
  })
  it('does not mistake shell approvals or question-like printed commands for question menus', () => {
    for (const text of ['Would you like to run the following command?\n$ npm test\n1. Yes\nEnter to select', 'console.log("Question 1/1? Enter to select")']) {
      expect(new TerminalQuestionSignal().observe(text)).toBeUndefined()
    }
  })
})
