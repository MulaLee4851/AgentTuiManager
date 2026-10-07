import type { AgentKind } from './shared/manager-api'

export default function AutoCompactControls({ kind, value, onChange }: {
  kind: AgentKind; value?: number; onChange: (tokens: number | undefined) => void
}): JSX.Element | null {
  if (kind !== 'codex' && kind !== 'claude') return null
  return <div className='launcher-proxy-section'>
    <div className='launcher-section-title'><h2>自动压缩上下文</h2><span>仅当前窗口 · 下次启动生效</span></div>
    <div className='launcher-config-form'><label>自动压缩阈值（K Tokens）<input className='launcher-field'
      type='number' min={kind === 'claude' ? 100 : 1} max={1000} step={1}
      placeholder='留空继承全局设置' value={value === undefined ? '' : value / 1000}
      onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value) * 1000)}
    /></label></div>
    <div className='launcher-config-security'><strong>如何填写</strong><span>100 表示 100,000 个 Token。留空使用 Agent 默认设置，保存后重启该 Agent 生效。
      {kind === 'claude' ? ' Claude Code 需使用支持此设置的版本；本机的全局压缩设置优先。' : ' 设置更大的阈值不会增加模型能处理的对话长度。'}
    </span></div>
  </div>
}
