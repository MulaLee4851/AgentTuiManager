// Runs real bundled main/preload/renderer with synthetic sessions and loopback-only model APIs.
const { app, ipcMain } = require('electron')
app.disableHardwareAcceleration()
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')
const http = require('node:http')
const root = mkdtempSync(join(tmpdir(), 'agent-tui-upgrade-smoke-'))
process.env.AGENT_TUI_USER_DATA_DIR = root
const screenshots = resolve('.tmp/upgrade-screenshots')
mkdirSync(screenshots, { recursive: true })
let launches = 0
const requests = []
const session = { sessionId: 'fixture-agent', displayName: '趋势分析 · 测试会话', agentKind: 'codex', workspace: root, status: 'running', activity: 'running', recoveryAttempts: 0, userStopRequested: false }
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => {
  const fake = {
    'agent-manager:list-sessions': () => [session, { ...session, sessionId: 'fixture-shell', displayName: 'Shell · 测试终端', agentKind: 'generic' }],
    'agent-manager:list-pending-approvals': () => [],
    'agent-manager:terminal-replay': () => ({ data: 'Isolated UI verification\r\n', sequence: 0 }),
    'agent-manager:resize': () => undefined,
    'agent-manager:write': () => undefined,
    'agent-manager:choose-workspace': () => root,
    'agent-manager:discover-sessions': () => [],
    'agent-manager:discover-recent-codex-sessions': () => Array.from({ length: 50 }, (_, index) => ({ id: `history-${index}`, title: `跨工作区历史 ${index}`, workspace: join(root, `project-${index}`), updatedAt: Date.now() - index * 1000 })),
    'agent-manager:detect-agent-environment': () => ({ agentKind: 'codex', executable: 'codex', nodeAvailable: true, npmAvailable: true, agentInstalled: true }),
    'agent-manager:list-ccswitch-providers': (_event, kind) => Array.from({ length: 26 }, (_, index) => ({ id: `fixture-${index}`, name: `Gateway ${index}`, agentKind: kind, baseUrl: 'https://gateway.example/v1', isCurrent: index === 0, hasApiKey: true })),
    'agent-manager:start-session': (_event, request) => { launches++; if (request.nativeSessionId !== 'history-49' || !request.workspace.endsWith('project-49')) throw Error('History did not preserve native workspace'); return { ...session, ...request } },
  }
  return originalHandle(channel, fake[channel] ?? handler)
}
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    const protocol = req.url.includes('/anthropic/') ? 'anthropic' : req.url.includes('/responses/') ? 'responses' : 'chat'
    const authorized = protocol === 'anthropic' ? req.headers['x-api-key'] === 'fixture-key-anthropic' : req.headers.authorization === `Bearer fixture-key-${protocol}`
    requests.push({ endpoint: req.url, method: req.method, authorized })
    res.setHeader('content-type', 'application/json')
    if (!authorized) { res.writeHead(401); res.end('{}'); return }
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: `fixture-${protocol}-model` }] })); return }
    const text = JSON.stringify({ ok: true })
    res.end(JSON.stringify(protocol === 'anthropic' ? { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }] }
      : protocol === 'responses' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }
      : { choices: [{ finish_reason: 'stop', message: { content: text } }] }))
  })
})
let port
server.listen(0, '127.0.0.1', () => { port = server.address().port })
const timer = setTimeout(() => { console.error('Upgrade smoke timed out'); app.exit(1) }, 60000)
async function captureVerifiedDom(window, name) {
  // Windows may not allocate a capture surface for a hidden normal window.
  // Render its verified DOM in a separate offscreen surface without app scripts.
  const html = await window.webContents.executeJavaScript(`(() => {
    const clone=document.documentElement.cloneNode(true);
    const sourceInputs=document.querySelectorAll('input');clone.querySelectorAll('input').forEach((input,index)=>{const source=sourceInputs[index];if(source.type==='checkbox'||source.type==='radio'){if(source.checked)input.setAttribute('checked','');else input.removeAttribute('checked')}else input.setAttribute('value',source.type==='password'?'':source.value)});
    const sourceOptions=document.querySelectorAll('option');clone.querySelectorAll('option').forEach((option,index)=>{if(sourceOptions[index].selected)option.setAttribute('selected','');else option.removeAttribute('selected')});
    return clone.outerHTML;
  })()`)
  const css = await window.webContents.executeJavaScript(`Array.from(document.styleSheets).map(sheet=>Array.from(sheet.cssRules).map(rule=>rule.cssText).join(String.fromCharCode(10))).join(String.fromCharCode(10))`)
  const snapshot = join(screenshots, name + '.html')
  const assetBase = window.webContents.getURL().includes('app.asar') ? pathToFileURL(resolve('dist-electron/renderer/index.html')).href : window.webContents.getURL()
  const originalRoot = new URL('.', window.webContents.getURL()).href
  const snapshotHtml = html.replaceAll(originalRoot, new URL('.', assetBase).href)
  writeFileSync(snapshot, snapshotHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '').replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, '').replace('<head>', `<head><base href="${assetBase}"><style>${css}</style>`))
  // Capture these local snapshots with an isolated headless Chromium profile.
}
app.on('browser-window-created', (_event, win) => {
  if (win.webContents.getLastWebPreferences().offscreen) return
  win.hide(); win.on('show', () => win.hide())
  win.webContents.once('did-finish-load', async () => {
    try {
      while (!port) await new Promise(resolve => setTimeout(resolve, 20))
      const result = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms=180) => new Promise(resolve => setTimeout(resolve, ms));
        const click = text => { const element = [...document.querySelectorAll('button')].find(item => {const clone=item.cloneNode(true);clone.querySelectorAll('[aria-hidden="true"]').forEach(node=>node.remove());return clone.textContent.trim() === text || item.getAttribute('aria-label') === text}); if (!element || element.disabled) throw Error('Missing enabled button: '+text); element.click(); };
        const input = (element, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); };
        await wait(350);
        const nav=document.querySelector('[aria-label="主导航"]');
        const main=document.querySelector('.workspace-main');
        const initialLeft=main.getBoundingClientRect().left;
        if(!nav||document.querySelector('[data-panel="navigation"]'))throw Error('Top navigation missing or old sidebar remains');
        if(document.querySelector('[aria-label="切换工作区"]'))throw Error('Inactive workspace scope is visible');
        const terminal=document.querySelector('.xterm');
        click('统计');await wait();
        if(!document.querySelector('[role="menu"][aria-label="统计"]'))throw Error('Statistics menu failed to open');
        if(main.getBoundingClientRect().left!==initialLeft||document.querySelector('.xterm')!==terminal)throw Error('Menu moved/remounted terminal');
        click('统计');await wait();
        if(document.querySelector('[role="menu"][aria-label="统计"]'))throw Error('Statistics menu failed to close');
        click('＋ 新建 Agent');await wait();click('管理列表');await wait();
        input([...document.querySelectorAll('.favorite-workspace-manager label')].find(item=>item.textContent.startsWith('工作区名称')).querySelector('input'),'常用分析项目');
        input([...document.querySelectorAll('.favorite-workspace-manager label')].find(item=>item.textContent.startsWith('工作区路径')).querySelector('input'),${JSON.stringify(root)});
        await wait();click('添加工作区');await wait();click('常用分析项目');await wait();
        if(document.querySelector('#workspace').value!==${JSON.stringify(root)})throw Error('Favorite did not fill workspace');
        click('收起管理');click('独立配置');await wait();document.querySelector('[aria-label="启用独立配置"]').click();await wait();
        [...document.querySelectorAll('.launcher-config-sources button')].find(item=>item.textContent.includes('CCSwitch')).click();await wait();
        input(document.querySelector('[aria-label="搜索 CC Switch 配置"]'),'Gateway 25');await wait();
        const visibleProviders=document.querySelectorAll('.ccswitch-provider-list button');
        if(visibleProviders.length!==1)throw Error('Provider search failed');visibleProviders[0].click();await wait();
        document.querySelector('[aria-label="启用独立配置"]').click();click('恢复历史');await wait();
        if(document.querySelectorAll('.launcher-session-item').length!==50)throw Error('History does not show 50 global sessions');
        input(document.querySelector('[aria-label="搜索历史会话"]'),'project-49');await wait();
        if(document.querySelectorAll('.launcher-session-item').length!==1)throw Error('Workspace history search failed');document.querySelector('.launcher-session-item').click();await wait();click('恢复会话');await wait();
        click('返回总览');await wait();
        const api=window.agentManager;const before=await api.getLlmReviewSettings();
        const reviewers=['chat','responses','anthropic'].map((kind,index)=>({id:'review-'+index,name:['主审核器','备用 Responses','备用 Claude'][index],enabled:true,backend:'api',protocol:['openai-chat','openai-responses','anthropic-messages'][index],baseUrl:'http://127.0.0.1:${port}/'+kind+'/v1',apiKey:'fixture-key-'+kind,model:'fixture-'+kind+'-model'}));
        let saved=await api.updateLlmReviewSettings({...before,enabled:true,reviewers});
        if(JSON.stringify(saved).includes('fixture-key-'))throw Error('Credential leaked in settings summary');
        for(const reviewer of saved.reviewers){const models=await api.listLlmReviewModels(saved,reviewer.id);if(models.length!==1)throw Error('Model catalog failed');const tested=await api.testLlmReviewer(saved,reviewer.id);if(tested.model!==reviewer.model)throw Error('Selected connection target mismatch');}
        click('设置');await wait();click('审核器设置');await wait();
        if(document.querySelectorAll('.reviewer-pool-select').length!==3)throw Error('Reviewer pool UI missing entries');
        return {topNavigation:true,terminalStable:true,scopeHidden:true,navigationGroups:true,favorites:true,providerSearch:true,globalHistory:50,historyDirectResume:true,protocols:3,modelCatalogs:3,connectionChecks:3,secretSummarySafe:true};
      })()`)
      await new Promise(resolve => setTimeout(resolve, 200))
      await captureVerifiedDom(win, 'reviewer-pool')
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.llm-review-dialog footer button')].find(button=>button.textContent==='取消')?.click()`)
      await win.webContents.executeJavaScript(`document.activeElement?.blur()`)
      await new Promise(resolve => setTimeout(resolve, 350))
      await captureVerifiedDom(win, 'overview')
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='☰ 列表').click()`)
      await new Promise(resolve => setTimeout(resolve, 180))
      await win.webContents.executeJavaScript(`(()=>{const logo=document.querySelector('.agent-session-list .agent-generic');if(!logo||getComputedStyle(logo).display==='none')throw Error('Generic Agent icon missing from compact rail')})()`)
      await win.webContents.executeJavaScript(`(async()=>{const panel=document.querySelector('[data-panel="agents"]'),grid=document.querySelector('.terminal-grid'),before=grid.getBoundingClientRect().left;panel.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));await new Promise(r=>setTimeout(r,180));if(!panel.classList.contains('panel-expanded')||grid.getBoundingClientRect().left!==before)throw Error('Agent list hover changed terminal layout');panel.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));await new Promise(r=>setTimeout(r,300))})()`)
      await captureVerifiedDom(win, 'agent-list')
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='＋ 新建 Agent').click()`)
      await new Promise(resolve => setTimeout(resolve, 180))
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='管理列表').click()`)
      await new Promise(resolve => setTimeout(resolve, 180))
      await captureVerifiedDom(win, 'favorite-workspaces')
      if (launches !== 1 || requests.length !== 6 || requests.some(item => !item.authorized)) throw Error('Unexpected launch or loopback protocol traffic')
      console.log(JSON.stringify({ ok: true, ...result, launches, loopbackRequests: requests.length, screenshots }))
      clearTimeout(timer); server.close(); app.exit(0)
    } catch (error) { console.error(error.message); clearTimeout(timer); server.close(); app.exit(1) }
  })
})
require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js'))
