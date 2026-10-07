import { useState } from 'react'
import type { CCSwitchProviderSummary } from './shared/manager-api'

function providerHost(baseUrl?: string): string {
  if (!baseUrl) return '未配置地址'
  try { return new URL(baseUrl).host } catch { return baseUrl }
}

export default function CCSwitchProviderList({
  providers, selectedId, loading, error, disabled, onSelect, onRefresh, title = '选择 Provider',
}: {
  title?: string
  providers: CCSwitchProviderSummary[]
  selectedId: string
  loading: boolean
  error: string
  disabled: boolean
  onSelect: (provider: CCSwitchProviderSummary) => void
  onRefresh: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const visible = providers.filter(provider => !normalized || [provider.name, provider.id, provider.baseUrl, provider.model, provider.agentKind].some(value => value?.toLocaleLowerCase().includes(normalized)))
  const selected = providers.find(provider => provider.id === selectedId)
  return <div className='ccswitch-provider-section'>
    <div className='launcher-section-title'><h2>{title}</h2><button type='button' className='button-secondary mini-button' disabled={disabled || loading} onClick={onRefresh}>{loading ? '读取中…' : '刷新'}</button></div>
    {error && <p className='launcher-state error'>读取失败：{error}</p>}
    {!error && !loading && providers.length === 0 && <p className='launcher-state'>CC Switch 中没有找到此类 Agent 的配置</p>}
    {!error && !loading && providers.length > 0 && <p className='ccswitch-provider-count'>{providers[0]?.agentKind === 'codex' ? 'Codex' : 'Claude Code'} · 共 {providers.length} 个配置，{providers.filter(provider => !provider.issue).length} 个可导入。滚动查看完整列表。</p>}
    <input className='launcher-field ccswitch-provider-search' type='search' aria-label='搜索 CC Switch 配置' placeholder='搜索名称、地址或模型' disabled={disabled} value={query} onChange={event => setQuery(event.target.value)} />
    {normalized && <p className='ccswitch-provider-count' role='status'>找到 {visible.length} / {providers.length} 个配置{selected && !visible.includes(selected) ? ` · 已选择：${selected.name}` : ''}</p>}
    {normalized && visible.length === 0 && <p className='launcher-state'>没有匹配的配置，请尝试其他关键词</p>}
    <div className='ccswitch-provider-list' aria-label='CC Switch 配置列表'>
      {visible.map((provider) => <button
        type='button'
        key={provider.id}
        className={`ccswitch-provider-item${selectedId === provider.id ? ' active' : ''}${provider.issue ? ' invalid' : ''}`}
        disabled={disabled || Boolean(provider.issue)}
        aria-pressed={selectedId === provider.id}
        title={provider.issue ? `${provider.name}：${provider.issue}` : provider.name}
        onClick={() => onSelect(provider)}
      >
        <span className='ccswitch-provider-main'><strong>{provider.name}</strong>{provider.isCurrent && <em>当前</em>}<small>{providerHost(provider.baseUrl)}</small></span>
        <span className='ccswitch-provider-meta'><span>{provider.model || '继承模型'}</span><span>{provider.hasApiKey ? '已配置密钥' : '缺少密钥'}</span></span>
        {provider.issue && <small className='ccswitch-provider-issue'>{provider.issue}</small>}
      </button>)}
    </div>
    <div className='launcher-config-security'><strong>只读导入</strong><span>Manager 只读取所选 Provider 的快照并加密保存；不会修改 CCSwitch 或 Agent 的原始配置。</span></div>
  </div>
}
