// Real CC Switch SQLite reader, encrypted store, IPC and UI; synthetic data only.
const { app, ipcMain } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const root = fs.mkdtempSync(join(tmpdir(), 'agent-tui-review-import-smoke-'))
process.env.AGENT_TUI_USER_DATA_DIR = root
const originalRead = fsp.readFile
fsp.readFile = async function (path, ...args) {
  // Supply only a fixture path, never consult the user's CC Switch installation.
  if (String(path).replaceAll('\\', '/').endsWith('/com.ccswitch.desktop/app_paths.json')) {
    return JSON.stringify({ app_config_dir_override: root })
  }
  return originalRead.call(this, path, ...args)
}
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => originalHandle(channel,
  ['agent-manager:discover-sessions', 'agent-manager:discover-recent-codex-sessions'].includes(channel) ? async () => [] : handler)
const requests = []
const credentials = { codex: 'synthetic-codex-import-key', claude: 'synthetic-claude-import-key' }
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    const kind = req.url.startsWith('/claude/') ? 'claude' : 'codex'
    const authorized = req.headers.authorization === `Bearer ${credentials[kind]}`
    requests.push({ kind, authorized, method: req.method })
    res.setHeader('content-type', 'application/json')
    if (!authorized) { res.writeHead(401); res.end('{}'); return }
    if (req.url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return }
    const text = '{"ok":true}'
    res.end(JSON.stringify(kind === 'claude'
      ? { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }] }
      : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }))
  })
})
const timer = setTimeout(() => { console.error('Review import smoke timed out'); app.exit(1) }, 60000)
const helpers = `
  const wait = () => new Promise(resolve => setTimeout(resolve, 120));
  const until = async test => { for(let i=0;i<80;i++){if(test())return;await wait()}throw Error('UI state timed out') };
  const button = name => [...document.querySelectorAll('button')].find(item => item.textContent.trim()===name || item.getAttribute('aria-label')===name);
  const click = name => { const item=button(name); if(!item || item.disabled)throw Error('Missing enabled button '+name);item.click() };
  const checkbox = label => document.querySelector('input[aria-label="'+label+'"]');
  const field = name => [...document.querySelectorAll('label')].find(label => label.firstChild?.textContent===name)?.querySelector('select,input');
  const select = (item, value) => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(item,value);item.dispatchEvent(new Event('change',{bubbles:true})) };
`
app.on('browser-window-created', (_event, win) => {
  win.hide(); win.on('show', () => win.hide())
  win.webContents.once('did-finish-load', async () => {
    try {
      await win.webContents.executeJavaScript(`(async()=>{
        ${helpers}
        await until(()=>button('设置')); click('设置'); await wait(); click('审核器设置');
        await until(()=>button('添加审核器') && !button('保存设置').disabled);
        click('添加审核器'); await wait();
        if(checkbox('启用 审核器 1').checked)throw Error('Blank reviewer was enabled');
        document.querySelector('.llm-settings-fields [role="switch"]').click(); await wait();
        for(const kind of ['codex','claude']) {
          click('从 CC Switch 导入'); await wait(); select(field('CC Switch 类型'),kind);
          await until(()=>[...document.querySelectorAll('.ccswitch-provider-item')].some(item=>item.textContent.includes('Fixture '+kind)));
          [...document.querySelectorAll('.ccswitch-provider-item')].find(item=>item.textContent.includes('Fixture '+kind)).click();
          await wait(); click('导入所选配置');
          await until(()=>checkbox('启用 Fixture '+kind));
          if(field('API Key').value)throw Error('Imported key reached renderer');
          if(!document.body.textContent.includes('API Key 已安全保存'))throw Error('Missing saved key indicator');
          click('获取模型'); await until(()=>[...field('审核模型').options].some(option=>option.value==='fixture-model'));
          select(field('审核模型'),'fixture-model'); await wait();
          click('测试连接'); await until(()=>document.body.textContent.includes('连接正常 · fixture-model'));
          checkbox('启用 Fixture '+kind).click(); await wait();
        }
        click('保存设置'); await wait(); await until(()=>!button('保存设置').disabled);
        if(document.querySelector('.form-error'))throw Error('Final save rejected');
        const saved=await window.agentManager.getLlmReviewSettings();
        if(!saved.enabled || saved.reviewers.length!==3 || saved.reviewers[0].enabled)throw Error('Draft state mismatch: '+JSON.stringify({enabled:saved.enabled,count:saved.reviewers.length,entries:saved.reviewers.map(entry=>({enabled:entry.enabled,hasApiKey:entry.hasApiKey,hasModel:!!entry.model}))}));
        if(!saved.reviewers.slice(1).every(entry=>entry.enabled && entry.hasApiKey && entry.model==='fixture-model' && !('apiKey' in entry)))throw Error('Imported reviewer was not saved');
      })()`)
      await new Promise((resolve, reject) => { win.webContents.once('did-finish-load', resolve); win.webContents.once('did-fail-load', reject); win.reload() })
      await win.webContents.executeJavaScript(`(async()=>{
        ${helpers}
        await until(()=>button('设置')); click('设置'); await wait(); click('审核器设置');
        await until(()=>button('保存设置') && !button('保存设置').disabled);
        for(const kind of ['codex','claude']) {
          const row=[...document.querySelectorAll('.reviewer-pool-select')].find(item=>item.textContent.includes('Fixture '+kind));
          if(!row)throw Error('Imported reviewer missing after reload'); row.click();await wait();
          if(field('API Key').value)throw Error('Saved key reached renderer');
          click('测试连接'); await until(()=>document.body.textContent.includes('连接正常 · fixture-model'));
        }
      })()`)
      if (requests.length !== 6 || requests.some(item => !item.authorized)) throw Error('Unexpected protocol or credential routing')
      const stored = fs.readFileSync(join(root, 'llm-review-settings.json'), 'utf8')
      if (Object.values(credentials).some(key => stored.includes(key))) throw Error('Credential was stored as plaintext')
      console.log(JSON.stringify({ ok: true, realSqliteReader: true, realEncryptedStore: true, realIPC: true, finalSave: true,
        reloadConnections: true, requests, isolatedUserData: root }))
      clearTimeout(timer); server.close(); app.exit(0)
    } catch (error) { console.error(error.message); clearTimeout(timer); server.close(); app.exit(1) }
  })
})
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) })
  const database = new SQL.Database()
  database.run('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER, sort_index INTEGER, created_at INTEGER)')
  database.run('CREATE TABLE provider_endpoints (provider_id TEXT, app_type TEXT, url TEXT, added_at INTEGER)')
  for (const kind of ['codex', 'claude']) {
    const baseUrl = `http://127.0.0.1:${port}/${kind}/v1`
    const settings = kind === 'codex' ? { auth: { OPENAI_API_KEY: credentials[kind] }, config: `model_provider='fixture'\n[model_providers.fixture]\nbase_url='${baseUrl}'\nwire_api='responses'` }
      : { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: credentials[kind] } }
    database.run('INSERT INTO providers VALUES (?, ?, ?, ?, 1, 1, 1)', [kind, kind, 'Fixture '+kind, JSON.stringify(settings)])
  }
  fs.writeFileSync(join(root, 'cc-switch.db'), database.export()); database.close()
  require(resolve(process.env.AGENT_TUI_SMOKE_ENTRY || 'dist-electron/main.js'))
})().catch(error => { console.error(error.message); clearTimeout(timer); server.close(); app.exit(1) })
