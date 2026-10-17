import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { saveConfigFile } from '../lib/config.js'
import { Controller, UserError } from '../lib/controller.js'
import { mountRoutes, sameOrigin } from '../lib/web.js'

let dir
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'web-test-'))
})
after(() => rm(dir, { recursive: true, force: true }))

test('config: saveConfigFile merges, removes null keys, writes 0600', async () => {
  await writeFile(join(dir, 'config.json'), JSON.stringify({ server: 'https://old', readOnly: true, graphs: ['A'] }))
  await saveConfigFile(dir, { server: 'https://new', graphs: ['B', 'C'], e2eePassword: undefined })
  let saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
  assert.deepEqual(saved, { server: 'https://new', readOnly: true, graphs: ['B', 'C'] })
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600)
  await saveConfigFile(dir, { server: null })
  saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
  assert.equal(saved.server, undefined)
})

test('controller: status never exposes the E2EE password; setup validates input', async () => {
  const d = await mkdtemp(join(dir, 'ctl-'))
  await writeFile(join(d, 'config.json'), JSON.stringify({ e2eePassword: 'top-secret' }))
  const c = new Controller({ dataDir: d }, { info() {}, warn() {} })
  const s = c.status()
  assert.equal(s.config.hasE2eePassword, true)
  assert.ok(!JSON.stringify(s).includes('top-secret'))
  assert.equal(s.runtime.state, 'missing')
  assert.equal(s.auth.loggedIn, false)
  // Fake runtime so the restarted daemon does not download the real one.
  await mkdir(join(d, 'runtime', '2.0.2', 'js'), { recursive: true })
  await writeFile(join(d, 'runtime', '2.0.2', '.ready'), '2.0.2\n')
  await writeFile(join(d, 'runtime', '2.0.2', 'js', 'logseq-cli.js'), 'console.log(JSON.stringify({status:"ok",data:{graphs:[]}}))')
  assert.equal(c.status().runtime.state, 'ready')
  await assert.rejects(c.saveSetup({ server: 'ftp://x' }), UserError)
  await assert.rejects(c.saveSetup({ graphs: 'A' }), UserError)
  // Empty password keeps the saved one.
  await c.saveSetup({ server: 'https://sync.example.com/', graphs: [' A ', 'A', ''], e2eePassword: '' })
  const saved = JSON.parse(await readFile(join(d, 'config.json'), 'utf8'))
  assert.deepEqual(saved, { e2eePassword: 'top-secret', server: 'https://sync.example.com', graphs: ['A'] })
  assert.deepEqual(c.config.graphs, ['A'])
  // An empty list removes the key: sync every graph on the server.
  await c.saveSetup({ graphs: [] })
  assert.equal(JSON.parse(await readFile(join(d, 'config.json'), 'utf8')).graphs, undefined)
  assert.deepEqual(c.config.graphs, [])
  assert.equal(c.daemon.auto, true)
  await c.stop()
})

test('controller: reads the logged-in email from auth.json', async () => {
  const d = await mkdtemp(join(dir, 'auth-'))
  const payload = Buffer.from(JSON.stringify({ email: 'me@example.com', exp: 1700000000 })).toString('base64url')
  await writeFile(join(d, 'auth.json'), JSON.stringify({ 'id-token': `h.${payload}.s` }))
  const c = new Controller({ dataDir: d }, { info() {}, warn() {} })
  assert.deepEqual(c.status().auth, { loggedIn: true, email: 'me@example.com', expiresAt: 1700000000000 })
  // Logout removes both the CLI copy and the seed, so the seed is not copied back.
  await mkdir(join(d, 'logseq'), { recursive: true })
  await writeFile(join(d, 'logseq', 'auth.json'), '{}')
  await c.logout()
  assert.equal(c.status().auth.loggedIn, false)
})

// ---- routes ----------------------------------------------------------------------------

function fakeServer(connection) {
  const routes = new Map()
  const ctx = {
    get: (name) => (name === 'connection' ? connection : undefined),
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const call = async (path, { method = 'GET', headers = {}, body } = {}) => {
    const [pathname] = path.split('?')
    const route = routes.get(pathname)
    if (!route) return { status: 404 }
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
    Object.assign(req, { method, url: path, headers: { host: '127.0.0.1:3000', ...headers } })
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status
        this.headersSent = true
      },
      end(text) {
        this.body = text ? JSON.parse(text) : undefined
      },
    }
    await route.handler(req, res)
    return res
  }
  return { ctx, routes, call }
}

test('web: host gate is enforced; without it only loopback is admitted', async () => {
  const calls = []
  const controller = { status: () => ({ ok: 'status' }), config: { graphs: [] } }
  const gated = fakeServer({ requestRejection: (req) => (calls.push(req.url), 401) })
  const dispose = mountRoutes(gated.ctx, () => controller)
  assert.equal((await gated.call('/dsh-logseq/api/status')).status, 401)
  assert.deepEqual(calls, ['/dsh-logseq/api/status'])
  dispose()
  assert.equal(gated.routes.size, 0)

  const open = fakeServer(undefined)
  mountRoutes(open.ctx, () => controller)
  assert.equal((await open.call('/dsh-logseq/api/status')).status, 200)
  assert.equal((await open.call('/dsh-logseq/api/status', { headers: { host: 'example.com' } })).status, 403)

  const throwing = fakeServer({
    requestRejection() {
      throw new Error('boom')
    },
  })
  mountRoutes(throwing.ctx, () => controller)
  assert.equal((await throwing.call('/dsh-logseq/api/status')).status, 403)
})

test('web: POST needs same origin + JSON; errors map to 400 without leaking', async () => {
  let got
  const controller = {
    config: { graphs: ['A'] },
    login: async (u, p) => {
      got = [u, p]
      return { loggedIn: true }
    },
    saveSetup: async (b) => {
      if (b.server === 'ftp://x') throw new UserError('server must be an http(s) URL')
    },
    status: () => ({}),
  }
  const s = fakeServer({ requestRejection: () => undefined })
  mountRoutes(s.ctx, () => controller)
  const json = { 'content-type': 'application/json' }
  assert.equal((await s.call('/dsh-logseq/api/login', { method: 'GET' })).status, 405)
  assert.equal((await s.call('/dsh-logseq/api/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await s.call('/dsh-logseq/api/login', { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body: {} })).status, 403)
  assert.equal((await s.call('/dsh-logseq/api/login', { method: 'POST', headers: json, body: {} })).status, 400)
  const ok = await s.call('/dsh-logseq/api/login', { method: 'POST', headers: { ...json, origin: 'http://127.0.0.1:3000' }, body: { username: 'u', password: 'p' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(got, ['u', 'p'])
  const bad = await s.call('/dsh-logseq/api/setup', { method: 'POST', headers: json, body: { server: 'ftp://x' } })
  assert.deepEqual([bad.status, bad.body.error], [400, 'server must be an http(s) URL'])
  assert.equal((await s.call('/dsh-logseq/api/setup', { method: 'POST', headers: json, body: '{bad' })).status, 400)
  assert.equal(s.routes.has('/dsh-logseq/api/page'), false)
})

test('web: sameOrigin rejects cross-site fetch metadata and mismatched Origin', () => {
  const req = (headers) => ({ headers: { host: 'dsh.example.com', ...headers } })
  assert.equal(sameOrigin(req({ origin: 'https://dsh.example.com' })), true)
  assert.equal(sameOrigin(req({ origin: 'https://evil.example.com' })), false)
  assert.equal(sameOrigin(req({ 'sec-fetch-site': 'cross-site', origin: 'https://dsh.example.com' })), false)
  assert.equal(sameOrigin(req({ origin: 'null' })), false)
})

test('sync: auto mode adds the graphs found on the server and skips the probe graph', async () => {
  const d = await mkdtemp(join(dir, 'auto-'))
  const rt = join(d, 'runtime', '2.0.2')
  await mkdir(join(rt, 'js'), { recursive: true })
  await writeFile(join(rt, '.ready'), '2.0.2\n')
  // Fake CLI: remote-graphs returns two graphs plus the probe, everything else is ok/empty.
  await writeFile(
    join(rt, 'js', 'logseq-cli.js'),
    `const a=process.argv.slice(2);const d=a[0]==='sync'&&a[1]==='remote-graphs'?{graphs:[{'graph-name':'A','graph-e2ee?':true},{'graph-name':'B'},{'graph-name':'dsh-logseq-probe'}]}:{graphs:[]};console.log(JSON.stringify({status:'ok',data:d}))`,
  )
  const { SyncDaemon } = await import('../lib/sync.js')
  const { loadConfig } = await import('../lib/config.js')
  const daemon = new SyncDaemon(loadConfig({ dataDir: d, server: 'https://s.example.com' }), { info() {}, warn() {} })
  let changed = 0
  daemon.onGraphsChanged = () => changed++
  await daemon.discover()
  assert.deepEqual(daemon.graphNames(), ['A', 'B'])
  await daemon.discover()
  assert.equal(changed, 1)
})
