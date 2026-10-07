import { useEffect, useRef, useState } from 'react'

export default function ProviderModelField({ baseUrl, apiKey, sessionId, clearApiKey, disabled, deepseek, value, onChange }: {
  baseUrl: string; apiKey: string; sessionId?: string; clearApiKey?: boolean
  disabled: boolean; deepseek: boolean; value: string; onChange: (value: string) => void
}): JSX.Element {
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    generation.current++; setModels([]); setError(''); setBusy(false)
    return () => { generation.current++ }
  }, [baseUrl, apiKey, sessionId, clearApiKey, disabled, deepseek])
  const fetchModels = async (): Promise<void> => {
    const current = ++generation.current
    setBusy(true); setError('')
    try {
      if (!window.agentManager.listProviderModels) throw new Error('请重启 Manager 后获取模型')
      const result = await window.agentManager.listProviderModels({ baseUrl, apiKey, sessionId, clearApiKey })
      if (current === generation.current) setModels(result)
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : '获取模型失败')
    } finally { if (current === generation.current) setBusy(false) }
  }
  return <div className='provider-model-field'>
    <label>模型<input className='launcher-field' disabled={disabled || deepseek} value={value} onChange={event => onChange(event.target.value)} placeholder={deepseek ? '请在 DeepSeek Harness Web 设置中配置' : '留空时继承本机默认模型'} /></label>
    {!deepseek && <>
      <button type='button' className='button-secondary' disabled={disabled || busy || !baseUrl.trim()} onClick={() => { void fetchModels() }}>{busy ? '获取中…' : '获取模型列表'}</button>
      {models.length > 0 && <label>选择模型<select className='launcher-field' disabled={disabled} value={models.includes(value) ? value : ''} onChange={event => { if (event.target.value) onChange(event.target.value) }}><option value=''>请选择模型（也可手动填写）</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>}
      {error && <p className='form-error' role='alert'>{error}</p>}
    </>}
  </div>
}
