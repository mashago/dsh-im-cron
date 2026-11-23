/**
 * Payload execution: notify / command (agent is injected in M2.5).
 *
 * One run produces exactly one `runs.jsonl` record and at most one delivered
 * message. The runner never throws for expected failures — a bad command or an
 * offline bot becomes a record plus a `patch` the scheduler persists.
 */
import { runCommand as defaultExec } from './exec.js'
import { diag } from '../diag.js'

const RETRYABLE_PENDING = new Set(['bot-not-connected', 'cancelled', 'provider-unavailable', 'channel-unavailable'])
const NEEDS_REBIND = new Set(['unknown-bot', 'unknown-target'])
const UNRETRYABLE = new Set([
  'bad-request',
  'invalid-target',
  'target-conflict',
  'target-rejected',
  'capability-unavailable',
  'target-changed',
  'account-changed',
  'delivery-failed',
  'send-result-unknown',
])

const STDERR_LINES = 15
const TEXT_TAIL_CHARS = 500

function jobLabel(job) {
  return job.name && String(job.name).trim() !== '' ? String(job.name).trim() : job.id
}

function tailLines(text, count) {
  const lines = String(text ?? '').split('\n').filter((line) => line !== '')
  return lines.slice(-count).join('\n')
}

function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `…${value.slice(value.length - max)}`
}

function formatCommandFailure(job, outcome) {
  const label = jobLabel(job)
  if (outcome.spawnError !== undefined) {
    return `⚠️ ${label} 无法启动：${outcome.spawnError}`
  }
  if (outcome.timedOut) {
    return `⚠️ ${label} 超时被终止（${Math.round(outcome.durationMs / 1000)}s）`
  }
  const detail = tailLines(outcome.stderr, STDERR_LINES) || tailLines(outcome.stdout, STDERR_LINES)
  const header = `⚠️ ${label} failed（exit ${outcome.exitCode ?? outcome.signal ?? 'unknown'}）`
  return detail === '' ? header : `${header}\n\n${detail}`
}

/** Last 15 lines of a stderr-ish body for the failure message. */
function failureDetail(outcome) {
  return tailLines(outcome.stderr, STDERR_LINES) || tailLines(outcome.stdout, STDERR_LINES)
}

function successText(job) {
  return `✅ ${jobLabel(job)} 完成（无输出）`
}

function buildCommandText(job, outcome) {
  if (outcome.spawnError !== undefined || outcome.timedOut || outcome.exitCode !== 0) {
    return formatCommandFailure(job, outcome)
  }
  const stdout = String(outcome.stdout ?? '').trim()
  return stdout === '' ? successText(job) : stdout
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function shouldDeliver(job, ok) {
  const policy = job.deliver ?? 'always'
  if (policy === 'never') return false
  if (policy === 'on-failure') return !ok
  return true
}

function emptyFailure(error) {
  return { kind: 'failed', reason: 'deliver-unavailable', error }
}

/**
 * Deliver one text under the error policy.
 * @returns {Promise<{ status: 'sent'|'failed'|'pending'|'skipped', error?: string, attempts: number }>}
 */
async function deliverWithPolicy(send, job, text, { sleep = defaultSleep, logger = null, retryDelayMs = [5_000, 30_000] } = {}) {
  if (typeof send !== 'function') return { status: 'skipped', error: 'channel-unavailable', attempts: 0 }
  let attempts = 0
  let plainTried = false
  for (;;) {
    attempts += 1
    let outcome
    try {
      outcome = await send(job, text, plainTried ? { format: 'plain' } : undefined)
    } catch (error) {
      outcome = { status: 'failed', error: String(error?.code ?? error?.message ?? error) }
    }
    const status = outcome?.status ?? 'failed'
    if (status === 'sent') return { status: 'sent', attempts }
    const code = outcome?.error ?? 'delivery-failed'
    // A rich-text refusal is retried once as plain text; an unknown outcome is
    // not retried again because the message may already be visible.
    if (code === 'delivery-failed' && !plainTried) {
      plainTried = true
      logger?.warn?.('[im-cron] markdown 投递失败，改用纯文本重发一次')
      continue
    }
    if (status === 'pending' || RETRYABLE_PENDING.has(code)) {
      const delay = retryDelayMs[attempts - 1]
      if (delay !== undefined) {
        logger?.warn?.(`[im-cron] 投递未完成（${code}），${Math.round(delay / 1000)}s 后重试（第 ${attempts} 次）`)
        await sleep(delay)
        continue
      }
      return { status: 'pending', error: code, attempts }
    }
    if (UNRETRYABLE.has(code) || NEEDS_REBIND.has(code)) {
      return { status: 'failed', error: code, attempts }
    }
    return { status: 'failed', error: code, attempts }
  }
}

/**
 * Create the payload runner.
 * @param {{ store: import('./store.js').Store, config: object, logger?: object, now?: () => Date, send?: Function | null, exec?: Function, agent?: object | null, sleep?: Function }} deps
 */
export function createJobRunner({
  store,
  config,
  logger = null,
  now = () => new Date(),
  send = null,
  exec = defaultExec,
  agent = null,
  sleep = defaultSleep,
} = {}) {
  /**
   * Execute one occurrence.
   * @param {{ job: object, occurrence: Date | string, trigger?: 'schedule'|'manual', signal?: AbortSignal }} input
   * @returns {Promise<{ record: object, patch: object, delivered: boolean }>}
   */
  async function run({ job, occurrence, trigger = 'schedule', signal }) {
    const startedAt = Date.now()
    const occurrenceIso = occurrence instanceof Date ? occurrence.toISOString() : String(occurrence)
    diag('runner:enter', {
      jobId: job.id,
      occurrence: occurrenceIso,
      trigger,
      jobSnapshot: { lastFiredFor: job.lastFiredFor ?? null, endedAt: job.endedAt ?? null, sessionId: job.task?.sessionId ?? null, runs: job.task?.runs ?? null },
    })
    const mode = job.payload?.kind ?? 'unknown'
    const patch = {}

    let ok = false
    let text = ''
    let result = { kind: 'failed', reason: 'unknown-payload' }
    let sessionId
    let turn

    if (mode === 'notify') {
      text = String(job.payload.text ?? '')
      ok = text.trim() !== ''
      result = ok ? { kind: 'ok' } : { kind: 'failed', reason: 'empty-text' }
    } else if (mode === 'command') {
      // The path was resolved against `scriptDir` when the job was created, so a
      // run never depends on the caller's cwd or on a name lookup.
      const script = typeof job.payload.script === 'string' ? job.payload.script : ''
      if (script === '') {
        result = { kind: 'failed', reason: 'script-missing' }
        patch.state = 'invalid'
      } else {
        // Spawn the file directly instead of handing a path to a shell: a
        // scriptDir containing spaces would otherwise be word-split.
        const requested = job.payload.timeoutSeconds
        // A bad per-job timeout (declared config, or a job stored before the
        // tool-side check) must not disable the timeout or overflow setTimeout.
        const timeoutSeconds = Number.isSafeInteger(requested) && requested >= 1 && requested <= 86_400
          ? requested
          : config.defaultTimeoutSeconds
        const outcome = await exec({ argv: [script], cwd: config.scriptDir }, {
          timeoutSeconds,
          env: { IMCRON_JOB: job.id, IMCRON_OCCURRENCE: occurrenceIso },
          signal,
        })
        const exit = outcome.exitCode
        const succeeded = outcome.spawnError === undefined && !outcome.timedOut && exit === 0
        ok = succeeded
        text = buildCommandText(job, outcome)
        result = succeeded
          ? { kind: 'ok', exit }
          : { kind: 'failed', exit: exit ?? null, reason: outcome.timedOut ? 'timeout' : 'exit-nonzero', detail: failureDetail(outcome) || undefined }
      }
    } else if (mode === 'agent') {
      if (agent === null || typeof agent.runTurn !== 'function') {
        result = { kind: 'failed', reason: 'agent-unavailable' }
      } else {
        const outcome = await agent.runTurn(job, {
          prompt: job.payload.prompt,
          timeoutSeconds: job.payload.timeoutSeconds ?? config.agent?.timeoutSeconds,
          signal,
          occurrence: occurrenceIso,
        })
        ok = outcome?.ok === true
        text = String(outcome?.text ?? '')
        sessionId = outcome?.sessionId
        turn = outcome?.turn
        result = outcome?.result ?? (ok ? { kind: 'ok' } : { kind: 'failed', reason: outcome?.reason ?? 'agent-failed' })
        if (outcome?.task !== undefined) patch.task = outcome.task
        if (outcome?.blocked === true) result = { ...result, reason: 'session-archived' }
      }
    } else {
      patch.state = 'invalid'
    }

    if (ok && text.trim() === '' && mode !== 'notify') text = successText(job)
    if (!ok && String(text).trim() === '') {
      text = `⚠️ ${jobLabel(job)} failed（${result.reason ?? 'unknown'}）`
    }

    const record = {
      at: now().toISOString(),
      jobId: job.id,
      mode,
      occurrence: occurrenceIso,
      trigger,
      durationMs: Date.now() - startedAt,
      result,
    }
    if (sessionId !== undefined) record.sessionId = sessionId
    if (turn !== undefined) record.turn = turn

    let delivered = false
    if (shouldDeliver(job, ok)) {
      const delivery = await deliverWithPolicy(send, job, text, { sleep, logger })
      record.deliver = { status: delivery.status, ...(delivery.error === undefined ? {} : { error: delivery.error }), attempts: delivery.attempts }
      delivered = delivery.status === 'sent'
      if (delivery.status === 'failed' && NEEDS_REBIND.has(delivery.error)) patch.state = 'needs-rebind'
    } else {
      record.deliver = { status: 'skipped' }
    }

    record.textTail = clip(text, TEXT_TAIL_CHARS)

    try {
      await store.appendRun(record)
    } catch (error) {
      logger?.error?.(`[im-cron] 写 runs.jsonl 失败：${String(error)}`)
    }
    return { record, patch, delivered }
  }

  return { run, deliverWithPolicy }
}

export { deliverWithPolicy, buildCommandText, formatCommandFailure, shouldDeliver }
export default createJobRunner