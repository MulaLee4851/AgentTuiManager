import { describe, expect, it } from 'vitest'
import { parseApprovalCommand } from '../../electron/approval-command-parser'
import { MAX_APPROVAL_COMMAND_LENGTH } from '../../src/shared/approval-input'

const deletion = 'Remove-Item -LiteralPath C:\\project\\build -Recurse -Force'
const hasDeletion = (source: string) => parseApprovalCommand(source).commandTokens?.some(command =>
  command.name === 'remove-item' || command.name === 'rm') ?? false

describe('static executable expansions', () => {
  it.each([
    `Write-Output "$(${deletion})"`,
    `Write-Output "prefix $(${deletion}) suffix"`,
    `Write-Output "$(Write-Output \"$(${deletion})\")"`,
    `Write-Output "$(Write-Output ')'; ${deletion})"`,
    `Write-Output "\\$(${deletion})"`,
    `pwsh -Command 'Write-Output "$(${deletion})"'`,
    `Write-Output @"\n'$(${deletion})'\n"@`,
    `Write-Output $(${deletion})`,
    'Write-Output "$(Remove-`\r\nItem -LiteralPath C:\\project\\build -Recurse -Force)"',
    `bash -c 'echo "$(rm -rf ./build)"'`,
    'bash -c \'echo "`rm -rf ./build`"\'',
    'printf "%s" "`rm -rf ./build`"',
    'bash -c \'echo "$(printf "%s" "$(rm -rf ./build)")"\'',
    'cat <<EOF\n"$(rm -rf ./build)"\nEOF',
    'python - <<PY\nprint("$(rm -rf ./build)")\nPY',
  ])('finds executed nested commands in %s', source => {
    const parsed = parseApprovalCommand(source)
    expect(parsed.incomplete).toBeUndefined()
    expect(hasDeletion(source)).toBe(true)
    expect(parsed.commandTokens).toHaveLength(parsed.commands.length)
  })

  it.each([
    `Write-Output '$(${deletion})'`,
    `Write-Output "\`$(${deletion})"`,
    'Write-Output "`Remove-Item C:\\project\\build`""',
    `Write-Output @'\n$(${deletion})\n'@`,
    `Write-Output @"\n\`$(${deletion})\n"@`,
    'bash -c \'echo "\\$(rm -rf ./build)"\'',
    "bash -c 'echo ''$(rm -rf ./build)'''",
    'bash -c "echo \'literal rm -rf ./build\'"',
    'cat <<\'EOF\'\n$(rm -rf ./build)\nEOF',
    'cat <<"EOF"\n$(rm -rf ./build)\nEOF',
    'cat <<EOF\n\\$(rm -rf ./build)\nEOF',
    `python -c 'print("$(${deletion})")'`,
    `node -e 'console.log("$(${deletion})")'`,
    'python - <<\'PY\'\nprint("$(rm -rf ./build)")\nPY',
    'node -e \'console.log(`<<EOF\n$(rm -rf ./build)\nEOF\n`)\'',
  ])('keeps non-executable literal content opaque in %s', source => {
    const parsed = parseApprovalCommand(source)
    expect(parsed.incomplete).toBeUndefined()
    expect(hasDeletion(source)).toBe(false)
  })

  it('retains inline-language code for its own inspection without parsing its string literals as shell commands', () => {
    const source = `print("$(${deletion})")`
    const parsed = parseApprovalCommand(`python -c '${source}'`)
    expect(parsed.code).toEqual([{ language: 'python', source }])
    expect(parsed.commands).toHaveLength(1)
  })

  it('does not consider incomplete nested expansions fully inspected', () => {
    expect(parseApprovalCommand('Write-Output "$(Remove-Item ./build"').incomplete).toBe('unterminated-command-substitution')
  })
})

describe('argument boundaries for preview matching', () => {
  it.each([
    ['git clean -ndx', ['clean', '-ndx']],
    ["git clean 'filename -n'", ['clean', 'filename -n']],
    ["git -C 'C:\\project path' clean -- '-n'", ['clean', '--', '-n']],
    ['robocopy C:\\source C:\\destination /MIR /L', ['C:\\source', 'C:\\destination', '/MIR', '/L']],
    ['robocopy "C:\\source /L" C:\\destination /MIR', ['C:\\source /L', 'C:\\destination', '/MIR']],
    [`${deletion} -WhatIf:$false`, ['-LiteralPath', 'C:\\project\\build', '-Recurse', '-Force', '-WhatIf:$false']],
    [`${deletion} '-WhatIf'`, ['-LiteralPath', 'C:\\project\\build', '-Recurse', '-Force', '-WhatIf']],
  ])('preserves one token per real argument for %s', (source, args) => {
    const parsed = parseApprovalCommand(source)
    expect(parsed.commandTokens).toHaveLength(parsed.commands.length)
    expect(parsed.commandTokens![0]!.args.map(argument => argument.value)).toEqual(args)
  })

  it('preserves original executable spelling, quoted flags, empty arguments and dynamic expressions', () => {
    const parsed = parseApprovalCommand('& "C:\\Program Files\\Git\\bin\\git.exe" clean "-n" \'\' "$(Write-Output target)"')
    expect(parsed.commandTokens![0]).toMatchObject({ name: 'git',
      executable: { value: 'C:\\Program Files\\Git\\bin\\git.exe', raw: '"C:\\Program Files\\Git\\bin\\git.exe"' },
      args: [
        { value: 'clean', raw: 'clean' }, { value: '-n', raw: '"-n"', quoted: 'double' },
        { value: '', raw: "''", quoted: 'single' },
        { value: '$(Write-Output target)', raw: '"$(Write-Output target)"', quoted: 'double', dynamic: true },
      ],
    })
  })

  it('keeps token metadata aligned for nested shell commands and synthetic pipeline markers', () => {
    const parsed = parseApprovalCommand('bash -c \'printf "%s" test | sh; git clean -n\'')
    expect(parsed.commandTokens).toHaveLength(parsed.commands.length)
    for (const [index, command] of parsed.commandTokens!.entries()) {
      expect(parsed.commands[index]).toBe(command.piped ? '| ' + command.name
        : [command.name, ...command.args.map(argument => argument.value)].join(' '))
    }
  })
})

describe('bounded intact command inspection', () => {
  const wrap = (body: string, count: number, double = false): string => {
    for (let index = 0; index < count; index++) body = double
      ? 'pwsh -Command "' + body.replace(/"/g, '""') + '"'
      : "pwsh -Command '" + body.replace(/'/g, "''") + "'"
    return body
  }

  it.each([0, 1, 2, 8])('inspects the dangerous tail of an intact 128 KiB command with %s wrapper levels', wrappers => {
    const build = (padding: string) => wrap('Write-Output ' + padding + '; ' + deletion, wrappers)
    const source = build('x'.repeat(MAX_APPROVAL_COMMAND_LENGTH - build('').length))
    expect(source).toHaveLength(MAX_APPROVAL_COMMAND_LENGTH)
    const parsed = parseApprovalCommand(source)
    expect(parsed.incomplete).toBeUndefined()
    expect(parsed.commandTokens?.some(command => command.name === 'remove-item')).toBe(true)
  })

  it('rejects a root above the shared command cap instead of inspecting a clipped prefix', () => {
    const source = 'Write-Output ' + 'x'.repeat(MAX_APPROVAL_COMMAND_LENGTH) + '; ' + deletion
    const parsed = parseApprovalCommand(source)
    expect(parsed.incomplete).toBe('command-length-limit')
    expect(parsed.commands).toEqual([])
  })

  it('keeps the existing nesting limit fail-closed', () => {
    expect(parseApprovalCommand(wrap(deletion, 9)).incomplete).toBe('nested-command-limit')
  })

  it('bounds repeated expansion work even when the intact root is within the input cap', () => {
    const build = (padding: string) => wrap('Write-Output $(Write-Output ' + padding + ')', 6, true)
    const source = build('x'.repeat(MAX_APPROVAL_COMMAND_LENGTH - build('').length))
    expect(source).toHaveLength(MAX_APPROVAL_COMMAND_LENGTH)
    expect(parseApprovalCommand(source).incomplete).toBe('nested-command-limit')
  })
})
