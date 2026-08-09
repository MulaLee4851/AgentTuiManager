const { randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, unlink, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

function requiredArgument(name) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing required argument ${name}`)
  return value
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function normalizeWorkspace(workspace) {
  return resolve(workspace).toLocaleLowerCase('en-US')
}

async function persist(path, conversation) {
  const temporaryPath = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(conversation, null, 2))
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

async function main() {
  const nativeRoot = requiredArgument('--native-root')
  const workspace = requiredArgument('--workspace')
  const sessionsRoot = join(nativeRoot, 'sessions')
  const resumeId = optionalArgument('--resume')
  if (resumeId !== undefined) {
    if (!/^[a-zA-Z0-9-]+$/.test(resumeId)) throw new Error('Invalid native session id')
    const conversation = JSON.parse(await readFile(join(sessionsRoot, `${resumeId}.json`), 'utf8'))
    if (conversation.sessionId !== resumeId) throw new Error('Native session id does not match persisted data')
    if (normalizeWorkspace(conversation.workspace) !== normalizeWorkspace(workspace)) {
      throw new Error(`Native session ${resumeId} does not belong to workspace ${workspace}`)
    }
    const encoded = Buffer.from(JSON.stringify(conversation), 'utf8').toString('base64')
    process.stdout.write(`NATIVE_RESUME_JSON=${encoded}\n`)
    return
  }
  const sessionId = randomUUID()
  const nativePath = join(sessionsRoot, `${sessionId}.json`)
  const conversation = { sessionId, workspace, turns: [] }
  await mkdir(sessionsRoot, { recursive: true })
  await persist(nativePath, conversation)

  process.stdout.write(`NATIVE_FIXTURE_PID=${process.pid}\n`)
  process.stdout.write(`NATIVE_SESSION_ID=${sessionId}\n`)
  process.stdout.write('NATIVE_FIXTURE_READY\n')

  process.stdin.setEncoding('utf8')
  let input = ''
  let pending = Promise.resolve()

  const consume = () => {
    for (;;) {
      const separator = input.search(/[\r\n]/)
      if (separator < 0) return
      const line = input.slice(0, separator)
      input = input.slice(separator + 1).replace(/^[\r\n]+/, '')
      if (!line) continue
      pending = pending.then(async () => {
        if (line === '@native-session') {
          process.stdout.write(`NATIVE_SESSION_ID=${sessionId}\n`)
          return
        }
        conversation.turns.push(line)
        await persist(nativePath, conversation)
        process.stdout.write(`NATIVE_TURN_PERSISTED=${conversation.turns.length}\n`)
      })
    }
  }

  process.stdin.on('data', (data) => {
    input += data
    consume()
  })
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
