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
 * Progress of the current (or last failed) preparation, for the web UI.
 * @type {{ phase: 'idle'|'downloading'|'extracting'|'error', received: number, total: number, error?: string }}
 */
const progress = { phase: 'idle', received: 0, total: 0 }

/**
 * @param {import('./config.js').LogseqConfig} config
 * @returns {{ state: 'ready'|'missing'|'preparing'|'error', version: string, received?: number, total?: number, error?: string }}
 */
export function runtimeStatus(config) {
  const version = config.logseqVersion
  if (existsSync(join(runtimeDir(config), MARKER))) return { state: 'ready', version }
  if (pending) return { state: 'preparing', version, phase: progress.phase, received: progress.received, total: progress.total }
  if (progress.phase === 'error') return { state: 'error', version, error: progress.error }
  return { state: 'missing', version }
}

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
  if (!pending) {
    Object.assign(progress, { phase: 'downloading', received: 0, total: 0, error: undefined })
    pending = prepare(config, dir, log).then(
      (path) => {
        progress.phase = 'idle'
        return path
      },
      (error) => {
        Object.assign(progress, { phase: 'error', error: error.message })
        throw error
      },
    )
    pending.finally(() => {
      pending = undefined
    }).catch(() => {})
  }
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
    if (asarPath) progress.phase = 'extracting'
    if (!asarPath) {
      const url = config.runtimeUrl || defaultRuntimeUrl(config)
      const zipPath = join(staging, 'release.zip')
      log(`downloading Logseq ${config.logseqVersion} runtime from ${url}`)
      await download(url, zipPath, log)
      progress.phase = 'extracting'
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

const STALL_MS = 60_000

/**
 * Download with stall detection: abort when no bytes arrive for STALL_MS (a hung
 * connection otherwise blocks forever with nothing in the log), and log progress.
 */
async function download(url, dest, log) {
  const ac = new AbortController()
  let timer
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => ac.abort(new Error(`download stalled: no data for ${STALL_MS / 1000}s`)), STALL_MS)
  }
  arm()
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} ${url}`)
    const total = Number(res.headers.get('content-length')) || 0
    progress.total = total
    let got = 0
    let lastLog = Date.now()
    const body = Readable.fromWeb(res.body)
    body.on('data', (chunk) => {
      got += chunk.length
      progress.received = got
      arm()
      if (Date.now() - lastLog > 30_000) {
        lastLog = Date.now()
        log(`downloaded ${(got / 1e6).toFixed(0)}MB${total ? ` / ${(total / 1e6).toFixed(0)}MB` : ''}`)
      }
    })
    await pipeline(body, createWriteStream(dest), { signal: ac.signal })
  } catch (error) {
    throw ac.signal.aborted && ac.signal.reason instanceof Error
      ? new Error(`${ac.signal.reason.message}; set runtimeAsar or runtimeUrl in config.json (see README)`)
      : error
  } finally {
    clearTimeout(timer)
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
