import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'

import { CCSwitchProviderReader, parseCCSwitchProvider, resolveCCSwitchDatabasePath, type CCSwitchProviderRow } from '../../electron/ccswitch-provider-reader'

function row(overrides: Partial<CCSwitchProviderRow> = {}): CCSwitchProviderRow {
  return {
    id: 'provider-1',
    appType: 'codex',
    name: 'Provider One',
    settingsConfig: '{}',
    isCurrent: true,
    ...overrides,
  }
}

describe('CCSwitch provider parsing', () => {
  it.each(['https://user:fictional-inline-key@gateway.example/v1', 'https://gateway.example/v1?api_key=fictional-inline-key', 'https://gateway.example/v1#fictional-inline-key'])('rejects credential-bearing service URLs before publishing summaries', baseUrl => {
    const provider = parseCCSwitchProvider(row({ settingsConfig: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fictional-api-key', ANTHROPIC_BASE_URL: baseUrl } }), appType: 'claude' }))
    expect(provider.baseUrl).toBeUndefined()
    expect(provider.issue).toContain('Base URL')
    expect(JSON.stringify(provider)).not.toContain('fictional-inline-key')
  })
  it('detects the selected wire protocol and hides credentials echoed in labels', () => {
    const provider = parseCCSwitchProvider(row({ name: 'gateway-fictional-key', settingsConfig: JSON.stringify({ auth: { OPENAI_API_KEY: 'fictional-key' }, config: "model_provider='custom'\nmodel='fictional-key'\n[model_providers.custom]\nbase_url='https://gateway.example/v1'\nwire_api='chat'" }) }))
    expect(provider.protocol).toBe('openai-chat')
    expect(provider.model).toBeUndefined()
    expect(provider.name).not.toContain('fictional-key')
  })
  it('parses Codex auth and the selected TOML provider without assuming its id', () => {
    const provider = parseCCSwitchProvider(row({
      settingsConfig: JSON.stringify({
        auth: { OPENAI_API_KEY: 'codex-secret' },
        config: `model_provider = 'my_gateway'\nmodel = 'gpt-5.6'\n[model_providers.my_gateway]\nbase_url = 'https://codex.example/v1'`,
      }),
    }))
    expect(provider).toMatchObject({
      id: 'provider-1',
      baseUrl: 'https://codex.example/v1',
      model: 'gpt-5.6',
      hasApiKey: true,
      apiKey: 'codex-secret',
    })
    expect(provider.issue).toBeUndefined()
  })

  it('parses Claude custom gateway variables used by CCSwitch', () => {
    const provider = parseCCSwitchProvider(row({
      appType: 'claude',
      settingsConfig: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'claude-secret',
          ANTHROPIC_BASE_URL: 'https://claude.example',
          ANTHROPIC_MODEL: 'claude-opus-4-1',
        },
      }),
    }))
    expect(provider).toMatchObject({
      baseUrl: 'https://claude.example',
      model: 'claude-opus-4-1',
      hasApiKey: true,
      apiKey: 'claude-secret',
    })
  })

  it('returns an unusable summary instead of exposing malformed provider content', () => {
    const provider = parseCCSwitchProvider(row({ settingsConfig: '{broken' }))
    expect(provider.hasApiKey).toBe(false)
    expect(provider.issue).toContain('Provider 配置无法解析')
    expect(JSON.stringify(provider)).not.toContain('{broken')
  })
  it('keeps login-backed accounts visible without importing account tokens', () => {
    const provider = parseCCSwitchProvider(row({settingsConfig: JSON.stringify({auth: {auth_mode: 'chatgpt', tokens: {access_token: 'private-token'}}})}))
    expect(provider.issue).toContain('Codex CLI 登录')
    expect(JSON.stringify(provider)).not.toContain('private-token')
    expect(parseCCSwitchProvider(row({id:'claude-official',appType:'claude',settingsConfig:'{"env":{}}'})).issue).toContain('官方登录')
    expect(JSON.stringify(parseCCSwitchProvider(row({settingsConfig:'{"secret":"private-value", broken'})))).not.toContain('private-value')
  })
})

const temporaryRoots: string[] = []
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ccswitch-path-test-')); temporaryRoots.push(root)
  return {root, appPaths: join(root, 'app_paths.json'), data: join(root, 'OneDrive 空间', '.cc-switch')}
}
async function database(directory: string, count: number, key: string) {
  await mkdir(directory, {recursive:true})
  const SQL = await initSqlJs({wasmBinary:new Uint8Array(await readFile(require.resolve('sql.js/dist/sql-wasm.wasm'))).buffer})
  const db = new SQL.Database()
  db.run('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER, sort_index INTEGER, created_at INTEGER); CREATE TABLE provider_endpoints (provider_id TEXT, app_type TEXT, url TEXT, added_at INTEGER)')
  for (let i=0;i<count;i++) db.run('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?)', [
    'provider-'+i, 'codex', 'Gateway '+i, JSON.stringify({auth:{OPENAI_API_KEY:key},config:"model_provider='custom'\n[model_providers.custom]\nbase_url='https://gateway.example/v1'"}), i===0?1:0, i, i,
  ])
  db.run('INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?, ?)', ['claude-1','claude','Claude Gateway',JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://claude.example',ANTHROPIC_AUTH_TOKEN:key}}),1,0,0])
  await writeFile(join(directory,'cc-switch.db'),db.export()); db.close()
}

describe('CC Switch custom data directory', () => {
  it('uses the default directory when no override exists', async () => {
    const f=await fixture()
    expect(await resolveCCSwitchDatabasePath(f.appPaths,f.root)).toBe(join(f.root,'.cc-switch','cc-switch.db'))
    await writeFile(f.appPaths, JSON.stringify({app_config_dir_override:null}))
    expect(await resolveCCSwitchDatabasePath(f.appPaths,f.root)).toBe(join(f.root,'.cc-switch','cc-switch.db'))
  })
  it('lists every matching provider from the configured directory, and imports from that same source', async () => {
    const f=await fixture()
    await database(join(f.root,'.cc-switch'),1,'stale-key')
    await database(f.data,26,'correct-key')
    await writeFile(f.appPaths,JSON.stringify({app_config_dir_override:f.data}))
    const reader=new CCSwitchProviderReader(undefined,f.appPaths,f.root)
    const summaries=await reader.list('codex')
    expect(summaries).toHaveLength(26)
    expect(summaries.at(-1)?.name).toBe('Gateway 25')
    expect(JSON.stringify(summaries)).not.toContain('correct-key')
    expect(await reader.import('codex','provider-25')).toMatchObject({apiKey:'correct-key',source:'ccswitch'})
    expect(await reader.list('claude')).toHaveLength(1)
    expect(await reader.importForReview('claude', 'claude-1')).toMatchObject({ enabled: false, backend: 'api', protocol: 'anthropic-messages', anthropicAuth: 'bearer', apiKey: 'correct-key' })
    expect(await reader.importForReview('codex', 'provider-25')).toMatchObject({ protocol: 'openai-responses', apiKey: 'correct-key' })
    await expect(reader.importForReview('codex', "provider-25' OR 1=1 --")).rejects.toThrow('不完整')
    await writeFile(f.appPaths,JSON.stringify({app_config_dir_override:null}))
    expect(await reader.list('codex')).toHaveLength(1)
    expect(await reader.import('codex','provider-0')).toMatchObject({apiKey:'stale-key'})
  })
  it('does not silently use the stale default database if the custom location is unavailable', async () => {
    const f=await fixture(); await database(join(f.root,'.cc-switch'),1,'stale-key')
    await writeFile(f.appPaths,JSON.stringify({app_config_dir_override:f.data}))
    await expect(new CCSwitchProviderReader(undefined,f.appPaths,f.root).list('codex')).rejects.toThrow('当前数据目录')
  })
  it('rejects malformed and relative overrides without echoing file contents', async () => {
    const f=await fixture()
    await writeFile(f.appPaths,'{"secret":"private-value",broken')
    await expect(resolveCCSwitchDatabasePath(f.appPaths,f.root)).rejects.toThrow('格式无效')
    await writeFile(f.appPaths,JSON.stringify({app_config_dir_override:'relative/folder'}))
    await expect(resolveCCSwitchDatabasePath(f.appPaths,f.root)).rejects.toThrow('绝对路径')
  })
})
