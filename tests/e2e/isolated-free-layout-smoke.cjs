// Actual built main/preload/renderer. Only synthetic sessions; no live CLI or credentials.
const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')
const root = mkdtempSync(join(tmpdir(), 'agent-tui-free-layout-smoke-'))
process.env.AGENT_TUI_USER_DATA_DIR = root
app.disableHardwareAcceleration()
const out = resolve('.tmp/free-layout-verification')
mkdirSync(out, { recursive: true })
let replayRequests = 0
const activeRequests = []
const sessions = Array.from({ length: 3 }, (_, i) => ({ sessionId: 'layout-' + i, displayName: 'Agent ' + (i + 1), agentKind: 'codex', workspace: root, nativeSessionId: '00000000-0000-0000-0000-00000000000' + i, status: 'running', activity: 'running', userStopRequested: false, recoveryAttempts: 0 }))
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, callback) => handle(channel, ({
  'agent-manager:list-sessions': () => sessions,
  'agent-manager:list-pending-approvals': () => [],
  'agent-manager:terminal-replay': () => { replayRequests++; return { data: 'Synthetic terminal content\r\n', sequence: 0 } },
  'agent-manager:resize': () => undefined,
  'agent-manager:write': () => undefined,
  'agent-manager:set-active-session': (_event, id) => { activeRequests.push(id) },
})[channel] ?? callback)
const timeout = setTimeout(() => { console.error('Free layout smoke timed out'); app.exit(1) }, 60000)
let captureWindow = false
async function capture(window, name) {
  const snapshot = await window.webContents.executeJavaScript(`(() => {
    const clone=document.documentElement.cloneNode(true);
    clone.querySelectorAll('script,link[rel="stylesheet"],meta[http-equiv]').forEach(el=>el.remove());
    clone.querySelectorAll('option').forEach((el,i)=>{if(document.querySelectorAll('option')[i].selected)el.setAttribute('selected','');else el.removeAttribute('selected')});
    return {html:clone.outerHTML,css:[...document.styleSheets].map(s=>[...s.cssRules].map(r=>r.cssText).join('\\n')).join('\\n'),width:innerWidth,height:innerHeight};
  })()`)
  const html = join(out, name + '.html')
  writeFileSync(html, snapshot.html.replace('<head>', `<head><base href="${pathToFileURL(resolve('dist-electron/renderer/index.html')).href}"><style>${snapshot.css}</style>`))
  captureWindow = true
  const surface = new BrowserWindow({ show: false, width: snapshot.width, height: snapshot.height, webPreferences: { offscreen: true, sandbox: true } })
  captureWindow = false
  await surface.loadFile(html)
  await new Promise(resolve => setTimeout(resolve, 200))
  const image = await surface.webContents.capturePage()
  if (image.isEmpty()) throw Error('Empty layout screenshot')
  writeFileSync(join(out, name + '.png'), image.toPNG())
  surface.destroy()
}
app.on('browser-window-created', (_event, win) => {
  if (captureWindow) return
  win.hide(); win.on('show', () => win.hide())
  win.webContents.once('did-finish-load', async () => {
    try {
      win.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 1280, height: 900 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 1280, height: 900 }, deviceScaleFactor: 1, scale: 1 })
      await win.webContents.executeJavaScript(`(async()=>{
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await wait(30)}throw Error('Layout UI condition timed out')};
        await until(()=>document.querySelectorAll('.xterm').length===3);
        const nodes=[...document.querySelectorAll('.xterm')];
        const tile=id=>document.querySelector('[data-testid="terminal-tile-layout-'+id+'"]');
        const rect=id=>{const s=tile(id).style;return {x:parseFloat(s.left),y:parseFloat(s.top),width:parseFloat(s.width),height:parseFloat(s.height),z:parseInt(s.zIndex)}};
        const select=value=>{const el=document.querySelector('[aria-label="总览排列方式"]');el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}))};
        select('free');await until(()=>tile(0).classList.contains('terminal-card-floating'));await wait(300);
        window.probe={wait,until,tile,rect,select,nodes,before:rect(0)};
        tile(1).querySelector('.xterm-helper-textarea').focus();
        if(tile(0).querySelectorAll('[data-resize-edge]').length!==8)throw Error('Eight resize handles missing');
      })()`)
      // Real Chromium mouse input exercises pointer capture as well as event wiring.
      const point = await win.webContents.executeJavaScript(`(()=>{const r=probe.tile(0).querySelector('h2').getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+r.height/2)}})()`)
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 73, y: point.y + 49 })
      await new Promise(resolve => setTimeout(resolve, 100))
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 73, y: point.y + 49 })
      await win.webContents.executeJavaScript(`(async()=>{await probe.wait(150);const now=probe.rect(0);if(now.x!==probe.before.x+73||now.y!==probe.before.y+49)throw Error('Real header drag failed: '+JSON.stringify(now));if(probe.tile(0).classList.contains('terminal-card-detail'))throw Error('Drag opened detail');if(!probe.tile(0).contains(document.activeElement)||document.activeElement.classList.contains('xterm-helper-textarea'))throw Error('Drag left keyboard input in an Agent terminal');})()`)
      const resize = await win.webContents.executeJavaScript(`(()=>{probe.beforeResize=probe.rect(0);const r=probe.tile(0).querySelector('[data-resize-edge="e"]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+60)}})()`)
      win.webContents.sendInputEvent({ type: 'mouseMove', ...resize })
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...resize })
      win.webContents.sendInputEvent({ type: 'mouseMove', x: resize.x + 90, y: resize.y })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: resize.x + 90, y: resize.y })
      const result = await win.webContents.executeJavaScript(`(async()=>{
        const p=probe;await p.wait(300);let now=p.rect(0);
        if(now.width!==p.beforeResize.width+90||now.height!==p.beforeResize.height)throw Error('Independent width resize failed');
        const down=p.tile(0).querySelector('[data-resize-edge="s"]');
        down.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',shiftKey:true,bubbles:true}));await p.wait(50);
        now=p.rect(0);if(now.height!==p.beforeResize.height+32)throw Error('Independent height resize failed');
        const saved=JSON.parse(localStorage.getItem('agent-tui-manager:free-overview-layout:v1')).windows['layout-0'];
        if(saved.width!==now.width||saved.height!==now.height)throw Error('Geometry not persisted');
        const original=JSON.stringify(p.rect(0));const move=p.tile(0).querySelector('.free-window-move');
        move.dispatchEvent(new PointerEvent('pointerdown',{pointerId:99,button:0,clientX:250,clientY:200,bubbles:true}));
        window.dispatchEvent(new PointerEvent('pointermove',{pointerId:99,clientX:320,clientY:260}));await p.wait(50);
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await p.wait(50);
        if(JSON.stringify(p.rect(0))!==original||p.tile(0).hasAttribute('data-free-layout-interacting'))throw Error('Escape did not cancel');
        p.select('grid');await p.wait(100);if(p.tile(0).style.width)throw Error('Free geometry leaked into grid');
        p.select('free');await p.wait(100);if(p.rect(0).width!==saved.width)throw Error('Mode switch lost geometry');
        [...document.querySelectorAll('[aria-label="Agent 显示模式"] button')].find(b=>b.textContent.includes('列表')).click();await p.wait(100);
        [...document.querySelectorAll('[aria-label="Agent 显示模式"] button')].find(b=>b.textContent.includes('总览')).click();await p.wait(100);
        p.tile(0).querySelector('[aria-label="查看 Agent 1"]').click();await p.wait(100);
        [...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent).includes('返回总览')).click();await p.wait(150);
        if(p.rect(0).width!==saved.width)throw Error('Detail switch lost geometry');
        if(p.nodes.some((node,i)=>node!==document.querySelectorAll('.xterm')[i]))throw Error('Layout changes recreated terminal');
        const active=[...document.querySelectorAll('.terminal-card-floating')].filter(t=>!t.classList.contains('terminal-card-hidden'));
        for(const tile of active){const header=tile.querySelector('header'),id=tile.querySelector('.native-session-id');if(header.scrollWidth>header.clientWidth+1||id.scrollWidth>id.clientWidth+1)throw Error('Header or ID clipped')}
        return {realPointerDrag:true,independentWidthHeight:true,eightHandles:true,escapeCancel:true,persisted:true,terminalNodesPreserved:true,headerFits:true,geometry:saved};
      })()`)
      if (replayRequests !== 3) throw Error('Layout change replayed terminal history')
      await win.webContents.executeJavaScript(`(async()=>{
        const move=probe.tile(2).querySelector('.free-window-move');
        for(let i=0;i<50;i++)move.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',shiftKey:true,bubbles:true}));
        await probe.wait(100);probe.tile(0).querySelector('.free-window-move').focus({preventScroll:true});await probe.wait(100);
        const canvas=document.querySelector('.terminal-grid-free');canvas.scrollTop=700;canvas.dispatchEvent(new Event('scroll'));await probe.wait(150);
      })()`)
      if (activeRequests.at(-1) !== null) {
        console.error(JSON.stringify({activeRequests,geometry:await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('.terminal-grid-free'),r=probe.tile(0).getBoundingClientRect(),b=c.getBoundingClientRect();return {scroll:c.scrollTop,height:c.clientHeight,scrollHeight:c.scrollHeight,card:{top:r.top,bottom:r.bottom},canvas:{top:b.top,bottom:b.bottom},third:probe.rect(2)}})()`)}))
        throw Error('Offscreen Agent still suppresses reminders')
      }
      await win.webContents.executeJavaScript(`(async()=>{const canvas=document.querySelector('.terminal-grid-free');canvas.scrollTop=0;canvas.dispatchEvent(new Event('scroll'));await probe.wait(150)})()`)
      if (activeRequests.at(-1) !== 'layout-0') throw Error('Visible active Agent did not regain reminder focus')
      await capture(win, 'free-layout')
      // Reload tests persisted preferences, separately from the no-remount checks above.
      await win.webContents.executeJavaScript(`localStorage.setItem('layout-smoke-reload',JSON.stringify(probe.rect(0)))`)
      await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload() })
      const restored = await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<100;i++){const tile=document.querySelector('.terminal-card-floating');if(tile){const saved=JSON.parse(localStorage.getItem('layout-smoke-reload'));if(parseFloat(tile.style.width)!==saved.width||parseFloat(tile.style.height)!==saved.height)throw Error('Reload lost layout');return true}await new Promise(r=>setTimeout(r,30))}throw Error('Free mode not restored')})()`)
      const report = { ok: true, isolated: true, ...result, dragFocusSafe: true, offscreenReminders: true, restoredAfterReload: restored, replayRequestsBeforeReload: 3 }
      writeFileSync(join(out, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); clearTimeout(timeout); app.exit(0)
    } catch(error) { console.error(error); clearTimeout(timeout); app.exit(1) }
  })
})
require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js'))
