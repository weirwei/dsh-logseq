import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { extractZipEntry, openAsar } from '../lib/archive.js'

let dir
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'archive-test-'))
})
after(() => rm(dir, { recursive: true, force: true }))

/** Build a zip with the given entries ({name, data, method}). */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data, method } of entries) {
    const body = method === 8 ? deflateRawSync(data) : data
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, body)
    centrals.push(central, n)
    offset += 30 + n.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** Build an asar archive holding the given files. */
function makeAsar(files) {
  const header = { files: {} }
  const bodies = []
  let offset = 0
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/')
    let node = header
    for (const part of parts.slice(0, -1)) node = node.files[part] ??= { files: {} }
    node.files[parts.at(-1)] = { size: data.length, offset: String(offset) }
    bodies.push(data)
    offset += data.length
  }
  const json = Buffer.from(JSON.stringify(header))
  const padded = Math.ceil(json.length / 4) * 4
  const pickle = Buffer.alloc(8 + padded)
  pickle.writeUInt32LE(4 + padded, 0)
  pickle.writeUInt32LE(json.length, 4)
  json.copy(pickle, 8)
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(pickle.length, 4)
  return Buffer.concat([prefix, pickle, ...bodies])
}

test('extracts deflated and stored zip entries', async () => {
  const zip = join(dir, 'a.zip')
  const big = Buffer.from('x'.repeat(100_000) + 'end')
  await writeFile(zip, makeZip([
    { name: 'other.txt', data: Buffer.from('nope'), method: 0 },
    { name: 'resources/app.asar', data: big, method: 8 },
    { name: 'stored.bin', data: Buffer.from('raw'), method: 0 },
  ]))
  await extractZipEntry(zip, 'resources/app.asar', join(dir, 'out1'))
  assert.deepEqual(await readFile(join(dir, 'out1')), big)
  await extractZipEntry(zip, 'stored.bin', join(dir, 'out2'))
  assert.equal(await readFile(join(dir, 'out2'), 'utf8'), 'raw')
  await assert.rejects(extractZipEntry(zip, 'missing', join(dir, 'out3')), /entry not found/)
})

test('reads nested files from an asar archive', async () => {
  const asarPath = join(dir, 'app.asar')
  await writeFile(asarPath, makeAsar({
    'package.json': Buffer.from('{}'),
    'js/logseq-cli.js': Buffer.from('console.log("cli")'),
    'js/db-worker-node.js': Buffer.from('console.log("worker")'),
  }))
  const asar = await openAsar(asarPath)
  try {
    assert.equal((await asar.read('js/logseq-cli.js')).toString(), 'console.log("cli")')
    assert.equal((await asar.read('js/db-worker-node.js')).toString(), 'console.log("worker")')
    await assert.rejects(asar.read('js/nope.js'), /not found/)
  } finally {
    await asar.close()
  }
})

export { makeAsar, makeZip }
