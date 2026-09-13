const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

for (const scenario of ['authenticated', 'unauthorized', 'missing-entry']) {
  test(`runtime smoke validates ${scenario} frontend`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-smoke-fixture-'))
    try {
      fs.mkdirSync(path.join(root, 'lib'))
      fs.writeFileSync(path.join(root, 'lib', 'bin.js'), `
        const http = require('node:http');
        if (process.argv.includes('--dump-default-config')) {
          console.log('web-server: {}'); process.exit(0);
        }
        if (!process.argv.includes('--no-open')) process.exit(4);
        const server = http.createServer((req, res) => {
          if (${JSON.stringify(scenario)} === 'unauthorized') { res.writeHead(401); return res.end(); }
          if (req.url.includes('token=')) {
            res.writeHead(303, { location: '/', 'set-cookie': 'session=fixture; HttpOnly' }); return res.end();
          }
          if (req.headers.cookie !== 'session=fixture') { res.writeHead(401); return res.end(); }
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(${JSON.stringify(scenario)} === 'missing-entry' ? '<html>error</html>' : '<script src="/assets/app.js"></script>');
        });
        server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fixture-secret'));
      `)
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'test-runtime.mjs'), root], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      })
      assert.ifError(result.error)
      assert.equal(result.status, scenario === 'authenticated' ? 0 : 1, result.stdout + result.stderr)
      assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
