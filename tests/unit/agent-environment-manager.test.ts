import { describe, expect, it } from 'vitest'

import { installCommandForAgent, installedExecutableVersion, packageForAgent, registryUrl, supportsDeepSeekNode } from '../../electron/agent-environment-manager'
import { mergeWindowsPaths } from '../../electron/windows-environment'

describe('Agent environment installation catalog', () => {
  it('uses fixed official npm packages instead of renderer-provided commands', () => {
    expect(packageForAgent('codex')).toBe('@openai/codex')
    expect(packageForAgent('claude')).toBe('@anthropic-ai/claude-code')
    expect(packageForAgent('deepseek')).toBe('@deepseek-ai/dsh')
    expect(packageForAgent('pi')).toBe('@earendil-works/pi-coding-agent@legacy-node20')
    expect(packageForAgent('generic')).toBeUndefined()
    expect(installCommandForAgent('codex')).toBe('npm install -g @openai/codex')
    expect(installCommandForAgent('deepseek')).toBe('npm install -g @deepseek-ai/dsh')
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

  it('keeps Pi installed when its executable exists but the version probe does not exit', () => {
    expect(installedExecutableVersion(undefined, true)).toBe('已检测到可执行文件（版本查询未结束）')
    expect(installedExecutableVersion(undefined, false)).toBeUndefined()
  })

  it('enforces the Node versions published by DeepSeek Harness', () => {
    expect(supportsDeepSeekNode('v22.19.0')).toBe(true)
    expect(supportsDeepSeekNode('24.0.0')).toBe(true)
    expect(supportsDeepSeekNode('v22.18.9')).toBe(false)
    expect(supportsDeepSeekNode('v20.20.0')).toBe(false)
  })
})
