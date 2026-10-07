// Actual main/preload/renderer; CC Switch and CLI discovery use synthetic fixtures.
const { app, ipcMain } = require('electron')
const { mkdtempSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
process.env.AGENT_TUI_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'agent-tui-cc-ui-'))
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => {
  if (channel === 'agent-manager:list-ccswitch-providers') handler = async () => Array.from({length:26}, (_,index) => ({
    id:'fixture-'+index, name:'Gateway '+index, agentKind:'codex', baseUrl:'https://gateway.example/v1',
    isCurrent:index===0, hasApiKey:true,
  }))
  if (channel === 'agent-manager:detect-agent-environment') handler = async () => ({agentKind:'codex', executable:'codex',nodeAvailable:true,npmAvailable:true,agentInstalled:true})
  if (channel === 'agent-manager:discover-sessions') handler = async () => []
  return originalHandle(channel, handler)
}
const timer=setTimeout(()=>{console.error('CC Switch UI smoke timed out');app.exit(1)},25000)
app.on('browser-window-created',(_event,win)=>{
  win.hide(); win.on('show',()=>win.hide())
  win.webContents.once('did-finish-load',async()=>{
    try {
      await win.webContents.executeJavaScript(`(async()=>{
        const click=text=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));if(!b)throw Error('Missing button '+text);b.click()};
        const wait=()=>new Promise(r=>setTimeout(r,150));
        await wait();click('新建 Agent');await wait();click('独立配置');await wait();
        document.querySelector('[aria-label="启用独立配置"]').click();await wait();click('选择已保存的服务配置');await wait();
      })()`)
      const result=await win.webContents.executeJavaScript(`(()=>{
        const list=document.querySelector('.ccswitch-provider-list'), buttons=list?.querySelectorAll('button');
        if(buttons?.length!==26)throw Error('Incomplete provider list');
        if(list.scrollHeight<=list.clientHeight)throw Error('List is not scrollable');
        list.scrollTop=list.scrollHeight;buttons[25].click();
        return {count:buttons.length,scrollHeight:list.scrollHeight,height:list.clientHeight,scrollTop:list.scrollTop};
      })()`)
      await new Promise(r=>setTimeout(r,150))
      const selected=await win.webContents.executeJavaScript(`document.querySelector('.ccswitch-provider-list button[aria-pressed="true"]')?.textContent`)
      if(!selected?.includes('Gateway 25'))throw Error('Last provider cannot be selected')
      await win.webContents.executeJavaScript(`(()=>{
        const list=document.querySelector('.ccswitch-provider-list'), selected=list.querySelector('button[aria-pressed="true"]');
        const outer=list.getBoundingClientRect(), inner=selected.getBoundingClientRect();
        if(inner.top<outer.top-1||inner.bottom>outer.bottom+1)throw Error('Last provider outside scroll viewport');
      })()`)
      console.log(JSON.stringify({ok:true,syntheticProviders:true,...result}));clearTimeout(timer);app.exit(0)
    } catch(e) {console.error(e);clearTimeout(timer);app.exit(1)}
  })
})
require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js'))
