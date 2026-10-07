import { useEffect, useRef } from 'react'
import type { SessionSummary } from './shared/manager-api'
import { trapDialogTab } from './dialog-focus'

export default function SessionRecoveryDialog({ session, onChoose, onClose }: {
  session: SessionSummary
  onChoose: (choice: 'history' | 'fresh' | 'retry') => void
  onClose: () => void
}): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => { dialogRef.current?.focus() }, [])
  return <div className='modal-backdrop continuation-confirm-backdrop recovery-choice-backdrop'
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }; trapDialogTab(event, dialogRef.current) }}>
    <section className='continuation-confirm-dialog' ref={dialogRef} tabIndex={-1} role='dialog' aria-modal='true' aria-labelledby='recovery-choice-heading'>
      <header><h2 id='recovery-choice-heading'>会话恢复失败</h2></header>
      <div className='continuation-confirm-body'>
        <p><strong>{session.displayName}</strong> 已连续尝试恢复 3 次，仍未成功启动。</p>
        <p className='continuation-confirm-error'>{session.lastError ?? '原生会话暂时无法恢复'}</p>
        <p>可以选择工作区中的其他历史会话，按原配置新建会话，或重试。历史对话文件会保留。</p>
      </div>
      <footer className='recovery-choice-actions'>
        <button type='button' className='button-secondary' onClick={onClose}>稍后处理</button>
        <button type='button' className='button-secondary' onClick={() => onChoose('history')}>选择历史会话</button>
        <button type='button' className='button-secondary' onClick={() => onChoose('fresh')}>按原配置开启新会话</button>
        <button type='button' className='button-primary' onClick={() => onChoose('retry')}>继续重试</button>
      </footer>
    </section>
  </div>
}
