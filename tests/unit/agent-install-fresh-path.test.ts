import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  environment: { Path: 'C:\\fresh-node;C:\\fresh-npm' },
  resolve: vi.fn(() => 'C:\\fresh-node\\npm.cmd'),
}))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn,
}))
vi.mock('../../electron/platform-environment', () => ({
  environmentWithFreshPath: () => mocks.environment,
  pathFromEnvironment: (env: typeof mocks.environment) => env.Path,
}))
vi.mock('../../electron/executable-resolution', () => ({ resolveExecutableForPty: mocks.resolve }))
import { installAgent } from '../../electron/agent-environment-manager'

it.skipIf(process.platform !== 'win32')('updates with latest tag and selected registry, serializes requests and releases lock after failure', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
  mocks.spawn.mockReturnValue(child)
  const progress = vi.fn()
  const pending = installAgent('codex', 'official', progress, 'update')
  await expect(installAgent('claude', 'configured', undefined, 'update')).rejects.toThrow('已有 Agent')
  expect(mocks.spawn).toHaveBeenLastCalledWith(expect.any(String),
    expect.arrayContaining(['install', '--global', '@openai/codex@latest', '--registry', 'https://registry.npmjs.org/']),
    expect.objectContaining({ env: mocks.environment, windowsHide: true }))
  const failure = expect(pending).rejects.toThrow('更新失败')
  child.emit('exit', 1, null)
  await failure
  mocks.spawn.mockImplementation(() => {
    const next = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
    queueMicrotask(() => next.emit('exit', 0, null))
    return next
  })
  await installAgent('codex', 'configured', progress, 'update')
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'completed', message: '更新完成' }))
})

it.skipIf(process.platform !== 'win32')('installs using refreshed PATH and resolved npm without restarting Manager', async () => {
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  })
  await installAgent('codex')
  expect(mocks.resolve).toHaveBeenCalledWith('npm', { path: mocks.environment.Path })
  expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String),
    expect.arrayContaining(['C:\\fresh-node\\npm.cmd', '@openai/codex']),
    expect.objectContaining({ env: mocks.environment, windowsHide: true }))
})
