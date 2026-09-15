import { useEffect, useRef, useState } from 'react'

export function startupOutputText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/((?:api[_-]?key|authorization|password|secret)\s*[:=]\s*)[^\r\n]+/gi, '$1[已隐藏]')
    .replace(/\r/g, '').slice(-16000).trim()
}

/** Read only on demand; never poll full PTY history in the background. */
export default function DeepSeekStartupOutput({ sessionId }: { sessionId: string }): JSX.Element {
  const [output, setOutput] = useState<string>()
  const [busy, setBusy] = useState(false)
  const requestId = useRef(0)
  useEffect(() => {
    setOutput(undefined); setBusy(false)
    return () => { requestId.current += 1 }
  }, [sessionId])
  const load = async (): Promise<void> => {
    const id = ++requestId.current
    setBusy(true)
    try {
      const snapshot = await window.agentManager.terminalReplay(sessionId)
      if (requestId.current !== id) return
      setOutput(startupOutputText(snapshot.data) || '该进程尚未产生输出；请检查 Node.js 版本和 Executable，或停止后重试。')
    } catch {
      if (requestId.current === id) setOutput('无法读取启动输出，请重试。')
    } finally {
      if (requestId.current === id) setBusy(false)
    }
  }
  return <div className='deepseek-startup-output' onClick={(event) => event.stopPropagation()}>
    <button type='button' className='button-secondary button-compact' disabled={busy} onClick={() => { void load() }}>
      {busy ? '读取中…' : output === undefined ? '查看启动输出' : '刷新启动输出'}
    </button>
    {output !== undefined && <pre aria-label='DeepSeek 启动输出'>{output}</pre>}
  </div>
}
