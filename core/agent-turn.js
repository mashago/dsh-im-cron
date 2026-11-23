/**
 * Agent-turn runtime for the `agent` payload (M2.5).
 *
 * One job owns one dedicated task session. A run:
 *   1. resolves the session (live → resume → recreate on session/not-found),
 *   2. posts one follow-up message carrying our own id,
 *   3. attributes the resulting turn by watching session events
 *      (`turn/start` opens a turn, `user/message` with our id claims it,
 *      `turn/end` for that turn closes it),
 *   4. returns the last assistant text of that turn.
 *
 * The session is never bound to a chat, so dsh-im cannot mirror it — the caller
 * delivers the answer exactly once. `turn/start` carries no message id, which is
 * why attribution needs the follow-up message identity.
 */
import { randomUUID } from 'node:crypto'
import { getAgentSettings } from '../agent-settings.js'
import { diag } from '../diag.js'

const MAX_TRACKED_TURNS = 8

function safeGet(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function sessionIdOf(value) {
  return value?.sessionId ?? value?.agent?.session?.id ?? value?.session?.id ?? value?.id ?? null
}

function assistantText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** Marker that lets a task session's title identify it as a scheduled task. */
const TASK_TITLE_PREFIX = '⏰ '

/**
 * Name a task session after its job so it is findable in the Web sidebar, where
 * an unassigned session otherwise sits under "Ungrouped" with a generic title.
 *
 * A title the user set by hand is left alone, and relabeling is idempotent. This
 * is decoration: any failure leaves the run untouched.
 * @param {object} session - the task session to label
 * @param {string} jobName - job name to show
 */
function labelTaskSession(session, jobName) {
  const name = typeof jobName === 'string' ? jobName.trim() : ''
  if (name === '') return
  if (typeof session?.append !== 'function' || typeof session?.snapshotEvents !== 'function') return
  const title = `${TASK_TITLE_PREFIX}${name.slice(0, 60)}`
  try {
    const events = session.snapshotEvents()
    const latest = Array.isArray(events) ? events.findLast?.((event) => event?.type === 'session/title') : undefined
    const current = latest?.data?.title
    if (typeof current === 'string' && current !== '' && !current.startsWith(TASK_TITLE_PREFIX)) return
    if (current === title) return
    session.append('session/title', latest?.data === undefined
      ? { title, source: { kind: 'user' }, messageSeqs: [] }
      : { ...latest.data, title })
  } catch {
    // A missing label must not fail the run it decorates.
  }
}

function reasonKind(reason) {
  return typeof reason === 'string' ? reason : reason?.kind ?? 'unknown'
}

function errorCode(error) {
  return typeof error?.code === 'string' && error.code !== '' ? error.code : 'agent-error'
}

function failure(reason, { error, text = '', task, blocked = false } = {}) {
  return {
    ok: false,
    blocked,
    text,
    ...(task === undefined ? {} : { task }),
    result: { kind: 'failed', reason, ...(error === undefined ? {} : { error }) },
  }
}

/**
 * Create the agent-turn runtime.
 * @param {{
 *   ctx: object,
 *   config: object,
 *   logger?: object,
 *   now?: () => Date,
 *   subscribe?: ((handler: (session: object, event: object) => void) => (() => void)) | null,
 *   cwd?: string, // explicit override; otherwise the plugin state directory
 *   pollMs?: number,
 * }} deps
 */
export function createAgentTurn({
  ctx,
  config = {},
  logger = null,
  now = () => new Date(),
  subscribe = null,
  cwd = null,
  pollMs = null,
} = {}) {
  // Services may be provided by plugins whose async `apply` finishes after ours,
  // so resolve them on use instead of capturing them at construction.
  let controllerService = null
  let agentsService = null
  let presetsService = null
  const controller = () => {
    const found = safeGet(ctx, 'sessionController')
    if (found !== undefined && found !== null) controllerService = found
    return controllerService
  }
  const agents = () => {
    const found = safeGet(ctx, 'agents')
    if (found !== undefined && found !== null) agentsService = found
    return agentsService
  }
  const permissionPresets = () => {
    const found = safeGet(ctx, 'permissionPresets')
    if (found !== undefined && found !== null) presetsService = found
    return presetsService
  }
  const hasController = () => {
    const value = controller()
    return value !== null && typeof value.resolveAgent === 'function' && typeof value.create === 'function'
  }
  const canResolve = () => hasController() || typeof agents()?.get === 'function'
  const enabled = config.agent?.enabled !== false

  const maxAgeDays = config.agent?.taskSessionMaxAgeDays ?? 30
  const maxConcurrent = Math.max(1, config.agent?.maxConcurrent ?? 2)
  const waitBudgetMs = Math.max(pollMs !== null ? pollMs * 2 : (config.pollSeconds ?? 30) * 2_000, 200)

  const watchers = new Map()

  function dispatch(session, event) {
    const id = session?.id
    if (typeof id !== 'string') return
    const set = watchers.get(id)
    if (set === undefined || set.size === 0) return
    for (const watcher of [...set]) {
      try {
        watcher(event)
      } catch (error) {
        logger?.warn?.(`[im-cron] 回合事件处理异常：${String(error?.message ?? error)}`)
      }
    }
  }

  let unsubscribe = null
  if (subscribe !== null && typeof subscribe === 'function') {
    unsubscribe = subscribe(dispatch)
  } else if (typeof ctx?.on === 'function') {
    try {
      unsubscribe = ctx.on('session/event', dispatch, { global: true })
    } catch (error) {
      logger?.warn?.(`[im-cron] 无法订阅 session/event：${String(error?.message ?? error)}`)
      unsubscribe = null
    }
  }

  // ---- concurrency gate -------------------------------------------------
  let active = 0
  const queue = []

  function releaseSlot() {
    active = Math.max(0, active - 1)
    const next = queue.shift()
    if (next !== undefined) {
      if (next.timer !== null) clearTimeout(next.timer)
      active += 1
      next.resolve(releaseSlot)
    }
  }

  function acquireSlot() {
    if (active < maxConcurrent) {
      active += 1
      return Promise.resolve(releaseSlot)
    }
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null }
      waiter.timer = setTimeout(() => {
        const index = queue.indexOf(waiter)
        if (index !== -1) queue.splice(index, 1)
        resolve(null)
      }, waitBudgetMs)
      waiter.timer.unref?.()
      queue.push(waiter)
    })
  }

  // ---- session resolution ------------------------------------------------
  /**
   * Create the dedicated task session through the public Session Controller:
   * `create` composes the preset and default route, `selectModel` pins the
   * configured route, `resolveAgent` hands back the live Agent.
   */
  async function createTaskSession(task, desired) {
    const sc = controller()
    const request = { cwd: desired.cwd, ...(desired.agentPreset === undefined ? {} : { agentPreset: desired.agentPreset }) }
    diag('create-task-session:enter', { request, desired })
    let created
    try {
      created = await sc.create(request)
    } catch (error) {
      const code = errorCode(error)
      if (desired.agentPreset !== undefined && (code === 'agent-preset/not-found' || /preset/u.test(String(error?.message ?? '')))) {
        logger?.warn?.(`[im-cron] 任务会话 preset "${desired.agentPreset}" 不可用，改用默认 preset`)
        created = await sc.create({ cwd: desired.cwd })
      } else {
        return { ok: false, result: failure('session-create-failed', { error: code }) }
      }
    }
    const sessionId = sessionIdOf(created)
    if (sessionId === null) return { ok: false, result: failure('session-create-failed', { error: 'no-session-id' }) }

    if (desired.provider !== undefined && desired.model !== undefined && typeof sc.selectModel === 'function') {
      try {
        await sc.selectModel({
          sessionId,
          provider: desired.provider,
          model: desired.model,
          ...(desired.reasoningEffort === undefined ? {} : { reasoningEffort: desired.reasoningEffort }),
        })
      } catch (error) {
        logger?.warn?.(`[im-cron] 任务会话模型选择失败，沿用默认模型：${errorCode(error)}`)
      }
    }

    const resolved = await sc.resolveAgent(sessionId)
    if (resolved?.agent === undefined) {
      return { ok: false, result: failure('session-create-failed', { error: errorCode(resolved?.error ?? 'agent-unavailable') }) }
    }
    await applyPermissionPreset(resolved.agent)
    return {
      ok: true,
      agent: resolved.agent,
      sessionId,
      agentPreset: created?.agentPreset ?? desired.agentPreset,
      created: true,
      // The expiry clock belongs to this session, not to the job. Carrying the
      // old stamp forward marked a freshly created session as expired on the
      // very next run, so it was rebuilt every time.
      sessionCreatedAt: now().toISOString(),
    }
  }

  async function applyPermissionPreset(agent) {
    const settings = getAgentSettings()
    const fromSettings = settings.permissionPreset
    const fromConfig = config.agent?.permissionPreset
    const preset = fromSettings ?? fromConfig
    const service = permissionPresets()
    diag('permission-preset:resolve', {
      fromSettings: fromSettings ?? null,
      fromConfig: fromConfig ?? null,
      chosen: preset ?? null,
      settingsSnapshot: settings,
      service: service === null ? 'missing' : typeof service.set,
      sessionPresent: agent?.session !== undefined,
    })
    if (preset === null || preset === undefined) return
    if (service === null || typeof service.set !== 'function') {
      logger?.warn?.('[im-cron] permissionPresets 不可用，跳过权限档设置')
      return
    }
    try {
      service.set(agent.session, preset)
      diag('permission-preset:applied', { preset })
    } catch (error) {
      diag('permission-preset:failed', { preset, error: String(error?.message ?? error) })
      logger?.warn?.(`[im-cron] 设置权限档 "${preset}" 失败：${String(error?.message ?? error)}`)
    }
  }

  async function resolveExisting(sessionId) {
    if (hasController()) {
      const result = await controller().resolveAgent(sessionId)
      if (result?.agent !== undefined) return { ok: true, agent: result.agent, sessionId }
      const code = result?.error?.code ?? 'agent-error'
      return { ok: false, code }
    }
    const service = agents()
    const live = service?.get?.(sessionId)
    if (live !== undefined && live !== null) return { ok: true, agent: live, sessionId }
    try {
      const handle = await service.resume({ resumeSessionId: sessionId })
      return { ok: true, agent: handle.agent, sessionId }
    } catch (error) {
      return { ok: false, code: errorCode(error) }
    }
  }

  function taskExpired(task) {
    const createdAt = Date.parse(task.sessionCreatedAt ?? '')
    if (!Number.isFinite(createdAt)) return false
    return now().getTime() - createdAt > maxAgeDays * 86_400_000
  }

  async function ensureAgent(task, desired, hasSettings = false) {
    diag('ensure-agent:enter', {
      frozenSessionId: task.sessionId ?? null,
      hasSettings,
      desired,
      frozenConfig: task.config ?? null,
    })
    if (typeof task.sessionId === 'string' && task.sessionId !== '') {
      if (taskExpired(task)) {
        diag('ensure-agent:decision', { decision: 'rebuild-expired' })
        logger?.info?.(`[im-cron] 任务会话 ${task.sessionId} 超过 ${maxAgeDays} 天，换新会话`)
      } else if (task.config === undefined ? hasSettings : !sameConfig(task.config, desired)) {
        diag('ensure-agent:decision', { decision: 'rebuild-config-changed' })
        logger?.info?.('[im-cron] 任务会话配置已变更，下一次运行重建会话')
      } else {
        diag('ensure-agent:decision', { decision: 'reuse' })
        const resolved = await resolveExisting(task.sessionId)
        if (resolved.ok) {
          // A reused session keeps whatever it had; re-pin so a changed preset applies.
          await applyPermissionPreset(resolved.agent)
          return resolved
        }
        if (resolved.code === 'session/writer-held') {
          return { ok: false, result: { ok: false, text: '', result: { kind: 'skipped', reason: 'writer-held' } } }
        }
        if (resolved.code !== 'session/not-found') {
          return { ok: false, result: failure(resolved.code) }
        }
        logger?.warn?.(`[im-cron] 任务会话 ${task.sessionId} 不存在，重新创建`)
      }
    }
    if (!hasController()) return { ok: false, result: failure('session-create-unavailable') }
    diag('ensure-agent:decision', { decision: 'create' })
    return createTaskSession(task, desired)
  }

  // ---- turn attribution --------------------------------------------------
  function watchTurn(sessionId, messageId, { timeoutMs, hardTimeoutMs, signal, witness = null }) {
    let openTurn = null
    let candidateTurn = null
    let ourTurn = null
    let settled = false
    let timeoutTimer = null
    let hardTimer = null
    const texts = new Map()
    const watcherSet = watchers.get(sessionId) ?? new Set()
    watchers.set(sessionId, watcherSet)

    let resolvePromise
    const promise = new Promise((resolve) => { resolvePromise = resolve })

    const cleanup = () => {
      if (settled) return false
      settled = true
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
      if (hardTimer !== null) clearTimeout(hardTimer)
      watcherSet.delete(watcher)
      if (watcherSet.size === 0) watchers.delete(sessionId)
      signal?.removeEventListener?.('abort', onAbort)
      return true
    }

    const settle = (outcome) => {
      if (!cleanup()) return
      resolvePromise(outcome)
    }

    function onAbort() {
      settle({ kind: 'aborted', turn: ourTurn ?? candidateTurn })
    }

    const watcher = (event) => {
      const type = event?.type
      const data = event?.data
      if (type === 'turn/start') {
        openTurn = typeof data?.turn === 'number' ? data.turn : null
        if (ourTurn === null && candidateTurn === null) candidateTurn = openTurn
        return
      }
      if (type === 'user/message') {
        if (data?.id === messageId) {
          ourTurn = typeof openTurn === 'number' ? openTurn : candidateTurn
        }
        return
      }
      if (type === 'tool/call') {
        // Tool activity invalidates any text collected so far: a preamble like
        // "let me check" is not the answer to the task.
        const turn = data?.turn
        if (typeof turn === 'number') texts.delete(turn)
        return
      }
      if (type === 'assistant/message') {
        const turn = data?.turn
        if (typeof turn === 'number') {
          const message = data?.message
          const blocks = Array.isArray(message?.content) ? message.content : []
          const askedTool = blocks.some((block) => block?.type === 'tool-call')
          if (data?.interrupted === true || askedTool) texts.delete(turn)
          else {
            const text = assistantText(message)
            // An empty step contributes nothing; a later step still supplies the answer.
            if (text === '') texts.delete(turn)
            else texts.set(turn, text)
          }
          while (texts.size > MAX_TRACKED_TURNS) texts.delete(texts.keys().next().value)
        }
        return
      }
      if (type === 'turn/end') {
        const turn = data?.turn
        const owns = ourTurn !== null ? turn === ourTurn : (candidateTurn !== null && turn === candidateTurn)
        if (!owns) return
        settle({
          kind: 'ended',
          turn,
          reason: reasonKind(data?.reason),
          text: texts.get(turn) ?? '',
        })
      }
    }

    watcherSet.add(watcher)
    if (timeoutMs !== null && timeoutMs > 0) {
      // First stage only reports slowness: a turn that finishes shortly after the
      // soft deadline still has a real answer worth delivering. The hard stage
      // settles `stuck`, and only that stage cancels the turn.
      timeoutTimer = setTimeout(() => {
        witness?.({ kind: 'slow', turn: ourTurn ?? candidateTurn })
        hardTimer = setTimeout(() => settle({ kind: 'stuck', turn: ourTurn ?? candidateTurn }), hardTimeoutMs - timeoutMs)
        hardTimer.unref?.()
      }, timeoutMs)
      timeoutTimer.unref?.()
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    return {
      promise,
      dispose: () => { cleanup() },
    }
  }

  function taskFrom(job) {
    const task = job?.task !== null && typeof job?.task === 'object' ? job.task : {}
    return {
      cwd: typeof task.cwd === 'string' && task.cwd !== '' ? task.cwd : (cwd ?? config.stateDir ?? process.cwd()),
      sessionId: task.sessionId,
      agentPreset: task.agentPreset,
      runs: Number.isSafeInteger(task.runs) ? task.runs : 0,
      sessionCreatedAt: task.sessionCreatedAt,
      config: task.config,
    }
  }

  /** Current settings resolved over whatever the job already froze. */
  function desiredConfig(task) {
    const settings = getAgentSettings()
    const desired = {
      cwd: settings.cwd ?? task.cwd,
      agentPreset: settings.agentPreset ?? task.agentPreset,
      provider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      permissionPreset: settings.permissionPreset,
    }
    diag('desired-config', { settings, desired })
    return desired
  }

  /** Whether the operator configured any task-session setting at all. */
  function settingsConfigured() {
    const settings = getAgentSettings()
    return ['cwd', 'agentPreset', 'provider', 'model', 'reasoningEffort', 'permissionPreset']
      .some((field) => settings[field] !== undefined)
  }

  function sameConfig(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
  }

  /**
   * Run one agent turn for a job.
   * @param {object} job
   * @param {{ prompt: string, timeoutSeconds?: number, signal?: AbortSignal, occurrence?: string }} options
   */
  async function runTurn(job, options = {}) {
    if (!enabled) return failure('agent-disabled')
    if (!canResolve()) return failure('agent-unavailable')
    const prompt = String(options.prompt ?? job?.payload?.prompt ?? '')
    if (prompt.trim() === '') return failure('empty-prompt')

    const timeoutSeconds = options.timeoutSeconds ?? config.agent?.timeoutSeconds ?? 900
    const seconds = Number(timeoutSeconds)
    const timeoutMs = Number.isFinite(seconds) && seconds > 0 ? Math.max(50, Math.round(seconds * 1000)) : 900_000
    // The hard deadline is the point at which we stop trusting the turn at all;
    // the soft one only reports that it is slow.
    const graceSeconds = config.agent?.stuckGraceSeconds
    const hardMs = Number.isFinite(Number(graceSeconds)) && Number(graceSeconds) > 0
      ? Math.max(timeoutMs, Math.round(Number(graceSeconds) * 1000))
      : timeoutMs * 2
    const task = taskFrom(job)
    const desired = desiredConfig(task)

    const release = await acquireSlot()
    if (release === null) {
      return { ok: false, text: '', result: { kind: 'skipped', reason: 'busy' } }
    }

    try {
      const ensured = await ensureAgent(task, desired, settingsConfigured())
      if (!ensured.ok) return ensured.result ?? failure('agent-unavailable')
      const agent = ensured.agent
      const sessionId = ensured.sessionId
      // Label before the turn so a crash still leaves a findable session.
      labelTaskSession(agent?.session, job?.name)
      const frozenConfig = desired
      const nextTask = {
        ...task,
        sessionId,
        cwd: desired.cwd,
        agentPreset: desired.agentPreset,
        config: frozenConfig,
        runs: task.runs + 1,
        // A reused session keeps its birth date; a session created or recreated
        // in this run starts the max-age clock over.
        sessionCreatedAt: ensured.created === true
          ? (ensured.sessionCreatedAt ?? now().toISOString())
          : (task.sessionCreatedAt ?? now().toISOString()),
        lastRunAt: now().toISOString(),
        ...(ensured.agentPreset === undefined ? {} : { agentPreset: ensured.agentPreset }),
      }

      if (agent?.status === 'running') {
        return { ok: false, text: '', task: { ...task, sessionId }, result: { kind: 'skipped', reason: 'running' } }
      }

      const messageId = randomUUID()
      const message = {
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: {
          kind: 'im-cron',
          form: 'notice',
          summary: `定时任务 ${job?.name ?? job?.id ?? ''}`.slice(0, 120),
          jobId: job?.id,
          occurrence: options.occurrence,
        },
      }

      const watcher = watchTurn(sessionId, messageId, {
        timeoutMs,
        hardTimeoutMs: hardMs,
        signal: options.signal,
        witness: (stage) => {
          if (stage.kind !== 'slow') return
          logger?.warn?.(`[im-cron] 任务 ${job?.id ?? '?'} 超过 ${timeoutSeconds}s 仍在运行，继续等到 ${Math.round(hardMs / 1000)}s`)
        },
      })
      try {
        agent.followup(message)
      } catch (error) {
        watcher.dispose()
        return failure('followup-failed', { error: errorCode(error), task: nextTask })
      }

      const outcome = await watcher.promise
      if (outcome.kind === 'stuck') {
        // The hard deadline passed: the turn is not going to produce an answer we
        // can trust, so cancel it and report the failure once.
        try {
          agent.cancel?.({ kind: 'user' })
        } catch (error) {
          logger?.warn?.(`[im-cron] 取消失败回合出错：${errorCode(error)}`)
        }
        logger?.error?.(`[im-cron] 任务 ${job?.id ?? '?'} 回合超过 ${Math.round(hardMs / 1000)}s 仍未结束，已取消`)
        return { ok: false, text: '', sessionId, turn: outcome.turn, task: nextTask, result: { kind: 'failed', reason: 'stuck' } }
      }
      if (outcome.kind === 'aborted') {
        return { ok: false, text: '', sessionId, turn: outcome.turn, task: nextTask, result: { kind: 'pending', reason: 'aborted' } }
      }

      const reason = outcome.reason
      const text = outcome.text ?? ''
      if (reason === 'blocked') {
        logger?.warn?.(`[im-cron] 任务会话 ${sessionId} 已归档（blocked），下一轮将重建`)
        return {
          ok: false,
          blocked: true,
          text,
          sessionId,
          turn: outcome.turn,
          task: { ...nextTask, sessionId: undefined },
          result: { kind: 'failed', reason: 'session-archived' },
        }
      }
      if (reason === 'completed' || reason === 'max-tokens') {
        return { ok: true, text, sessionId, turn: outcome.turn, task: nextTask, result: { kind: 'ok', reason } }
      }
      return {
        ok: false,
        text,
        sessionId,
        turn: outcome.turn,
        task: nextTask,
        result: { kind: 'failed', reason },
      }
    } finally {
      release()
    }
  }

  function detach() {
    if (typeof unsubscribe === 'function') unsubscribe()
    watchers.clear()
  }

  return {
    get available() { return enabled && canResolve() },
    get reason() {
      if (!enabled) return 'agent-disabled'
      return canResolve() ? null : 'session-controller-missing'
    },
    runTurn,
    detach,
  }
}

export default createAgentTurn