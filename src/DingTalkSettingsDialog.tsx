import { type FormEvent, useEffect, useRef, useState } from 'react'

import type { DingTalkSettingsSummary } from './shared/manager-api'

function readableError(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
}

const DEFAULTS: DingTalkSettingsSummary = {
  enabled: false, hasClientSecret: false, commandsPerMinute: 20,
  agentModeEnabled: false, hasAgentApiKey: false, agentRetryCount: 3, agentProxyEnabled: false,
  agentProxyHost: '127.0.0.1', agentProxyPort: 7897, hasAgentProxyPassword: false,
  connectionStatus: 'disabled',
}

export default function DingTalkSettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<DingTalkSettingsSummary>(DEFAULTS)
  const [clientSecret, setClientSecret] = useState('')
  const [clearClientSecret, setClearClientSecret] = useState(false)
  const [agentApiKey, setAgentApiKey] = useState('')
  const [clearAgentApiKey, setClearAgentApiKey] = useState(false)
  const [proxyPassword, setProxyPassword] = useState('')
  const [clearProxyPassword, setClearProxyPassword] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [closeArmed, setCloseArmed] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    void window.agentManager.getDingTalkSettings().then(setSettings).catch((reason) => setError(readableError(reason))).finally(() => setBusy(false))
    const statusTimer = setInterval(() => {
      void window.agentManager.getDingTalkSettings().then((next) => {
        setSettings((current) => ({ ...current, connectionStatus: next.connectionStatus, connectionError: next.connectionError }))
      }).catch(() => undefined)
    }, 2_000)
    return () => {
      clearInterval(statusTimer)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  const armClose = (): void => {
    setCloseArmed(true); if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setCloseArmed(false), 500)
  }
  const resetBinding = async (): Promise<void> => {
    setBusy(true); setError('')
    try { setSettings(await window.agentManager.resetDingTalkBinding()) }
    catch (reason) { setError(readableError(reason)) }
    finally { setBusy(false) }
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const saved = await window.agentManager.updateDingTalkSettings({
        enabled: settings.enabled, clientId: settings.clientId,
        ...(clientSecret ? { clientSecret } : {}), ...(clearClientSecret ? { clearClientSecret: true } : {}),
        commandsPerMinute: settings.commandsPerMinute,
        agentModeEnabled: settings.agentModeEnabled, agentBaseUrl: settings.agentBaseUrl,
        ...(agentApiKey ? { agentApiKey } : {}), ...(clearAgentApiKey ? { clearAgentApiKey: true } : {}), agentModel: settings.agentModel, agentRetryCount: settings.agentRetryCount,
        agentProxyEnabled: settings.agentProxyEnabled, agentProxyHost: settings.agentProxyHost, agentProxyPort: settings.agentProxyPort,
        agentProxyUsername: settings.agentProxyUsername, ...(proxyPassword ? { agentProxyPassword: proxyPassword } : {}),
        ...(clearProxyPassword ? { clearAgentProxyPassword: true } : {}),
      })
      setSettings(saved); setClientSecret(''); setClearClientSecret(false); setAgentApiKey(''); setClearAgentApiKey(false); setProxyPassword(''); setClearProxyPassword(false)
      if (saved.connectionStatus === 'error') setError(saved.connectionError ?? '钉钉连接失败，请检查配置')
      else onClose()
    } catch (reason) { setError(readableError(reason)) }
    finally { setBusy(false) }
  }

  const statusLabel = settings.connectionStatus === 'connected' ? '已连接' : settings.connectionStatus === 'connecting' ? '连接中' : settings.connectionStatus === 'error' ? '连接错误' : '已关闭'
  const initCommand = settings.bindingKey ? `/init ${settings.bindingKey}` : ''
  return <div className='modal-backdrop' role='presentation' onMouseDown={(event) => { if (event.target === event.currentTarget) armClose() }} onDoubleClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <form className='rules-dialog dingtalk-settings-dialog' role='dialog' aria-modal='true' aria-labelledby='dingtalk-settings-title' onMouseDown={() => setCloseArmed(false)} onSubmit={(event) => { void save(event) }}>
      <header><div><span className='eyebrow'>REMOTE DEVELOPMENT</span><h2 id='dingtalk-settings-title'>钉钉远程开发</h2></div><span className={`dingtalk-status status-${settings.connectionStatus ?? 'disabled'}`}><i />{statusLabel}</span></header>
      <p className='rules-help'>首次使用通过一次性 Key 绑定一个钉钉账号。绑定后只有该账号可操作；固定命令和 Agent 模式都继续遵守审批与高危操作安全策略。</p>
      <label className='launcher-config-toggle'><span><strong>启用钉钉 Stream</strong><small>使用钉钉官方长连接，不需要暴露公网回调端口。</small></span><input type='checkbox' role='switch' aria-label='启用钉钉远程开发' checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /></label>
      <div className={'dingtalk-settings-fields' + (settings.enabled ? '' : ' disabled')}>
        <label>Client ID<input className='launcher-field' disabled={!settings.enabled} value={settings.clientId ?? ''} onChange={(event) => setSettings((current) => ({ ...current, clientId: event.target.value }))} /></label>
        <label>Client Secret<input className='launcher-field' disabled={!settings.enabled || clearClientSecret} type='password' autoComplete='off' value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder={settings.hasClientSecret ? '已安全保存，留空保持不变' : '请输入 Client Secret'} /></label>
        {settings.hasClientSecret && <label className='dingtalk-clear-secret'><input type='checkbox' checked={clearClientSecret} onChange={(event) => setClearClientSecret(event.target.checked)} />清除已保存的 Client Secret</label>}
        <section className='dingtalk-binding-card'><div><strong>账号绑定</strong><span>{settings.boundStaffId ? `已绑定 ${settings.boundSenderName || settings.boundStaffId}` : '等待首次绑定'}</span></div>{settings.boundStaffId ? <button type='button' className='button-secondary button-compact' disabled={busy} onClick={() => { void resetBinding() }}>解除并生成新 Key</button> : <div className='dingtalk-init-command'><code>{initCommand}</code><button type='button' className='button-secondary button-compact' onClick={() => { void window.agentManager.writeClipboardText(initCommand) }}>复制</button></div>}<small>{settings.boundStaffId ? `Staff ID：${settings.boundStaffId}` : '请在钉钉中向机器人发送以上完整命令；绑定成功后 Key 立即失效。'}</small></section>
        <label>每分钟操作上限<input className='launcher-field' disabled={!settings.enabled} type='number' min={1} max={120} value={settings.commandsPerMinute} onChange={(event) => setSettings((current) => ({ ...current, commandsPerMinute: Number(event.target.value) }))} /></label>
        <section className='dingtalk-agent-mode'><label className='launcher-config-toggle'><span><strong>自然语言 Agent 模式</strong><small>把自然语言转换为受控的 Manager 操作；不会执行任意命令。</small></span><input type='checkbox' role='switch' aria-label='启用钉钉 Agent 模式' disabled={!settings.enabled} checked={settings.agentModeEnabled} onChange={(event) => setSettings((current) => ({ ...current, agentModeEnabled: event.target.checked }))} /></label><div className={settings.agentModeEnabled ? '' : 'disabled'}>
          <label>Base URL<input className='launcher-field' disabled={!settings.agentModeEnabled} value={settings.agentBaseUrl ?? ''} onChange={(event) => setSettings((current) => ({ ...current, agentBaseUrl: event.target.value }))} placeholder='https://api.example.com/v1' /></label>
          <label>API Key<input className='launcher-field' disabled={!settings.agentModeEnabled || clearAgentApiKey} type='password' autoComplete='off' value={agentApiKey} onChange={(event) => setAgentApiKey(event.target.value)} placeholder={settings.hasAgentApiKey ? '已安全保存，留空保持不变' : '请输入 API Key'} /></label>
          {settings.hasAgentApiKey && <label className='dingtalk-clear-secret'><input type='checkbox' checked={clearAgentApiKey} onChange={(event) => setClearAgentApiKey(event.target.checked)} />清除已保存的 Agent API Key</label>}
          <label>Model<input className='launcher-field' disabled={!settings.agentModeEnabled} value={settings.agentModel ?? ''} onChange={(event) => setSettings((current) => ({ ...current, agentModel: event.target.value }))} /></label>
          <label>失败重试次数<input className='launcher-field' disabled={!settings.agentModeEnabled} type='number' min={0} max={10} value={settings.agentRetryCount} onChange={(event) => setSettings((current) => ({ ...current, agentRetryCount: Number(event.target.value) }))} /><small>默认重试 3 次；只重试网络错误、超时、限流和服务端错误。</small></label>
          <label className='launcher-config-toggle'><span><strong>使用 HTTP 代理</strong><small>只用于 Agent 模型请求。</small></span><input type='checkbox' role='switch' aria-label='钉钉 Agent 使用 HTTP 代理' disabled={!settings.agentModeEnabled} checked={settings.agentProxyEnabled} onChange={(event) => setSettings((current) => ({ ...current, agentProxyEnabled: event.target.checked }))} /></label>
          <div className={'dingtalk-agent-proxy' + (settings.agentProxyEnabled ? '' : ' disabled')}><label>主机<input className='launcher-field' disabled={!settings.agentProxyEnabled} value={settings.agentProxyHost} onChange={(event) => setSettings((current) => ({ ...current, agentProxyHost: event.target.value }))} /></label><label>端口<input className='launcher-field' disabled={!settings.agentProxyEnabled} type='number' min={1} max={65535} value={settings.agentProxyPort} onChange={(event) => setSettings((current) => ({ ...current, agentProxyPort: Number(event.target.value) }))} /></label><label>用户名（可选）<input className='launcher-field' disabled={!settings.agentProxyEnabled} value={settings.agentProxyUsername ?? ''} onChange={(event) => setSettings((current) => ({ ...current, agentProxyUsername: event.target.value }))} /></label><label>密码（可选）<input className='launcher-field' disabled={!settings.agentProxyEnabled || clearProxyPassword} type='password' value={proxyPassword} onChange={(event) => setProxyPassword(event.target.value)} placeholder={settings.hasAgentProxyPassword ? '已安全保存' : ''} /></label></div>
          {settings.hasAgentProxyPassword && <label className='dingtalk-clear-secret'><input type='checkbox' checked={clearProxyPassword} onChange={(event) => setClearProxyPassword(event.target.checked)} />清除已保存的代理密码</label>}
        </div></section>
      </div>
      <div className='launcher-config-security'><strong>可执行范围</strong><span>/agents、/pending、/approve、/approve-all-force、/status、/tail、/workspace、/send、/send-status、/stop、/restart、/auto、/audit；自然语言最终也只会转换为这些操作。/approve-all-force 会忽略风险限制，请谨慎使用。</span></div>
      <div className='launcher-config-security'><strong>凭据保护</strong><span>Client Secret、Agent API Key 和代理密码使用系统安全存储加密，不返回页面、不写审计。</span></div>
      {error && <p className='form-error'>{error}</p>}{closeArmed && <p className='launcher-dismiss-hint rules-dismiss-hint'>再点击一次空白处关闭</p>}
      <footer><button type='button' className='button-secondary' onClick={onClose}>取消</button><button type='submit' className='button-primary' disabled={busy}>{busy ? '请稍后…' : '保存并连接'}</button></footer>
    </form>
  </div>
}
