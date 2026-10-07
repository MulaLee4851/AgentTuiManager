// Real renderer/preload/store with synthetic terminal content and isolated preferences.
const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const { join, resolve, dirname } = require('node:path')
const { pathToFileURL } = require('node:url')
const root = mkdtempSync(join(require('node:os').tmpdir(), 'agent-tui-appearance-'))
process.env.AGENT_TUI_USER_DATA_DIR = root
app.disableHardwareAcceleration()
const out = resolve('.tmp/appearance-verification'); mkdirSync(out, { recursive: true })
let replays = 0, restarts = 0, capturing = false
const sessions = Array.from({ length: 2 }, (_, index) => ({ sessionId: `appearance-${index}`, displayName: ['研究任务 · 长名称示例', '代码检查'][index], agentKind: 'codex',
  workspace: join(root, 'sample-workspace'), nativeSessionId: `00000000-0000-0000-0000-00000000000${index}`,
  status: 'running', activity: 'running', approvalMode: 'rules-auto', userStopRequested: false, recoveryAttempts: 0 }))
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, callback) => handle(channel, ({
  'agent-manager:list-sessions': () => sessions, 'agent-manager:list-pending-approvals': () => [],
  'agent-manager:terminal-replay': () => { replays++; return { data: 'Synthetic terminal text for font measurement\r\n> SAMPLE INPUT\r\n', sequence: 0 } },
  'agent-manager:resize': () => undefined, 'agent-manager:write': () => undefined,
  'agent-manager:restart-session': () => { restarts++ },
  'agent-manager:detect-agent-environment': () => ({ agentKind: 'codex', executable: 'codex', nodeAvailable: true, npmAvailable: true, agentInstalled: true }),
  'agent-manager:discover-sessions': () => [], 'agent-manager:discover-recent-codex-sessions': () => [],
})[channel] ?? callback)
async function capture(win, name) {
  await new Promise(resolve => setTimeout(resolve, 180))
  const snapshot = await win.webContents.executeJavaScript(`(() => {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script,link[rel="stylesheet"],meta[http-equiv]').forEach(e=>e.remove());
    clone.querySelectorAll('input').forEach((el,i)=>{const source=document.querySelectorAll('input')[i];if(source.checked)el.setAttribute('checked','');else el.removeAttribute('checked');el.setAttribute('value',source.type==='password'?'':source.value)});
    clone.querySelectorAll('option').forEach((el,i)=>{if(document.querySelectorAll('option')[i].selected)el.setAttribute('selected','');else el.removeAttribute('selected')});
    return {html:clone.outerHTML,css:[...document.styleSheets].map(s=>[...s.cssRules].map(r=>r.cssText).join('\\n')).join('\\n'),width:innerWidth,height:innerHeight};
  })()`)
  const html = join(out, name + '.html')
  writeFileSync(html, snapshot.html.replace('<head>', `<head><base href="${pathToFileURL(resolve('dist-electron/renderer/index.html')).href}"><style>${snapshot.css}*{animation:none!important;transition:none!important}</style>`))
  capturing = true
  const surface = new BrowserWindow({ show: false, width: snapshot.width, height: snapshot.height, webPreferences: { offscreen: true, sandbox: true } })
  capturing = false
  await surface.loadFile(html); await new Promise(resolve => setTimeout(resolve, 180))
  writeFileSync(join(out, name + '.png'), (await surface.webContents.capturePage()).toPNG()); surface.destroy()
}
const timeout = setTimeout(() => { console.error('Appearance smoke timed out'); app.exit(1) }, 90000)
app.on('browser-window-created', (_event, win) => {
  if (capturing) return
  win.hide(); win.on('show', () => win.hide()); win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    try {
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
      await win.webContents.executeJavaScript(`(async()=>{
        const wait=(ms=30)=>new Promise(r=>setTimeout(r,ms));
        const until=async test=>{for(let i=0;i<200;i++){if(test())return;await wait()}throw Error('UI condition timed out')};
        const button=name=>[...document.querySelectorAll('button')].find(e=>!e.closest('[inert]')&&(e.getAttribute('aria-label')===name||e.textContent.trim()===name));
        const click=name=>{const el=button(name);if(!el||el.disabled)throw Error('Missing '+name);el.click()};
        const select=(el,value)=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true}))};
        await until(()=>document.querySelectorAll('.xterm').length===2);await wait(800);
        const terminals=[...document.querySelectorAll('.xterm')];
        const open=async()=>{click('设置');await until(()=>button('界面与文字'));click('界面与文字');await until(()=>document.querySelector('input[name="ui-size"]:not(:disabled)'))};
        const saved=async()=>{await wait(80);await until(()=>document.querySelector('.appearance-save-status')?.textContent==='已保存')};
        await open();select(document.querySelector('#terminal-font-size'),'16');await saved();await wait(500);
        const font=()=>parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize);
        let frames=0;const frame=()=>{if(frames<500){frames++;requestAnimationFrame(frame)}};requestAnimationFrame(frame);
        try { await until(()=>font()===16) } catch {
          throw Error('Font not applied: '+JSON.stringify({font:font(),frames,host:[...document.querySelectorAll('.terminal-live-host')].map(e=>({w:e.clientWidth,h:e.clientHeight})),stored:await window.agentManager.getAppearanceSettings(),textLength:document.querySelector('.xterm-rows').textContent.length}));
        }
        window.appearanceProbe={wait,until,button,click,select,open,saved,terminals,font};
      })()`)
      for (const [size, scale] of [['compact', .85], ['standard', 1], ['comfortable', 1.1], ['large', 1.25]]) {
        for (const [width, height] of [[1280, 820], [860, 600]]) {
          await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
          await win.webContents.executeJavaScript(`(async()=>{
            const {wait,saved,font,terminals}=appearanceProbe;window.dispatchEvent(new Event('resize'));
            document.querySelector('input[value="${size}"]').click();await saved();await wait(500);
            const root=parseFloat(getComputedStyle(document.documentElement).fontSize);
            if(Math.abs(root-${16 * scale})>.01)throw Error('Wrong UI scale');
            const top=document.querySelector('.topbar');if(top.scrollWidth>top.clientWidth+1)throw Error('Toolbar overflow at ${size}/${width}');
            const dialog=document.querySelector('.appearance-dialog'),footer=dialog.querySelector('footer');
            if(dialog.scrollWidth>dialog.clientWidth+1||footer.getBoundingClientRect().bottom>innerHeight+1)throw Error('Dialog overflow at ${size}/${width}');
            const body=document.querySelector('.appearance-body'),y=footer.getBoundingClientRect().top;body.scrollTop=body.scrollHeight;await wait();
            if(Math.abs(footer.getBoundingClientRect().top-y)>1)throw Error('Footer moved');body.scrollTop=0;
            if(font()!==16)throw Error('UI size changed fixed terminal font');
            if(terminals.some(el=>!el.isConnected))throw Error('Terminal remounted');
          })()`)
          await capture(win, `appearance-${size}-${width}`)
        }
      }
      await win.webContents.executeJavaScript(`(async()=>{
        const {click,wait,until,open,saved,select}=appearanceProbe;
        click('完成');await wait(140);await open();
        if(!document.querySelector('input[value="large"]').checked||document.querySelector('#terminal-font-size').value!=='16')throw Error('Settings lost on reopen');
        click('完成');await wait(140);click('设置');await until(()=>appearanceProbe.button('终端显示模式'));click('终端显示模式');await until(()=>appearanceProbe.button('保存设置')&&!appearanceProbe.button('保存设置').disabled);
        if(!document.querySelector('.terminal-mode-summary').textContent.includes('Codex 原生模式'))throw Error('Mode name not updated');
        if(document.querySelector('.terminal-settings-body').textContent.includes('0.159.2'))throw Error('Internal verification leaked into UI');
      })()`)
      await capture(win, 'terminal-mode-large-860')
      await win.webContents.executeJavaScript(`(async()=>{
        const {click,wait,until}=appearanceProbe;click('取消');await wait(140);click('设置');await until(()=>appearanceProbe.button('审核器设置'));click('审核器设置');await until(()=>appearanceProbe.button('保存设置')&&!appearanceProbe.button('保存设置').disabled);await wait(180);
        const dialog=document.querySelector('.llm-review-dialog'),footer=dialog.querySelector('footer');
        if(dialog.scrollWidth>dialog.clientWidth+1||footer.getBoundingClientRect().bottom>innerHeight+1)throw Error('Reviewer layout overflow at large/860');
      })()`)
      await capture(win, 'reviewer-large-860')
      await win.webContents.executeJavaScript(`(async()=>{
        const {click,wait,until}=appearanceProbe;click('取消');await wait(140);click('＋ 新建 Agent');await until(()=>appearanceProbe.button('选择文件夹'));await wait(180);
        const dialog=document.querySelector('.agent-launcher');if(dialog.scrollWidth>dialog.clientWidth+1)throw Error('Launcher overflow at large/860');
        const footer=dialog.querySelector('.launcher-footer');if(footer&&footer.getBoundingClientRect().bottom>innerHeight+1)throw Error('Launcher footer clipped');
      })()`)
      await capture(win, 'launcher-large-860')
      await win.webContents.executeJavaScript(`(async()=>{
        const {click,wait,open,saved,font}=appearanceProbe;click('关闭');await wait(140);await open();click('恢复默认');await saved();await wait(500);
        if(document.documentElement.dataset.uiSize!=='standard'||document.querySelector('#terminal-font-size').value!=='auto')throw Error('Reset failed');
        const autoFont=font();document.querySelector('input[value="large"]').click();await saved();await wait(500);
        if(font()!==autoFont)throw Error('UI size changed automatic CLI font');
        click('恢复默认');await saved();await wait(300);
        click('完成');await wait(140);click('统计');await appearanceProbe.until(()=>appearanceProbe.button('Token 用量'));click('Token 用量');await wait(250);
      })()`)
      await capture(win, 'tokens-standard-860')
      const stored = JSON.parse(readFileSync(join(root, 'appearance-settings.json'), 'utf8'))
      if (stored.uiSize !== 'standard' || stored.terminalFontSize !== 'auto' || replays !== 2 || restarts !== 0) throw Error('Persistence or session stability failure')
      const result = { ok: true, scales: [85, 100, 110, 125], viewports: ['1280x820', '860x600'], terminalFontIndependent: true, automaticFontIndependent: true, realSettingsIPC: true, replayRequests: replays, runningSessionRestarts: restarts, reset: true }
      writeFileSync(join(out, 'verification.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); clearTimeout(timeout); app.exit(0)
    } catch (error) { console.error(error.message); clearTimeout(timeout); app.exit(1) }
  })
})
// Windows suppresses animation frames in fully hidden windows. Give the fixture
// a bounded timer-based frame clock; real Chromium still measures and renders cells.
// This checks layout/lifecycle, not native frame timing or performance.
const Module = require('node:module'), load = Module._load
class TestWindow extends BrowserWindow {
  constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true } }) }
  loadFile(file, options) {
    const clockFile = join(root, 'frame-clock.js'), fixtureFile = join(root, 'renderer.html')
    writeFileSync(clockFile, 'window.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),16);window.cancelAnimationFrame=clearTimeout;')
    const html = readFileSync(file, 'utf8').replace(/(src|href)="\.\/([^"]+)"/g, (_match, attr, relative) => `${attr}="${pathToFileURL(join(dirname(file), relative)).href}"`)
      .replace('<title>', `<script src="${pathToFileURL(clockFile).href}"></script><title>`)
    writeFileSync(fixtureFile, html)
    return super.loadFile(fixtureFile, options)
  }
}
Module._load = function (name, ...args) {
  const result = load.call(this, name, ...args)
  return name === 'electron' ? new Proxy(result, { get(target, key) { return key === 'BrowserWindow' ? TestWindow : Reflect.get(target, key) } }) : result
}
try { require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js')) }
finally { Module._load = load }
