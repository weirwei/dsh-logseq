/**
 * HTTP API for the web UI, mounted on the dsh web server under /dsh-logseq/api/.
 *
 * These routes take a Logseq password and an E2EE password and can read and write the
 * graphs, so every request must pass:
 *   1. the host's own request gate (`connection.requestRejection`: origin fence + dsh web
 *      login), the same check dsh's /api routes run. Without that service only loopback
 *      requests are admitted (fail closed).
 *   2. for writes: POST with a JSON body from the same origin (blocks form-based CSRF and
 *      cross-site fetches).
 * Secrets are never sent back: status reports only whether an E2EE password is set.
 */
import { LogseqCliError } from './cli.js'
import { UserError } from './controller.js'

export const API_PREFIX = '/dsh-logseq/api'
const MAX_BODY = 256 * 1024

/**
 * @param {any} ctx - cordis context that has `webServer`
 * @param {() => import('./controller.js').Controller} getController
 * @returns {() => void} disposer
 */
export function mountRoutes(ctx, getController) {
  const gate = (request) => {
    const connection = ctx.get?.('connection')
    const check = connection?.requestRejection
    if (typeof check === 'function') {
      try {
        return check.call(connection, request)
      } catch {
        return 403
      }
    }
    return isLoopback(request.headers.host) ? undefined : 403
  }

  /** @type {Record<string, { method: 'GET'|'POST', run: (c: import('./controller.js').Controller, input: any) => any }>} */
  const routes = {
    status: { method: 'GET', run: (c) => c.status() },
    'runtime/install': { method: 'POST', run: (c) => (c.installRuntime(), { ok: true }) },
    login: {
      method: 'POST',
      run: (c, b) => {
        if (!b.username || !b.password) throw new UserError('email and password are required')
        return c.login(String(b.username), String(b.password))
      },
    },
    logout: { method: 'POST', run: (c) => c.logout().then(() => ({ ok: true })) },
    'remote-graphs': { method: 'GET', run: (c) => c.remoteGraphs().then((graphs) => ({ graphs })) },
    setup: { method: 'POST', run: (c, b) => c.saveSetup(b).then(() => c.status()) },
  }

  const disposers = Object.entries(routes).map(([name, route]) =>
    ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/${name}`,
      handler: (request, response) => handle(request, response, route, gate, getController),
    }),
  )
  return () => disposers.forEach((d) => typeof d === 'function' && d())
}

async function handle(request, response, route, gate, getController) {
  try {
    const rejected = gate(request)
    if (rejected !== undefined) return send(response, rejected, { error: rejected === 401 ? 'dsh login required' : 'request refused' })
    if (request.method !== route.method) {
      response.writeHead(405, { allow: route.method })
      return response.end()
    }
    let input
    if (route.method === 'GET') {
      input = Object.fromEntries(new URL(request.url ?? '/', 'http://localhost').searchParams)
    } else {
      if (!sameOrigin(request)) return send(response, 403, { error: 'cross-origin request refused' })
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
        return send(response, 415, { error: 'expected application/json' })
      }
      input = await readJson(request)
    }
    const result = await route.run(getController(), input ?? {})
    send(response, 200, result ?? { ok: true })
  } catch (error) {
    if (error instanceof UserError) return send(response, 400, { error: error.message })
    if (error instanceof LogseqCliError) return send(response, 400, { error: error.message, code: error.code, hint: error.hint })
    send(response, 500, { error: error?.message || String(error) })
  }
}

function send(response, status, body) {
  if (response.headersSent) return response.end()
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new UserError('request body too large')
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new UserError('invalid JSON body')
  }
}

export function isLoopback(host) {
  if (!host) return false
  const h = host.toLowerCase()
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** Browsers send Origin on every POST; it must name the host the request was sent to. */
export function sameOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true // not a browser page (curl etc.); the host gate still applies
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}
