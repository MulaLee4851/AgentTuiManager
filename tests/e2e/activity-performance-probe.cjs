// Synthetic transcripts only; no credential, CLI config or live history access.
const fs = require('node:fs')
const { build } = require('esbuild')
const { mkdtempSync, writeFileSync, appendFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const root=mkdtempSync(join(tmpdir(),'atm-activity-performance-'))
fs.mkdirSync(resolve(".tmp/performance-diagnostics"),{recursive:true})
const all=[]
async function run(){
  for(const baseline of [false,true]){
    const source=baseline?{stdin:{contents:execFileSync('git',['show','42983f2:electron/native-session-activity.ts'],{encoding:'utf8'}),resolveDir:resolve('electron'),loader:'ts'}}:{entryPoints:['electron/native-session-activity.ts']}
    const path=join(root,baseline?'baseline.cjs':'current.cjs')
    await build({...source,bundle:true,platform:'node',format:'cjs',outfile:path})
    const {NativeSessionActivityMonitor}=require(path)
    for(const mib of [1,8,32]){
      const id='synthetic-'+mib
      const file=join(root,'rollout-'+id+'.jsonl')
      const meta=JSON.stringify({type:'session_meta',payload:{id,source:'cli'}})+'\n'
      const row=JSON.stringify({timestamp:1791190000000,type:'response_item',payload:{type:'function_call_output',call_id:'synthetic-done',output:'x'.repeat(1800)}})+'\n'
      const latest=JSON.stringify({timestamp:1791190001000,type:'event_msg',payload:{type:'task_started'}})+'\n'
      const data=meta+row.repeat(Math.floor((mib*1024*1024-meta.length-latest.length)/row.length))+latest
      writeFileSync(file,data)
      let events=0
      const session={sessionId:id,nativeSessionId:id,agentKind:'codex',status:'running',activitySince:0}
      const monitor=new NativeSessionActivityMonitor(()=>[session],()=>{events++},{codex:root,claude:root})
      const polls=[];let delay=0,last=performance.now()
      const heartbeat=setInterval(()=>{const now=performance.now();delay=Math.max(delay,now-last-2);last=now},2)
      while(events===0&&polls.length<50){const start=performance.now();const cpu=process.cpuUsage();await monitor.poll();const use=process.cpuUsage(cpu);polls.push({ms:Math.round(performance.now()-start),cpuMs:Math.round((use.user+use.system)/1000)});await new Promise(r=>setTimeout(r,5))}
      if(!events)throw Error('Synthetic activity not detected')
      const warmStart=performance.now();await monitor.poll();const unchangedMs=performance.now()-warmStart
      appendFileSync(file,latest);const appendStart=performance.now();await monitor.poll();const appendMs=performance.now()-appendStart
      clearInterval(heartbeat);monitor.stop()
      let publish
      const caughtUp=new Promise(resolve=>{publish=resolve})
      const scheduledMonitor=new NativeSessionActivityMonitor(()=>[session],()=>publish(),{codex:root,claude:root})
      const scheduledStart=performance.now()
      scheduledMonitor.start()
      const timeout=setTimeout(()=>{throw Error('Scheduled catchup timeout')},20000)
      await caughtUp
      const scheduledCatchupMs=performance.now()-scheduledStart
      scheduledMonitor.stop();clearTimeout(timeout)
      const result={version:baseline?'local.4':'optimized',fileBytes:data.length,pollCount:polls.length,totalPollMs:polls.reduce((sum,p)=>sum+p.ms,0),maxPollMs:Math.max(...polls.map(p=>p.ms)),maxEventLoopDelayMs:Math.round(delay),unchangedMs:+unchangedMs.toFixed(2),appendMs:+appendMs.toFixed(2),scheduledCatchupMs:Math.round(scheduledCatchupMs)}
      all.push(result);console.log(JSON.stringify(result))
    }
  }
  writeFileSync(resolve('.tmp/performance-diagnostics/activity-results.json'),JSON.stringify(all,null,2))
}
run().catch(error=>{console.error(error.message);process.exitCode=1})
