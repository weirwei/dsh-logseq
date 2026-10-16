/**
 * Prepares the Logseq CLI runtime: the two platform-independent JS bundles
 * (`js/logseq-cli.js`, `js/db-worker-node.js`) taken from the official desktop release,
 * plus shims for the only two external modules they `require`: `ws` and `keytar`.
 *
 * The bundles are extracted from the Linux x86_64 release zip regardless of the host
 * architecture — they are plain JS; the native modules in the zip are not used.
 */
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { extractZipEntry, openAsar } from './archive.js'

const require = createRequire(import.meta.url)
const shimsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime-shims')
const BUNDLES = ['js/logseq-cli.js', 'js/db-worker-node.js']
const MARKER = '.ready'

/** @param {import('./config.js').LogseqConfig} config */
export function runtimeDir(config) {
  return join(config.dataDir, 'runtime', config.logseqVersion)
}

/** @param {import('./config.js').LogseqConfig} config */
export function cliPath(config) {
  return join(runtimeDir(config), 'js', 'logseq-cli.js')
}

/** @param {import('./config.js').LogseqConfig} config */
export function defaultRuntimeUrl(config) {
  const v = config.logseqVersion
  return `https://github.com/logseq/logseq/releases/download/${encodeURIComponent(v)}/Logseq-linux-x86_64-${encodeURIComponent(v)}.zip`
}

let pending

/**
 * Ensure the runtime exists; download and extract once if not. Concurrent callers share
 * one preparation.
 * @param {import('./config.js').LogseqConfig} config
 * @param {(msg: string) => void} [log]
 * @returns {Promise<string>} path to logseq-cli.js
 */
export function ensureRuntime(config, log = () => {}) {
  const dir = runtimeDir(config)
  if (existsSync(join(dir, MARKER))) {
    // Shims are cheap; refresh them so plugin upgrades take effect without re-downloading.
    return writeShims(dir).then(() => cliPath(config))
  }
  pending ??= prepare(config, dir, log).finally(() => {
    pending = undefined
  })
  return pending
}

async function prepare(config, dir, log) {
  const staging = `${dir}.staging-${process.pid}`
  // A previous dsh process killed mid-download (e.g. restarted right after install) leaves
  // its staging dir behind; only one dsh process prepares the runtime, so clear them all.
  const parent = dirname(dir)
  const prefix = `${basename(dir)}.staging-`
  for (const name of await readdir(parent).catch(() => [])) {
    if (name.startsWith(prefix)) await rm(join(parent, name), { recursive: true, force: true })
  }
  await mkdir(join(staging, 'js'), { recursive: true })
  try {
    let asarPath = config.runtimeAsar
    if (!asarPath) {
      const url = config.runtimeUrl || defaultRuntimeUrl(config)
      const zipPath = join(staging, 'release.zip')
      log(`downloading Logseq ${config.logseqVersion} runtime from ${url}`)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${url}`)
      await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath))
      asarPath = join(staging, 'app.asar')
      await extractZipEntry(zipPath, 'resources/app.asar', asarPath)
      await rm(zipPath, { force: true })
    }
    const asar = await openAsar(asarPath)
    try {
      for (const bundle of BUNDLES) await writeFile(join(staging, bundle), await asar.read(bundle))
    } finally {
      await asar.close()
    }
    if (!config.runtimeAsar) await rm(asarPath, { force: true })
    await writeShims(staging)
    await writeFile(join(staging, MARKER), `${config.logseqVersion}\n`)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dirname(dir), { recursive: true })
    await rename(staging, dir)
    log(`Logseq runtime ready at ${dir}`)
    return cliPath(config)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function writeShims(dir) {
  const keytar = join(dir, 'node_modules', 'keytar')
  await mkdir(keytar, { recursive: true })
  await copyFile(join(shimsDir, 'keytar.cjs'), join(keytar, 'index.js'))
  await writeFile(join(keytar, 'package.json'), '{"name":"keytar","main":"index.js"}\n')

  // Re-export this plugin's own `ws` so the version is pinned by package.json.
  const ws = join(dir, 'node_modules', 'ws')
  await mkdir(ws, { recursive: true })
  const target = require.resolve('ws')
  const body = `module.exports = require(${JSON.stringify(target)})\n`
  const current = await readFile(join(ws, 'index.js'), 'utf8').catch(() => '')
  if (current !== body) await writeFile(join(ws, 'index.js'), body)
  await writeFile(join(ws, 'package.json'), '{"name":"ws","main":"index.js"}\n')
}
