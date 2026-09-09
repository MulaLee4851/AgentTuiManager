const { readFileSync } = require('node:fs')
const { join } = require('node:path')

function verifyPe(buffer) {
  const fail = (message) => { throw new Error(`Invalid Windows executable: ${message}`) }
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') fail('missing DOS header')
  const pe = buffer.readUInt32LE(60)
  if (pe + 24 > buffer.length || buffer.readUInt32LE(pe) !== 0x4550) fail('missing PE header')
  if (buffer.readUInt16LE(pe + 4) !== 0x8664) fail('expected Windows x64')
  const count = buffer.readUInt16LE(pe + 6)
  const table = pe + 24 + buffer.readUInt16LE(pe + 20)
  if (!count || table + count * 40 > buffer.length) fail('truncated section table')
  for (let i = 0; i < count; i++) {
    const section = table + i * 40
    const size = buffer.readUInt32LE(section + 16)
    const offset = buffer.readUInt32LE(section + 20)
    if (size && (offset < table + count * 40 || offset + size > buffer.length)) {
      fail(`section ${i} extends outside executable data`)
    }
  }
}

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return
  const executable = join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  verifyPe(readFileSync(executable))
  console.log(`Verified Windows x64 executable: ${executable}`)
}
module.exports.verifyPe = verifyPe

if (require.main === module) {
  for (const path of process.argv.slice(2)) {
    verifyPe(readFileSync(path))
    console.log(`Verified Windows x64 executable: ${path}`)
  }
}
