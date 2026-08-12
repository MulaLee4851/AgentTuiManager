import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import { AgentProxyStore, environmentForAgentProxy } from '../../electron/agent-proxy-store'
import type { SecureConfigurationCodec } from '../../electron/agent-configuration-store'

const codec: SecureConfigurationCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a),
  decryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)).toString('utf8'),
}

describe('AgentProxyStore', () => {
  it('encrypts credentials and preserves only a safe summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-proxy-'))
    const path = join(root, 'proxies.json')
    const store = await AgentProxyStore.load(path, codec)
    const saved = await store.save({ enabled: true, protocol: 'http', host: '127.0.0.1', port: 7897, username: 'user', password: 'secret' })

    expect(saved).toMatchObject({ enabled: true, protocol: 'http', host: '127.0.0.1', port: 7897, username: 'user', hasPassword: true })
    expect(saved).not.toHaveProperty('password')
    expect(await readFile(path, 'utf8')).not.toContain('secret')
  })

  it('keeps an existing password when an Agent proxy is edited with an empty password', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-proxy-'))
    const store = await AgentProxyStore.load(join(root, 'proxies.json'), codec)
    const first = await store.save({ enabled: true, host: 'localhost', port: 7897, username: 'u', password: 'keep' })
    const updated = await store.save({ enabled: true, host: 'localhost', port: 8080, username: 'u' }, first?.proxyId)
    expect(store.get(updated!.proxyId)?.password).toBe('keep')
  })

  it('builds proxy variables only for the target Agent environment', () => {
    expect(environmentForAgentProxy({ proxyId: 'p', protocol: 'http', host: '127.0.0.1', port: 7897, username: 'u name', password: 'p@ss' })).toEqual({
      HTTP_PROXY: 'http://u%20name:p%40ss@127.0.0.1:7897',
      HTTPS_PROXY: 'http://u%20name:p%40ss@127.0.0.1:7897',
      http_proxy: 'http://u%20name:p%40ss@127.0.0.1:7897',
      https_proxy: 'http://u%20name:p%40ss@127.0.0.1:7897',
    })
  })
})
