import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Config, apply, startPlugin } from '../index.js'
import { parseConfig } from '../config.js'

function fakeLogger() {
  const lines = { info: [], warn: [], error: [] }
  return {
    lines,
    info: (message) => lines.info.push(String(message)),
    warn: (message) => lines.warn.push(String(message)),
    error: (message) => lines.error.push(String(message)),
  }
}

function fakeCtx({ service = null, services = {}, logger = fakeLogger(), on = null } = {}) {
  const provided = new Map()
  const effects = []
  const listeners = new Map()
  const emit = (name, payload) => {
    for (const listener of listeners.get(name) ?? []) listener(payload)
  }
  const defaultOn = (name, listener) => {
    if (name === 'session/event') return () => {}
    const set = listeners.get(name) ?? new Set()
    set.add(listener)
    listeners.set(name, set)
    return () => set.delete(listener)
  }
  const listenersFor = (name) => [...(listeners.get(name) ?? [])]
  // Waterfall dispatch: listeners run in registration order, and the caller's
  // final `next` runs once every listener delegated.
  const dispatch = async (name, ...args) => {
    const finalNext = args.pop()
    let index = 0
    const step = async () => {
      const listener = listenersFor(name)[index]
      index += 1
      return listener === undefined ? await finalNext() : await listener(...args, step)
    }
    return await step()
  }
  return {
    logger: () => logger,
    emit,
    dispatch,
    on: on ?? defaultOn,
    get: (name) => (services[name] !== undefined ? services[name] : (name === 'dshIm' ? service : undefined)),
    provide: (name, value) => provided.set(name, value),
    effect: (fn) => { effects.push(fn) },
    provided,
    effects,
    loggerObj: logger,
  }
}

function fakeDshIm({ onSend } = {}) {
  const sent = []
  return {
    sent,
    service: {
      contractVersion: 1,
      async send(botId, targetId, text, options) {
        sent.push({ botId, targetId, text, options })
        onSend?.(botId, targetId, text)
        return { sent: true }
      },
      async describeConversation() {
        return { channel: 'qq', botId: 'bot-1', chatType: 'dm', chatId: null, senderId: 'OPENID-1' }
      },
      async listTargets(botId) {
        return { botId, channel: 'qq', targets: [] }
      },
      async createTarget(botId, target) {
        return target
      },
    },
  }
}

async function tempDir() {
  return await mkdtemp(join(tmpdir(), 'imcron-plugin-'))
}

const iso = (ms) => new Date(ms).toISOString()

/** A real executable in the plugin workspace, the way the resolver expects. */
async function helloScript(dir) {
  const scripts = join(dir, 'workspace')
  await mkdir(scripts, { recursive: true })
  const file = join(scripts, 'hello.sh')
  await writeFile(file, '#!/bin/sh\nprintf "任务输出"\n')
  await chmod(file, 0o755)
  return file
}

test('apply: a declared command job fires and pushes through dshIm', async () => {
  const dir = await tempDir()
  const dshIm = fakeDshIm()
  let nowMs = Date.parse('2026-11-20T01:00:00+08:00')
  const clock = () => new Date(nowMs)
  const ctx = fakeCtx({ service: dshIm.service })

  const runtime = startPlugin(ctx, {
    stateDir: dir,
    pollSeconds: 30,
    timezone: 'Asia/Shanghai',
    jobs: [{
      id: 'decl-hello',
      name: '问候',
      schedule: { at: iso(nowMs + 60_000) },
      payload: { kind: 'command', script: await helloScript(dir) },
      deliver: 'always',
      target: { botId: 'bot-1', targetId: 'cron-1' },
    }],
  }, { now: clock })

  await runtime.ready
  assert.equal(runtime.available, true)

  const idle = await runtime.scheduler.tick()
  assert.deepEqual(idle.fired, [])
  assert.equal(dshIm.sent.length, 0)

  nowMs += 61_000
  const due = await runtime.scheduler.tick()
  assert.deepEqual(due.fired.map((entry) => entry.jobId), ['decl-hello'])
  assert.equal(dshIm.sent.length, 1)
  assert.equal(dshIm.sent[0].text, '任务输出')
  assert.deepEqual(dshIm.sent[0].options, { format: 'markdown' })
  assert.equal(dshIm.sent[0].botId, 'bot-1')
  assert.equal(dshIm.sent[0].targetId, 'cron-1')

  const imCron = ctx.provided.get('imCron')
  assert.equal(imCron.version, 1)
  assert.equal(imCron.available, true)
  assert.equal(imCron.scheduler.listJobs().length, 1)
  runtime.stop()
})

test('apply: without dshIm the plugin still runs commands and records skipped delivery', async () => {
  const dir = await tempDir()
  let nowMs = Date.parse('2026-11-20T01:00:00+08:00')
  const ctx = fakeCtx()
  const runtime = startPlugin(ctx, {
    stateDir: dir,
    requireChannel: false,
    timezone: 'Asia/Shanghai',
    jobs: [{
      id: 'decl-hello',
      name: '问候',
      schedule: { at: iso(nowMs + 60_000) },
      payload: { kind: 'command', script: await helloScript(dir) },
    }],
  }, { now: () => new Date(nowMs) })

  await runtime.ready
  assert.equal(runtime.available, false)
  assert.match(ctx.loggerObj.lines.warn.join('\n'), /delivery=pending/u)

  nowMs += 61_000
  await runtime.scheduler.tick()
  const runs = await runtime.store.readRuns({ limit: 5 })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].result.kind, 'ok')
  assert.equal(runs[0].deliver.status, 'skipped')
  assert.equal(ctx.provided.get('imCron').available, false)
  runtime.stop()
})

test('apply: a broken declared job is skipped, the rest still load', async () => {
  const dir = await tempDir()
  const ctx = fakeCtx()
  let nowMs = Date.parse('2026-11-20T01:00:00+08:00')
  const runtime = startPlugin(ctx, {
    stateDir: dir,
    requireChannel: false,
    jobs: [
      { id: 'decl-bad', name: '坏任务', schedule: { at: '2020-01-01T00:00:00Z' }, payload: { kind: 'notify', text: 'x' } },
      { id: 'decl-ok', name: '好任务', schedule: { cron: '0 9 * * *' }, payload: { kind: 'notify', text: 'y' } },
    ],
  }, { now: () => new Date(nowMs) })

  await runtime.ready
  assert.deepEqual(runtime.scheduler.listJobs().map((job) => job.id), ['decl-ok'])
  assert.match(ctx.loggerObj.lines.warn.join('\n'), /排期非法/u)
  runtime.stop()
})

test('apply: never throws on garbage configuration', async () => {
  const dir = await tempDir()
  const ctx = fakeCtx()
  assert.doesNotThrow(() => {
    const runtime = startPlugin(ctx, { stateDir: dir, pollSeconds: 'not-a-number', activeHours: 'nope' })
    runtime.stop()
  })
})

test('effect: the registered disposer stops polling', async () => {
  const dir = await tempDir()
  const ctx = fakeCtx()
  const runtime = startPlugin(ctx, { stateDir: dir, requireChannel: false }, { now: () => new Date() })
  await runtime.ready
  assert.equal(typeof ctx.effects[0], 'function')
  const disposer = ctx.effects[0]()
  assert.equal(typeof disposer, 'function')
  assert.doesNotThrow(() => disposer())
})

test('apply: exported entry never throws even without a usable context', () => {
  assert.doesNotThrow(() => apply({}, {}))
})

function agentHarness() {
  const listeners = new Set()
  const sessions = new Map()
  let counter = 0

  const emit = (sessionId, event) => {
    for (const listener of [...listeners]) listener({ id: sessionId }, event)
  }

  function makeAgent(sessionId) {
    const agent = {
      session: { id: sessionId },
      status: 'idle',
      followup(message) {
        setTimeout(() => {
          emit(sessionId, { type: 'turn/start', data: { turn: 1 } })
          emit(sessionId, { type: 'user/message', data: { id: message.id, role: 'user', content: message.content, source: message.source } })
          emit(sessionId, {
            type: 'assistant/message',
            data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '汇总结果：三条要闻' }] } },
          })
          emit(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
        }, 0)
      },
    }
    return agent
  }

  const controller = {
    async create() {
      const sessionId = `session-${++counter}`
      const agent = makeAgent(sessionId)
      sessions.set(sessionId, agent)
      return { sessionId, agentPreset: 'standard' }
    },
    async selectModel(request) { return { selected: request } },
    async resolveAgent(sessionId) {
      const agent = sessions.get(sessionId)
      return agent === undefined
        ? { error: Object.assign(new Error('not found'), { code: 'session/not-found' }) }
        : { agent }
    },
  }

  return {
    services: { sessionController: controller },
    on: (name, handler) => {
      if (name !== 'session/event') return () => {}
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    sessions,
  }
}

test('apply: an agent job runs a turn, delivers the answer and remembers the session', async () => {
  const dir = await tempDir()
  const dshIm = fakeDshIm()
  const agents = agentHarness()
  let nowMs = Date.parse('2026-11-20T01:00:00+08:00')
  const ctx = fakeCtx({
    services: { dshIm: dshIm.service, ...agents.services },
    on: agents.on,
  })

  const runtime = startPlugin(ctx, {
    stateDir: dir,
    timezone: 'Asia/Shanghai',
    jobs: [{
      id: 'decl-news',
      name: '新闻汇总',
      schedule: { at: iso(nowMs + 60_000) },
      payload: { kind: 'agent', prompt: '汇总今天的重点新闻' },
      deliver: 'always',
      target: { botId: 'bot-1', targetId: 'cron-1' },
    }],
  }, { now: () => new Date(nowMs) })

  await runtime.ready
  assert.equal(runtime.agent.available, true)

  nowMs += 61_000
  const tick = await runtime.scheduler.tick()
  assert.deepEqual(tick.fired.map((entry) => entry.jobId), ['decl-news'])
  assert.equal(dshIm.sent.length, 1)
  assert.equal(dshIm.sent[0].text, '汇总结果：三条要闻')

  const job = runtime.scheduler.getJob('decl-news')
  assert.equal(job.task.sessionId, 'session-1')
  assert.equal(job.task.runs, 1)

  const runs = await runtime.store.readRuns({ limit: 5 })
  assert.equal(runs[0].mode, 'agent')
  assert.equal(runs[0].result.kind, 'ok')
  assert.equal(runs[0].sessionId, 'session-1')
  assert.equal(runs[0].turn, 1)
  runtime.stop()
})

test('apply: agent payload with deliver "never" records the answer without sending', async () => {
  const dir = await tempDir()
  const dshIm = fakeDshIm()
  const agents = agentHarness()
  let nowMs = Date.parse('2026-11-20T01:00:00+08:00')
  const ctx = fakeCtx({ services: { dshIm: dshIm.service, ...agents.services }, on: agents.on })

  const runtime = startPlugin(ctx, {
    stateDir: dir,
    jobs: [{
      id: 'decl-quiet',
      name: '静默汇总',
      schedule: { at: iso(nowMs + 60_000) },
      payload: { kind: 'agent', prompt: 'quiet please' },
      deliver: 'never',
      target: { botId: 'bot-1', targetId: 'cron-1' },
    }],
  }, { now: () => new Date(nowMs) })

  await runtime.ready
  nowMs += 61_000
  await runtime.scheduler.tick()
  assert.equal(dshIm.sent.length, 0)
  const runs = await runtime.store.readRuns({ limit: 5 })
  assert.equal(runs[0].deliver.status, 'skipped')
  assert.match(runs[0].textTail, /汇总结果/u)
  runtime.stop()
})


test('apply: a long body is handed to dsh-im whole (no pre-chunking)', async () => {
  const dir = await tempDir()
  const dshIm = fakeDshIm()
  let nowMs = Date.parse('2026-11-20T01:00:00+08:00')
  const ctx = fakeCtx({ service: dshIm.service })
  const body = 'x'.repeat(3_000)

  const runtime = startPlugin(ctx, {
    stateDir: dir,
    maxNotifyChars: 5_000,
    jobs: [{
      id: 'decl-long',
      name: '长文',
      schedule: { at: iso(nowMs + 60_000) },
      payload: { kind: 'notify', text: body },
      target: { botId: 'bot-1', targetId: 'cron-1' },
    }],
  }, { now: () => new Date(nowMs) })

  await runtime.ready
  nowMs += 61_000
  await runtime.scheduler.tick()
  assert.equal(dshIm.sent.length, 1, 'one send call, dsh-im owns the chunking')
  assert.equal(dshIm.sent[0].text.length, 3_000)
  runtime.stop()
})

test('apply: delivery keeps working after the chat session is rebound (/new)', async () => {
  const dir = await tempDir()
  const dshIm = fakeDshIm()
  let nowMs = Date.parse('2026-11-20T01:00:00+08:00')
  const ctx = fakeCtx({ service: dshIm.service })

  const runtime = startPlugin(ctx, {
    stateDir: dir,
    jobs: [{
      id: 'decl-rebind',
      name: '斜杠新会话后仍推送',
      schedule: { cron: '0 9 * * *' },
      payload: { kind: 'notify', text: '仍然送达' },
      target: { botId: 'bot-1', targetId: 'cron-1' },
    }],
  }, { now: () => new Date(nowMs) })

  await runtime.ready
  // Simulate `/new`: the harness session is no longer the chat binding, so the
  // reverse lookup stops answering. Delivery must not depend on it.
  dshIm.service.describeConversation = async () => null

  nowMs = Date.parse('2026-11-20T09:00:30+08:00')
  await runtime.scheduler.tick()
  await runtime.scheduler.tick()
  assert.equal(dshIm.sent.length, 1)
  assert.equal(dshIm.sent[0].targetId, 'cron-1')
  runtime.stop()
})


test('apply: native schedule tools are denied for IM-bound agents only', async () => {
  const dir = await tempDir()
  const restricted = []
  const dshIm = fakeDshIm()
  dshIm.service.describeConversationSync = (sessionId) => (
    sessionId === 'session-im' ? { channel: 'qq', botId: 'bot-1', chatType: 'dm', chatId: null, senderId: 'OPENID-1' } : null
  )
  const ctx = fakeCtx({ service: dshIm.service })
  const runtime = startPlugin(ctx, { stateDir: dir, requireChannel: false }, { now: () => new Date() })
  await runtime.ready

  const agent = (sessionId) => ({
    session: { id: sessionId },
    ctx: { tools: { restrict: (filter) => restricted.push({ sessionId, filter }) } },
  })
  ctx.emit('agent/created', { agent: agent('session-im'), source: 'fresh' })
  ctx.emit('agent/created', { agent: agent('session-web'), source: 'fresh' })

  assert.equal(restricted.length, 1)
  assert.equal(restricted[0].sessionId, 'session-im')
  assert.deepEqual(restricted[0].filter.deny, ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view'])
  runtime.stop()
})

test('apply: an agent without a scoped tools service does not break creation', async () => {
  const dir = await tempDir()
  const dshIm = fakeDshIm()
  dshIm.service.describeConversationSync = () => ({ chatType: 'dm' })
  const ctx = fakeCtx({ service: dshIm.service })
  const runtime = startPlugin(ctx, { stateDir: dir, requireChannel: false }, { now: () => new Date() })
  await runtime.ready
  assert.doesNotThrow(() => ctx.emit('agent/created', { agent: { session: { id: 'session-1' } } }))
  runtime.stop()
})


test('guard: native schedule calls from an IM session are blocked with an imcron hint', async () => {
  const dir = await tempDir()
  const dshIm = fakeDshIm()
  // The live sync memo can be cold for a resumed session; the async lookup is
  // the authoritative answer and must be enough on its own.
  dshIm.service.describeConversationSync = () => null
  dshIm.service.describeConversation = async (sessionId) => (
    sessionId === 'session-im' ? { channel: 'qq', botId: 'bot-1', chatType: 'dm', chatId: null, senderId: 'OPENID-1' } : null
  )
  const ctx = fakeCtx({ service: dshIm.service })
  const runtime = startPlugin(ctx, { stateDir: dir, requireChannel: false }, { now: () => new Date() })
  await runtime.ready

  const calls = []
  const next = async () => { calls.push('next'); return { content: [{ type: 'text', text: 'ran' }] } }
  const blocked = await ctx.dispatch(
    'tools/execute',
    { name: 'schedule_create', agent: { session: { id: 'session-im' } } },
    next,
  )
  assert.equal(calls.length, 0, 'the native tool must not run')
  assert.equal(blocked.isError, true)
  assert.match(blocked.content[0].text, /imcron_remind/u)

  const allowed = await ctx.dispatch(
    'tools/execute',
    { name: 'schedule_create', agent: { session: { id: 'session-web' } } },
    next,
  )
  assert.equal(calls.length, 1, 'web sessions keep the native tool')
  assert.equal(allowed.content[0].text, 'ran')

  const other = await ctx.dispatch(
    'tools/execute',
    { name: 'bash', agent: { session: { id: 'session-im' } } },
    next,
  )
  assert.equal(calls.length, 2, 'unrelated tools are untouched')
  assert.equal(other.content[0].text, 'ran')
  runtime.stop()
})


test('apply: the channel is resolved lazily when dsh-im appears after boot', async () => {
  const dir = await tempDir()
  const dshIm = fakeDshIm()
  const services = {}
  let nowMs = Date.parse('2026-11-20T01:00:00+08:00')
  const ctx = fakeCtx({ services })
  const runtime = startPlugin(ctx, {
    stateDir: dir,
    requireChannel: false,
    jobs: [{
      id: 'decl-late',
      name: '晚到的渠道',
      schedule: { at: iso(nowMs + 60_000) },
      payload: { kind: 'notify', text: '渠道稍后才就绪' },
      target: { botId: 'bot-1', targetId: 'cron-1' },
    }],
  }, { now: () => new Date(nowMs) })

  await runtime.ready
  assert.equal(ctx.provided.get('imCron').available, false)

  // dsh-im's own async apply finishes after ours: the service shows up late.
  services.dshIm = dshIm.service

  nowMs += 61_000
  await runtime.scheduler.tick()
  assert.equal(dshIm.sent.length, 1)
  assert.equal(dshIm.sent[0].text, '渠道稍后才就绪')
  assert.equal(ctx.provided.get('imCron').available, true)
  runtime.stop()
})

test('apply: the IM schedule guard works even when dsh-im resolves late', async () => {
  const dir = await tempDir()
  const dshIm = fakeDshIm()
  dshIm.service.describeConversationSync = () => null
  dshIm.service.describeConversation = async () => ({ chatType: 'dm' })
  const services = {}
  const ctx = fakeCtx({ services })
  const runtime = startPlugin(ctx, { stateDir: dir, requireChannel: false }, { now: () => new Date() })
  await runtime.ready
  services.dshIm = dshIm.service

  const next = async () => ({ content: [{ type: 'text', text: 'ran' }] })
  const blocked = await ctx.dispatch(
    'tools/execute',
    { name: 'schedule_create', agent: { session: { id: 'session-im' } } },
    next,
  )
  assert.equal(blocked.isError, true)
  runtime.stop()
})

test('plugin config: allowGroup defaults to off and stays live through the Loader reference', () => {
  const accepted = Config['~standard'].validate({ stateDir: '/tmp/state', timezone: 'Asia/Shanghai' })
  assert.equal(accepted.issues, undefined)
  assert.equal(accepted.value.allowGroup.get(), false)
  // The partial schema must not drop the row's other keys.
  assert.equal(accepted.value.stateDir, '/tmp/state')
  assert.equal(typeof accepted.value.allowGroup.get, 'function')

  // A resolved config carries the switch as a reference; parseConfig snapshots
  // the value read at startup.
  assert.equal(parseConfig({}).config.allowGroup, false)
  assert.equal(parseConfig({ allowGroup: { get: () => true } }).config.allowGroup, true)
})
