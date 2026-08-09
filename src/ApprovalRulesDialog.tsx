import { type FormEvent, useEffect, useState } from 'react'

export default function ApprovalRulesDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [rules, setRules] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)

  const reload = async (): Promise<void> => {
    setRules(await window.agentManager.listApprovalRules())
  }

  useEffect(() => {
    void reload().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
  }, [])

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    try {
      await window.agentManager.addApprovalRule(command)
      setCommand('')
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const remove = async (rule: string): Promise<void> => {
    setError('')
    try {
      await window.agentManager.removeApprovalRule(rule)
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return <div className="modal-backdrop" role="presentation">
    <section className="rules-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-rules-title">
      <header><div><span className="eyebrow">SAFETY</span><h2 id="approval-rules-title">自动批准规则</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭规则设置">×</button></header>
      <p className="rules-help">仅完整匹配的只读命令会自动批准。写入、删除和复合命令不会加入规则。</p>
      <form className="rule-add" onSubmit={(event) => { void add(event) }}>
        <input aria-label="新增批准命令" required value={command} onChange={(event) => setCommand(event.target.value)} placeholder="例如：git log --oneline" />
        <button type="submit" className="button-primary">添加</button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <div className="rules-list">
        {busy ? <p className="field-note">正在读取规则…</p> : rules.length === 0 ? <p className="field-note">还没有自定义规则</p> : rules.map((rule) => <div className="rule-row" key={rule}><code title={rule}>{rule}</code><button type="button" className="button-danger" onClick={() => { void remove(rule) }}>撤销</button></div>)}
      </div>
      <footer><button type="button" className="button-secondary" onClick={onClose}>完成</button></footer>
    </section>
  </div>
}
