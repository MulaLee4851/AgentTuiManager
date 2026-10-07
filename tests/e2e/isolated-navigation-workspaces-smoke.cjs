const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')
const root = mkdtempSync(join(tmpdir(), 'agent-tui-navigation-smoke-'))
process.env.AGENT_TUI_USER_DATA_DIR = root
app.disableHardwareAcceleration()
const out = resolve('.tmp/navigation-verification')
mkdirSync(out, { recursive: true })
const sessions = Array.from({ length: 2 }, (_, i) => ({ sessionId: 'nav-' + i, displayName: 'Agent ' + (i + 1), agentKind: 'codex',
  workspace: join(root, 'project-' + i), nativeSessionId: '00000000-0000-0000-0000-00000000000' + i,
  status: 'running', activity: 'running', approvalMode: 'manual', userStopRequested: false, recoveryAttempts: 0 }))
let replayRequests = 0, chosen = 0, opened = 0
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, callback) => handle(channel, ({
  'agent-manager:list-sessions': () => sessions,
  'agent-manager:list-pending-approvals': () => [],
  'agent-manager:terminal-replay': () => { replayRequests++; return { data: 'Synthetic UI verification\r\n', sequence: 0 } },
  'agent-manager:resize': () => undefined, 'agent-manager:write': () => undefined,
  'agent-manager:open-session-workspace': () => { opened++ },
  'agent-manager:discover-sessions': () => [], 'agent-manager:discover-recent-codex-sessions': () => [],
  'agent-manager:detect-agent-environment': () => ({ agentKind: 'codex', executable: 'codex', nodeAvailable: true, npmAvailable: true, agentInstalled: true }),
  'agent-manager:choose-workspace': () => join(root, 'recent-' + (++chosen)),
  'agent-manager:start-session': (_event, request) => { const session = { ...sessions[0], ...request, sessionId: 'created-' + chosen, nativeSessionId: undefined }; sessions.push(session); return session },
})[channel] ?? callback)
const timer = setTimeout(() => { console.error('Navigation smoke timed out'); app.exit(1) }, 90000)
let captureWindow = false
async function capture(win, name) {
  await new Promise(resolve => setTimeout(resolve, 180))
  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const clone = document.documentElement.cloneNode(true);
    const elements=[...document.documentElement.querySelectorAll('*')];clone.querySelectorAll('*').forEach((el,i)=>{if(elements[i].scrollTop)el.setAttribute('data-smoke-scroll-top',String(elements[i].scrollTop))});
    clone.querySelectorAll('script,link[rel="stylesheet"],meta[http-equiv]').forEach(el=>el.remove());
    clone.querySelectorAll('input').forEach((el,i)=>{const original=document.querySelectorAll('input')[i];el.setAttribute('value',original.type==='password'?'':original.value);if(original.checked)el.setAttribute('checked','')});
    clone.querySelectorAll('option').forEach((el,i)=>{if(document.querySelectorAll('option')[i].selected)el.setAttribute('selected','');else el.removeAttribute('selected')});
    return {html:clone.outerHTML,css:[...document.styleSheets].map(s=>[...s.cssRules].map(r=>r.cssText).join('\\n')).join('\\n'),width:innerWidth,height:innerHeight};
  })()`)
  const html = join(out, name + '.html')
  writeFileSync(html, snapshot.html.replace('<head>', `<head><base href="${pathToFileURL(resolve('dist-electron/renderer/index.html')).href}"><style>${snapshot.css}*{animation:none!important;transition:none!important}</style>`))
  captureWindow = true
  const surface = new BrowserWindow({ show: false, width: snapshot.width, height: snapshot.height, webPreferences: { offscreen: true, sandbox: true } })
  captureWindow = false
  await surface.loadFile(html)
  await surface.webContents.executeJavaScript("document.querySelectorAll('[data-smoke-scroll-top]').forEach(el=>el.scrollTop=Number(el.getAttribute('data-smoke-scroll-top')))")
  await new Promise(resolve => setTimeout(resolve, 200))
  const image = await surface.webContents.capturePage()
  writeFileSync(join(out, name + '.png'), image.toPNG()); surface.destroy()
}
app.on('browser-window-created', (_event, win) => {
  if (captureWindow) return
  win.hide(); win.on('show', () => win.hide()); win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message) })
  const execute = win.webContents.executeJavaScript.bind(win.webContents)
  win.webContents.executeJavaScript = async (source, ...args) => {
    new (require('node:vm').Script)(source)
    const result = await execute(source.startsWith('(async') ? source + '.catch(error=>({smokeError:error.message}))' : source, ...args)
    if (result?.smokeError) throw new Error(result.smokeError)
    return result
  }
  win.webContents.once('did-finish-load', async () => {
    try {
      await win.webContents.executeJavaScript(`(async()=>{
        const wait=(ms=30)=>new Promise(r=>setTimeout(r,ms));
        const until=async test=>{for(let i=0;i<150;i++){if(test())return;await wait()}throw Error('UI state timed out')};
        const visible=el=>el && !el.closest('[inert]') && getComputedStyle(el).visibility!=='hidden';
        const button=name=>[...document.querySelectorAll('button')].find(el=>visible(el)&&(el.getAttribute('aria-label')===name||el.textContent.trim()===name));
        const click=name=>{const el=button(name);if(!el||el.disabled)throw Error('Missing enabled button '+name);el.click()};
        const select=(el,value)=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true}))};
        await until(()=>document.querySelectorAll('.xterm').length===2);
        if(document.querySelector('[data-panel="navigation"]')||button('通知'))throw Error('Old navigation remains');
        const nodes=[...document.querySelectorAll('.xterm')];
        const header=document.querySelector('.terminal-card-header');
        const mode=header.querySelector('.full-auto-tile-button'),folder=header.querySelector('.workspace-folder-button');
        if(mode.nextElementSibling!==folder)throw Error('Folder toolbar ordering incorrect');folder.click();
        click('统计');await until(()=>button('审计'));
        const menu=button('审计').closest('[role="menu"]');
        if(getComputedStyle(menu).animationName==='none'||getComputedStyle(menu).animationDuration==='0s')throw Error('Dropdown animation missing');
        click('审计');await until(()=>document.querySelector('.audit-page')||document.querySelector('.audit-filters'));
        click('Agent 总览');await wait();
        if(nodes.some(node=>!node.isConnected))throw Error('Navigation remounted terminals');
        click('设置');await until(()=>button('配置快捷入口'));click('配置快捷入口');
        await until(()=>document.querySelector('[role="dialog"][aria-labelledby] .top-navigation-slot'));
        const fields=document.querySelectorAll('.top-navigation-slot select'); select(fields[0],'llm-review'); await wait(); click('完成');await wait(130);
        const slots=JSON.parse(localStorage.getItem('agent-tui-manager:top-navigation-shortcuts:v1')||'null');
        if(slots?.[0]?.action!=='llm-review')throw Error('Shortcut preference not saved');
        window.navProbe={wait,until,button,click,select,nodes,slots};
      })()`)
      await capture(win, 'top-navigation')
      if (replayRequests !== 2 || opened !== 1) throw Error('Navigation changed terminal replay or workspace actions')
      await win.webContents.executeJavaScript(`(async()=>{
        const {wait,until,click,button}=navProbe;
        click('设置');await until(()=>button('审核器设置'));click('审核器设置');
        await until(()=>button('保存设置')&&!button('保存设置').disabled);
        const footer=document.querySelector('.llm-review-dialog > footer'),scroll=document.querySelector('.llm-review-scroll');
        const y=footer.getBoundingClientRect().top;
        if(footer.getBoundingClientRect().bottom>innerHeight+1||scroll.scrollHeight<=scroll.clientHeight)throw Error('Reviewer footer or scroll area invalid');
        scroll.scrollTop=scroll.scrollHeight;await wait();
        if(Math.abs(footer.getBoundingClientRect().top-y)>1)throw Error('Reviewer footer moved while scrolling');
      })()`)
      await capture(win, 'reviewer-fixed-footer')
      await win.webContents.executeJavaScript(`(async()=>{
        const {wait,until,click,button}=navProbe; click('取消');await wait(130);
        for(let i=1;i<=6;i++) {
          click('＋ 新建 Agent');await until(()=>button('选择文件夹'));
          click('选择文件夹');await until(()=>document.querySelector('#workspace').value.endsWith('recent-'+i));
          await until(()=>button('启动 Agent')&&!button('启动 Agent').disabled);click('启动 Agent');
          await until(()=>button('返回总览'));click('返回总览');await wait(140);
        }
        const recent=JSON.parse(localStorage.getItem('agent-tui-manager:recent-workspaces:v1'));
        if(recent.length!==5||!recent[0].path.endsWith('recent-6')||!recent[4].path.endsWith('recent-2'))throw Error('Recent history ordering/limit failed');
        click('＋ 新建 Agent');await until(()=>button('展开工作区列表'));click('展开工作区列表');await wait(180);
        click('保留工作区 '+recent[0].path);await wait();
        const saved=JSON.parse(localStorage.getItem('agent-tui-manager:favorite-workspaces:v1'));
        if(saved.length!==1||saved[0].path!==recent[0].path)throw Error('Pin recent workspace failed');
        click('recent-6');await wait();if(document.querySelector('#workspace').value!==recent[0].path)throw Error('Workspace quick select failed');
      })()`)
      await capture(win, 'workspace-shortcuts')
      await win.webContents.executeJavaScript(`(async()=>{
        const {wait,until,click}=navProbe; click('关闭');await wait(130);click('☰ 列表');await wait(100);
        const panel=document.querySelector('[data-panel="agents"]');panel.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));await wait();
        click('隐藏Agent 列表');await wait(180);
        const handle=panel.querySelector('.panel-reveal-handle').getBoundingClientRect();
        const header=document.querySelector('.terminal-card:not(.terminal-card-hidden) .terminal-card-header').getBoundingClientRect();
        if(Math.abs(handle.top+handle.height/2-header.top-header.height/2)>1.5)throw Error('Hidden Agent list handle misaligned');
        if(!panel.querySelector('.panel-surface').hasAttribute('inert'))throw Error('Hidden Agent list remains interactive');
        click('展开Agent 列表');await wait(200);
        if(!panel.classList.contains('panel-expanded'))throw Error('Agent list reveal failed');
      })()`)
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 860, height: 680, deviceScaleFactor: 1, mobile: false })
      // Hidden Windows surfaces may defer native resize/media notifications.
      await win.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))")
      await new Promise(resolve => setTimeout(resolve, 250))
      await win.webContents.executeJavaScript(`(()=>{const top=document.querySelector('.topbar');if(top.scrollWidth>top.clientWidth+1)throw Error('Minimum-width toolbar overflows');if(!navProbe.button('更多快捷入口'))throw Error('Compact shortcut menu missing: '+JSON.stringify({width:innerWidth,media:matchMedia('(max-width: 1080px)').matches,labels:[...top.querySelectorAll('button')].map(b=>({label:b.getAttribute('aria-label'),inert:!!b.closest('[inert]'),visibility:getComputedStyle(b).visibility}))}));})()`)
      await capture(win, 'minimum-width')
      const result = { ok: true, realRendererAndIPC: true, isolatedSessions: true, recentLimit: 5, launches: chosen, initialReplayRequests: 2,
        navigation: true, shortcutConfiguration: true, reviewerFooter: true, hiddenListAlignment: true, minimumWidth: 860 }
      writeFileSync(join(out, 'verification.json'), JSON.stringify(result, null, 2));console.log(JSON.stringify(result));clearTimeout(timer);app.exit(0)
    } catch(error) { console.error(error.message); clearTimeout(timer); app.exit(1) }
  })
})
require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js'))
