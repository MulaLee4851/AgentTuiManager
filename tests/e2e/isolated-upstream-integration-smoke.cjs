// Real renderer/preload/model IPC; synthetic lifecycle handlers and local HTTP only.
const { app, ipcMain } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const http = require('node:http')
const root = mkdtempSync(join(tmpdir(), 'agent-tui-upstream-smoke-'))
process.env.AGENT_TUI_USER_DATA_DIR = root
app.disableHardwareAcceleration()
const out = resolve('.tmp/upstream-verification')
mkdirSync(out, { recursive: true })
const sessions = ['stable', 'recovery', 'history', 'fresh'].map((name, i) => ({
  sessionId: name, displayName: 'Fixture ' + name, agentKind: 'codex', workspace: join(root, 'project'),
  nativeSessionId: '00000000-0000-0000-0000-00000000000' + i,
  status: i === 0 ? 'running' : i === 1 ? 'failed' : 'stopped', activity: i === 0 ? 'running' : 'idle',
  approvalMode: 'agent-review', userStopRequested: false, recoveryAttempts: 0,
  startupRecoveryRequired: i === 1, startupFailureCount: i === 1 ? 3 : 0,
  lastError: i === 1 ? 'Synthetic resume failure' : undefined,
}))
let replays = 0, retries = 0, modelRequests = 0
const bindings = []
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, callback) => handle(channel, ({
  'agent-manager:list-sessions': () => sessions,
  'agent-manager:list-pending-approvals': () => [],
  'agent-manager:terminal-replay': () => { replays++; return { data: 'Synthetic merge verification\r\n', sequence: 0 } },
  'agent-manager:resize': () => undefined, 'agent-manager:write': () => undefined,
  'agent-manager:discover-sessions': () => [], 'agent-manager:discover-recent-codex-sessions': () => [],
  'agent-manager:list-ccswitch-providers': () => [],
  'agent-manager:detect-agent-environment': () => ({ agentKind: 'codex', executable: 'codex', nodeAvailable: true, npmAvailable: true, agentInstalled: true }),
  'agent-manager:list-binding-sessions': () => [{ id: 'replacement-fixture', title: 'Fixture replacement history', workspace: sessions[0].workspace, updatedAt: 1 }],
  'agent-manager:restart-session': (_event, id) => {
    if (id !== 'recovery') throw Error('Unexpected restart target')
    retries++; Object.assign(sessions[1], { status: 'running', startupRecoveryRequired: false, lastError: undefined })
  },
  'agent-manager:replace-session-binding': (_event, id, target) => {
    bindings.push({ id, target })
    const session = sessions.find(item => item.sessionId === id)
    if (!session) throw Error('Unexpected binding target')
    Object.assign(session, { status: 'running', nativeSessionId: target ?? undefined, approvalMode: 'manual' })
  },
})[channel] ?? callback)
const server = http.createServer((req, res) => {
  modelRequests++
  const valid = req.method === 'GET' && req.url === '/v1/models' && !req.headers.authorization
  res.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' })
  res.end(JSON.stringify(valid ? { data: [{ id: 'fixture-z' }, { id: 'fixture-a' }] } : {}))
})
const timer = setTimeout(() => { console.error('Upstream smoke timed out'); app.exit(1) }, 60000)
app.on('browser-window-created', (_event, win) => {
  win.hide(); win.on('show', () => win.hide()); win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    try {
      const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1'
      const result = await win.webContents.executeJavaScript(`(async()=>{
        const wait=(ms=30)=>new Promise(r=>setTimeout(r,ms));
        const until=async test=>{for(let i=0;i<200;i++){if(test())return;await wait()}throw Error('UI state timed out')};
        const visible=el=>el && !el.closest('[inert]') && getComputedStyle(el).visibility!=='hidden';
        const button=(name,scope=document)=>[...scope.querySelectorAll('button')].find(el=>visible(el)&&(el.getAttribute('aria-label')===name||el.textContent.trim()===name));
        const click=(name,scope)=>{const el=button(name,scope);if(!el||el.disabled)throw Error('Missing enabled button '+name);el.click()};
        const dialog=heading=>document.querySelector('[role="dialog"][aria-labelledby="'+heading+'"]');
        const tile=id=>document.querySelector('[data-testid="terminal-tile-'+id+'"]');
        const field=name=>[...document.querySelectorAll('label')].find(el=>el.firstChild?.textContent===name)?.querySelector('input,select');
        await until(()=>dialog('recovery-choice-heading')&&tile('stable')?.querySelector('.xterm'));
        const stable=tile('stable').querySelector('.xterm');
        click('继续重试',dialog('recovery-choice-heading'));
        await until(()=>tile('recovery')?.querySelector('.xterm')&&!dialog('recovery-choice-heading'));await wait(130);
        click('切换历史会话',tile('history'));await until(()=>button('关联并启动'));
        await until(()=>document.querySelector('.launcher-session-item'));
        document.querySelector('.launcher-session-item').click();await wait();
        click('关联并启动');await until(()=>tile('history')?.querySelector('.xterm'));await wait(130);
        click('切换历史会话',tile('fresh'));await until(()=>dialog('binding-heading'));
        click('按原配置开启新会话',dialog('binding-heading'));await until(()=>button('确认开启新会话'));
        if(tile('fresh').querySelector('.xterm'))throw Error('Fresh session started before explicit confirmation');
        if(!dialog('binding-heading').textContent.includes('更换会话后先使用普通审批模式'))throw Error('Missing approval-mode reset explanation');
        click('确认开启新会话');await until(()=>tile('fresh')?.querySelector('.xterm'));await wait(130);
        click('＋ 新建 Agent');await until(()=>button('独立配置'));
        click('独立配置');await wait();document.querySelector('[role="switch"][aria-label="启用独立配置"]').click();await wait();
        const input=field('服务地址（Base URL）');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(baseUrl)});input.dispatchEvent(new Event('input',{bubbles:true}));await wait();
        click('获取模型列表');await until(()=>field('选择模型'));
        const select=field('选择模型');
        if([...select.options].slice(1).map(o=>o.value).join(',')!=='fixture-a,fixture-z')throw Error('Models missing or unsorted');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'fixture-a');select.dispatchEvent(new Event('change',{bubbles:true}));await wait();
        if(field('模型').value!=='fixture-a')throw Error('Model selection was not applied');
        if(!stable.isConnected||tile('stable').querySelector('.xterm')!==stable)throw Error('Unrelated terminal recreated');
        if(document.querySelector('[data-panel="navigation"]'))throw Error('Upstream sidebar replaced local navigation');
        return {ok:true,recoveryRetry:true,historyReplacement:true,explicitFreshConfirmation:true,realModelIPC:true,unaffectedTerminalPreserved:true};
      })().catch(error=>({smokeError:error.message}))`)
      if (result.smokeError) throw Error(result.smokeError)
      if (retries !== 1 || modelRequests !== 1 || replays !== 4) throw Error('Unexpected request/replay counts')
      if (JSON.stringify(bindings) !== JSON.stringify([{ id: 'history', target: 'replacement-fixture' }, { id: 'fresh', target: null }])) throw Error('Incorrect native binding arguments')
      writeFileSync(join(out, 'verification.json'), JSON.stringify({ ...result, retries, replays, modelRequests, bindings }, null, 2))
      console.log(JSON.stringify(result));clearTimeout(timer);server.close();app.exit(0)
    } catch(error) { console.error(error.message);clearTimeout(timer);server.close();app.exit(1) }
  })
})
server.listen(0, '127.0.0.1', () => require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js')))
