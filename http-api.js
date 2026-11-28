/**
 * Owner-only HTTP surface for the Plugins-page jobs dialog.
 *
 * A hand-written plugin has no generated Remote namespace, so the page talks to
 * the Host through two small routes on the Web server (`ctx.webServer`, the same
 * seam `open-in-app` uses). Route-level auth no longer exists in this Host
 * generation: every handler asks `connection.admit(request)` first, which
 * applies the Host/Origin fence plus the login-token cookie/API credential and
 * yields the browser's owner Peer. Anything that is not the owner is refused —
 * the page is a global management surface and must never be reachable by a chat
 * session or another principal.
 *
 *   GET  /imcron/jobs          → { ok, now, jobs: [...] }
 *   POST /imcron/jobs/action   ← { id, action: 'pause'|'resume'|'delete' }
 */
import { JOB_ACTIONS, applyJobAction, collectJobs } from './jobs-view.js'

export const JOBS_PATH = '/imcron/jobs'
export const JOBS_ACTION_PATH = '/imcron/jobs/action'

const MAX_BODY_BYTES = 4096

/** Whether an admitted peer is the deployment owner. */
function isOwner(peer) {
  return peer?.principal?.kind === 'owner'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  try {
    res.statusCode = status
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.setHeader?.('cache-control', 'no-store')
    res.end(payload)
  } catch {
    // The client went away; nothing left to answer.
  }
}

/** Read a small JSON body; rejects with a code the route maps to a status. */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body too large')
      error.code = 'body-too-large'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('invalid JSON body')
    error.code = 'bad-json'
    throw error
  }
}

/**
 * Pure request handlers, split from the node adapter so they can be tested
 * without an HTTP server.
 * @param {{scheduler: object, store: object, config: object}} service - the imCron service
 * @param {{now?: () => Date, admit?: (request: object) => {peer?: object} | {rejection: number}}} [options]
 *   `admit` is the composition's `connection.admit`; when it is absent every
 *   request is refused rather than silently public.
 */
export function createJobsHandlers(service, { now = () => new Date(), admit } = {}) {
  const gate = (request) => {
    if (typeof admit !== 'function') {
      return { status: 503, body: { ok: false, code: 'unavailable' } }
    }
    let admission
    try {
      admission = admit(request)
    } catch {
      return { status: 503, body: { ok: false, code: 'unavailable' } }
    }
    if (admission === null || typeof admission !== 'object') {
      return { status: 401, body: { ok: false, code: 'unauthorized' } }
    }
    if ('rejection' in admission) {
      const status = admission.rejection === 403 ? 403 : admission.rejection === 503 ? 503 : 401
      return { status, body: { ok: false, code: status === 403 ? 'forbidden' : 'unauthorized' } }
    }
    if (!isOwner(admission.peer)) return { status: 403, body: { ok: false, code: 'forbidden' } }
    return null
  }

  return {
    /** Gate a request without touching a job; the adapter checks before reading a body. */
    authorize(request) {
      return gate(request)
    },

    async list(request) {
      const denied = gate(request)
      if (denied !== null) return denied
      try {
        const jobs = await collectJobs(service, now())
        return { status: 200, body: { ok: true, now: now().toISOString(), jobs } }
      } catch (error) {
        return {
          status: 500,
          body: { ok: false, code: 'internal', message: String(error?.message ?? error) },
        }
      }
    },

    async action(request, body) {
      const denied = gate(request)
      if (denied !== null) return denied
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 400, body: { ok: false, code: 'bad-request' } }
      }
      if (typeof body.id !== 'string' || body.id.trim() === '') {
        return { status: 400, body: { ok: false, code: 'bad-id' } }
      }
      if (!JOB_ACTIONS.includes(body.action)) {
        return { status: 400, body: { ok: false, code: 'bad-action' } }
      }
      const outcome = await applyJobAction(service, body.id.trim(), body.action)
      if (outcome.ok) return { status: 200, body: { ok: true } }
      const status = outcome.code === 'not-found' ? 404
        : outcome.code === 'bad-action' ? 400 : 409
      return { status, body: { ok: false, ...outcome } }
    },
  }
}

/** Mount both routes on one Web server; returns the disposer. */
function registerRoutes(webServer, admit, service) {
  const handlers = createJobsHandlers(service, { admit })
  const disposeList = webServer.register({
    kind: 'exact',
    path: JOBS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
        return
      }
      const outcome = await handlers.list(req)
      sendJson(res, outcome.status, outcome.body)
    },
  })
  let disposeAction
  try {
    disposeAction = webServer.register({
      kind: 'exact',
      path: JOBS_ACTION_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
          return
        }
        const denied = handlers.authorize(req)
        if (denied !== null) {
          sendJson(res, denied.status, denied.body)
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          const status = error?.code === 'body-too-large' ? 413 : 400
          sendJson(res, status, { ok: false, code: error?.code ?? 'bad-request' })
          return
        }
        const outcome = await handlers.action(req, body)
        sendJson(res, outcome.status, outcome.body)
      },
    })
  } catch (error) {
    // Do not leave half a surface behind when the second path is taken.
    disposeList()
    throw error
  }
  return () => {
    for (const dispose of [disposeList, disposeAction]) {
      try {
        dispose()
      } catch {
        // the server may already be gone
      }
    }
  }
}

/**
 * Register both routes when the profile composes a Web server.
 *
 * The server may be provided after this plugin applies (both are ordinary
 * rows), so an absent service parks the registration on `ctx.inject` instead
 * of silently skipping it.
 * @returns {() => void} disposer; a no-op when no Web server ever arrives
 */
export function installJobsRoutes({ ctx, service, logger = null }) {
  const lookup = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  // `connection` may arrive after this plugin and is resolved per request, so
  // the routes never hold a stale or absent admission seam.
  const admit = (request) => {
    const connection = lookup('connection')
    if (connection === null || connection === undefined || typeof connection.admit !== 'function') {
      return { rejection: 503 }
    }
    return connection.admit(request)
  }
  const direct = lookup('webServer')
  if (direct !== null && direct !== undefined && typeof direct.register === 'function') {
    return registerRoutes(direct, admit, service)
  }

  let disposeRoutes = null
  const attach = (webServer) => {
    if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') return
    try {
      disposeRoutes = registerRoutes(webServer, admit, service)
    } catch (error) {
      logger?.warn?.(`[im-cron] 注册任务页面路由失败：${String(error?.message ?? error)}`)
    }
  }
  const release = () => {
    if (disposeRoutes === null) return
    try {
      disposeRoutes()
    } catch {
      // the server may already be gone
    }
    disposeRoutes = null
  }

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      attach(scope.webServer)
      if (typeof scope.effect === 'function') scope.effect(() => release)
    })
    return release
  }

  logger?.info?.('[im-cron] 没有 Web 服务，跳过定时任务页面接口')
  return () => {}
}