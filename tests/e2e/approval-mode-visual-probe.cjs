// Hidden, isolated renderer probe: no live Agent, credentials or model calls.
const { app, BrowserWindow } = require('electron')
const { build } = require('esbuild')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { tmpdir } = require('node:os')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'approval-mode-visual-')))
const limit = setTimeout(() => app.exit(1), 20000)
app.whenReady().then(async () => {
  try {
    const bundle = await build({ stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import ApprovalModeDialog from './src/ApprovalModeDialog';
      window.agentManager={setApprovalMode:async (...args)=>window.modeCalls.push(args)};
      window.modeCalls=[];
      createRoot(document.getElementById('root')).render(<ApprovalModeDialog session={{
        sessionId:'visual-probe', displayName:'审批模式演示', agentKind:'codex', workspace:'C:/demo',
        status:'running', recoveryAttempts:0, userStopRequested:false, approvalMode:'rules-auto'
      }} onChanged={()=>{}} onClose={()=>{}} onConfigureReviewer={()=>{}} />);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } })
    const win = new BrowserWindow({ show: false, width: 1080, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message) })
    await win.loadURL('data:text/html,'+encodeURIComponent('<div id="root"></div><style>'+readFileSync(resolve('src/styles.css'),'utf8')+'</style>'))
    await win.webContents.executeJavaScript(bundle.outputFiles[0].text)
    await new Promise(resolve => setTimeout(resolve, 400))
    const result = await win.webContents.executeJavaScript(`(() => {
      const dialog=document.querySelector('[role="dialog"]'), radios=[...document.querySelectorAll('input[type=radio]')];
      if(radios.length!==4 || radios.filter(r=>r.checked).map(r=>r.value).join()!=='rules-auto')throw Error('Incorrect mode selection');
      const b=dialog.getBoundingClientRect();
      if(b.left<0||b.top<0||b.right>innerWidth+1||b.bottom>innerHeight+1)throw Error('Dialog outside viewport '+JSON.stringify({left:b.left,top:b.top,right:b.right,bottom:b.bottom,innerWidth,innerHeight}));
      radios.find(r=>r.value==='agent-review').click();
      return {radioCount:radios.length,width:b.width,height:b.height};
    })()`)
    await new Promise(resolve => setTimeout(resolve, 200))
    const screenshot = resolve(process.env.AGENT_TUI_PROBE_SCREENSHOT || 'approval-mode-preview.png')
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(`document.querySelector('footer .button-primary').click()`)
    await new Promise(resolve => setTimeout(resolve, 100))
    const calls = await win.webContents.executeJavaScript('window.modeCalls')
    if(JSON.stringify(calls)!==JSON.stringify([['visual-probe','agent-review']]))throw Error('Mode did not reach IPC boundary')
    console.log(JSON.stringify({ok:true,...result,screenshot}))
    clearTimeout(limit); app.exit(0)
  } catch(error) { console.error(error); clearTimeout(limit); app.exit(1) }
})
