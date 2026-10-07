// Isolated synthetic performance probe. Never opens live Manager data or a PTY.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const { build } = require('esbuild')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')
const root = mkdtempSync(join(tmpdir(), 'atm-render-performance-'))
app.setPath('userData', join(root, 'profile'))
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.on('window-all-closed', () => {})
const baseline = process.argv.includes('--baseline')
fs.mkdirSync(resolve(".tmp/performance-diagnostics"),{recursive:true})
const outputs = []
const renderer = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import App from './src/App';
const p=window.perf={start:performance.now(),opens:0,disposes:0,replays:0,writes:[],resizes:[],longTasks:[],terms:[],pending:0};
new PerformanceObserver(list=>{for(const e of list.getEntries())p.longTasks.push({start:e.startTime,ms:e.duration})}).observe({entryTypes:['longtask']});
const open=Terminal.prototype.open,write=Terminal.prototype.write,resize=Terminal.prototype.resize,dispose=Terminal.prototype.dispose;
Terminal.prototype.open=function(host){const start=performance.now();const result=open.call(this,host);p.opens++;p.terms.push({term:this,host,openMs:performance.now()-start,disposed:false});return result;};
Terminal.prototype.write=function(data,callback){const start=performance.now();p.pending++;return write.call(this,data,()=>{p.pending--;p.writes.push({chars:data.length,ms:performance.now()-start});callback?.();});};
Terminal.prototype.resize=function(cols,rows){const start=performance.now();const result=resize.call(this,cols,rows);p.resizes.push({cols,rows,ms:performance.now()-start});return result;};
Terminal.prototype.dispose=function(){p.disposes++;const entry=p.terms.find(x=>x.term===this);if(entry)entry.disposed=true;return dispose.call(this);};
const line='\\x1b[36mSynthetic assistant output \\x1b[0m'+'abcdef '.repeat(20)+'\\r\\n';
const data=line.repeat(window.fixtureLines);
const sessions=Array.from({length:3},(_,i)=>({sessionId:'fixture-'+i,displayName:'Synthetic Agent '+i,agentKind:'codex',workspace:i===2?'G:\\\\synthetic-b':'G:\\\\synthetic-a',status:'running',activity:'running',recoveryAttempts:0,userStopRequested:false}));
window.agentManager={platform:'win32',listSessions:async()=>sessions,listPendingApprovals:async()=>[],subscribe:()=>()=>{},onAttentionSound:()=>()=>{},setActiveSession:async()=>{},terminalReplay:async()=>{p.replays++;return {data,sequence:0};},resize:async()=>{},write:async()=>{},openExternalWeb:async()=>{},writeClipboardText:async()=>{}};
localStorage.setItem('agent-tui-manager:overview-preferences:v1',JSON.stringify({overviewMode:'list',groupByWorkspace:false}));
createRoot(document.getElementById('root')).render(<App/>);
window.probeReady=true;
`
let win
const watchdog = setTimeout(() => { console.error('Synthetic renderer probe timed out'); app.exit(1) }, 90000)
app.whenReady().then(async()=>{
  try {
    const bundle=await build({stdin:{contents:renderer,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outfile:join(root,'bundle.js'),platform:'browser',format:'iife',loader:{'.png':'dataurl','.svg':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},plugins:baseline?[{name:'baseline-source',setup(builder){builder.onLoad({filter:/[\\/]src[\\/](App|TerminalTile)\.tsx$/},args=>({contents:execFileSync('git',['show','42983f2:src/'+args.path.split(/[\\/]/).pop()],{encoding:'utf8'}),loader:'tsx',resolveDir:resolve('src')}));}}]:[]})
    const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text
    const css=readFileSync(resolve('node_modules/@xterm/xterm/css/xterm.css'),'utf8')+readFileSync(resolve('src/styles.css'),'utf8')+(bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text||'')
    const html=join(root,'index.html');writeFileSync(html,'<!doctype html><style>'+css+'</style><div id="root"></div>')
    for (const lines of [100,6000,20000]) {
      win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:true,backgroundThrottling:false,offscreen:true,partition:'perf-'+lines+'-'+baseline}})
      win.webContents.setFrameRate(60)
      await win.loadFile(html)
      await win.webContents.executeJavaScript('window.fixtureLines='+lines)
      await win.webContents.executeJavaScript(js)
      const result=await win.webContents.executeJavaScript(`(async()=>{
        const wait=ms=>new Promise(r=>setTimeout(r,ms));
        const until=async(fn,limit=15000)=>{const start=performance.now();while(!fn()){if(performance.now()-start>limit)throw Error('Probe condition timeout');await wait(10)}};
        const p=window.perf;await until(()=>p.opens===${baseline ? 3 : 1}&&p.writes.length>=1&&p.pending===0);
        const parsedMs=performance.now()-p.start;
        await until(()=>!document.querySelector('.terminal-card:not(.terminal-card-hidden) .terminal-resize-cover'));
        const firstReadyMs=performance.now()-p.start;
        await wait(300);
        const count=()=>({opens:p.opens,disposes:p.disposes,replays:p.replays});
        const first=count(),switches=[];
        for(let i=0;i<6;i++){
          const index=i%2?0:1,start=performance.now(),before=count();
          document.querySelectorAll('.agent-session-list button')[index].click();
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          switches.push({ms:performance.now()-start,opens:p.opens-before.opens,replays:p.replays-before.replays});
          await wait(250);
          await until(()=>p.pending===0);
        }
        if(switches.slice(1).some(s=>s.opens||s.replays))throw Error('Warm switch recreated a terminal');
        const buttons=[...document.querySelectorAll('button')];buttons.find(b=>b.textContent.trim()==='▦ 总览').click();await wait(900);
        const beforeDetail=count();document.querySelector('[data-testid="terminal-tile-fixture-0"]').click();await wait(900);
        const detail=count();const backStart=performance.now();[...document.querySelectorAll('button')].find(b=>b.textContent.trim().includes('返回总览')||b.getAttribute('aria-label')==='返回总览').click();
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        await until(()=>p.opens>=detail.opens+${baseline ? 2 : 0}&&p.pending===0);
        const returnParseMs=performance.now()-backStart;
        await wait(200);
        const returned=count();
        if(!${baseline}&&(detail.disposes||returned.opens!==beforeDetail.opens||returned.replays!==beforeDetail.replays))throw Error('Detail roundtrip replayed retained terminals');
        return {lines:window.fixtureLines,first,parsedMs,firstReadyMs,writeCount:p.writes.length,maxWriteChars:Math.max(...p.writes.map(w=>w.chars)),maxResizeMs:Math.max(0,...p.resizes.map(r=>r.ms)),longTasks:p.longTasks.map(t=>Math.round(t.ms)),switches,beforeDetail,detail,returned,returnParseMs};
      })()`)
      outputs.push(result);console.log(JSON.stringify({version:baseline?'local.4-source':'optimized-source',...result}))
      win.destroy();win=undefined
    }
    writeFileSync(resolve('.tmp/performance-diagnostics/renderer-'+(baseline?'before':'after')+'.json'),JSON.stringify({version:baseline?'local.4-source':'optimized-source',fixture:'3 synthetic agents, offscreen Electron, mocked IPC, no live data',outputs},null,2))
    clearTimeout(watchdog);app.exit(0)
  }catch(error){console.error(error.message);clearTimeout(watchdog);win?.destroy();app.exit(1)}
})
