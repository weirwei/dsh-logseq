/**
 * Keeps the configured graphs synced with the Logseq sync server.
 *
 * Model: the CLI's db-worker-node daemon (one per graph) is the sync client. `sync start`
 * asks it to open the websocket and returns once connected; the daemon keeps pushing and
 * pulling afterwards. This loop only (1) downloads graphs that are missing locally,
 * (2) starts sync, and (3) periodically checks `sync status`, restarting with backoff when
 * the websocket is not open (worker crashed, network blip, token refresh failure).
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { runCli, seedAuth } from './cli.js'

const MAX_BACKOFF_MS = 15 * 60_000

/** Empty local graph used only as the context for `sync remote-graphs`; never synced or shown. */
export const PROBE_GRAPH = 'dsh-logseq-probe'

/**
 * Graphs on the sync server visible to the logged-in account. The CLI only lists remote
 * graphs in the context of an existing local graph, so a dedicated probe graph is used.
 * @returns {Promise<Array<{ name: string, encrypted?: boolean }>>}
 */
export async function listRemoteGraphs(config) {
  const local = (await runCli(config, ['graph', 'list'])).graphs || []
  if (!local.includes(PROBE_GRAPH)) await runCli(config, ['graph', 'create', `--graph=${PROBE_GRAPH}`])
  const data = await runCli(config, ['sync', 'remote-graphs', `--graph=${PROBE_GRAPH}`], { timeoutMs: 60_000 })
  const list = Array.isArray(data) ? data : data?.graphs || []
  return list
    .map((g) => (typeof g === 'string' ? { name: g } : { name: g['graph-name'] || g.name, encrypted: g['graph-e2ee?'] }))
    .filter((g) => g.name && g.name !== PROBE_GRAPH)
}

/**
 * Remove a local graph that never finished downloading. `graph remove` cannot open a
 * broken graph, so stop its worker and delete the directory as a fallback.
 */
async function removeLocalGraph(config, graph) {
  try {
    await runCli(config, ['graph', 'remove', `--graph=${graph}`])
    return
  } catch {
    // fall through
  }
  await runCli(config, ['server', 'stop', `--graph=${graph}`], { timeoutMs: 20_000 }).catch(() => {})
  const graphsDir = join(config.dataDir, 'logseq', 'graphs')
  const dir = join(graphsDir, graph)
  // Never delete outside the graphs directory, whatever the graph name contains.
  if (dirname(dir) === graphsDir && basename(dir) === graph) await rm(dir, { recursive: true, force: true })
}

export class SyncDaemon {
  /**
   * @param {import('./config.js').LogseqConfig} config
   * @param {{ info: Function, warn: Function }} log
   */
  constructor(config, log) {
    this.config = config
    this.log = log
    /** @type {Map<string, { state: string, status?: any, error?: string, failures: number, nextTry: number, checkedAt?: number }>} */
    this.graphs = new Map(config.graphs.map((g) => [g, { state: 'pending', failures: 0, nextTry: 0 }]))
    /** No graph list configured: sync every graph the account has on the server. */
    this.auto = config.graphs.length === 0
    /** Error from the last remote graph listing (auto mode), shown in the status. */
    this.discoveryError = undefined
    /** Called when auto mode finds new graphs (the tools re-register with them). */
    this.onGraphsChanged = () => {}
    this.timer = undefined
    this.stopped = false
    this.running = undefined
  }

  start() {
    const tick = () => {
      if (this.stopped) return
      this.running = this.tickAll()
        .catch((error) => this.log.warn(`sync tick failed: ${error.message}`))
        .finally(() => {
          this.running = undefined
          if (!this.stopped) this.timer = setTimeout(tick, this.config.statusIntervalMs)
        })
    }
    tick()
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    await this.running?.catch(() => {})
    // Graceful worker shutdown flushes pending uploads before exit.
    await Promise.allSettled(
      [...this.graphs.keys()].map((graph) => runCli(this.config, ['server', 'stop', `--graph=${graph}`], { timeoutMs: 20_000 })),
    )
  }

  /** Snapshot for the status tool. */
  snapshot() {
    return Object.fromEntries(
      [...this.graphs].map(([graph, s]) => [
        graph,
        {
          state: s.state,
          ...(s.error ? { error: s.error } : {}),
          ...(s.status
            ? {
                wsState: s.status['ws-state'],
                localTx: s.status['local-tx'],
                remoteTx: s.status['remote-tx'],
                pendingLocal: s.status['pending-local'],
                pendingServer: s.status['pending-server'],
                lastError: s.status['last-error'],
              }
            : {}),
          ...(s.checkedAt ? { checkedAt: new Date(s.checkedAt).toISOString() } : {}),
        },
      ]),
    )
  }

  async tickAll() {
    const authFile = join(this.config.dataDir, 'logseq', 'auth.json')
    if (await seedAuth(this.config).catch(() => false)) this.log.info('copied auth.json into the CLI root')
    if (!existsSync(authFile)) {
      for (const s of this.graphs.values()) {
        Object.assign(s, { state: 'error', error: `missing ${authFile}; copy your Logseq auth.json to ${join(this.config.dataDir, 'auth.json')}` })
      }
      return
    }
    if (this.auto) await this.discover()
    let local
    try {
      local = new Set((await runCli(this.config, ['graph', 'list'], { log: this.log.info })).graphs || [])
    } catch (error) {
      for (const s of this.graphs.values()) Object.assign(s, { state: 'error', error: error.message })
      throw error
    }
    // Sequential: each graph spawns its own worker; avoid stampeding a small server.
    for (const [graph, s] of this.graphs) {
      if (this.stopped) return
      if (Date.now() < s.nextTry) continue
      try {
        await this.tickGraph(graph, s, local)
        s.failures = 0
        s.error = undefined
      } catch (error) {
        s.failures += 1
        s.state = 'error'
        s.error = error.hint ? `${error.message} (${error.hint})` : error.message
        const backoff = Math.min(MAX_BACKOFF_MS, this.config.statusIntervalMs * 2 ** (s.failures - 1))
        s.nextTry = Date.now() + backoff
        this.log.warn(`sync ${graph}: ${s.error}; retry in ${Math.round(backoff / 1000)}s`)
      }
    }
  }

  /** Auto mode: add graphs that appeared on the server since the last tick. */
  async discover() {
    try {
      const remote = await listRemoteGraphs(this.config)
      this.discoveryError = undefined
      const added = remote.map((g) => g.name).filter((name) => !this.graphs.has(name))
      for (const name of added) this.graphs.set(name, { state: 'pending', failures: 0, nextTry: 0 })
      if (added.length) {
        this.log.info(`sync: found ${added.join(', ')} on the server`)
        this.onGraphsChanged()
      }
    } catch (error) {
      this.discoveryError = error.hint ? `${error.message} (${error.hint})` : error.message
      this.log.warn(`sync: cannot list graphs on the server: ${this.discoveryError}`)
    }
  }

  /** Graph names being synced, in a stable order (configured order, then discovery order). */
  graphNames() {
    return [...this.graphs.keys()]
  }

  async tickGraph(graph, s, local) {
    const pw = this.config.e2eePassword
    const pwArgs = pw ? [`--e2ee-password=${pw}`] : []
    if (local.has(graph)) {
      let kv
      try {
        kv = (await runCli(this.config, ['graph', 'info', `--graph=${graph}`])).kv || {}
      } catch (error) {
        // A download that failed half-way leaves a graph directory the CLI cannot open.
        if (error.code !== 'graph-not-exists') throw error
        kv = {}
      }
      if (!kv['logseq.kv/graph-uuid']) {
        if (Object.keys(kv).length) {
          // A real local-only graph: syncing it would mean uploading it as a new remote graph.
          throw Object.assign(new Error(`local graph "${graph}" is not linked to a remote graph; refusing to sync it`), {
            hint: 'remove it locally or pick another name; this plugin only syncs graphs that exist on the server',
          })
        }
        // Empty shell left behind by an interrupted/failed download: remove and retry.
        this.log.warn(`sync ${graph}: removing empty local graph left by a failed download`)
        await removeLocalGraph(this.config, graph)
        local.delete(graph)
      }
    }
    if (!local.has(graph)) {
      s.state = 'downloading'
      this.log.info(`sync ${graph}: not present locally, downloading from server`)
      try {
        await runCli(this.config, ['sync', 'download', `--graph=${graph}`, ...pwArgs], { timeoutMs: 30 * 60_000, secrets: pwArgs })
      } catch (error) {
        await removeLocalGraph(this.config, graph)
        throw error
      }
      local.add(graph)
    }
    let status = await runCli(this.config, ['sync', 'status', `--graph=${graph}`])
    if (status['ws-state'] !== 'open') {
      s.state = 'starting'
      this.log.info(`sync ${graph}: ws-state=${status['ws-state']}, starting sync`)
      await runCli(this.config, ['sync', 'start', `--graph=${graph}`, ...pwArgs], { timeoutMs: 120_000, secrets: pwArgs })
      status = await runCli(this.config, ['sync', 'status', `--graph=${graph}`])
    }
    s.status = status
    s.checkedAt = Date.now()
    s.state = status['ws-state'] === 'open' ? 'synced' : `ws-${status['ws-state']}`
    if (status['last-error']) this.log.warn(`sync ${graph}: last-error ${JSON.stringify(status['last-error'])}`)
  }
}
