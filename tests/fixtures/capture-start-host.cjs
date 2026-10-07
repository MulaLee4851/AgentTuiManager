// Protocol-only fixture: capture synthetic start options without starting any CLI.
const net = require('node:net')
const args = process.argv.slice(2)
const endpoint = args[args.indexOf('--endpoint') + 1]
const hostId = args[args.indexOf('--host-id') + 1]
let start
const server = net.createServer(socket => {
  let buffer = ''
  const send = value => socket.write(JSON.stringify(value) + '\n')
  socket.on('error', () => {})
  socket.on('data', chunk => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const command = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
      if (command.type === 'start') { start = command; send({ type: 'ready', hostId }) }
      if (command.type === 'ping') send({ type: 'pong', ownership: 'managed' })
      if (command.type === 'replay') send({ type: 'replay', data: JSON.stringify(start) })
      if (command.type === 'stop') { send({ type: 'exit', exitCode: 0 }); socket.end(); server.close(); process.exit(0) }
    }
  })
})
server.listen(endpoint)
setTimeout(() => process.exit(1), 20000).unref()
