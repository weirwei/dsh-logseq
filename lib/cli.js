/**
 * Runs the Logseq CLI as a child process (argv array, never a shell).
 *
 * Every call uses HOME=<dataDir>, so the CLI root (`~/logseq`), auth.json, graphs, runtime
 * locks and the keytar shim's cache all stay inside the plugin's data directory. The
 * db-worker-node daemons the CLI spawns inherit the same environment.
 */
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRuntime } from './runtime.js'

export class LogseqCliError extends Error {
  constructor(message, { code, hint, args, stderr } = {}) {
    super(message)
    this.name = 'LogseqCliError'
    this.code = code
    this.hint = hint
    this.args = args
    this.stderr = stderr
  }
}

/** @param {import('./config.js').LogseqConfig} config */
export function cliEnv(config) {
  const env = { ...process.env, HOME: config.dataDir, LOGSEQ_KEYTAR_FILE: join(config.dataDir, '.keytar.json') }
  // NODE_OPTIONS of the dsh process (loaders, inspectors) must not leak into the CLI/worker.
  delete env.NODE_OPTIONS
  if (config.server) env.LOGSEQ_CLI_HTTP_BASE = config.server
  if (config.wsUrl) env.LOGSEQ_CLI_WS_URL = config.wsUrl
  return env
}

/**
 * Write `<dataDir>/logseq/cli.edn`. With a custom `http-base` the CLI would otherwise derive
 * the OAuth token endpoint as `<http-base>/oauth2/token`, which a self-hosted sync server
 * does not serve (404), so token refresh fails once the id token expires. Auth stays with
 * Logseq's Cognito; only the sync endpoints are self-hosted.
 * The file is owned by this plugin and rewritten when its content changes.
 */
export async function writeCliConfig(config) {
  const entries = [
    ['http-base', config.server],
    ['ws-url', config.wsUrl],
    ['oauth-token-endpoint', config.oauthTokenEndpoint],
  ].filter(([, v]) => v)
  const body = `;; managed by dsh-logseq-sync — edit ~/.dsh/logseq/config.json instead\n{${entries
    .map(([k, v]) => `:${k} ${JSON.stringify(v)}`)
    .join('\n ')}}\n`
  const file = join(config.dataDir, 'logseq', 'cli.edn')
  if ((await readFile(file, 'utf8').catch(() => '')) === body) return
  await mkdir(join(config.dataDir, 'logseq'), { recursive: true })
  await writeFile(file, body)
}

/** Copy `<dataDir>/auth.json` into the CLI root once, so users only drop one file. */
export async function seedAuth(config) {
  const seed = join(config.dataDir, 'auth.json')
  const target = join(config.dataDir, 'logseq', 'auth.json')
  if (!(await exists(seed)) || (await exists(target))) return false
  await mkdir(join(config.dataDir, 'logseq'), { recursive: true })
  await copyFile(seed, target)
  await chmod(target, 0o600)
  return true
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * @param {import('./config.js').LogseqConfig} config
 * @param {string[]} args - CLI arguments, e.g. ['search', 'block', '--content', 'x']
 * @param {{ output?: 'json'|'human', timeoutMs?: number, signal?: AbortSignal, secrets?: string[], log?: (m: string) => void }} [opts]
 * @returns {Promise<any>} parsed `data` for json output, raw text for human output
 */
const prepared = new Map()

export async function runCli(config, args, opts = {}) {
  const cli = await ensureRuntime(config, opts.log)
  if (!prepared.has(config.dataDir)) prepared.set(config.dataDir, writeCliConfig(config).catch((e) => (prepared.delete(config.dataDir), Promise.reject(e))))
  await prepared.get(config.dataDir)
  const output = opts.output || 'json'
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs
  const argv = [cli, ...args, '--output', output, '--timeout-ms', String(timeoutMs)]
  const shown = redact(args, opts.secrets)

  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: config.dataDir,
      env: cliEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
      // Hard stop a little after the CLI's own --timeout-ms.
      timeout: timeoutMs + 15_000,
      killSignal: 'SIGKILL',
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (c) => (out += c))
    child.stderr.setEncoding('utf8').on('data', (c) => (err.length < 64_000 ? (err += c) : null))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }))
  }).catch((error) => {
    throw new LogseqCliError(`logseq ${shown.join(' ')} failed to run: ${error.message}`, { args: shown })
  })

  if (output === 'human') {
    if (code !== 0 || /^Error \(/.test(stdout)) {
      throw new LogseqCliError((stdout || stderr).trim().slice(0, 2000) || `exit code ${code}`, { args: shown, stderr })
    }
    return stdout
  }

  const envelope = parseEnvelope(stdout)
  if (!envelope) {
    throw new LogseqCliError(`logseq ${shown[0] ?? ''} returned non-JSON output (exit ${code}): ${(stdout || stderr).trim().slice(0, 1000)}`, {
      args: shown,
      stderr,
    })
  }
  if (envelope.status !== 'ok') {
    const e = envelope.error || {}
    throw new LogseqCliError(`${e.code ? `${e.code}: ` : ''}${e.message || 'logseq command failed'}`, {
      code: e.code,
      hint: e.hint,
      args: shown,
      stderr,
    })
  }
  return envelope.data
}

/** The CLI prints one JSON object; progress output may precede it. */
function parseEnvelope(stdout) {
  const text = stdout.trim()
  try {
    return JSON.parse(text)
  } catch {
    const lines = text.split('\n').filter((l) => l.startsWith('{'))
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const v = JSON.parse(lines[i])
        if (v && typeof v === 'object' && 'status' in v) return v
      } catch {
        // keep looking
      }
    }
    return undefined
  }
}

function redact(args, secrets = []) {
  const hidden = new Set(secrets.filter(Boolean))
  return args.map((a) => (hidden.has(a) ? '***' : a))
}
