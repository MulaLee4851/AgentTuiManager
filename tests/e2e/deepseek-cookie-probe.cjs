// Isolated browser-level regression probe; no real DSH, accounts or model calls.
const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')

app.whenReady().then(async () => {
  const windows = []
  const server = createServer((req, res) => {
    if (req.url === '/?token=fixture') {
      res.writeHead(303, { location: '/', 'set-cookie': 'probe=fixture; HttpOnly; SameSite=Strict; Path=/' })
      return res.end()
    }
    const authenticated = req.headers.cookie?.includes('probe=fixture')
    res.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/html' })
    res.end(authenticated ? 'AUTH_OK' : 'AUTH_MISSING')
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/?token=fixture`
    const makeWindow = partition => {
      const win = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      windows.push(win)
      return win
    }
    const frame = makeWindow('probe-frame')
    await frame.loadURL('data:text/html,' + encodeURIComponent(`<iframe src="${url}"></iframe>`))
    const child = frame.webContents.mainFrame.frames[0]
    assert.equal(await child.executeJavaScript('document.body.textContent'), 'AUTH_MISSING')
    const top = makeWindow('probe-top')
    await top.loadURL(url)
    assert.equal(await top.webContents.executeJavaScript('document.body.textContent'), 'AUTH_OK')
    console.log('PASS: cross-site iframe loses Strict authentication; top-level page authenticates.')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    for (const win of windows) win.destroy()
    server.close()
    app.exit(process.exitCode || 0)
  }
})
