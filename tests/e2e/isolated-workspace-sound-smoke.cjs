// Actual main/preload/renderer with synthetic catalog entries. Never starts a CLI.
const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const root = mkdtempSync(join(tmpdir(), 'agent-tui-workspace-sound-smoke-'))
process.env.AGENT_TUI_USER_DATA_DIR = root
app.disableHardwareAcceleration()
const workspace = join(root, '项目 workspace & echo $(fixture);')
mkdirSync(workspace)
const file = join(root, 'fixture.exe')
writeFileSync(file, 'not executable')
const nativeId = '01a10a4a-391a-7190-abb6-7ade66501660'
const sessions = [workspace, file, join(root, 'missing')].map((path, index) => ({
  sessionId: 'fixture-' + index, displayName: index ? 'Fixture ' + index : '工作区快捷访问',
  // Generic, stopped catalog entries cannot trigger Codex config restoration.
  agentKind: 'generic', workspace: path, nativeSessionId: nativeId, status: 'stopped',
  userStopRequested: true, recoveryAttempts: 0,
}))
writeFileSync(join(root, 'managed-sessions.json'), JSON.stringify({ version: 1, lastWorkspaceSessionIds: [], sessions: sessions.map(summary => ({
  sessionId: summary.sessionId, hostId: summary.sessionId, summary, updatedAt: new Date().toISOString(),
})) }))
const opened = []
shell.openPath = async path => { opened.push(path); return '' }
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => {
  if (channel === 'agent-manager:list-sessions') {
    const original = handler
    // Display a running layout without a real PTY; workspace IPC uses the real catalog.
    handler = async (...args) => (await original(...args)).map(session => ({ ...session, agentKind: 'codex', status: 'running', activity: 'running' }))
  }
  if (channel === 'agent-manager:terminal-replay') handler = () => ({ data: 'Synthetic workspace preview\r\n', sequence: 0 })
  if (channel === 'agent-manager:resize' || channel === 'agent-manager:write') handler = () => undefined
  return originalHandle(channel, handler)
}
const output = resolve('.tmp/workspace-sound-verification')
mkdirSync(output, { recursive: true })
const timer = setTimeout(() => { console.error('Workspace/sound smoke timed out'); app.exit(1) }, 60000)
let captureWindow = false
async function capture(window, name) {
  const snapshot = await window.webContents.executeJavaScript(`(() => {
    const clone=document.documentElement.cloneNode(true);
    clone.querySelectorAll('script,link[rel="stylesheet"],meta[http-equiv]').forEach(el=>el.remove());
    clone.querySelectorAll('input').forEach((el,index)=>el.setAttribute('value',document.querySelectorAll('input')[index].value));
    clone.querySelectorAll('option').forEach((el,index)=>{if(document.querySelectorAll('option')[index].selected)el.setAttribute('selected','');else el.removeAttribute('selected')});
    const css=Array.from(document.styleSheets).map(s=>Array.from(s.cssRules).map(r=>r.cssText).join('\\n')).join('\\n');
    return {html:clone.outerHTML,css,width:innerWidth,height:innerHeight};
  })()`)
  const html = join(output, name + '.html')
  const { pathToFileURL } = require('node:url')
  const assetBase = pathToFileURL(resolve('dist-electron/renderer/index.html')).href
  writeFileSync(html, snapshot.html.replace('<head>', `<head><base href="${assetBase}"><style>${snapshot.css}</style>`))
  captureWindow = true
  const surface = new BrowserWindow({ show: false, width: snapshot.width, height: snapshot.height, webPreferences: { offscreen: true, sandbox: true } })
  captureWindow = false
  await surface.loadFile(html)
  await new Promise(resolve => setTimeout(resolve, 250))
  const png = await surface.webContents.capturePage()
  if (png.isEmpty()) throw Error('Empty verification screenshot')
  writeFileSync(join(output, name + '.png'), png.toPNG())
  surface.destroy()
}
app.on('browser-window-created', (_event, win) => {
  if (captureWindow) return
  win.hide(); win.on('show', () => win.hide())
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await wait(30)}throw Error('UI condition timed out')};
        await until(()=>document.querySelector('.workspace-path-link'));
        const tile=document.querySelector('[data-testid="terminal-tile-fixture-0"]');
        tile.querySelector('.workspace-path-link').click(); await wait(80);
        tile.querySelector('.workspace-folder-button').click(); await wait(80);
        if(tile.classList.contains('terminal-card-detail'))throw Error('Workspace click navigated to detail');
        const api=window.agentManager;
        for(const id of ['fixture-1','fixture-2','missing-agent']) {
          if(!await api.openSessionWorkspace(id).then(()=>false,()=>true))throw Error('Invalid workspace opened: '+id);
        }
        if(!await api.openSessionWorkspace({path:'invalid'}).then(()=>false,()=>true))throw Error('Arbitrary path object accepted');
        await api.getAttentionSoundSettings().then(s=>{if(s.sound!=='classic'||s.volume!==100)throw Error('Default sound changed')});
        window.smokeWait=wait;
        return {workspaceIpc:true,invalidFoldersRejected:true,defaultsPreserved:true};
      })()`)
      if (opened.length !== 2 || opened.some(path => path !== workspace)) throw Error('Incorrect workspace IPC target')
      const layouts = []
      for (const width of [1280, 900]) {
        // Hidden native windows may defer renderer resizes; emulate the actual viewport.
        win.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height: 850 }, viewPosition: { x: 0, y: 0 }, viewSize: { width, height: 850 }, deviceScaleFactor: 1, scale: 1 })
        await new Promise(resolve => setTimeout(resolve, 350))
        layouts.push(await win.webContents.executeJavaScript(`(() => {
          const tile=document.querySelector('[data-testid="terminal-tile-fixture-0"]');
          if(innerWidth!==${width})throw Error('Viewport resize was not applied');
          const id=tile.querySelector('.native-session-id'), header=tile.querySelector('header');
          const rect=id.getBoundingClientRect(), parent=header.getBoundingClientRect();
          if(id.textContent.trim()!=='ID: ${nativeId}' || id.scrollWidth>id.clientWidth+1 || id.scrollHeight>id.clientHeight+1)throw Error('ID is clipped');
          if(rect.bottom>parent.bottom || rect.right>parent.right)throw Error('ID overflows header');
          if(header.scrollWidth>header.clientWidth+1)throw Error('Header overflows');
          return {width:innerWidth,headerHeight:parent.height,idWidth:rect.width,idHeight:rect.height};
        })()`))
        await capture(win, 'workspace-' + width)
      }
      await win.webContents.executeJavaScript(`(async()=>{
        const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().endsWith('提示音设置'));
        if(!btn)throw Error('Sound settings missing');btn.click();await window.smokeWait(200);
      })()`)
      await capture(win, 'sound-settings')
      const sound = await win.webContents.executeJavaScript(`(async()=>{
        const api=window.agentManager;
        const saved=await api.updateAttentionSoundSettings({sound:'bell',volume:35});
        const loaded=await api.getAttentionSoundSettings();
        if(saved.sound!=='bell'||loaded.sound!=='bell'||loaded.volume!==35)throw Error('Settings did not roundtrip');
        for(const value of [{sound:'invalid',volume:50},{sound:'classic',volume:-1},{sound:'classic',volume:101}]){
          if(!await api.updateAttentionSoundSettings(value).then(()=>false,()=>true))throw Error('Invalid settings accepted');
        }
        return {saved:loaded,validated:true};
      })()`)
      const report = { ok: true, isolated: true, ...result, openedCount: opened.length, layouts, sound }
      writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify(report)); clearTimeout(timer); app.exit(0)
    } catch (error) { console.error(error); clearTimeout(timer); app.exit(1) }
  })
})
require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js'))
