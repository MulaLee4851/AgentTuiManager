const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'running'

process.stdout.write('\u001b[36mfake-agent>\u001b[0m ')

if (mode === 'normal-exit') process.exit(0)
if (mode === 'crash') process.exit(1)
if (mode !== 'running') process.exit(2)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => process.stdout.write(data))
