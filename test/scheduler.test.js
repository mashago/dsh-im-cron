import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseConfig } from '../config.js'
import { createScheduler } from '../core/scheduler.js'
import { Store } from '../core/store.js'

async function setup({ config: configOverrides = {}, runner } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-sched-'))
  const { config } = parseConfig({ stateDir: dir, pollSeconds: 5, ...configOverrides })
  const store = new Store(dir)
  const calls = []
  const clock = { now: new Date('2026-11-20T01:00:00+08:00') }
  const effectiveRunner = runner ?? {
    run: async ({ job, occurrence }) => {
      calls.push({ jobId: job.id, occurrence: occurrence.toISOString() })
      return { record: { jobId: job.id }, patch: {} }
    },
  }
  const scheduler = createScheduler({
    store,
    config,
    runner: effectiveRunner,
    logger: null,
    now: () => clock.now,
    pollMs: 1_000,
    freshWindowMs: 60_000,
  })
  return { dir, store, config, scheduler, calls, clock }
}

function atJob(ms, overrides = {}) {
  return {
    id: 'imc-at',
    name: '一次性',
    schedule: { kind: 'at', at: new Date(ms).toISOString() },
    payload: { kind: 'notify', text: 'go' },
    deliver: 'never',
    enabled: true,
    createdAt: new Date(ms - 60 * 60_000).toISOString(),
    ...overrides,
  }
}

test('scheduler: a future one-shot does not fire and stays scheduled', async () => {
  const { scheduler, calls, clock } = await setup()
  await scheduler.upsertJob(atJob(clock.now.getTime() + 60_000))
  const result = await scheduler.tick()
  assert.deepEqual(result.fired, [])
  assert.equal(calls.length, 0)
})

test('scheduler: a due one-shot fires once, then ends and never repeats', async () => {
  const { scheduler, calls, clock, store } = await setup()
  const jobId = 'imc-at'
  const job = atJob(clock.now.getTime() - 10_000)
  await scheduler.upsertJob(job)

  const first = await scheduler.tick()
  assert.deepEqual(first.fired.map((entry) => entry.jobId), [jobId])
  assert.equal(calls.length, 1)
  assert.equal(scheduler.getJob(jobId).endedAt !== undefined, true)
  assert.equal(scheduler.getJob(jobId).lastFiredFor, job.schedule.at)

  const second = await scheduler.tick()
  assert.deepEqual(second.fired, [])
  assert.equal(calls.length, 1)

  const persisted = await store.load()
  assert.equal(persisted.jobs.length, 1)
  assert.equal(persisted.jobs[0].endedAt !== undefined, true)
})

test('scheduler: the water mark survives a restart (no duplicate fire)', async () => {
  const { scheduler, store, config, clock } = await setup()
  const job = atJob(clock.now.getTime() - 10_000)
  await scheduler.upsertJob(job)
  await scheduler.tick()

  const calls = []
  const restarted = createScheduler({
    store,
    config,
    runner: { run: async (input) => { calls.push(input); return { record: {}, patch: {} } } },
    logger: null,
    now: () => new Date(clock.now.getTime() + 5_000),
    pollMs: 1_000,
    freshWindowMs: 60_000,
  })
  const result = await restarted.tick()
  assert.deepEqual(result.fired, [])
  assert.equal(calls.length, 0)
})

test('scheduler: catchUp none skips a backlog but advances the water mark', async () => {
  const { scheduler, calls, clock } = await setup({ config: { catchUp: 'none' } })
  const nowMs = clock.now.getTime()
  await scheduler.upsertJob({
    id: 'imc-cron',
    name: '每分钟',
    schedule: { kind: 'cron', expression: '* * * * *', timezone: 'Asia/Shanghai' },
    payload: { kind: 'notify', text: 'tick' },
    deliver: 'never',
    enabled: true,
    createdAt: new Date(nowMs - 60 * 60_000).toISOString(),
    lastFiredFor: new Date(nowMs - 10 * 60_000).toISOString(),
  })

  const result = await scheduler.tick()
  assert.deepEqual(result.fired, [])
  assert.equal(result.skipped[0].jobId, 'imc-cron')
  assert.equal(calls.length, 0)
  const lastFired = Date.parse(scheduler.getJob('imc-cron').lastFiredFor)
  assert.ok(lastFired <= nowMs && nowMs - lastFired < 90_000, 'water mark moves to the latest missed slot')

  const next = await scheduler.tick()
  assert.deepEqual(next.fired, [])
})

test('scheduler: catchUp once fires the latest missed slot exactly once', async () => {
  const { scheduler, calls, clock } = await setup({ config: { catchUp: 'once' } })
  const nowMs = clock.now.getTime()
  await scheduler.upsertJob({
    id: 'imc-cron',
    name: '每分钟',
    schedule: { kind: 'cron', expression: '* * * * *', timezone: 'Asia/Shanghai' },
    payload: { kind: 'notify', text: 'tick' },
    deliver: 'never',
    enabled: true,
    createdAt: new Date(nowMs - 60 * 60_000).toISOString(),
    lastFiredFor: new Date(nowMs - 10 * 60_000).toISOString(),
  })

  const first = await scheduler.tick()
  assert.deepEqual(first.fired.map((entry) => entry.jobId), ['imc-cron'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].occurrence, scheduler.getJob('imc-cron').lastFiredFor)

  await scheduler.tick()
  assert.equal(calls.length, 1)
})

test('scheduler: paused, broken and ended jobs are skipped', async () => {
  const { scheduler, calls, clock } = await setup()
  const due = clock.now.getTime() - 10_000
  await scheduler.upsertJob(atJob(due, { id: 'imc-paused', enabled: false }))
  await scheduler.upsertJob(atJob(due, { id: 'imc-broken', state: 'needs-rebind' }))
  await scheduler.upsertJob(atJob(due, { id: 'imc-ended', endedAt: new Date(due - 1_000).toISOString() }))
  await scheduler.tick()
  assert.equal(calls.length, 0)
})

test('scheduler: a slow run does not hold up another due job', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const started = []
  const { scheduler, clock } = await setup({
    runner: {
      run: async ({ job }) => {
        started.push(job.id)
        if (job.id === 'imc-slow') await gate
        return { patch: {} }
      },
    },
  })
  const nowMs = clock.now.getTime()
  await scheduler.upsertJob(atJob(nowMs - 10_000, { id: 'imc-slow' }))

  // The pass returns while the payload is still blocked on the gate. Before the
  // fix this line never ran until the run finished.
  const first = await scheduler.tick()
  assert.deepEqual(first.fired.map((entry) => entry.jobId), ['imc-slow'])
  assert.deepEqual(started, ['imc-slow'])

  // A job that becomes due during the slow run is fired by the next pass instead
  // of queueing behind it.
  await scheduler.upsertJob(atJob(nowMs - 5_000, { id: 'imc-fast' }))
  const second = await scheduler.tick()
  assert.deepEqual(second.fired.map((entry) => entry.jobId), ['imc-fast'])
  assert.deepEqual(started, ['imc-slow', 'imc-fast'])

  release()
  await scheduler.settle()
  for (const job of scheduler.listJobs()) assert.equal(job.inflight, undefined)
})

test('scheduler: a run still in flight is skipped by the next pass, not queued', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const calls = []
  const { scheduler, clock } = await setup({
    runner: {
      run: async ({ job }) => {
        calls.push(job.id)
        await gate
        return { patch: {} }
      },
    },
  })
  const anchorMs = Math.floor(clock.now.getTime() / 60_000) * 60_000
  await scheduler.upsertJob({
    id: 'imc-every',
    name: '每分钟',
    schedule: { kind: 'every', unit: 'minute', count: 1, at: null, timezone: 'Asia/Shanghai', anchor: new Date(anchorMs).toISOString() },
    payload: { kind: 'notify', text: 'tick' },
    deliver: 'never',
    enabled: true,
    createdAt: new Date(anchorMs - 600_000).toISOString(),
    lastFiredFor: new Date(anchorMs - 1_000).toISOString(),
  })

  clock.now = new Date(anchorMs + 30_000)
  const first = await scheduler.tick()
  assert.deepEqual(first.fired.map((entry) => entry.jobId), ['imc-every'])

  // The +60s slot is due now, but the previous run has not settled.
  clock.now = new Date(anchorMs + 90_000)
  const second = await scheduler.tick()
  assert.deepEqual(second.fired, [])
  assert.deepEqual(second.skipped, [{ jobId: 'imc-every', reason: 'running' }])
  assert.equal(calls.length, 1)

  release()
  await scheduler.settle()
})

test('scheduler: expired ended jobs are pruned', async () => {
  const { scheduler, clock } = await setup({ config: { endedRetentionHours: 24 } })
  await scheduler.upsertJob(atJob(clock.now.getTime() - 10_000, {
    id: 'imc-old',
    endedAt: new Date(clock.now.getTime() - 48 * 3_600_000).toISOString(),
  }))
  await scheduler.tick()
  assert.equal(scheduler.getJob('imc-old'), undefined)
})

test('scheduler: endedRetentionHours 0 disables pruning', async () => {
  const { scheduler, clock } = await setup({ config: { endedRetentionHours: 0 } })
  await scheduler.upsertJob(atJob(clock.now.getTime() - 10_000, {
    id: 'imc-keep',
    endedAt: new Date(clock.now.getTime() - 365 * 24 * 3_600_000).toISOString(),
  }))
  await scheduler.tick()
  assert.notEqual(scheduler.getJob('imc-keep'), undefined)
})

test('scheduler: runNow does not touch the water mark', async () => {
  const { scheduler, calls, clock } = await setup()
  const job = atJob(clock.now.getTime() + 3_600_000, { id: 'imc-manual' })
  await scheduler.upsertJob(job)
  const result = await scheduler.runNow('imc-manual')
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(scheduler.getJob('imc-manual').lastFiredFor, undefined)
  assert.equal((await scheduler.runNow('missing')).reason, 'not-found')
})
test('scheduler: one occurrence never starts twice, even across a reloaded store', async () => {
  const { scheduler, calls, clock, dir, config, store } = await setup()
  const at = clock.now.getTime() + 1_000
  await scheduler.upsertJob(atJob(at))
  clock.now = new Date(at + 500)

  const first = await scheduler.tick()
  assert.deepEqual(first.fired.map((entry) => entry.jobId), ['imc-at'])
  assert.equal(calls.length, 1)

  // A second tick in the same process must not see the slot as due again.
  const second = await scheduler.tick()
  assert.deepEqual(second.fired, [])
  assert.equal(calls.length, 1)

  // The claim is on disk: a fresh scheduler over the same store also refuses.
  const reloaded = createScheduler({
    store: new Store(dir),
    config,
    runner: { run: async ({ job, occurrence }) => { calls.push({ jobId: job.id, occurrence: occurrence.toISOString() }); return { patch: {} } } },
    logger: null,
    now: () => clock.now,
    pollMs: 1_000,
    freshWindowMs: 60_000,
  })
  await reloaded.tick()
  assert.equal(calls.length, 1)
})

test('scheduler: a claim is durably written before the payload runs', async () => {
  let seen
  const { scheduler, clock, store } = await setup({
    runner: {
      run: async ({ job, occurrence }) => {
        // The store must already carry the claim while the payload still runs.
        const onDisk = await store.load()
        const persisted = onDisk.jobs.find((candidate) => candidate.id === job.id)
        seen = {
          lastFiredFor: persisted?.lastFiredFor ?? null,
          endedAt: persisted?.endedAt ?? null,
          inflight: persisted?.inflight?.occurrence ?? null,
        }
        return { patch: {} }
      },
    },
  })
  const at = clock.now.getTime() + 1_000
  await scheduler.upsertJob(atJob(at))
  clock.now = new Date(at + 500)
  await scheduler.tick()
  await scheduler.settle()
  assert.equal(seen.lastFiredFor, new Date(at).toISOString())
  assert.equal(seen.endedAt !== null, true)
  assert.equal(seen.inflight, new Date(at).toISOString())
})

test('scheduler: a run left claimed by a dead process is recorded, not replayed', async () => {
  const { scheduler, clock, dir, config, calls } = await setup()
  const at = clock.now.getTime() + 1_000
  await scheduler.upsertJob(atJob(at))
  // Simulate a crash mid-run: the claim is on disk, the run never settled.
  const store2 = new Store(dir)
  const state = await store2.load()
  state.jobs[0].lastFiredFor = new Date(at).toISOString()
  state.jobs[0].endedAt = new Date(at).toISOString()
  state.jobs[0].inflight = { occurrence: new Date(at).toISOString(), startedAt: new Date(at).toISOString() }
  await store2.save(state)

  const restarted = createScheduler({
    store: store2,
    config,
    runner: { run: async ({ job, occurrence }) => { calls.push({ jobId: job.id, occurrence: occurrence.toISOString() }); return { patch: {} } } },
    logger: null,
    now: () => clock.now,
    pollMs: 1_000,
    freshWindowMs: 60_000,
  })
  await restarted.tick()
  assert.equal(calls.length, 0)
  const records = await store2.readRuns()
  const interrupted = records.filter((record) => record.result?.kind === 'interrupted')
  assert.equal(interrupted.length, 1)
  assert.equal(interrupted[0].jobId, 'imc-at')
  const after = await store2.load()
  assert.equal(after.jobs[0].inflight, undefined)
})

test('scheduler: a declaration upsert keeps the water mark and finish time', async () => {
  const { scheduler, clock } = await setup()
  const at = clock.now.getTime() + 1_000
  await scheduler.upsertJob(atJob(at))
  clock.now = new Date(at + 500)
  await scheduler.tick()

  const before = await scheduler.getJob('imc-at')
  assert.ok(before.lastFiredFor !== undefined)
  assert.ok(before.endedAt !== undefined)

  // Re-declaring the same job must not resurrect it.
  await scheduler.upsertJob(atJob(at))
  const after = await scheduler.getJob('imc-at')
  assert.equal(after.lastFiredFor, before.lastFiredFor)
  assert.equal(after.endedAt, before.endedAt)
})

test('scheduler: a deadline is armed to the nearest due job, not the sweep', async () => {
  const { scheduler, clock } = await setup()
  const soon = clock.now.getTime() + 1_500
  const later = clock.now.getTime() + 600_000
  await scheduler.upsertJob({ ...atJob(soon), id: 'imc-soon', name: 'soon' })
  await scheduler.upsertJob({ ...atJob(later), id: 'imc-later', name: 'later' })
  const armed = scheduler.armedDeadline()
  assert.equal(armed, soon)
})

test('scheduler: an armed deadline fires without waiting for the sweep', async () => {
  const { scheduler, clock, calls } = await setup()
  const at = clock.now.getTime() + 1_000
  await scheduler.upsertJob(atJob(at))
  scheduler.start()
  try {
    clock.now = new Date(at + 10)
    // Shorten the wait the scheduler computes: the job is due "now" for the test
    // clock, so the armed timer is what makes it fire.
    await scheduler.fireArmed()
    assert.equal(calls.length, 1)
  } finally {
    scheduler.stop()
  }
})

test('scheduler: an already-due slot is left to the sweep instead of spinning', async () => {
  const { scheduler, clock, calls } = await setup()
  // Five minutes stale is past the freshness window, so `catchUp: none` skips it
  // and the water mark advances instead of leaving a deadline in the past.
  const at = clock.now.getTime() - 300_000
  await scheduler.upsertJob(atJob(at))
  clock.now = new Date(at + 310_000)
  await scheduler.tick()
  assert.equal(calls.length, 0)
  // Nothing is due in the future, so no deadline is armed.
  assert.equal(scheduler.armedDeadline(), null)
})

test('scheduler: stop clears the armed deadline', async () => {
  const { scheduler, clock } = await setup()
  await scheduler.upsertJob(atJob(clock.now.getTime() + 5_000))
  scheduler.start()
  assert.ok(scheduler.armedDeadline() !== null)
  scheduler.stop()
  assert.equal(scheduler.armedDeadline(), null)
})

test('scheduler: maxRuns ends the job after that many scheduled runs', async () => {
  const { scheduler, clock, calls } = await setup()
  const anchorMs = Math.floor(clock.now.getTime() / 60_000) * 60_000
  await scheduler.upsertJob({
    ...atJob(anchorMs + 1_000),
    schedule: { kind: 'every', unit: 'minute', count: 1, at: null, timezone: 'Asia/Shanghai', anchor: new Date(anchorMs).toISOString() },
    maxRuns: 2,
  })

  // Stay inside the freshness window so each slot counts as on time.
  clock.now = new Date(anchorMs + 59_000)
  await scheduler.tick()
  await scheduler.settle()
  let job = await scheduler.getJob('imc-at')
  assert.equal(job.runsDone, 1)
  assert.equal(job.endedAt, undefined)

  clock.now = new Date(anchorMs + 118_000)
  await scheduler.tick()
  await scheduler.settle()
  job = await scheduler.getJob('imc-at')
  assert.equal(job.runsDone, 2)
  assert.ok(job.endedAt !== undefined)
  assert.equal(calls.length, 2)

  // A finished job is not runnable even though its schedule keeps producing slots.
  clock.now = new Date(anchorMs + 177_000)
  await scheduler.tick()
  assert.equal(calls.length, 2)
})

test('scheduler: a manual run does not consume the scheduled budget', async () => {
  const { scheduler, clock, calls } = await setup()
  await scheduler.upsertJob({ ...atJob(clock.now.getTime() + 600_000), maxRuns: 1 })
  await scheduler.runNow('imc-at', 'manual')
  const job = await scheduler.getJob('imc-at')
  assert.equal(calls.length, 1)
  assert.equal(job.runsDone, undefined)
  assert.equal(job.endedAt, undefined)
})

test('scheduler: a slot outside activeHours is consumed, not deferred', async () => {
  const { scheduler, clock, calls } = await setup({
    config: { activeHours: { start: '08:00', end: '22:00', timezone: 'Asia/Shanghai' } },
  })
  // 03:00 local is outside the window.
  const at = Date.parse('2026-11-20T03:00:00+08:00')
  await scheduler.upsertJob(atJob(at))
  clock.now = new Date(at + 500)
  const result = await scheduler.tick()
  assert.equal(calls.length, 0)
  assert.deepEqual(result.skipped, [{ jobId: 'imc-at', reason: 'active-hours' }])
  const job = await scheduler.getJob('imc-at')
  assert.equal(job.lastFiredFor, new Date(at).toISOString())
  assert.ok(job.endedAt !== undefined)
})

test('scheduler: a slot inside activeHours runs as usual', async () => {
  const { scheduler, clock, calls } = await setup({
    config: { activeHours: { start: '08:00', end: '22:00', timezone: 'Asia/Shanghai' } },
  })
  const at = Date.parse('2026-11-20T09:00:00+08:00')
  await scheduler.upsertJob(atJob(at))
  clock.now = new Date(at + 500)
  await scheduler.tick()
  assert.equal(calls.length, 1)
})

test('scheduler: an overnight activeHours window spans midnight', async () => {
  const { scheduler, clock, calls } = await setup({
    config: { activeHours: { start: '22:00', end: '06:00', timezone: 'Asia/Shanghai' } },
  })
  const at = Date.parse('2026-11-21T02:00:00+08:00')
  await scheduler.upsertJob(atJob(at))
  clock.now = new Date(at + 500)
  await scheduler.tick()
  assert.equal(calls.length, 1)
})

test('scheduler: concurrent ensureLoaded writes one interrupted record, not one per caller', async () => {
  const { scheduler, clock, dir, config, store } = await setup()
  const at = clock.now.getTime() + 1_000
  await scheduler.upsertJob(atJob(at))
  // Simulate a crash mid-run: the claim is on disk with no settlement.
  const state = await store.load()
  state.jobs[0].lastFiredFor = new Date(at).toISOString()
  state.jobs[0].endedAt = new Date(at).toISOString()
  state.jobs[0].inflight = { occurrence: new Date(at).toISOString(), startedAt: new Date(at).toISOString() }
  await store.save(state)

  const reloaded = createScheduler({
    store: new Store(dir), config, logger: null, now: () => clock.now, pollMs: 1_000, freshWindowMs: 60_000,
    runner: { run: async () => ({ patch: {} }) },
  })
  // The plugin's readiness probe, start(), and the first tick all race here.
  await Promise.all([reloaded.ensureLoaded(), reloaded.ensureLoaded(), reloaded.ensureLoaded()])
  const records = (await new Store(dir).readRuns()).filter((record) => record.result?.kind === 'interrupted')
  assert.equal(records.length, 1)
})

test('scheduler: an interrupted attempt spends one unit of the maxRuns budget', async () => {
  const { scheduler, clock, dir, config, store } = await setup()
  const at = clock.now.getTime() + 1_000
  await scheduler.upsertJob({ ...atJob(at), maxRuns: 2 })
  const state = await store.load()
  state.jobs[0].lastFiredFor = new Date(at).toISOString()
  state.jobs[0].endedAt = new Date(at).toISOString()
  state.jobs[0].inflight = { occurrence: new Date(at).toISOString(), startedAt: new Date(at).toISOString() }
  state.jobs[0].maxRuns = 1
  state.jobs[0].runsDone = 0
  await store.save(state)

  const reloaded = createScheduler({
    store: new Store(dir), config, logger: null, now: () => clock.now, pollMs: 1_000, freshWindowMs: 60_000,
    runner: { run: async () => ({ patch: {} }) },
  })
  await reloaded.ensureLoaded()
  const job = await reloaded.getJob('imc-at')
  assert.equal(job.runsDone, 1)
  // The only allowed attempt was the crashed one, so the job is finished.
  assert.ok(job.endedAt !== undefined)
})
