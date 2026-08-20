import { describe, expect, it } from 'vitest'

import { nodeInstallCommandForPlatform, ripgrepInstallCommandForPlatform } from '../../electron/agent-environment-manager'
import { environmentWithFreshPath } from '../../electron/platform-environment'

describe('platform environment compatibility', () => {
  it('delegates Windows PATH handling to the existing implementation', () => {
    const environment = environmentWithFreshPath(
      { Path: 'C:\\existing' },
      { platform: 'win32', registryPaths: ['D:\\tools'] },
    )
    expect(environment.Path).toBe('C:\\existing;D:\\tools')
  })

  it('merges the macOS login PATH with standard package manager locations', () => {
    const environment = environmentWithFreshPath(
      { PATH: '/usr/bin:/bin' },
      { platform: 'darwin', loginPath: '/opt/homebrew/bin:/usr/bin' },
    )
    expect(environment.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin')
  })

  it('keeps Windows installers unchanged while exposing Homebrew on macOS', () => {
    expect(nodeInstallCommandForPlatform('win32')).toBe('winget install --id OpenJS.NodeJS.LTS --exact')
    expect(ripgrepInstallCommandForPlatform('win32')).toBe('winget install --id BurntSushi.ripgrep.MSVC --exact')
    expect(nodeInstallCommandForPlatform('darwin')).toBe('brew install node')
    expect(ripgrepInstallCommandForPlatform('darwin')).toBe('brew install ripgrep')
  })
})
