/**
 * Read model for the Plugins-page jobs dialog.
 *
 * The model-facing tools are scoped to one chat's target; this view is the
 * owner's page and lists every target. Rows carry raw flags (`enabled`, `ended`,
 * `state`, `inflight`) and the client derives the status grouping, so the
 * display rule lives next to the buttons that depend on it.
 *
 * `applyJobAction` is the owner-side equivalent of pause / resume / delete. It
 * deliberately skips the chat-ownership check of `imcron_*` (the page has no
 * chat): the HTTP route enforces `owner` instead. Repairing a `needs-rebind`
 * job still needs a chat session to recreate the target, so it stays out.
 */
import { hostTimezone } from './config.js'
import { describeSchedule, nextDue } from './core/schedule.js'
import { withoutExecutionState } from './core/scheduler.js'

/** Last run record per job, newest record wins (readRuns appends in order). */
function lastRuns(runs) {
  const byJob = new Map()
  for (const record of runs) {
    if (record?.jobId !== undefined) byJob.set(record.jobId, record)
  }
  return byJob
}

function nextRunOf(job, timezone) {
  if (job.enabled === false || job.state !== undefined || job.endedAt !== undefined) return ''
  try {
    const due = nextDue(job.schedule, new Date(job.lastFiredFor ?? job.createdAt))
    return due === undefined ? '' : due.toISOString()
  } catch {
    return ''
  }
}

/** One display string for what the job actually does, capped for the wire. */
function previewOf(job) {
  const payload = job.payload ?? {}
  const text = typeof payload.text === 'string' ? payload.text
    : typeof payload.script === 'string' ? payload.script
      : typeof payload.prompt === 'string' ? payload.prompt
        : ''
  const trimmed = text.trim()
  if (trimmed === '') return ''
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed
}

function describeSafely(schedule, timezone) {
  try {
    return describeSchedule(schedule, { timezone })
  } catch {
    return ''
  }
}

function rowOf(job, last, now, timezone) {
  const target = job.target ?? {}
  return {
    id: job.id,
    name: job.name ?? '',
    payloadKind: job.payload?.kind ?? 'unknown',
    deliver: job.deliver ?? 'always',
    schedule: describeSafely(job.schedule, timezone),
    nextRunAt: nextRunOf(job, timezone),
    target: {
      channel: typeof target.channel === 'string' ? target.channel : '',
      targetId: typeof target.targetId === 'string' ? target.targetId : '',
      label: typeof target.label === 'string' ? target.label : '',
      botId: typeof target.botId === 'string' ? target.botId : '',
    },
    payloadPreview: previewOf(job),
    enabled: job.enabled !== false,
    ended: job.endedAt !== undefined,
    ...(job.state === undefined ? {} : { state: job.state }),
    inflight: job.inflight !== undefined,
    createdAt: String(job.createdAt ?? ''),
    ...(job.maxRuns === undefined ? {} : {
      maxRuns: job.maxRuns,
      runsDone: Number.isSafeInteger(job.runsDone) ? job.runsDone : 0,
    }),
    ...(job.activeHours === undefined ? {} : { activeHours: job.activeHours }),
    ...(job.endedAt === undefined ? {} : { endedAt: String(job.endedAt) }),
    ...(job.createdBy === undefined ? {} : { createdBy: job.createdBy }),
    ...(last === undefined ? {} : {
      lastRunAt: String(last.at ?? ''),
      lastResult: String(last.result?.kind ?? '')
        + (last.result?.reason === undefined ? '' : `/${last.result.reason}`),
      lastDeliver: String(last.deliver?.status ?? ''),
      ...(Number.isFinite(last.durationMs) ? { lastDurationMs: last.durationMs } : {}),
      ...(typeof last.result?.error === 'string' ? { lastError: last.result.error } : {}),
    }),
  }
}

/**
 * Every job as one display row.
 * @param {{scheduler: object, store: object, config: object}} service - the imCron service
 * @param {Date} [now] - clock used for the schedule description
 * @returns {Promise<object[]>} rows, unsorted (the client groups them)
 */
export async function collectJobs(service, now = new Date()) {
  const jobs = service.scheduler.listJobs()
  const runs = await service.store.readRuns({ limit: 500 })
  const last = lastRuns(Array.isArray(runs) ? runs : [])
  const timezone = service.config?.timezone ?? hostTimezone(now)
  return jobs.map((job) => rowOf(job, last.get(job.id), now, timezone))
}

/** The three owner-side actions; anything else is a bad request. */
export const JOB_ACTIONS = Object.freeze(['pause', 'resume', 'delete'])

/**
 * Apply one action by id.
 * @param {{scheduler: object}} service - the imCron service
 * @param {string} id - job id
 * @param {'pause'|'resume'|'delete'} action
 * @returns {Promise<{ok: true} | {ok: false, code: string}>}
 */
export async function applyJobAction(service, id, action) {
  const job = service.scheduler.getJob(id)
  if (job === undefined) return { ok: false, code: 'not-found' }
  if (action === 'pause') {
    if (job.endedAt !== undefined) return { ok: false, code: 'job-ended' }
    await service.scheduler.upsertJob({ ...withoutExecutionState(job), enabled: false })
    return { ok: true }
  }
  if (action === 'resume') {
    if (job.endedAt !== undefined) return { ok: false, code: 'job-ended' }
    // Both stalled states need the owning chat to recreate the target; the
    // page can only delete such a job.
    if (job.state === 'needs-rebind' || job.state === 'invalid') {
      return { ok: false, code: 'job-needs-chat-repair' }
    }
    await service.scheduler.upsertJob({ ...withoutExecutionState(job), enabled: true })
    return { ok: true }
  }
  if (action === 'delete') {
    const removed = await service.scheduler.removeJob(id)
    return removed ? { ok: true } : { ok: false, code: 'not-found' }
  }
  return { ok: false, code: 'bad-action' }
}