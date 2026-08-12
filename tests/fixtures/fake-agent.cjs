const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'running'

process.stdout.write('\u001b[36mfake-agent>\u001b[0m ')
const printEnvIndex = process.argv.indexOf('--print-env')
if (printEnvIndex >= 0) process.stdout.write(`env:${process.env[process.argv[printEnvIndex + 1]] ?? 'missing'} `)

if (mode === 'normal-exit') process.exit(0)
if (mode === 'crash') process.exit(1)
if (mode !== 'running') process.exit(2)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  process.stdout.write(data)
  if (data.includes('exit 1')) process.exit(1)
})
