/**
 * Owns the plugin's live state: the effective config, the sync daemon, and the setup
 * steps the web UI drives (runtime download, login, saving server/graphs/E2EE password).
 *
 * The tools and the HTTP routes both read `controller.config` / `controller.daemon` at
 * call time, so a setup change made in the UI takes effect without restarting dsh.
 */
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runCli, seedAuth } from './cli.js'
import { envOverrides, loadConfig, saveConfigFile } from './config.js'
import { ensureRuntime, runtimeStatus } from './runtime.js'
import { listRemoteGraphs, SyncDaemon } from './sync.js'

export class Controller extends EventEmitter {
  /**
   * @param {object} options - overrides of config.json fields (from the dsh plugin config)
   * @param {{ info: Function, warn: Function }} log
   */
  constructor(options, log) {
    super()
    this.options = options
    this.log = log
    this.config = loadConfig(options)
    /** @type {SyncDaemon | undefined} */
    this.daemon = undefined
    this.stopped = false
  }

  start() {
    const config = this.config
    if (!config.sync) {
      seedAuth(config).catch(() => {})
      return
    }
    const daemon = new SyncDaemon(config, this.log)
    daemon.onGraphsChanged = () => this.emit('change')
    this.daemon = daemon
    // Prepare runtime and sync in the background: a first-run download must not block dsh startup.
    const boot = async (attempt = 1) => {
      try {
        if (await seedAuth(config)) this.log.info('copied auth.json into the CLI root')
        await ensureRuntime(config, this.log.info)
        if (!daemon.stopped) daemon.start()
      } catch (error) {
        if (daemon.stopped) return
        const wait = Math.min(30 * 60_000, 60_000 * 2 ** (attempt - 1))
        this.log.warn(`startup failed: ${error.message}; retry in ${Math.round(wait / 1000)}s`)
        daemon.bootTimer = setTimeout(() => boot(attempt + 1), wait)
      }
    }
    boot()
  }

  async stop() {
    this.stopped = true
    await this.stopDaemon()
  }

  async stopDaemon() {
    const daemon = this.daemon
    this.daemon = undefined
    if (!daemon) return
    clearTimeout(daemon.bootTimer)
    await daemon.stop()
  }

  /** Re-read config.json and restart syncing with it. */
  async reload() {
    await this.stopDaemon()
    if (this.stopped) return
    this.config = loadConfig(this.options)
    this.log.info(`config reloaded: graphs=${this.config.graphs.join(',') || '-'} server=${this.config.server || '-'} sync=${this.config.sync}`)
    this.start()
    this.emit('change')
  }

  // ---- setup -------------------------------------------------------------------------

  status() {
    const config = this.config
    const auth = readAuth(config)
    return {
      runtime: runtimeStatus(config),
      auth,
      config: {
        server: config.server || '',
        graphs: config.graphs,
        hasE2eePassword: Boolean(config.e2eePassword),
        readOnly: config.readOnly,
        envOverrides: envOverrides(),
      },
      sync: this.daemon ? this.daemon.snapshot() : null,
      syncAuto: this.daemon ? this.daemon.auto : false,
      discoveryError: this.daemon?.discoveryError,
    }
  }

  /** Start the runtime download in the background; progress shows up in status(). */
  installRuntime() {
    ensureRuntime(this.config, this.log.info).then(
      () => {
        // A configured-but-waiting daemon picks the runtime up on its next retry; restart now instead.
        if (this.config.sync) this.reload().catch((e) => this.log.warn(`reload failed: ${e.message}`))
      },
      (error) => this.log.warn(`runtime download failed: ${error.message}`),
    )
  }

  /** Log in with a Logseq account (Cognito password auth); writes <dataDir>/logseq/auth.json. */
  async login(username, password) {
    const args = ['login', `--username=${username}`, `--password=${password}`]
    await runCli(this.config, args, { secrets: [args[2]], timeoutMs: 60_000 })
    this.log.info(`logged in as ${username}`)
    if (this.config.sync) await this.reload()
    return readAuth(this.config)
  }

  /**
   * Forget the login: delete auth.json (and the seed copy, which would otherwise be copied
   * back). Not `logseq logout`: that also opens the provider's logout page in a browser.
   */
  async logout() {
    await this.stopDaemon()
    await Promise.all([
      rm(join(this.config.dataDir, 'logseq', 'auth.json'), { force: true }),
      rm(join(this.config.dataDir, 'auth.json'), { force: true }),
    ])
    this.log.info('logged out (auth.json removed)')
    this.emit('change')
  }

  /** Graphs on the sync server visible to the logged-in account. */
  remoteGraphs() {
    return listRemoteGraphs(this.config)
  }

  /**
   * Save the sync settings from the UI and restart syncing.
   * @param {{ server?: string, graphs?: string[], e2eePassword?: string }} input
   */
  async saveSetup(input) {
    const patch = {}
    if (input.server !== undefined) {
      const server = String(input.server).trim().replace(/\/+$/, '')
      if (server && !/^https?:\/\/[^\s/]+/i.test(server)) throw new UserError('server must be an http(s) URL')
      patch.server = server || null
    }
    if (input.graphs !== undefined) {
      if (!Array.isArray(input.graphs)) throw new UserError('graphs must be a list')
      const graphs = [...new Set(input.graphs.map((g) => String(g).trim()).filter(Boolean))]
      patch.graphs = graphs.length ? graphs : null // empty: sync every graph on the server
    }
    // An empty password field means "keep the saved one"; it is never sent back to the browser.
    if (typeof input.e2eePassword === 'string' && input.e2eePassword !== '') patch.e2eePassword = input.e2eePassword
    await saveConfigFile(this.config.dataDir, patch)
    await this.reload()
  }

}

/** An error whose message is safe and useful to show in the UI as-is (HTTP 400). */
export class UserError extends Error {}

/** Who is logged in, from the id token in auth.json (decoded for display only, not verified). */
function readAuth(config) {
  const file = join(config.dataDir, 'logseq', 'auth.json')
  const seed = join(config.dataDir, 'auth.json')
  if (!existsSync(file) && !existsSync(seed)) return { loggedIn: false }
  try {
    const auth = JSON.parse(readFileSync(existsSync(file) ? file : seed, 'utf8'))
    const token = auth['id-token'] || auth.idToken || auth.id_token
    const claims = token ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) : {}
    return { loggedIn: true, email: claims.email, expiresAt: claims.exp ? claims.exp * 1000 : undefined }
  } catch {
    return { loggedIn: true }
  }
}
