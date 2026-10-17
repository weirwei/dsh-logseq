/**
 * dsh-logseq-sync — DeepSeek Harness plugin.
 *
 * On load: prepares the Logseq CLI runtime under ~/.dsh/logseq, starts a sync daemon for
 * the configured graphs (download if missing → sync start → periodic health check), and
 * registers `logseq_*` tools that read and write the local graph copies. Writes reach the
 * sync server through the same db-worker-node daemon that does the syncing.
 *
 * With `dsh web`, it also serves the API behind the "Logseq" sidebar panel (client/), which
 * walks through setup (runtime download, login, E2EE password) and browses/edits graphs.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { Controller } from './controller.js'
import { buildTools } from './tools.js'
import { mountRoutes } from './web.js'

export const name = 'logseq-sync'
export const inject = []

/** One controller per process: a re-applied plugin (HMR) must not start a second daemon. */
let current

/**
 * @param {any} ctx - cordis context (host plane)
 * @param {object} [options] - optional overrides of config.json fields
 */
export function apply(ctx, options = {}) {
  const config = loadConfig(options)
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const log = makeLogger(ctx, config)
  log.info(`config: graphs=${config.graphs.join(',') || '-'} server=${config.server || '-'} sync=${config.sync} readOnly=${config.readOnly}`)

  let controller = current
  if (!controller || controller.stopped) {
    controller = current = new Controller(options, log)
    const own = controller
    own.start()
    onDispose(ctx, async () => {
      if (current === own) current = undefined
      await own.stop()
    })
  }

  ctx.inject(['tools'], (toolCtx) => {
    let disposers = []
    const register = () => {
      disposers.forEach((d) => typeof d === 'function' && d())
      disposers = buildTools(controller.config, controller.daemon).map((tool) => toolCtx.tools.register(tool))
    }
    register()
    controller.on('change', register)
    onDispose(toolCtx, () => {
      controller.off('change', register)
      disposers.forEach((d) => typeof d === 'function' && d())
    })
  })

  ctx.inject(['webServer'], (webCtx) => {
    try {
      const dispose = mountRoutes(webCtx, () => controller)
      onDispose(webCtx, dispose)
    } catch (error) {
      log.warn(`web UI API not mounted: ${error.message}`)
    }
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
