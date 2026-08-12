import { type FormEvent, useEffect, useRef, useState } from 'react'

function readableError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
}

export default function ApprovalRulesDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [rules, setRules] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [closeArmed, setCloseArmed] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const armBackdropClose = (): void => {
    setCloseArmed(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => { setCloseArmed(false); closeTimer.current = undefined }, 500)
  }

  const resetBackdropClose = (): void => {
    setCloseArmed(false)
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  }

  const reload = async (): Promise<void> => {
    setRules(await window.agentManager.listApprovalRules())
  }

  useEffect(() => {
    void reload().catch((reason) => setError(readableError(reason))).finally(() => setBusy(false))
  }, [])

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    try {
      await window.agentManager.addApprovalRule(command)
      setCommand('')
      await reload()
    } catch (reason) {
      setError(readableError(reason))
    }
  }

  const remove = async (rule: string): Promise<void> => {
    setError('')
    try {
      await window.agentManager.removeApprovalRule(rule)
      await reload()
    } catch (reason) {
      setError(readableError(reason))
    }
  }

  return <div className="modal-backdrop" role="presentation"
    onMouseDown={(event) => { if (event.target === event.currentTarget) armBackdropClose() }}
    onDoubleClick={(event) => { if (event.target === event.currentTarget) { resetBackdropClose(); onClose() } }}>
    <section className="rules-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-rules-title" onMouseDown={resetBackdropClose}>
      <header><div><span className="eyebrow">SAFETY</span><h2 id="approval-rules-title">自动批准规则</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭规则设置">×</button></header>
      <p className="rules-help">填写一条实际执行的完整命令。规则只做完整匹配；删除、提权、下载执行和敏感文件覆盖等高危操作不会加入。</p>
      <form className="rule-add" onSubmit={(event) => { void add(event) }}>
        <input aria-label="新增批准命令" required value={command} onChange={(event) => setCommand(event.target.value)} placeholder="例如：git log --oneline" />
        <button type="submit" className="button-primary">添加</button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <div className="rules-list">
        {busy ? <p className="field-note">正在读取规则…</p> : rules.length === 0 ? <p className="field-note">还没有自定义规则</p> : rules.map((rule) => <div className="rule-row" key={rule}><code title={rule}>{rule}</code><button type="button" className="button-danger" onClick={() => { void remove(rule) }}>撤销</button></div>)}
      </div>
      {closeArmed && <p className="launcher-dismiss-hint rules-dismiss-hint">再点击一次空白处关闭，已填写规则会保留</p>}
      <footer><button type="button" className="button-secondary" onClick={onClose}>完成</button></footer>
    </section>
  </div>
}
