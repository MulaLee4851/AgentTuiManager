import type { AgentKind } from './shared/manager-api'
import type { NetworkRetrySettings } from './shared/network-retry'

export default function NetworkRetryControls({ agentKind, value, onChange }: {
  agentKind: AgentKind
  value: NetworkRetrySettings
  onChange: (value: NetworkRetrySettings) => void
}): JSX.Element | null {
  if (agentKind !== 'codex' && agentKind !== 'claude') return null
  const count = (key: 'codexStreamRetries' | 'codexRequestRetries' | 'claudeRequestRetries', label: string, max: number) => <label>{label}<input
    className='launcher-field' type='number' min={0} max={max} step={1}
    value={value[key] ?? ''} placeholder='留空使用 Agent 默认设置'
    onChange={(event) => onChange({ ...value, [key]: event.target.value === '' ? undefined : Number(event.target.value) })}
  /></label>
  return <div className='launcher-proxy-section'>
    <div className='launcher-section-title'><h2>网络断线重试</h2><span>仅当前 Agent · 下次启动生效</span></div>
    <div className='launcher-config-form'>
      {agentKind === 'codex' ? <>
        {count('codexStreamRetries', '流式断线重连次数（0–100）', 100)}
        {count('codexRequestRetries', 'HTTP 请求重试次数（0–100）', 100)}
      </> : <>
        <label>长重试模式<select className='launcher-field' value={value.claudeRetryWatchdog === undefined ? 'inherit' : String(value.claudeRetryWatchdog)} onChange={(event) => {
          const watchdog = event.target.value === 'inherit' ? undefined : event.target.value === 'true'
          onChange({ ...value, claudeRetryWatchdog: watchdog, ...(watchdog !== true && (value.claudeRequestRetries ?? 0) > 15 ? { claudeRequestRetries: 15 } : {}) })
        }}><option value='inherit'>使用 Agent 默认设置</option><option value='false'>关闭</option><option value='true'>开启</option></select></label>
        {count('claudeRequestRetries', `请求重试次数（0–${value.claudeRetryWatchdog ? 1000 : 15}）`, value.claudeRetryWatchdog ? 1000 : 15)}
      </>}
    </div>
    <div className='launcher-config-security'><strong>重试说明</strong><span>留空使用 Agent 默认设置；0 表示不重试。
      {agentKind === 'codex' ? ' Codex 使用独立服务配置时可自定义次数；使用内置服务配置时仍按 Codex 默认次数重试。' : ' Claude Code 的长重试模式需要版本支持。开启后，模型繁忙可能持续重试，不受此处次数限制。'}
    </span></div>
  </div>
}
