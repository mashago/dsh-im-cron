import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAgentTurn } from '../core/agent-turn.js'
import { setAgentSettings } from '../agent-settings.js'

/**
 * Minimal stand-in for DSH's session/agent services: sessions are just ids,
 * events are dispatched synchronously from a per-followup plan.
 */
function createHarness({ plan, timeoutSeconds = 5, maxConcurrent = 2, permissionPreset = null, agentModel = true, modelReject = null, permissionNames = null } = {}) {
  setAgentSettings({})
  const listeners = new Set()
  const sessions = new Map()
  const created = []
  const cancels = []
  let nextSession = 1

  const emit = (sessionId, event) => {
    const session = { id: sessionId }
    for (const listener of [...listeners]) listener(session, event)
  }

  function makeAgent(sessionId) {
    const titles = []
    const agent = {
      titles,
      session: {
        id: sessionId,
        snapshotEvents: () => titles.map((title) => ({ type: 'session/title', data: { title } })),
        append: (type, data) => { if (type === 'session/title') titles.push(data.title) },
      },
      status: 'idle',
      turns: 0,
      ...(agentModel ? {
        model: {
          select(selection) {
            modelSelections.push({ sessionId, ...selection })
          },
        },
      } : {}),
      cancel(cause) { cancels.push({ sessionId, cause }) },
      followup(message) {
        agent.turns += 1
        const turn = agent.turns
        const handler = plan ?? ((msg, api) => api.complete(msg, 'answer-ok'))
        setTimeout(() => {
          try {
            handler(message, {
              turn,
              sessionId,
              /** Raw event sink for scripted turns that need tool/call shapes. */
              emit(sid, event) { emit(sid, event) },
              complete(msg, text, reason = { kind: 'completed' }) {
                emit(sessionId, { type: 'turn/start', data: { turn } })
                emit(sessionId, { type: 'user/message', data: { id: msg.id, role: 'user', content: msg.content, source: msg.source } })
                if (text !== null) {
                  emit(sessionId, {
                    type: 'assistant/message',
                    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
                  })
                }
                emit(sessionId, { type: 'turn/end', data: { turn, reason } })
              },
              startOnly() {
                emit(sessionId, { type: 'turn/start', data: { turn } })
              },
              assistant(msg, text) {
                emit(sessionId, {
                  type: 'assistant/message',
                  data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
                })
              },
              end(reason) {
                emit(sessionId, { type: 'turn/end', data: { turn, reason } })
              },
              agent,
            })
          } catch {
            // swallow plan failures: the test asserts on the final outcome
          }
        }, 0)
      },
    }
    return agent
  }

  const selections = []
  const controller = {
    async create({ cwd, agentPreset }) {
      const sessionId = `session-${nextSession++}`
      created.push({ sessionId, cwd, agentPreset })
      const agent = makeAgent(sessionId)
      sessions.set(sessionId, agent)
      // Real DSH composes the deployment default preset when none is requested,
      // and reports it back; the task stores that resolved name.
      return { sessionId, agentPreset: agentPreset ?? 'standard' }
    },
    async selectModel(request) {
      selections.push(request)
      return { selected: request }
    },
    async resolveAgent(sessionId) {
      const agent = sessions.get(sessionId)
      if (agent !== undefined) return { agent }
      const error = new Error('Session not found')
      error.code = 'session/not-found'
      return { error }
    },
  }

  const presetCalls = []
  const modelSelections = []
  const modelValidations = []
  let rejectModel = modelReject
  const ctx = {
    get: (name) => {
      if (name === 'sessionController') return controller
      if (name === 'permissionPresets') {
        return {
          ...(permissionNames === null ? {} : { names: permissionNames }),
          set: (session, name) => presetCalls.push({ session, name }),
        }
      }
      if (name === 'llm') {
        return {
          async resolveCallConfig(selection) {
            modelValidations.push(selection)
            if (rejectModel !== null) {
              const error = new Error('model route rejected')
              error.code = rejectModel
              throw error
            }
          },
        }
      }
      return undefined
    },
  }

  return {
    ctx,
    controller,
    selections,
    sessions,
    presetCalls,
    modelSelections,
    modelValidations,
    rejectModel: (value) => { rejectModel = value },
    created,
    cancels,
    emit,
    subscribe: (handler) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    runtime: (options = {}) => createAgentTurn({
      ctx,
      config: { stateDir: '/tmp/imcron-state', agent: { enabled: true, timeoutSeconds, maxConcurrent, permissionPreset } },
      subscribe: (handler) => {
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      pollMs: 10,
      ...options,
    }),
  }
}

function job(overrides = {}) {
  return {
    id: 'imc-agent',
    name: '汇总',
    payload: { kind: 'agent', prompt: 'summarize news' },
    task: { cwd: '/tmp', sessionId: undefined, agentPreset: 'standard', runs: 0 },
    ...overrides,
  }
}

test('agent: a completed turn returns the last assistant text', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  assert.equal(runtime.available, true)

  const result = await runtime.runTurn(job(), { prompt: 'summarize news', occurrence: '2026-11-20T01:00:00.000Z' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'answer-ok')
  assert.equal(result.turn, 1)
  assert.equal(result.sessionId, 'session-1')
  assert.equal(result.task.sessionId, 'session-1')
  assert.equal(result.task.runs, 1)
  assert.equal(result.result.kind, 'ok')
})

test('agent: max-tokens still counts as success', async () => {
  const harness = createHarness({
    plan: (msg, api) => api.complete(msg, 'partial', { kind: 'max-tokens' }),
  })
  const result = await harness.runtime().runTurn(job(), { prompt: 'x' })
  assert.equal(result.ok, true)
  assert.equal(result.result.reason, 'max-tokens')
})

test('agent: an archived session reports blocked and drops the session id', async () => {
  const harness = createHarness({
    plan: (msg, api) => api.complete(msg, 'too late', { kind: 'blocked' }),
  })
  const result = await harness.runtime().runTurn(job({ task: { cwd: '/tmp', sessionId: 'session-1' } }), { prompt: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.blocked, true)
  assert.equal(result.result.reason, 'session-archived')
  assert.equal(result.task.sessionId, undefined)
})

test('agent: an aborted turn is pending, not failed', async () => {
  const harness = createHarness({
    plan: (msg, api) => api.complete(msg, null, { kind: 'aborted', reason: { kind: 'user' } }),
  })
  const result = await harness.runtime().runTurn(job(), { prompt: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.result.kind, 'failed')
  assert.equal(result.result.reason, 'aborted')
})

test('agent: a missing session is recreated and the run continues', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  const result = await runtime.runTurn(
    job({ task: { cwd: '/tmp', sessionId: 'session-gone', runs: 4 } }),
    { prompt: 'x' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'session-1')
  assert.equal(harness.created.length, 1)
  assert.equal(result.task.runs, 5)
})

test('agent: an expired session is rebuilt once, not on every run', async () => {
  let clockMs = Date.parse('2026-11-20T01:00:00+08:00')
  const harness = createHarness()
  const runtime = harness.runtime({
    now: () => new Date(clockMs),
    config: {
      stateDir: '/tmp/imcron-state',
      agent: { enabled: true, timeoutSeconds: 5, maxConcurrent: 2, taskSessionMaxAgeDays: 30 },
    },
  })

  const first = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(first.ok, true)
  assert.equal(harness.created.length, 1)
  const firstCreatedAt = first.task.sessionCreatedAt
  assert.ok(Number.isFinite(Date.parse(firstCreatedAt)))

  // Past the 30-day limit: the session is replaced and its clock restarts.
  clockMs += 31 * 86_400_000
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.equal(harness.created.length, 2)
  assert.notEqual(second.sessionId, first.sessionId)
  assert.ok(Date.parse(second.task.sessionCreatedAt) > Date.parse(firstCreatedAt))

  // The fresh session is young again, so this run must reuse it. Before the fix
  // the old stamp was carried forward and every run rebuilt the session.
  clockMs += 3_600_000
  const third = await runtime.runTurn(job({ task: second.task }), { prompt: 'three' })
  assert.equal(third.ok, true)
  assert.equal(third.sessionId, second.sessionId)
  assert.equal(harness.created.length, 2)
})

test('agent: a running agent is skipped instead of queued', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  // Warm up the session so the next run resolves it.
  await runtime.runTurn(job(), { prompt: 'x' })
  harness.sessions.get('session-1').status = 'running'
  const result = await runtime.runTurn(job({ task: { cwd: '/tmp', sessionId: 'session-1' } }), { prompt: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.result.kind, 'skipped')
  assert.equal(result.result.reason, 'running')
})

test('agent: an out-of-range timeout falls back instead of firing immediately', async () => {
  const harness = createHarness({
    plan: (msg, api) => setTimeout(() => api.complete(msg, 'ok'), 20),
  })
  const result = await harness.runtime().runTurn(job(), { prompt: 'x', timeoutSeconds: 10 ** 9 })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'ok')
})

test('agent: a turn that finishes after the soft deadline still delivers its answer', async () => {
  const harness = createHarness({
    timeoutSeconds: 0.05,
    plan: (msg, api) => {
      api.startOnly()
      api.agent.status = 'running'
      // Finishes between the soft deadline (50ms) and the hard one (100ms).
      setTimeout(() => api.complete(msg, 'slow but fine'), 70)
    },
  })
  const runtime = harness.runtime()
  const result = await runtime.runTurn(job(), { prompt: 'x' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'slow but fine')
  assert.equal(harness.cancels.length, 0)
})

test('agent: a turn past the hard deadline is cancelled and reported stuck', async () => {
  const harness = createHarness({
    timeoutSeconds: 0.05,
    plan: (msg, api) => {
      api.startOnly()
      api.agent.status = 'running'
    },
  })
  const runtime = harness.runtime()
  const result = await runtime.runTurn(job(), { prompt: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.result.kind, 'failed')
  assert.equal(result.result.reason, 'stuck')
  // Cancel happens at the hard deadline, as part of settling the run.
  assert.equal(harness.cancels.length, 1)
  assert.deepEqual(harness.cancels[0].cause, { kind: 'user' })
})

test('agent: an explicit stuck grace overrides the doubled deadline', async () => {
  const harness = createHarness({
    timeoutSeconds: 0.05,
    plan: (msg, api) => {
      api.startOnly()
      api.agent.status = 'running'
    },
  })
  const runtime = harness.runtime({ config: { agent: { enabled: true, timeoutSeconds: 0.05, stuckGraceSeconds: 0.15 } } })
  const result = await runtime.runTurn(job(), { prompt: 'x' })
  assert.equal(result.result.reason, 'stuck')
})

test('agent: attribution falls back to the opened turn when the claim event is missing', async () => {
  const harness = createHarness({
    plan: (msg, api) => {
      api.startOnly()
      api.assistant(msg, 'fallback text')
      api.end({ kind: 'completed' })
    },
  })
  const result = await harness.runtime().runTurn(job(), { prompt: 'x' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'fallback text')
})

test('agent: the last assistant message of the turn wins', async () => {
  const harness = createHarness({
    plan: (msg, api) => {
      api.startOnly()
      api.complete(msg, null, { kind: 'completed' })
    },
  })
  // A second run on the same session keeps accumulating by turn number.
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  const second = await runtime.runTurn(job({ task: { ...first.task, sessionId: first.sessionId } }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.equal(second.turn, 2)
})

test('agent: a followup failure is reported without throwing', async () => {
  const harness = createHarness()
  harness.sessions.set('session-1', {
    session: { id: 'session-1' },
    status: 'idle',
    followup() { throw new Error('inbox closed') },
  })
  const result = await harness.runtime().runTurn(job({ task: { cwd: '/tmp', sessionId: 'session-1' } }), { prompt: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.result.reason, 'followup-failed')
})

test('agent: concurrency is capped and queued runs proceed afterwards', async () => {
  const harness = createHarness({
    maxConcurrent: 1,
    plan: (msg, api) => setTimeout(() => api.complete(msg, 'slow'), 30),
  })
  const runtime = harness.runtime()
  const first = runtime.runTurn(job({ task: { cwd: '/tmp', sessionId: undefined } }), { prompt: 'a' })
  const second = runtime.runTurn(job({ task: { cwd: '/tmp', sessionId: undefined } }), { prompt: 'b' })
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
})

test('agent: no session controller means the runtime is unavailable', async () => {
  const runtime = createAgentTurn({ ctx: { get: () => undefined }, config: {} })
  assert.equal(runtime.available, false)
  const result = await runtime.runTurn(job(), { prompt: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.result.reason, 'agent-unavailable')
})

test('agent: an empty prompt is rejected before touching any session', async () => {
  const harness = createHarness()
  const result = await harness.runtime().runTurn(job(), { prompt: '   ' })
  assert.equal(result.result.reason, 'empty-prompt')
  assert.equal(harness.created.length, 0)
})

test('agent: services provided after construction are picked up', async () => {
  const harness = createHarness()
  const holder = { controller: undefined }
  const ctx = { get: (name) => (name === 'sessionController' ? holder.controller : undefined) }
  const runtime = createAgentTurn({
    ctx,
    config: { agent: { enabled: true, timeoutSeconds: 5 } },
    subscribe: harness.subscribe,
    pollMs: 10,
  })
  assert.equal(runtime.available, false)
  holder.controller = harness.controller
  assert.equal(runtime.available, true)
  const result = await runtime.runTurn(job(), { prompt: 'late provider' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'answer-ok')
})


test('agent settings: a changed cwd rebuilds the task session on the next run', async () => {
  setAgentSettings({ cwd: '/tmp' })
  const harness = createHarness()
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(first.ok, true)
  const firstSession = first.sessionId

  setAgentSettings({ cwd: '/tmp/other' })
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.notEqual(second.sessionId, firstSession)
  assert.equal(second.task.config.cwd, '/tmp/other')
  assert.equal(harness.created.length, 2)
  setAgentSettings({})
})

test('agent sessions: cwd defaults to the plugin state directory', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  const result = await runtime.runTurn(job({ task: { sessionId: undefined, runs: 0 } }), { prompt: 'x' })
  assert.equal(result.ok, true)
  assert.equal(harness.created[0].cwd, '/tmp/imcron-state')
  assert.equal(result.task.config.cwd, '/tmp/imcron-state')
})

test('agent settings: an unchanged config keeps the same session', async () => {
  setAgentSettings({ cwd: '/tmp', agentPreset: 'standard' })
  const harness = createHarness()
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(harness.created.length, 1)
  setAgentSettings({})
})

test('agent settings: a provider/model route is pinned on the task session only', async () => {
  const harness = createHarness()
  setAgentSettings({ cwd: '/tmp', provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  const runtime = harness.runtime()

  const result = await runtime.runTurn(job(), { prompt: 'route me' })
  assert.equal(result.ok, true)
  assert.equal(harness.created.length, 1)
  assert.equal(harness.created[0].cwd, '/tmp')
  assert.deepEqual(harness.modelValidations, [{ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }])
  assert.equal(harness.modelSelections.length, 1)
  assert.equal(harness.modelSelections[0].sessionId, result.sessionId)
  assert.equal(harness.modelSelections[0].provider, 'deepseek-account')
  assert.equal(harness.modelSelections[0].model, 'deepseek-flash')
  assert.equal(harness.modelSelections[0].reasoningEffort, 'high')
  // selectModel would also persist the deployment default, which task settings must not touch.
  assert.equal(harness.selections.length, 0)
  setAgentSettings({})
})

test('agent settings: a Host without agent.model.select falls back to selectModel', async () => {
  const harness = createHarness({ agentModel: false })
  setAgentSettings({ cwd: '/tmp', provider: 'deepseek-account', model: 'deepseek-flash' })
  const result = await harness.runtime().runTurn(job(), { prompt: 'route me' })
  assert.equal(result.ok, true)
  assert.equal(harness.modelSelections.length, 0)
  assert.equal(harness.selections.length, 1)
  assert.equal(harness.selections[0].sessionId, result.sessionId)
  setAgentSettings({})
})

test('agent settings: a model change applies in place and keeps the task session', async () => {
  const harness = createHarness()
  setAgentSettings({ cwd: '/tmp', provider: 'p', model: 'model-a', reasoningEffort: 'high' })
  const runtime = harness.runtime()
  const first = await runtime.runTurn(
    job({ task: { cwd: '/tmp', sessionId: undefined, runs: 0 } }),
    { prompt: 'one' },
  )
  assert.equal(first.ok, true)
  assert.equal(harness.created.length, 1)

  setAgentSettings({ cwd: '/tmp', provider: 'p', model: 'model-b', reasoningEffort: 'high' })
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(harness.created.length, 1)
  assert.deepEqual(harness.modelSelections.at(-1), {
    sessionId: first.sessionId, provider: 'p', model: 'model-b', reasoningEffort: 'high',
  })
  assert.equal(second.task.config.model, 'model-b')
  setAgentSettings({})
})

test('agent settings: the resolved default preset does not rebuild the session', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  const first = await runtime.runTurn(
    job({ task: { cwd: '/tmp', sessionId: undefined, runs: 0 } }),
    { prompt: 'one' },
  )
  assert.equal(first.ok, true)
  // The deployment composed "standard", but the operator never configured one.
  assert.equal(first.task.agentPreset, 'standard')
  assert.equal(first.task.config.agentPreset, undefined)

  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(harness.created.length, 1)
})

test('agent settings: an effort-only change applies in place too', async () => {
  const harness = createHarness()
  setAgentSettings({ cwd: '/tmp', provider: 'p', model: 'model-a', reasoningEffort: 'high' })
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(first.ok, true)

  setAgentSettings({ cwd: '/tmp', provider: 'p', model: 'model-a', reasoningEffort: 'low' })
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(harness.created.length, 1)
  assert.equal(harness.modelSelections.at(-1).reasoningEffort, 'low')
  assert.equal(second.task.config.reasoningEffort, 'low')
  setAgentSettings({})
})

test('agent settings: a permission-only change keeps the task session', async () => {
  const harness = createHarness()
  setAgentSettings({ cwd: '/tmp', permissionPreset: 'workspace-write' })
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(first.ok, true)

  setAgentSettings({ cwd: '/tmp', permissionPreset: 'danger-full-access' })
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(harness.created.length, 1)
  assert.deepEqual(harness.presetCalls.map((call) => call.name), ['workspace-write', 'danger-full-access'])
  setAgentSettings({})
})

test('agent settings: clearing the permission preset rebuilds the task session', async () => {
  const harness = createHarness()
  setAgentSettings({ cwd: '/tmp', permissionPreset: 'workspace-write' })
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(first.ok, true)

  setAgentSettings({ cwd: '/tmp' })
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(harness.created.length, 2)
  assert.equal(second.task.config.permissionPreset, undefined)
  setAgentSettings({})
})

test('agent settings: clearing the model pin rebuilds the task session', async () => {
  const harness = createHarness()
  setAgentSettings({ cwd: '/tmp', provider: 'p', model: 'model-a' })
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(first.ok, true)

  setAgentSettings({ cwd: '/tmp' })
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(harness.created.length, 2)
  assert.equal(harness.modelSelections.length, 1)
  assert.equal(second.task.config.provider, undefined)
  setAgentSettings({})
})

test('agent settings: an unusable route fails the run before creating a session', async () => {
  const harness = createHarness({ modelReject: 'model-unavailable' })
  setAgentSettings({ cwd: '/tmp', provider: 'p', model: 'missing' })
  const result = await harness.runtime().runTurn(job(), { prompt: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.result.reason, 'model-unavailable')
  assert.match(result.text, /不可用/u)
  assert.equal(harness.created.length, 0)
  assert.equal(harness.modelSelections.length, 0)
  setAgentSettings({})
})

test('agent settings: a running session is not re-pinned mid-turn', async () => {
  const harness = createHarness()
  setAgentSettings({ cwd: '/tmp', provider: 'p', model: 'model-a' })
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(first.ok, true)
  harness.sessions.get(first.sessionId).status = 'running'

  setAgentSettings({ cwd: '/tmp', provider: 'p', model: 'model-b' })
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, false)
  assert.equal(second.result.reason, 'running')
  assert.equal(harness.modelSelections.length, 1)
  setAgentSettings({})
})

test('agent settings: a legacy session yields to the first configured settings', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(first.ok, true)
  const legacyTask = { cwd: '/tmp', sessionId: first.sessionId }

  setAgentSettings({ cwd: '/tmp/legacy' })
  const second = await runtime.runTurn(job({ task: legacyTask }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(second.task.config.cwd, '/tmp/legacy')
  setAgentSettings({})
})

// The file's top-level tests run concurrently and `setAgentSettings` is
// module-global, so these cases pin the preset through the runtime config
// instead. The settings path is covered separately in agent-settings.test.js.
test('agent: the configured permission preset is pinned on a new task session', async () => {
  const harness = createHarness({ permissionPreset: 'danger-full-access' })
  const runtime = harness.runtime()
  const result = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(result.ok, true)
  assert.deepEqual(harness.presetCalls.map((call) => call.name), ['danger-full-access'])
  assert.equal(harness.presetCalls[0].session.id, result.sessionId)
})

test('agent: a reused task session is re-pinned, not skipped', async () => {
  const harness = createHarness({ permissionPreset: 'danger-full-access' })
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job(), { prompt: 'one' })
  const second = await runtime.runTurn(job({ task: first.task }), { prompt: 'two' })
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(harness.created.length, 1)
  // The reuse path must apply the preset too, otherwise a pinned preset never
  // reaches a task session that already exists.
  assert.equal(harness.presetCalls.length, 2)
})

test('agent: an unconfigured task takes the advertised strict preset', async () => {
  const harness = createHarness({
    permissionNames: ['workspace-write', 'workspace-write-strict', 'danger-full-access'],
  })
  const result = await harness.runtime().runTurn(job(), { prompt: 'x' })
  assert.equal(result.ok, true)
  assert.deepEqual(harness.presetCalls.map((call) => call.name), ['workspace-write-strict'])
})

test('agent: an unknown configured preset warns instead of switching', async () => {
  const warnings = []
  const harness = createHarness({ permissionNames: ['workspace-write', 'danger-full-access'] })
  setAgentSettings({ cwd: '/tmp', permissionPreset: 'gone-preset' })
  const result = await harness.runtime({
    logger: { warn: (message) => warnings.push(String(message)), info() {} },
  }).runTurn(job(), { prompt: 'x' })
  assert.equal(result.ok, true)
  assert.equal(harness.presetCalls.length, 0)
  assert.ok(warnings.some((message) => message.includes('gone-preset')), warnings.join(' | '))
  setAgentSettings({})
})

test('agent: no configured preset leaves the session policy alone', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  await runtime.runTurn(job(), { prompt: 'one' })
  assert.deepEqual(harness.presetCalls, [])
})

test('agent: the task session is named after the job', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  const result = await runtime.runTurn(job({ name: '汇总新浪财经' }), { prompt: 'one' })
  assert.equal(result.ok, true)
  const titles = harness.sessions.get(result.sessionId).titles
  assert.deepEqual(titles, ['⏰ 汇总新浪财经'])
})

test('agent: a second run does not relabel the same task session', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job({ name: '汇总新浪财经' }), { prompt: 'one' })
  await runtime.runTurn(job({ name: '汇总新浪财经', task: first.task }), { prompt: 'two' })
  assert.deepEqual(harness.sessions.get(first.sessionId).titles, ['⏰ 汇总新浪财经'])
})

test('agent: a title the user already set is left alone', async () => {
  const harness = createHarness()
  const runtime = harness.runtime()
  const first = await runtime.runTurn(job({ name: '汇总' }), { prompt: 'one' })
  const agent = harness.sessions.get(first.sessionId)
  // Simulate a title the user typed by hand; relabeling it would lose their name.
  agent.session.snapshotEvents = () => [{ type: 'session/title', data: { title: '我自己的会话名' } }]
  agent.session.append = (type) => { throw new Error(`must not rewrite ${type}`) }
  const second = await runtime.runTurn(job({ name: '汇总', task: first.task }), { prompt: 'two' })
  assert.equal(second.ok, true)
  assert.equal(second.sessionId, first.sessionId)
})

/** Emit a scripted turn after the runner has subscribed, so it sees every event. */
function scriptedTurn(steps) {
  return (msg, api) => {
    const sid = api.sessionId
    const t = api.turn
    setTimeout(() => {
      const run = (event) => api.emit(sid, event)
      run({ type: 'turn/start', data: { turn: t } })
      run({ type: 'user/message', data: { id: msg.id, role: 'user', content: msg.content, source: msg.source } })
      for (const step of steps) {
        if (step.text !== undefined) {
          const content = [{ type: 'text', text: step.text }]
          if (step.toolCall === true) content.push({ type: 'tool-call', id: `c${step.step}`, name: 'bash', arguments: '{}' })
          run({ type: 'assistant/message', data: { turn: t, step: step.step, message: { role: 'assistant', content } } })
        }
        if (step.toolCall === true) {
          run({ type: 'tool/call', data: { turn: t, step: step.step, callId: `c${step.step}`, name: 'bash', arguments: '{}' } })
        }
      }
      run({ type: 'turn/end', data: { turn: t, reason: { kind: 'completed' } } })
    }, 0)
  }
}

test('agent: a preamble before a tool call is not the answer', async () => {
  const harness = createHarness({
    plan: scriptedTurn([
      { step: 1, text: '我来查一下。', toolCall: true },
      { step: 2, text: 'CPU 19%' },
    ]),
  })
  harness.emit = harness.emit
  const runtime = harness.runtime()
  const result = await runtime.runTurn(job(), { prompt: 'one' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'CPU 19%')
})

test('agent: an answer step that also asks for a tool is discarded', async () => {
  const harness = createHarness({
    plan: scriptedTurn([{ step: 1, text: '稍等，我查一下。', toolCall: true }]),
  })
  const runtime = harness.runtime()
  const result = await runtime.runTurn(job(), { prompt: 'one' })
  // Nothing pure-text was produced; the run still succeeds and the deliverer
  // falls back to the "完成（无输出）" notice.
  assert.equal(result.ok, true)
  assert.equal(result.text, '')
})

test('agent: text followed by a tool call and no final text yields no answer', async () => {
  const harness = createHarness({
    plan: scriptedTurn([
      { step: 1, text: '初步看是 19%。' },
      { step: 2, text: '我再确认一下。', toolCall: true },
    ]),
  })
  const runtime = harness.runtime()
  const result = await runtime.runTurn(job(), { prompt: 'one' })
  // The turn ended on tool activity, so the partial text is not the answer.
  assert.equal(result.ok, true)
  assert.equal(result.text, '')
})
