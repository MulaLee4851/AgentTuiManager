import { useEffect, useId, useRef, useState } from 'react'
import { SESSION_STATUS_LABEL, parseSessionDisplayStatus, type SessionDisplayStatus } from './shared/session-state'

const OPTIONS = Object.entries(SESSION_STATUS_LABEL) as Array<[SessionDisplayStatus, string]>

/** Empty means all; also reads the previous single-select preference. */
export function normalizeStatusFilter(value: unknown): SessionDisplayStatus[] {
  const values = Array.isArray(value) ? value : [value]
  return [...new Set(values.flatMap((item) => {
    const status = typeof item === 'string' ? parseSessionDisplayStatus(item) : undefined
    return status ? [status] : []
  }))]
}

export default function SessionStatusFilter({ value, onChange }: {
  value: SessionDisplayStatus[]
  onChange: (value: SessionDisplayStatus[]) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const labels = OPTIONS.filter(([status]) => value.includes(status)).map(([, label]) => label)
  const summary = labels.length === 0 || labels.length === OPTIONS.length ? '全部状态' : labels.join('、')
  return <div className='overview-status-filter' ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }}>
    <button ref={trigger} type='button' aria-label='筛选 Agent 状态' aria-expanded={open}
      aria-controls={id} title={summary} onClick={() => setOpen((shown) => !shown)}>
      <span>{summary}</span><span aria-hidden='true'>▾</span>
    </button>
    {open && <div id={id} className='overview-status-options' role='group' aria-label='Agent 状态选项'>
      <button type='button' onClick={() => onChange([])}>显示全部状态</button>
      {OPTIONS.map(([status, label]) => <label key={status}>
        <input type='checkbox' checked={value.includes(status)} onChange={() => onChange(
          value.includes(status) ? value.filter((item) => item !== status) : [...value, status]
        )} />{label}
      </label>)}
      <small>可多选；未勾选时显示全部</small>
    </div>}
  </div>
}
