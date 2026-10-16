/**
 * dsh-logseq-sync — DeepSeek Harness plugin.
 *
 * On load: prepares the Logseq CLI runtime under ~/.dsh/logseq, starts a sync daemon for
 * the configured graphs (download if missing → sync start → periodic health check), and
 * registers `logseq_*` tools that read and write the local graph copies. Writes reach the
 * sync server through the same db-worker-node daemon that does the syncing.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { seedAuth } from './cli.js'
import { loadConfig } from './config.js'
import { ensureRuntime } from './runtime.js'
import { SyncDaemon } from './sync.js'
import { buildTools } from './tools.js'

export const name = 'logseq-sync'
export const inject = []

let daemon

/**
 * @param {any} ctx - cordis context (host plane)
 * @param {object} [options] - optional overrides of config.json fields
 */
export function apply(ctx, options = {}) {
  const config = loadConfig(options)
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const log = makeLogger(ctx, config)

  log.info(`config: graphs=${config.graphs.join(',') || '-'} server=${config.server || '-'} sync=${config.sync} readOnly=${config.readOnly}`)

  // Prepare runtime and sync in the background: a first-run download must not block dsh startup.
  if (config.sync && config.graphs.length && !daemon) {
    daemon = new SyncDaemon(config, log)
    const own = daemon
    const boot = async (attempt = 1) => {
      try {
        if (await seedAuth(config)) log.info('copied auth.json into the CLI root')
        await ensureRuntime(config, log.info)
        if (!own.stopped) own.start()
      } catch (error) {
        if (own.stopped) return
        const wait = Math.min(30 * 60_000, 60_000 * 2 ** (attempt - 1))
        log.warn(`startup failed: ${error.message}; retry in ${Math.round(wait / 1000)}s`)
        own.bootTimer = setTimeout(() => boot(attempt + 1), wait)
      }
    }
    boot()
    onDispose(ctx, async () => {
      clearTimeout(own.bootTimer)
      if (daemon === own) daemon = undefined
      await own.stop()
    })
  } else if (!config.sync) {
    seedAuth(config).catch(() => {})
  }

  ctx.inject(['tools'], (toolCtx) => {
    const disposers = buildTools(config, daemon).map((tool) => toolCtx.tools.register(tool))
    onDispose(toolCtx, () => disposers.forEach((d) => typeof d === 'function' && d()))
  })
}

function onDispose(ctx, fn) {
  if (typeof ctx.effect === 'function') ctx.effect(() => fn, 'dsh-logseq-sync')
  else if (typeof ctx.on === 'function') ctx.on('dispose', fn)
}

function makeLogger(ctx, config) {
  const file = join(config.dataDir, 'plugin.log')
  let host
  try {
    host = typeof ctx.logger === 'function' ? ctx.logger('logseq-sync') : undefined
  } catch {
    host = undefined
  }
  const write = (level, msg) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${msg}\n`, { mode: 0o600 })
    } catch {
      // logging must never break the plugin
    }
    host?.[level]?.(msg)
  }
  return { info: (m) => write('info', m), warn: (m) => write('warn', m) }
}

export default { name, inject, apply }
