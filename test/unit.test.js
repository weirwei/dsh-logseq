import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/config.js'
import { buildTools } from '../lib/tools.js'

let dir
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'unit-test-'))
})
after(() => rm(dir, { recursive: true, force: true }))

test('config: file values, derived ws url, env overrides', async () => {
  await writeFile(join(dir, 'config.json'), JSON.stringify({ server: 'https://sync.example.com/', graphs: ['A', 'B'], e2eePassword: 'p' }))
  const c = loadConfig({ dataDir: dir })
  assert.equal(c.server, 'https://sync.example.com')
  assert.equal(c.wsUrl, 'wss://sync.example.com/sync/%s')
  assert.deepEqual(c.graphs, ['A', 'B'])
  assert.equal(c.sync, true)
  assert.equal(c.logseqVersion, '2.0.2')

  process.env.DSH_LOGSEQ_GRAPHS = 'X, Y'
  try {
    assert.deepEqual(loadConfig({ dataDir: dir }).graphs, ['X', 'Y'])
  } finally {
    delete process.env.DSH_LOGSEQ_GRAPHS
  }
})

test('config: missing file means sync off, invalid file throws', async () => {
  const empty = await mkdtemp(join(dir, 'empty-'))
  const c = loadConfig({ dataDir: empty })
  assert.equal(c.sync, false)
  assert.deepEqual(c.graphs, [])
  await writeFile(join(empty, 'config.json'), '{oops')
  assert.throws(() => loadConfig({ dataDir: empty }), /invalid/)
})


test('tools: read-only mode drops write tools', () => {
  const config = loadConfig({ dataDir: dir, graphs: ['Miki'], readOnly: true })
  const names = buildTools(config).map((t) => t.name)
  assert.ok(names.includes('logseq_search'))
  assert.ok(!names.some((n) => n.startsWith('logseq_upsert') || n === 'logseq_remove'))
})

test('tools: schemas are closed objects with valid required keys', () => {
  const config = loadConfig({ dataDir: dir, graphs: ['Miki'] })
  for (const t of buildTools(config)) {
    assert.equal(t.parameters.type, 'object')
    assert.equal(t.parameters.additionalProperties, false)
    for (const r of t.parameters.required ?? []) assert.ok(r in t.parameters.properties, `${t.name}.${r}`)
    assert.equal(typeof t.execute, 'function')
    assert.deepEqual(t.output.render({}, 'x'), [{ type: 'text', text: 'x' }])
  }
})

test('tools: argv uses --flag=value, so values starting with "-" stay values', async () => {
  // Fake runtime: a CLI that echoes its argv as the JSON envelope.
  const runtime = join(dir, 'runtime', '2.0.2')
  execFileSync('mkdir', ['-p', join(runtime, 'js')])
  await writeFile(join(runtime, '.ready'), '2.0.2\n')
  await writeFile(
    join(runtime, 'js', 'logseq-cli.js'),
    'console.log(JSON.stringify({status:"ok",data:{argv:process.argv.slice(2),home:process.env.HOME}}))',
  )
  const config = loadConfig({ dataDir: dir, graphs: ['Miki'] })
  const tools = Object.fromEntries(buildTools(config).map((t) => [t.name, t]))

  const search = JSON.parse(await tools.logseq_search.execute({ type: 'block', content: '--force' }))
  assert.deepEqual(search.argv.slice(0, 4), ['search', 'block', '--content=--force', '--graph=Miki'])
  assert.equal(search.home, dir)
  const edn = await readFile(join(dir, 'logseq', 'cli.edn'), 'utf8')
  assert.match(edn, /:http-base "https:\/\/sync\.example\.com"/)
  assert.match(edn, /:ws-url "wss:\/\/sync\.example\.com\/sync\/%s"/)
  assert.match(edn, /:oauth-token-endpoint "https:\/\/logseq-prod\.auth\.us-east-1\.amazoncognito\.com\/oauth2\/token"/)

  const upsert = await tools.logseq_upsert_block.execute({ graph: 'Daily', targetPage: 'P', blocks: '- a\n  - b', updateTags: '["AI"]' })
  const argv = JSON.parse(upsert).argv
  assert.ok(argv.includes('--target-page=P'))
  assert.ok(argv.includes('--blocks=- a\n  - b'))
  assert.ok(argv.includes('--update-tags=["AI"]'))
  assert.ok(argv.includes('--graph=Daily'))

  const big = '- ' + 'x'.repeat(70_000)
  const bigArgv = JSON.parse((await tools.logseq_upsert_block.execute({ targetPage: 'P', blocks: big }))).argv
  assert.ok(bigArgv.some((a) => a.startsWith('--blocks-file=')))

  await assert.rejects(tools.logseq_show.execute({}), /one of page, id, uuid/)
  await assert.rejects(tools.logseq_remove.execute({ type: 'block', page: 'x' }), /one of id, uuid/)
  const rm1 = JSON.parse(await tools.logseq_remove.execute({ type: 'page', page: 'Old', force: true }).then((s) => s)).argv
  assert.deepEqual(rm1.slice(0, 4), ['remove', 'page', '--page=Old', '--force'])
})

test('keytar shim persists to file with 0600', async () => {
  const file = join(dir, 'kt.json')
  const shim = fileURLToPath(new URL('../runtime-shims/keytar.cjs', import.meta.url))
  const script = `const k=require(${JSON.stringify(shim)});(async()=>{await k.setPassword('Logseq E2EE','g1','secret');console.log(await k.getPassword('Logseq E2EE','g1'))})()`
  const env = { ...process.env, LOGSEQ_KEYTAR_FILE: file }
  assert.equal(execFileSync(process.execPath, ['-e', script], { env }).toString().trim(), 'secret')
  const read = `require(${JSON.stringify(shim)}).getPassword('Logseq E2EE','g1').then(console.log)`
  assert.equal(execFileSync(process.execPath, ['-e', read], { env }).toString().trim(), 'secret')
  const { statSync } = await import('node:fs')
  assert.equal(statSync(file).mode & 0o777, 0o600)
})
