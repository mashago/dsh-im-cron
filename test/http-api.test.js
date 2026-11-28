import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withoutExecutionState } from '../core/scheduler.js'
import { applyJobAction, collectJobs } from '../jobs-view.js'
import { JOBS_ACTION_PATH, JOBS_PATH, createJobsHandlers, installJobsRoutes } from '../http-api.js'

const MINUTE = { kind: 'every', unit: 'minute', count: 10, timezone: 'Asia/Shanghai' }

function job(overrides = {}) {
  return {
    id: 'imc-a',
    name: '早报',
    payload: { kind: 'agent', prompt: 'x' },
    schedule: { ...MINUTE, anchor: '2026-11-27T10:00:00.000Z' },
    target: { botId: 'bot-1', targetId: 'cron-a', channel: 'qq', label: '早报群' },
    deliver: 'always',
    enabled: true,
    createdAt: '2026-11-27T09:00:00.000Z',
    lastFiredFor: '2026-11-27T10:00:00.000Z',
    ...overrides,
  }
}

function makeService(jobs, runs = []) {
  const list = jobs.map((entry) => ({ ...entry }))
  const calls = []
  return {
    calls,
    scheduler: {
      listJobs: () => list.map((entry) => ({ ...entry })),
      getJob: (id) => list.find((entry) => entry.id === id),
      async upsertJob(next) {
        calls.push({ op: 'upsert', id: next.id, enabled: next.enabled, job: next })
        const index = list.findIndex((entry) => entry.id === next.id)
        if (index === -1) list.push({ ...next })
        else list[index] = { ...next }
        return { ...next }
      },
      async removeJob(id) {
        calls.push({ op: 'remove', id })
        const index = list.findIndex((entry) => entry.id === id)
        if (index === -1) return false
        list.splice(index, 1)
        return true
      },
    },
    store: { readRuns: async () => runs },
    config: { timezone: 'Asia/Shanghai' },
  }
}

const ownerPeer = { principal: { kind: 'owner' } }
const guestPeer = { principal: { kind: 'guest' } }
const admitOwner = () => ({ peer: ownerPeer })
const admitGuest = () => ({ peer: guestPeer })
const admitAnonymous = () => ({ rejection: 401 })
const request = { headers: {}, method: 'GET' }

test('jobs view: rows carry the raw flags the client groups by', async () => {
  const service = makeService([
    job(),
    job({ id: 'imc-b', name: '暂停的', enabled: false }),
    job({ id: 'imc-c', name: '已结束', endedAt: '2026-11-27T11:00:00.000Z' }),
    job({ id: 'imc-d', name: '目标失效', state: 'needs-rebind' }),
  ], [
    { jobId: 'imc-a', at: '2026-11-27T10:00:05.000Z', result: { kind: 'ok' }, deliver: { status: 'sent' } },
    { jobId: 'imc-a', at: '2026-11-27T10:10:05.000Z', result: { kind: 'failed', reason: 'timeout' }, durationMs: 1234 },
  ])
  const rows = await collectJobs(service, new Date('2026-11-27T10:20:00.000Z'))
  const byId = new Map(rows.map((row) => [row.id, row]))

  assert.equal(byId.get('imc-a').enabled, true)
  assert.equal(byId.get('imc-a').ended, false)
  assert.match(byId.get('imc-a').schedule, /每 10 分钟/u)
  assert.equal(byId.get('imc-a').nextRunAt, '2026-11-27T10:10:00.000Z')
  assert.equal(byId.get('imc-a').lastResult, 'failed/timeout')
  assert.equal(byId.get('imc-a').lastRunAt, '2026-11-27T10:10:05.000Z')
  assert.deepEqual(byId.get('imc-a').target, {
    channel: 'qq', targetId: 'cron-a', label: '早报群', botId: 'bot-1',
  })
  assert.equal(byId.get('imc-a').payloadKind, 'agent')
  assert.equal(byId.get('imc-a').payloadPreview, 'x')
  assert.equal(byId.get('imc-a').lastDurationMs, 1234)

  assert.equal(byId.get('imc-b').nextRunAt, '')
  assert.equal(byId.get('imc-c').ended, true)
  assert.equal(byId.get('imc-c').nextRunAt, '')
  assert.equal(byId.get('imc-d').state, 'needs-rebind')
  assert.equal(byId.get('imc-d').nextRunAt, '')
})

test('jobs view: pause and resume toggle the flag; delete removes', async () => {
  const service = makeService([job()])
  assert.deepEqual(await applyJobAction(service, 'imc-a', 'pause'), { ok: true })
  const paused = service.calls.at(-1)
  assert.equal(paused.op, 'upsert')
  assert.equal(paused.id, 'imc-a')
  assert.equal(paused.enabled, false)
  // The scheduler owns these; a snapshot must not write them back.
  assert.equal('lastFiredFor' in paused.job, false)
  assert.equal('inflight' in paused.job, false)
  assert.equal('endedAt' in paused.job, false)

  assert.deepEqual(await applyJobAction(service, 'imc-a', 'resume'), { ok: true })
  const resumed = service.calls.at(-1)
  assert.equal(resumed.enabled, true)
  assert.equal('lastFiredFor' in resumed.job, false)

  assert.deepEqual(await applyJobAction(service, 'imc-a', 'delete'), { ok: true })
  assert.deepEqual(service.calls.at(-1), { op: 'remove', id: 'imc-a' })
  assert.deepEqual(await applyJobAction(service, 'imc-a', 'delete'), { ok: false, code: 'not-found' })
})

test('jobs view: an ended job refuses resume and a stalled one needs its chat', async () => {
  const ended = makeService([job({ endedAt: '2026-11-27T11:00:00.000Z' })])
  assert.deepEqual(await applyJobAction(ended, 'imc-a', 'resume'), { ok: false, code: 'job-ended' })
  assert.deepEqual(await applyJobAction(ended, 'imc-a', 'pause'), { ok: false, code: 'job-ended' })
  assert.equal(ended.calls.length, 0)

  const stalled = makeService([job({ state: 'needs-rebind' })])
  assert.deepEqual(await applyJobAction(stalled, 'imc-a', 'resume'), { ok: false, code: 'job-needs-chat-repair' })
  assert.equal(stalled.calls.length, 0)

  const invalid = makeService([job({ state: 'invalid' })])
  assert.deepEqual(await applyJobAction(invalid, 'imc-a', 'resume'), { ok: false, code: 'job-needs-chat-repair' })

  assert.deepEqual(await applyJobAction(makeService([]), 'imc-a', 'bogus'), { ok: false, code: 'not-found' })
  assert.deepEqual(await applyJobAction(makeService([job()]), 'imc-a', 'bogus'), { ok: false, code: 'bad-action' })
})

test('jobs api: connection.admit gates every request', async () => {
  const service = makeService([job()])
  const anonymous = createJobsHandlers(service, { admit: admitAnonymous })
  assert.equal((await anonymous.list(request)).status, 401)
  assert.equal((await anonymous.action(request, { id: 'imc-a', action: 'pause' })).status, 401)

  const guest = createJobsHandlers(service, { admit: admitGuest })
  assert.equal((await guest.list(request)).status, 403)
  assert.equal((await guest.action(request, { id: 'imc-a', action: 'pause' })).body.code, 'forbidden')
  assert.equal(service.calls.length, 0)

  const unavailable = createJobsHandlers(service, {})
  assert.equal((await unavailable.list(request)).status, 503)

  const throwing = createJobsHandlers(service, { admit: () => { throw new Error('down') } })
  assert.equal((await throwing.list(request)).status, 503)
})

test('jobs api: the owner reads and mutates', async () => {
  const service = makeService([job()])
  const handlers = createJobsHandlers(service, {
    admit: admitOwner,
    now: () => new Date('2026-11-27T10:20:00.000Z'),
  })
  const list = await handlers.list(request)
  assert.equal(list.status, 200)
  assert.equal(list.body.ok, true)
  assert.equal(list.body.jobs.length, 1)
  assert.equal(list.body.now, '2026-11-27T10:20:00.000Z')

  const missing = await handlers.action(request, { id: 'imc-missing', action: 'delete' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'not-found')
  const ok = await handlers.action(request, { id: 'imc-a', action: 'pause' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
})

test('jobs api: malformed requests are rejected before touching a job', async () => {
  const service = makeService([job()])
  const handlers = createJobsHandlers(service, { admit: admitOwner })

  assert.equal((await handlers.action(request, undefined)).body.code, 'bad-request')
  assert.equal((await handlers.action(request, [])).body.code, 'bad-request')
  assert.equal((await handlers.action(request, { action: 'pause' })).body.code, 'bad-id')
  assert.equal((await handlers.action(request, { id: '   ', action: 'pause' })).body.code, 'bad-id')
  assert.equal((await handlers.action(request, { id: 'imc-a' })).body.code, 'bad-action')
  assert.equal((await handlers.action(request, { id: 'imc-a', action: 'explode' })).body.code, 'bad-action')
  assert.equal(service.calls.length, 0)
})

function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  }
}

function fakeConnection(admit = admitOwner) {
  return { admit }
}

function fakeRes() {
  const result = { headers: {}, body: '' }
  return {
    result,
    statusCode: 0,
    setHeader(name, value) {
      result.headers[name] = value
    },
    end(body) {
      result.body = String(body ?? '')
    },
  }
}

function fakeReq({ method = 'GET', body } = {}) {
  return {
    method,
    headers: {},
    socket: { destroyed: false },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
}

async function call(route, options = {}) {
  const res = fakeRes()
  await route.handler(fakeReq(options), res)
  return {
    status: res.statusCode,
    headers: res.result.headers,
    json: res.result.body === '' ? null : JSON.parse(res.result.body),
  }
}

test('jobs api: routes admit through connection and are disposable', async () => {
  const webServer = fakeWebServer()
  let admitted = 0
  const connection = fakeConnection((request) => {
    admitted += 1
    return { peer: ownerPeer }
  })
  const service = makeService([job()])
  const ctx = {
    get: (name) => (name === 'webServer' ? webServer : name === 'connection' ? connection : undefined),
  }
  const dispose = installJobsRoutes({ ctx, service })

  assert.deepEqual(webServer.routes.map((route) => route.path), [JOBS_PATH, JOBS_ACTION_PATH])

  const listRoute = webServer.routes[0]
  const actionRoute = webServer.routes[1]

  const listed = await call(listRoute)
  assert.equal(listed.status, 200)
  assert.equal(listed.json.jobs.length, 1)
  assert.equal(admitted, 1)
  assert.match(listed.headers['content-type'], /application\/json/u)
  assert.equal(listed.headers['cache-control'], 'no-store')

  assert.equal((await call(listRoute, { method: 'POST' })).status, 405)
  assert.equal((await call(actionRoute, { method: 'GET' })).status, 405)
  assert.equal((await call(actionRoute, { method: 'POST', body: '{oops' })).json.code, 'bad-json')

  const paused = await call(actionRoute, { method: 'POST', body: { id: 'imc-a', action: 'pause' } })
  assert.equal(paused.status, 200)
  assert.equal(paused.json.ok, true)
  assert.equal(service.calls.at(-1).op, 'upsert')
  assert.equal(service.calls.at(-1).enabled, false)

  dispose()
  assert.equal(webServer.routes.length, 0)
})

test('jobs api: a rejected caller never reaches a job', async () => {
  const webServer = fakeWebServer()
  const service = makeService([job()])
  const ctx = {
    get: (name) => (name === 'webServer' ? webServer : name === 'connection' ? fakeConnection(admitGuest) : undefined),
  }
  const dispose = installJobsRoutes({ ctx, service })
  const listed = await call(webServer.routes[0])
  assert.equal(listed.status, 403)
  assert.equal(listed.json.code, 'forbidden')
  const acted = await call(webServer.routes[1], { method: 'POST', body: { id: 'imc-a', action: 'delete' } })
  assert.equal(acted.status, 403)
  assert.equal(service.calls.length, 0)
  dispose()
})

test('jobs api: routes wait for a Web server provided later', () => {
  const webServer = fakeWebServer()
  let parked = null
  const ctx = {
    get: (name) => (name === 'connection' ? fakeConnection() : undefined),
    inject: (deps, callback) => {
      parked = { deps, callback }
    },
  }
  const dispose = installJobsRoutes({ ctx, service: makeService([job()]) })
  assert.deepEqual(parked.deps, ['webServer'])
  assert.equal(webServer.routes.length, 0)

  parked.callback({ webServer, effect: (factory) => factory() })
  assert.deepEqual(webServer.routes.map((route) => route.path), [JOBS_PATH, JOBS_ACTION_PATH])

  dispose()
  assert.equal(webServer.routes.length, 0)
})

test('jobs api: a profile without a Web server registers nothing', () => {
  const dispose = installJobsRoutes({ ctx: { get: () => undefined }, service: makeService([]) })
  assert.equal(typeof dispose, 'function')
  dispose()
})


test('scheduler: a toggle copy carries no scheduler-owned fields', () => {
  const copy = withoutExecutionState({
    id: 'imc-a',
    enabled: true,
    lastFiredFor: '2026-11-27T10:00:00.000Z',
    inflight: { occurrence: '2026-11-27T10:00:00.000Z' },
    endedAt: '2026-11-27T11:00:00.000Z',
  })
  assert.deepEqual(copy, { id: 'imc-a', enabled: true })
})

test('jobs api: authorization is available without a body', () => {
  const handlers = createJobsHandlers(makeService([job()]), { admit: admitGuest })
  assert.deepEqual(handlers.authorize(request), { status: 403, body: { ok: false, code: 'forbidden' } })
  const owner = createJobsHandlers(makeService([job()]), { admit: admitOwner })
  assert.equal(owner.authorize(request), null)
})
