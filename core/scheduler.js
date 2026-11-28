/**
 * Polling scheduler.
 *
 * Every tick reads the water mark (`job.lastFiredFor`), asks the schedule for the
 * next occurrence, and fires it when it is due. A slot that is stale (the host
 * was asleep, or the process was down) is a backlog and is skipped: missed slots
 * are never replayed, only the water mark moves forward. A slot is still fired
 * when the process reached it inside the freshness window.
 */
import { nextDue } from './schedule.js'
import { hostTimezone } from '../config.js'
import { diag } from '../diag.js'

const MAX_SLOTS_PER_TICK = 1_000
const HOUR_MS = 3_600_000
/**
 * Longest single timer. `setTimeout` overflows past ~24.8 days, and a long wait
 * is recomputed as chunks anyway so a timezone or DST change is picked up.
 */
const MAX_TIMER_MS = 6 * HOUR_MS

function errorText(error) {
  return String(error?.message ?? error)
}

function isRunnable(job) {
  return job.enabled !== false && job.state === undefined && job.endedAt === undefined
}

/**
 * Every occurrence at or before `nowMs`, oldest first (bounded).
 * @param {object} schedule
 * @param {Date} after
 * @param {number} nowMs
 */
/**
 * A job copy without the fields a running scheduler owns.
 *
 * `upsertJob` keeps the live `lastFiredFor` / `inflight` / `endedAt` when the
 * incoming copy omits them, so a pause/resume taken from a snapshot cannot
 * rewind a slot the scheduler just claimed.
 */
export function withoutExecutionState(job) {
  const { lastFiredFor, inflight, endedAt, ...rest } = job
  return rest
}

export function collectDueSlots(schedule, after, nowMs) {
  const slots = []
  let cursor = after
  for (let index = 0; index < MAX_SLOTS_PER_TICK; index += 1) {
    const due = nextDue(schedule, cursor)
    if (due === undefined || due.getTime() > nowMs) break
    slots.push(due)
    cursor = due
  }
  return slots
}

/**
 * Create the scheduler.
 * @param {{
 *   store: import('./store.js').Store,
 *   config: object,
 *   runner: { run: Function },
 *   logger?: object,
 *   now?: () => Date,
 *   pollMs?: number,
 *   freshWindowMs?: number,
 * }} deps
 */
export function createScheduler({
  store,
  config,
  runner,
  logger = null,
  now = () => new Date(),
  pollMs = null,
  freshWindowMs = null,
} = {}) {
  const intervalMs = pollMs ?? Math.max(1_000, (config.pollSeconds ?? 30) * 1000)
  // A slot counts as "fresh" when we reach it near its deadline. Armed timers hit
  // it within milliseconds; the safety sweep may be up to one interval late. This
  // is deliberately independent of `intervalMs` so changing the sweep cadence
  // cannot silently change backlog classification.
  const freshness = freshWindowMs ?? Math.max(intervalMs * 2, 60_000)
  /** @type {{ version: number, jobs: object[] }} */
  let state = { version: 1, jobs: [] }
  let loaded = false
  /** In-flight load promise, so concurrent callers share one load and one recovery. */
  let loading = null
  /** The safety sweep; it is the guarantee, not the precision path. */
  let sweepTimer = null
  /** The armed deadline timer; an optimization over {@link sweepTimer}. */
  let deadlineTimer = null
  /** The instant {@link deadlineTimer} is pointed at, or null when nothing is armed. */
  let armedFor = null
  let running = false
  let dirty = false
  const inFlight = new Map()
  const listeners = new Set()

  function readNow() {
    const value = now()
    return value instanceof Date ? value : new Date(value)
  }

  function scheduleOf(job) {
    return job.schedule
  }

  function findJob(id) {
    return state.jobs.find((job) => job.id === id)
  }

  function patchJob(job, patch) {
    if (patch === null || patch === undefined) return
    if (patch.state !== undefined) job.state = patch.state
    if (patch.endedAt !== undefined) job.endedAt = patch.endedAt
    if (patch.task !== undefined) job.task = patch.task
    if (patch.extra !== undefined) Object.assign(job, patch.extra)
  }

  /**
   * Record one scheduled execution and finish the job when its budget is spent.
   *
   * Only scheduled runs count: `imcron_trigger` is an explicit outside-the-plan
   * action, so it cannot quietly eat a remaining run.
   * @returns {boolean} whether the budget ended the job
   */
  function countScheduledRun(job) {
    job.runsDone = (Number.isSafeInteger(job.runsDone) ? job.runsDone : 0) + 1
    dirty = true
    const budget = Number(job.maxRuns)
    if (!Number.isSafeInteger(budget) || budget < 1) return false
    if (job.runsDone < budget) return false
    job.endedAt = readNow().toISOString()
    logger?.info?.(`[im-cron] 任务 ${job.id} 已执行 ${job.runsDone}/${budget} 次，标记结束`)
    return true
  }

  /**
   * Whether one due instant falls inside the configured execution window.
   *
   * The window is compared in wall-clock minutes so an overnight window
   * (`22:00`–`06:00`) works, and `start === end` disables every slot rather than
   * meaning "all day" — matching the semantics of the equivalent OpenClaw knob.
   * @param {number} atMs - the instant that is due
   * @returns {boolean}
   */
  function withinActiveHours(atMs) {
    const active = config.activeHours
    if (active === null || active === undefined) return true
    const zone = active.timezone ?? config.timezone ?? hostTimezone(readNow())
    let parts
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(atMs))
    } catch {
      // An unusable timezone must not silently swallow every run.
      logger?.warn?.(`[im-cron] activeHours 时区 "${zone}" 不可用，本次不限制执行时段`)
      return true
    }
    const hour = Number(parts.find((part) => part.type === 'hour')?.value)
    const minute = Number(parts.find((part) => part.type === 'minute')?.value)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true
    const at = hour * 60 + minute
    const toMinutes = (value) => Number(String(value).slice(0, 2)) * 60 + Number(String(value).slice(3, 5))
    const start = toMinutes(active.start)
    const end = toMinutes(active.end)
    if (start === end) return false
    if (end === 24 * 60) return at >= start
    return end > start ? (at >= start && at < end) : (at >= start || at < end)
  }

  /**
   * Flush pending state.
   * @returns {Promise<boolean>} whether the state is now on disk
   */
  async function persist() {
    if (!dirty) return true
    dirty = false
    try {
      await store.save(state)
      diag('persist', {
        jobs: state.jobs.map((job) => ({
          id: job.id,
          lastFiredFor: job.lastFiredFor ?? null,
          endedAt: job.endedAt ?? null,
          inflight: job.inflight?.occurrence ?? null,
          sessionId: job.task?.sessionId ?? null,
        })),
      })
      return true
    } catch (error) {
      dirty = true
      logger?.error?.(`[im-cron] 保存状态失败：${errorText(error)}`)
      return false
    }
  }

  /**
   * Load the store once, even when several callers race for it.
   *
   * `start()`, the first tick, and the plugin's own readiness probe all ask for
   * this at startup. Without a shared promise they all pass the `loaded` check
   * before the first `await` and every one of them runs the recovery pass — which
   * writes one `interrupted` record per caller for the same claim.
   * @returns {Promise<void>}
   */
  function ensureLoaded() {
    if (loaded) return Promise.resolve()
    if (loading !== null) return loading
    loading = (async () => {
      try {
        await store.ensureDir()
      } catch (error) {
        logger?.warn?.(`[im-cron] 创建状态目录失败：${errorText(error)}`)
      }
      try {
        state = await store.load()
      } catch (error) {
        logger?.error?.(`[im-cron] 读取状态失败，按空状态启动：${errorText(error)}`)
        state = { version: 1, jobs: [] }
      }
      loaded = true
      // Close out runs a previous process left claimed before pruning can discard
      // their evidence, then drop expired one-shot jobs and make sure the state
      // file exists so the CLI and operators can see an empty-but-valid store.
      await recoverInterrupted()
      pruneEnded(readNow().getTime())
      dirty = true
      await persist()
    })().finally(() => { loading = null })
    return loading
  }

  function pruneEnded(nowMs) {
    const retentionHours = config.endedRetentionHours ?? 0
    if (retentionHours <= 0) return
    const keep = []
    for (const job of state.jobs) {
      if (job.endedAt === undefined) {
        keep.push(job)
        continue
      }
      const endedMs = Date.parse(job.endedAt)
      if (!Number.isFinite(endedMs) || nowMs - endedMs < retentionHours * HOUR_MS) {
        keep.push(job)
      } else {
        dirty = true
        logger?.info?.(`[im-cron] 清理已结束任务 ${job.id}（保留 ${retentionHours}h）`)
      }
    }
    state.jobs = keep
  }

  /**
   * Claim one occurrence durably before any payload runs.
   *
   * The claim is the idempotency gate: `lastFiredFor` (and, for a one-shot job,
   * `endedAt`) reach the disk before the payload starts, so no second actor —
   * another tick, a reload that reloads state, an upsert — can treat the same
   * slot as due again. `inflight` records that a run owns the slot, so a process
   * that dies mid-run leaves evidence instead of a silently reusable slot.
   * @returns {Promise<boolean>} whether the claim reached the disk
   */
  async function claim(job, slot) {
    const claimAt = readNow().toISOString()
    const previous = {
      lastFiredFor: job.lastFiredFor,
      ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
      ...(job.inflight === undefined ? {} : { inflight: job.inflight }),
    }
    job.lastFiredFor = slot.toISOString()
    // A one-shot job is decided the moment it starts; retrying it after a crash
    // would be a duplicate, and the interrupted record explains the gap.
    if (scheduleOf(job).kind === 'at') job.endedAt = claimAt
    job.inflight = { occurrence: slot.toISOString(), startedAt: claimAt }
    dirty = true
    if (await persist()) return true
    // An unpersisted claim cannot stop a second start, so do not run at all.
    job.lastFiredFor = previous.lastFiredFor
    if (previous.endedAt === undefined) delete job.endedAt
    else job.endedAt = previous.endedAt
    if (previous.inflight === undefined) delete job.inflight
    else job.inflight = previous.inflight
    return false
  }

  /**
   * Settle the slot a run owned: the payload finished (or failed) and the job no
   * longer has a run in progress.
   */
  function release(job) {
    if (job.inflight === undefined) return
    delete job.inflight
    dirty = true
  }

  /**
   * Earliest instant any runnable job is due, or null when none is scheduled.
   * @returns {number|null} epoch milliseconds
   */
  function nextDeadlineMs() {
    let earliest = null
    for (const job of state.jobs) {
      if (!isRunnable(job)) continue
      const after = new Date(job.lastFiredFor ?? job.createdAt ?? readNow().getTime())
      const due = nextDue(scheduleOf(job), after)
      if (due === undefined || due === null) continue
      const at = due.getTime()
      if (!Number.isFinite(at)) continue
      if (earliest === null || at < earliest) earliest = at
    }
    return earliest
  }

  /**
   * Point a timer at the nearest deadline so a due slot fires on time instead of
   * on the next sweep.
   *
   * The sweep stays armed: a suspended machine, a clock jump, or a bug here
   * degrades to the polling behaviour rather than to a missed run. A deadline
   * that is already due is left to the sweep — arming it would spin.
   */
  function arm() {
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer)
      deadlineTimer = null
      armedFor = null
    }
    const nowMs = readNow().getTime()
    const deadline = nextDeadlineMs()
    if (deadline === null) return
    const delay = deadline - nowMs
    if (!(delay > 0)) return
    const wait = Math.min(delay, MAX_TIMER_MS)
    armedFor = nowMs + wait
    diag('arm', { deadline: new Date(deadline).toISOString(), delayMs: wait, chunked: delay > MAX_TIMER_MS })
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null
      armedFor = null
      void tick()
        .catch((error) => logger?.error?.(`[im-cron] 定时触发异常：${errorText(error)}`))
        .finally(() => { arm() })
    }, wait)
    deadlineTimer.unref?.()
  }

  /** Re-point the deadline timer after a job changed or a tick completed. */
  function wake() {
    arm()
  }

  async function fire(job, slot) {
    diag('fire:enter', {
      jobId: job.id,
      slot: slot.toISOString(),
      inFlight: [...inFlight.keys()],
      lastFiredFor: job.lastFiredFor ?? null,
      endedAt: job.endedAt ?? null,
      sessionId: job.task?.sessionId ?? null,
      runs: job.task?.runs ?? null,
    })
    if (inFlight.has(job.id)) {
      diag('fire:skipped-running', { jobId: job.id, slot: slot.toISOString() })
      logger?.info?.(`[im-cron] ${job.id} 上一次仍在运行，跳过 ${slot.toISOString()}`)
      return { skipped: 'running' }
    }
    // Claim before executing: the durable record is the only thing that stops the
    // same occurrence from starting twice. A claim that never reached the disk
    // must not run, or two actors could both start the slot.
    if (!await claim(job, slot)) {
      logger?.error?.(`[im-cron] ${job.id} 无法持久化 ${slot.toISOString()} 的占位，本轮跳过`)
      return { skipped: 'claim-failed' }
    }
    const startedAt = Date.now()
    // A run can outlive the job object it started with: an update, pause or
    // remove replaces `state.jobs` while the payload is still running. Always
    // settle into the *current* record, not the captured one, or the run's task
    // session / budget / inflight claim lands in an object nobody reads.
    const liveJob = () => findJob(job.id)
    const task = (async () => {
      try {
        const { patch } = await runner.run({ job, occurrence: slot, trigger: 'schedule' })
        diag('fire:runner-returned', { jobId: job.id, slot: slot.toISOString(), durationMs: Date.now() - startedAt, patch })
        const live = liveJob()
        if (live !== undefined) patchJob(live, patch)
      } catch (error) {
        diag('fire:runner-threw', { jobId: job.id, slot: slot.toISOString(), error: errorText(error) })
        logger?.error?.(`[im-cron] 任务 ${job.id} 执行异常：${errorText(error)}`)
      } finally {
        const live = liveJob()
        if (live !== undefined) {
          release(live)
          // The budget is settled with the run, not with the scheduling pass: a
          // claimed occurrence counts even if the payload fails, or the job was
          // removed while it ran (the record is gone, so there is nothing to count).
          countScheduledRun(live)
        }
        inFlight.delete(job.id)
        dirty = true
        await persist()
      }
    })()
    inFlight.set(job.id, task)
    // Fire-and-forget: the pass must not wait for the payload. Waiting here meant
    // one slow turn (default: 900s soft / 1800s hard deadline) held up every other
    // due job and kept the `running` guard closed, so the fallback sweep could not
    // run either. `settle()` is the join point for tests and shutdown.
    void task.catch((error) => logger?.error?.(`[im-cron] 任务 ${job.id} 结算异常：${errorText(error)}`))
    return { skipped: null }
  }

  /**
   * Close out runs a previous process left claimed.
   *
   * The slot stays consumed — a claimed occurrence never replays, which keeps a
   * reminder from arriving twice — and the run log records why nothing was
   * delivered.
   */
  async function recoverInterrupted() {
    for (const job of state.jobs) {
      if (job.inflight === undefined) continue
      const occurrence = typeof job.inflight.occurrence === 'string'
        ? job.inflight.occurrence
        : (job.lastFiredFor ?? job.createdAt ?? readNow().toISOString())
      logger?.warn?.(`[im-cron] 任务 ${job.id} 上次在 ${occurrence} 开始后未正常结束，记 interrupted`)
      try {
        await store.appendRun({
          at: readNow().toISOString(),
          jobId: job.id,
          mode: job.payload?.kind ?? 'unknown',
          occurrence,
          trigger: 'schedule',
          durationMs: 0,
          result: { kind: 'interrupted', reason: 'process-restart' },
          deliver: { status: 'skipped', error: 'process-restart' },
        })
      } catch (error) {
        logger?.error?.(`[im-cron] 写中断记录失败：${errorText(error)}`)
      }
      delete job.inflight
      // An interrupted attempt still spent a scheduled slot: a budget that ignored
      // crashes could retry the same "3 times" forever.
      countScheduledRun(job)
      dirty = true
    }
  }

  /**
   * One scheduling pass. Exported for tests and for a manual kick.
   * @returns {Promise<{ fired: Array<{ jobId: string, occurrence: string }>, skipped: Array<{ jobId: string, reason: string }> }>}
   */
  async function tick() {
    if (running) {
      diag('tick:reentered-while-running')
      return { fired: [], skipped: [] }
    }
    running = true
    const fired = []
    const skipped = []
    diag('tick:enter', { now: readNow().toISOString(), jobs: state.jobs.length })
    try {
      await ensureLoaded()
      const nowDate = readNow()
      const nowMs = nowDate.getTime()

      for (const job of state.jobs) {
        if (!isRunnable(job)) {
          diag('tick:not-runnable', { jobId: job.id, enabled: job.enabled, state: job.state ?? null, endedAt: job.endedAt ?? null })
          continue
        }
        const after = new Date(job.lastFiredFor ?? job.createdAt ?? nowMs)
        const slots = collectDueSlots(scheduleOf(job), after, nowMs)
        if (slots.length === 0) {
          // No future occurrence at all is the only `ended` signal for schedules
          // that can run dry; a merely skipped backlog keeps its future slots.
          const future = nextDue(scheduleOf(job), after)
          if (future === undefined) {
            job.endedAt = nowDate.toISOString()
            dirty = true
          }
          diag('tick:no-due', { jobId: job.id, after: after.toISOString(), future: future?.toISOString() ?? null })
          continue
        }

        const latest = slots[slots.length - 1]
        const fresh = nowMs - latest.getTime() <= freshness
        const backlog = slots.length > 1 || !fresh
        // A backlog is consumed, never replayed: a reminder past its window is
        // stale, and replaying intervals would burst duplicate work at startup.
        const toRun = backlog ? null : latest
        diag('tick:due', {
          jobId: job.id,
          after: after.toISOString(),
          slots: slots.map((slot) => slot.toISOString()),
          latest: latest.toISOString(),
          fresh,
          backlog,
          willRun: toRun !== null,
        })

        if (toRun === null) {
          // Advance the water mark so a backlog never replays on the next tick.
          // A slot that does run is claimed by `fire()` instead.
          job.lastFiredFor = latest.toISOString()
          dirty = true
          skipped.push({ jobId: job.id, reason: `backlog:${slots.length}` })
          continue
        }

        if (!withinActiveHours(toRun.getTime())) {
          // Consume the slot instead of deferring it: a reminder that missed its
          // window is stale news, and deferring would stack overnight slots into
          // one burst at the window open. A one-shot job is finished by this.
          job.lastFiredFor = toRun.toISOString()
          if (scheduleOf(job).kind === 'at') job.endedAt = readNow().toISOString()
          dirty = true
          diag('tick:outside-active-hours', { jobId: job.id, slot: toRun.toISOString(), activeHours: config.activeHours })
          skipped.push({ jobId: job.id, reason: 'active-hours' })
          continue
        }

        const result = await fire(job, toRun)
        if (result.skipped !== null) {
          skipped.push({ jobId: job.id, reason: result.skipped })
        } else {
          fired.push({ jobId: job.id, occurrence: toRun.toISOString() })
        }
      }

      pruneEnded(nowMs)
      await persist()
      for (const listener of listeners) {
        try {
          listener({ fired, skipped })
        } catch (error) {
          logger?.warn?.(`[im-cron] tick 监听器异常：${errorText(error)}`)
        }
      }
    } finally {
      diag('tick:exit', { fired, skipped })
      running = false
      // Re-point the deadline timer: this pass consumed the deadline it was
      // armed for, and a job may have become due while it ran.
      arm()
    }
    return { fired, skipped }
  }

  /** Start polling; returns an idempotent stop function. */
  function start() {
    if (sweepTimer !== null) return stop
    sweepTimer = setInterval(() => {
      tick().catch((error) => logger?.error?.(`[im-cron] 调度循环异常：${errorText(error)}`))
    }, intervalMs)
    sweepTimer.unref?.()
    // Arm once the state is loaded; `tick` re-arms after every completed pass.
    void ensureLoaded().then(() => { arm() }).catch(() => {})
    return stop
  }

  function stop() {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer)
      deadlineTimer = null
    }
    armedFor = null
  }

  /**
   * Run one job immediately without touching its schedule or water mark.
   * @param {string} id
   */
  async function runNow(id, trigger = 'manual') {
    await ensureLoaded()
    const job = findJob(id)
    if (job === undefined) return { ok: false, reason: 'not-found' }
    if (!isRunnable(job)) return { ok: false, reason: job.state ?? (job.endedAt !== undefined ? 'ended' : 'disabled') }
    if (inFlight.has(id)) return { ok: false, reason: 'running' }
    const task = (async () => {
      try {
        const { record, patch } = await runner.run({ job, occurrence: readNow(), trigger })
        const live = findJob(id)
        if (live !== undefined) patchJob(live, patch)
        return { ok: true, record }
      } finally {
        inFlight.delete(id)
        dirty = true
        await persist()
      }
    })()
    inFlight.set(id, task)
    return await task
  }

  /** Snapshot of jobs (read-only copy for tools and the CLI). */
  function listJobs() {
    return state.jobs.map((job) => ({ ...job }))
  }

  function getJob(id) {
    const job = findJob(id)
    return job === undefined ? undefined : { ...job }
  }

  /**
   * Add or replace a job; the caller owns validation.
   * @param {object} job
   * @param {{ clearEndedAt?: boolean }} [options] - `clearEndedAt` lets an explicit
   *   update (schedule / maxRuns) revive a job without losing the default
   *   "re-declaring the same job keeps it finished" behaviour.
   */
  async function upsertJob(job, { clearEndedAt = false } = {}) {
    await ensureLoaded()
    const index = state.jobs.findIndex((candidate) => candidate.id === job.id)
    diag('upsert-job', {
      jobId: job.id,
      replacing: index !== -1,
      incoming: { lastFiredFor: job.lastFiredFor ?? null, endedAt: job.endedAt ?? null },
      existing: index === -1 ? null : { lastFiredFor: state.jobs[index].lastFiredFor ?? null, endedAt: state.jobs[index].endedAt ?? null },
    })
    if (index === -1) state.jobs.push(job)
    else {
      // Execution state belongs to the running scheduler, not to the declaration
      // that replaces the job. Dropping it would make the slot look due again.
      const existing = state.jobs[index]
      state.jobs[index] = {
        ...job,
        ...(job.lastFiredFor === undefined && existing.lastFiredFor !== undefined ? { lastFiredFor: existing.lastFiredFor } : {}),
        ...(!clearEndedAt && job.endedAt === undefined && existing.endedAt !== undefined ? { endedAt: existing.endedAt } : {}),
        ...(job.inflight === undefined && existing.inflight !== undefined ? { inflight: existing.inflight } : {}),
      }
    }
    dirty = true
    await persist()
    arm()
    return { ...job }
  }

  /** Remove a job. */
  async function removeJob(id) {
    await ensureLoaded()
    const before = state.jobs.length
    state.jobs = state.jobs.filter((job) => job.id !== id)
    if (state.jobs.length === before) return false
    dirty = true
    await persist()
    arm()
    return true
  }

  function onTick(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /**
   * Wait until every run started by {@link tick} has settled.
   *
   * The scheduling pass no longer blocks on payloads, so callers that need the
   * finished run records (tests, a future graceful shutdown) join here instead.
   */
  async function settle() {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight.values()])
    }
  }

  return {
    start,
    stop,
    tick,
    settle,
    runNow,
    listJobs,
    getJob,
    upsertJob,
    removeJob,
    onTick,
    ensureLoaded,
    /** The instant the precision timer is pointed at, or null when none is armed. */
    armedDeadline: () => armedFor,
    /** Fire the precision timer's work now; tests use it instead of waiting. */
    fireArmed: async () => { await tick() },
    get loaded() { return loaded },
  }
}

export default createScheduler