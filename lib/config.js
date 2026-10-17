/**
 * Plugin configuration.
 *
 * Everything lives under one data directory (default `~/.dsh/logseq`, inside the dsh-home
 * volume so it survives container rebuilds). The Logseq CLI is always run with
 * `HOME=<dataDir>`, so its own files land there too:
 *
 *   <dataDir>/config.json        this plugin's config (written by the user)
 *   <dataDir>/auth.json          optional seed: copied to logseq/auth.json if that is missing
 *   <dataDir>/logseq/            the CLI root dir (auth.json, cli.edn, graphs/)
 *   <dataDir>/runtime/<version>/ extracted CLI bundle + shims
 *   <dataDir>/.keytar.json       E2EE key cache written by the keytar shim (mode 0600)
 *   <dataDir>/plugin.log         plugin log
 */
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_LOGSEQ_VERSION = '2.0.2'
export const DEFAULT_TOKEN_ENDPOINT = 'https://logseq-prod.auth.us-east-1.amazoncognito.com/oauth2/token'

/**
 * @typedef {object} LogseqConfig
 * @property {string} dataDir
 * @property {string} [server]          sync server http base, e.g. https://sync.example.com
 * @property {string} [wsUrl]           override for the websocket URL template (`%s` = graph id)
 * @property {string[]} graphs          graphs to keep synced; first one is the tools' default
 * @property {string} [e2eePassword]    E2EE password for encrypted graphs
 * @property {string} oauthTokenEndpoint OAuth token endpoint used to refresh auth.json
 * @property {boolean} sync             run the sync daemon (default true when server is set)
 * @property {boolean} readOnly         register read tools only
 * @property {string} logseqVersion     Logseq release tag the runtime is extracted from
 * @property {string} [runtimeUrl]      override download URL of the Linux zip (mirror)
 * @property {string} [runtimeAsar]     use a local app.asar instead of downloading
 * @property {number} statusIntervalMs  sync health-check interval
 * @property {number} timeoutMs         default per-command timeout
 * @property {number} maxOutputChars    cap on text returned to the model
 */

/** @returns {LogseqConfig} */
export function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir || process.env.DSH_LOGSEQ_HOME || join(homedir(), '.dsh', 'logseq')
  let file = {}
  try {
    file = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`dsh-logseq-sync: invalid ${join(dataDir, 'config.json')}: ${error.message}`)
  }
  const merged = { ...file, ...stripUndefined(overrides) }
  const env = process.env
  const server = trimSlash(env.DSH_LOGSEQ_SERVER || merged.server)
  const graphsRaw = env.DSH_LOGSEQ_GRAPHS ? env.DSH_LOGSEQ_GRAPHS.split(',') : merged.graphs
  const graphs = (Array.isArray(graphsRaw) ? graphsRaw : graphsRaw ? [graphsRaw] : [])
    .map((g) => String(g).trim())
    .filter(Boolean)
  return {
    dataDir,
    server,
    wsUrl: merged.wsUrl || (server ? `${server.replace(/^http/, 'ws')}/sync/%s` : undefined),
    graphs,
    e2eePassword: env.DSH_LOGSEQ_E2EE_PASSWORD || merged.e2eePassword || undefined,
    oauthTokenEndpoint: merged.oauthTokenEndpoint || DEFAULT_TOKEN_ENDPOINT,
    sync: merged.sync ?? Boolean(server),
    readOnly: Boolean(merged.readOnly),
    logseqVersion: merged.logseqVersion || DEFAULT_LOGSEQ_VERSION,
    runtimeUrl: merged.runtimeUrl,
    runtimeAsar: merged.runtimeAsar,
    statusIntervalMs: merged.statusIntervalMs ?? 60_000,
    timeoutMs: merged.timeoutMs ?? 60_000,
    maxOutputChars: merged.maxOutputChars ?? 20_000,
  }
}

/** Keys the web UI may write into config.json. */
const UI_KEYS = ['server', 'graphs', 'e2eePassword']

/**
 * Merge `patch` into `<dataDir>/config.json` (other keys are kept) and write it with mode
 * 0600 via a temp file + rename, so a crash never leaves a half-written config.
 * `undefined` values leave a key unchanged; `null` removes it.
 * @param {string} dataDir
 * @param {{ server?: string|null, graphs?: string[]|null, e2eePassword?: string|null }} patch
 */
export async function saveConfigFile(dataDir, patch) {
  const file = join(dataDir, 'config.json')
  let current = {}
  try {
    current = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`invalid ${file}: ${error.message}`)
  }
  const next = { ...current }
  for (const key of UI_KEYS) {
    if (patch[key] === undefined) continue
    if (patch[key] === null) delete next[key]
    else next[key] = patch[key]
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

/** Environment variables that override config.json (the UI cannot change those values). */
export function envOverrides() {
  return ['DSH_LOGSEQ_SERVER', 'DSH_LOGSEQ_GRAPHS', 'DSH_LOGSEQ_E2EE_PASSWORD'].filter((k) => process.env[k])
}

function trimSlash(url) {
  return url ? String(url).replace(/\/+$/, '') : undefined
}

function stripUndefined(object) {
  return Object.fromEntries(Object.entries(object || {}).filter(([, v]) => v !== undefined))
}
