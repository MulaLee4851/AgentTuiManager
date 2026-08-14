import { describe, expect, it } from 'vitest'

import { installCommandForAgent, packageForAgent, registryUrl } from '../../electron/agent-environment-manager'
import { mergeWindowsPaths } from '../../electron/windows-environment'

describe('Agent environment installation catalog', () => {
  it('uses fixed official npm packages instead of renderer-provided commands', () => {
    expect(packageForAgent('codex')).toBe('@openai/codex')
    expect(packageForAgent('claude')).toBe('@anthropic-ai/claude-code')
    expect(packageForAgent('pi')).toBe('@earendil-works/pi-coding-agent@legacy-node20')
    expect(packageForAgent('generic')).toBeUndefined()
    expect(installCommandForAgent('codex')).toBe('npm install -g @openai/codex')
    expect(registryUrl('configured')).toBeUndefined()
    expect(registryUrl('npmmirror')).toBe('https://registry.npmmirror.com/')
    expect(registryUrl('tencent')).toBe('https://mirrors.cloud.tencent.com/npm/')
    expect(registryUrl('huawei')).toBe('https://repo.huaweicloud.com/repository/npm/')
  })
})

describe('Pi Windows PATH refresh', () => {
  it('preserves inherited entries and appends newly installed locations once', () => {
    expect(mergeWindowsPaths(['C:\\existing;C:\\Shared', 'c:\\shared;D:\\new']))
      .toBe('C:\\existing;C:\\Shared;D:\\new')
  })
})
