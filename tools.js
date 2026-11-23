/**
 * Model-facing tools for dsh-im-cron (M3).
 *
 * Nine tools, three of them create work:
 *   imcron_remind  fixed text at the scheduled time (no model, no shell)
 *   imcron_run     one configuration-declared command
 *   imcron_ask     one agent turn in the job's dedicated task session
 * and six manage existing jobs (list / update / remove / pause / resume / trigger).
 *
 * Target isolation: a model can never name a bot or a chat. The target comes from
 * `describeConversation(exec.agent.session.id)`, and management tools only see
 * jobs whose frozen target matches the calling chat.
 *
 * These are plain `ToolDefinition` objects rather than `defineTool()` results: the
 * plugin keeps no `@deepseek-ai/dsh*` runtime dependency, so each execute
 * validates its own arguments (the schema is still checked by the host).
 */
import { randomBytes } from 'node:crypto'
import { hostTimezone } from './config.js'
import { describeSchedule, nextDue, nextRuns, parseSchedule } from './core/schedule.js'
import { ScriptError, resolveScriptPath } from './core/scripts.js'

export const name = 'im-cron-tools'
export const inject = ['tools', 'imCron']

class ToolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/**
 * The three schedule inputs are mutually exclusive: pick exactly one of `at`,
 * `cron` or `every`. Each description names its own shape so the model can tell
 * them apart at the point it fills the field.
 */
const AT_SCHEMA = {
  oneOf: [
    { type: 'string', description: 'Once at this instant (RFC3339 with an offset), e.g. 2026-11-21T09:00:00+08:00. '
      + 'Must be strictly in the future. Use `cron` for anything recurring and `every` for an interval.' },
    {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD (local date)' },
        time: { type: 'string', description: 'HH:mm, defaults to 00:00' },
        timezone: { type: 'string', description: 'IANA zone for this wall clock' },
      },
      required: ['date'],
      additionalProperties: false,
    },
  ],
}

const CRON_SCHEMA = {
  type: 'string',
  description: 'Recurring wall-clock pattern, five fields: minute hour day-of-month month day-of-week (0-7, 0/7 = Sunday). '
    + 'Write the local wall time directly — never convert it to UTC; the expression is read in `timezone`. '
    + 'Examples: "0 9 * * 1-5" (weekdays 09:00), "0 9,18 * * *" (09:00 and 18:00), "0 9 1 * *" (1st of each month), '
    + '"0 9 L * *" (last day of each month). '
    + 'No seconds, no macros, no "value/step". '
    + 'Use it whenever the user names weekdays, several times a day, a day of the month, or a month. '
    + 'Do not use it for "every N days": "*/15" means the 1st, 16th and 31st, not every 15 days.',
}

const EVERY_SCHEMA = {
  type: 'object',
  description: 'Interval cadence: the distance between runs. '
    + 'Use it for "every N minutes/hours/days/weeks", including intervals cron cannot express (every 90 minutes, every 15 days). '
    + 'minute/hour count from when the job is created; day/week fire at `at` on the calendar grid.',
  properties: {
    unit: { type: 'string', enum: ['minute', 'hour', 'day', 'week'], description: 'Interval unit.' },
    count: { type: 'integer', description: 'Interval size: minute 1-1440, hour 1-168, day 1-365, week 1-52.' },
    at: {
      type: 'string',
      description: 'every-only wall time as HH:mm for unit day/week (defaults to 00:00); not an instant. '
        + 'The first run is the NEXT occurrence of this time (today if still ahead, otherwise tomorrow), '
        + 'then every `count` units from there — tell the user the first run. '
        + 'Not accepted for unit minute/hour, which start from the creation minute.',
    },
    timezone: { type: 'string', description: 'IANA zone for the day/week wall clock; required semantics for day/week.' },
  },
  required: ['unit', 'count'],
  additionalProperties: false,
}

const MAX_RUNS_SCHEMA = {
  type: 'integer',
  description: 'Stop after this many SCHEDULED runs (1-10000). Manual imcron_trigger does not count. '
    + 'Use it for "do this 3 times"; omit for an open-ended schedule.',
}

const TIMEZONE_SCHEMA = {
  type: 'string',
  description: 'IANA zone for this schedule, e.g. "Asia/Shanghai". Defaults to the host zone.',
}

function textResult(text) {
  return [{ type: 'text', text }]
}

function outputSchema(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}

const CREATED_SCHEMA = {
  ok: { type: 'boolean' },
  id: { type: 'string' },
  name: { type: 'string' },
  schedule: { type: 'string' },
  nextRunAt: { type: 'string' },
  next3: { type: 'array', items: { type: 'string' } },
}

const JOB_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    payload: { type: 'string' },
    schedule: { type: 'string' },
    nextRunAt: { type: 'string' },
    deliver: { type: 'string' },
    enabled: { type: 'boolean' },
    ended: { type: 'boolean' },
    maxRuns: { type: 'integer' },
    runsDone: { type: 'integer' },
    state: { type: 'string' },
    lastRunAt: { type: 'string' },
    lastResult: { type: 'string' },
    lastDeliver: { type: 'string' },
  },
  required: ['id', 'name', 'payload', 'schedule', 'deliver', 'enabled'],
  additionalProperties: false,
}

/**
 * One job's status for the list rendering: a finished one-shot is not a paused
 * job, and calling it 暂停 invites the user to try resuming something that will
 * never run again.
 */
/** What a job does when it fires, in the words the list renders. */
const PAYLOAD_LABELS = Object.freeze({ notify: '提醒', command: '命令', agent: '模型' })

function payloadLabel(job) {
  const kind = typeof job.payload === 'string' && job.payload !== '' ? job.payload : 'unknown'
  return PAYLOAD_LABELS[kind] ?? kind
}

function jobStatus(job) {
  if (job.ended === true) return '已结束'
  return job.enabled === true ? '启用' : '暂停'
}

/** Human-readable form of a job's internal `state` for the list render. */
function jobStateLabel(state) {
  if (state === 'needs-rebind') return '投递目标失效（修复后用 imcron_resume）'
  return String(state)
}

function createToolRuntime(ctx) {
  const runtime = () => {
    const service = ctx.get('imCron')
    if (service === undefined || service === null) {
      throw new ToolError('cron-unavailable', '定时任务插件尚未就绪')
    }
    return service
  }

  /**
   * The script directory the model should name scripts from, for the schema it
   * reads before its first call.
   *
   * Never throws: the tool table is built while the service that owns the
   * configuration may not exist yet, and a description must not break loading.
   * @returns {string|null}
   */
  function scriptDirNow() {
    try {
      const dir = ctx.get('imCron')?.config?.scriptDir
      return typeof dir === 'string' && dir !== '' ? dir : null
    } catch {
      return null
    }
  }

  /**
   * Resolve the model's script reference, reporting refusals as tool errors so
   * the model can explain them and pick another file.
   * @param {string} scriptDir
   * @param {string} input
   * @returns {Promise<string>}
   */
  async function resolveScript(scriptDir, input) {
    try {
      return await resolveScriptPath(scriptDir, input)
    } catch (error) {
      if (error instanceof ScriptError) throw new ToolError(error.code, error.message)
      throw error
    }
  }

  function channelOrThrow(im) {
    if (im.channel === null || im.channel === undefined) {
      throw new ToolError('channel-unavailable', '当前没有可用的 IM 渠道，无法建投递任务')
    }
    return im.channel
  }

  function sessionIdOf(exec) {
    const sessionId = exec?.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new ToolError('no-session', '无法确定当前会话，请在聊天里调用')
    }
    return sessionId
  }

  function zoneOf(im, explicit) {
    return explicit ?? im.config.timezone ?? hostTimezone()
  }

  function parseToolSchedule(im, args) {
    const timezone = zoneOf(im, args.timezone)
    try {
      return parseSchedule({ at: args.at, cron: args.cron, every: args.every }, { timezone, now: new Date() })
    } catch (error) {
      throw new ToolError(error?.code ?? 'bad-schedule', error?.message ?? String(error))
    }
  }

  function nextThree(schedule, from = new Date()) {
    return nextRuns(schedule, from, 3).map((date) => date.toISOString())
  }

  function newId() {
    return `imc-${randomBytes(4).toString('hex')}`
  }

  function defaultName(payload) {
    if (payload.kind === 'notify') return String(payload.text ?? '').slice(0, 24) || '提醒'
    if (payload.kind === 'command') {
      const script = typeof payload.script === 'string' ? payload.script : ''
      return `脚本 ${script.split('/').pop() || '未命名'}`.slice(0, 24)
    }
    return String(payload.prompt ?? '').slice(0, 24) || '定时任务'
  }

  function jobCount(im) {
    return im.scheduler.listJobs().length
  }

  function jobsForTarget(im, target) {
    return im.scheduler.listJobs().filter((job) => job.target !== undefined
      && job.target.botId === target.botId
      && job.target.targetId === target.targetId)
  }

  /** Target of the calling chat, without creating one; null when it has none. */
  async function existingTarget(im, sessionId) {
    const channel = channelOrThrow(im)
    return await channel.describeTarget(sessionId)
  }

  /** Ensure a job belongs to the calling chat before exposing or mutating it. */
  async function ownJob(im, exec, id) {
    if (typeof id !== 'string' || id === '') throw new ToolError('bad-request', '缺少任务 id')
    const job = im.scheduler.getJob(id)
    if (job === undefined) throw new ToolError('job-not-found', `找不到任务 ${id}`)
    if (job.target === undefined) throw new ToolError('job-not-owned', '该任务没有投递目标，不能在这里管理')
    const target = await existingTarget(im, sessionIdOf(exec))
    if (target === null || job.target.botId !== target.botId || job.target.targetId !== target.targetId) {
      // Deliberately the same answer as "not found": a chat must not learn about
      // another chat's jobs by probing ids.
      throw new ToolError('job-not-found', `找不到任务 ${id}`)
    }
    return job
  }

  async function createJob({ im, exec, schedule, payload, deliver, maxRuns }) {
    const channel = channelOrThrow(im)
    if (im.available !== true) {
      throw new ToolError('channel-unavailable', '当前没有可用的 IM 渠道，无法建投递任务')
    }
    const sessionId = sessionIdOf(exec)
    if (jobCount(im) >= im.config.maxJobs) {
      throw new ToolError('too-many-jobs', `任务总数已达上限 ${im.config.maxJobs}`)
    }
    const name = defaultName(payload)
    const target = await channel.resolveTarget(sessionId, {
      jobName: name,
      allowChannels: im.config.allowChannels,
      allowGroup: typeof im.isGroupAllowed === 'function' ? im.isGroupAllowed() : im.config.allowGroup,
    }).catch((error) => {
      throw new ToolError(error?.code ?? 'resolve-target-failed', error?.message ?? String(error))
    })

    // A group has many speakers but a command task has exactly one author, so the
    // whole payload stays private-chat only. `target.chatType` is only known here.
    if (payload.kind === 'command' && target.chatType === 'group') {
      throw new ToolError('command-not-allowed-in-group', '群聊里不支持脚本任务，请私聊我创建')
    }
    if (jobsForTarget(im, target).length >= im.config.maxJobsPerTarget) {
      throw new ToolError('too-many-jobs', `这个聊天已有 ${im.config.maxJobsPerTarget} 个任务，已达上限`)
    }

    const now = new Date()
    const job = {
      id: newId(),
      name,
      target: { botId: target.botId, targetId: target.targetId, channel: target.channel, label: name },
      schedule,
      payload,
      deliver,
      enabled: true,
      createdAt: now.toISOString(),
      createdBy: { sessionId },
      ...(maxRuns === undefined ? {} : { maxRuns, runsDone: 0 }),
    }
    await im.scheduler.upsertJob(job)
    const next3 = nextThree(schedule, now)
    return {
      ok: true,
      id: job.id,
      name: job.name,
      schedule: describeSchedule(schedule),
      nextRunAt: next3[0] ?? '',
      next3,
    }
  }

  function validateTimeoutSeconds(value) {
    if (value === undefined || value === null) return undefined
    if (!Number.isSafeInteger(value) || value < 1 || value > 86_400) {
      throw new ToolError('bad-timeout', 'timeoutSeconds 必须是 1-86400 的整数')
    }
    return value
  }

  function validateMaxRuns(value) {
    if (value === undefined || value === null) return undefined
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
      throw new ToolError('bad-max-runs', 'maxRuns 必须是 1-10000 的整数')
    }
    return value
  }

  function validateNotify(value, { allowed, fallback, label }) {
    if (value === undefined) return fallback
    if (!allowed.includes(value)) {
      throw new ToolError('bad-notify', `notify 只能是 ${allowed.join(' / ')}（${label}）`)
    }
    return value
  }

  function validateNotifyText(im, text) {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new ToolError('empty-text', '提醒内容不能为空')
    }
    if (text.length > im.config.maxNotifyChars) {
      throw new ToolError('text-too-long', `提醒内容最多 ${im.config.maxNotifyChars} 字`)
    }
  }

  // ------------------------------------------------------------------ tools
  const tools = {}

  tools.imcron_remind = {
    name: 'imcron_remind',
    description: 'Send a fixed text to this chat at the scheduled time. No model turn, no shell, no token cost. '
      + 'Use it for reminders like "tell me to write the report at 9". '
      + 'In an IM chat prefer this over schedule_create: schedule_* starts a model turn and only mirrors the answer when the deployment enables '
      + 'deliverModelAnswers, while this tool always pushes to the chat. '
      + 'Do NOT use it to ask the agent to do something or to run a script — use imcron_ask or imcron_run.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The exact message to send.' },
        at: AT_SCHEMA,
        cron: CRON_SCHEMA,
        every: EVERY_SCHEMA,
        timezone: TIMEZONE_SCHEMA,
        maxRuns: MAX_RUNS_SCHEMA,
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema(CREATED_SCHEMA),
      render: (_args, value) => textResult(`已创建提醒 ${value.id}：${value.schedule}，下次 ${value.nextRunAt}`),
    },
    async execute(args, exec) {
      const im = runtime()
      validateNotifyText(im, args.text)
      const schedule = parseToolSchedule(im, args)
      return await createJob({
        im,
        exec,
        schedule,
        payload: { kind: 'notify', text: args.text },
        deliver: 'always',
        maxRuns: validateMaxRuns(args.maxRuns),
      })
    },
  }

  tools.imcron_run = {
    name: 'imcron_run',
    description: 'Spawn a script at the scheduled time and report its output to this chat. '
      + 'No model turn and no shell string: name ONE executable script that already lives in the plugin workspace directory. '
      + 'The script runs with that directory as its cwd and receives IMCRON_JOB and IMCRON_OCCURRENCE in its environment. '
      + 'Exit 0 with output is delivered; a non-zero exit is reported as a failure. '
      + 'Use notify:"never" when the output is not needed. '
      + 'Do NOT use it for reminders (imcron_remind) or for anything that needs a model (imcron_ask). '
      + 'Command tasks are not available in group chats.',
    parameters: {
      type: 'object',
      properties: {
        script: (() => {
          const dir = scriptDirNow()
          const where = dir === null
            ? 'inside the plugin workspace directory'
            : `in ${dir}`
          const example = dir === null ? '"stock-report.sh"' : `"${dir}/stock-report.sh"`
          return {
            type: 'string',
            description: `Script to run: a file name ${where} (e.g. "stock-report.sh"), or an absolute path that lives `
              + `${where}. Example resolved path: ${example}. It must be an existing executable file with a shebang line. `
              + 'Free-form shell commands are not accepted here.',
          }
        })(),
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: 86_400,
          description: 'Kill the script after this many seconds (1-86400); defaults to the plugin defaultTimeoutSeconds.',
        },
        at: AT_SCHEMA,
        cron: CRON_SCHEMA,
        every: EVERY_SCHEMA,
        timezone: TIMEZONE_SCHEMA,
        maxRuns: MAX_RUNS_SCHEMA,
        notify: { type: 'string', enum: ['always', 'on-failure', 'never'], description: 'Defaults to on-failure.' },
      },
      required: ['script'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema(CREATED_SCHEMA),
      render: (_args, value) => textResult(`已创建脚本任务 ${value.id}：${value.schedule}，下次 ${value.nextRunAt}`),
    },
    async execute(args, exec) {
      const im = runtime()
      const scriptPath = await resolveScript(im.config.scriptDir, args.script)
      const schedule = parseToolSchedule(im, args)
      const timeoutSeconds = validateTimeoutSeconds(args.timeoutSeconds)
      return await createJob({
        im,
        exec,
        schedule,
        payload: {
          kind: 'command',
          script: scriptPath,
          ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        },
        deliver: validateNotify(args.notify, { allowed: ['always', 'on-failure', 'never'], fallback: 'on-failure', label: 'imcron_run' }),
        maxRuns: validateMaxRuns(args.maxRuns),
      })
    },
  }

  tools.imcron_ask = {
    name: 'imcron_ask',
    description: 'At the scheduled time this runs ONE agent turn with the given prompt in a dedicated task session (reused across runs), '
      + 'then pushes the answer back to this chat unless notify:"never". No shell. '
      + 'Use it for digests, research, summaries and any recurring model task whose result belongs in this chat. '
      + 'Use it whenever this chat asks for work at a later time ("in 1 minute", "at 9", "every minute"): do not wait '
      + 'with an inline sleep in the chat session, which blocks the turn and runs under the chat sandbox instead of '
      + 'the task session one. '
      + 'The answer is produced by a model, so the run costs tokens and may take minutes. '
      + 'Prefer this over schedule_create when the result should arrive in this chat: schedule_* only mirrors answers when '
      + 'deliverModelAnswers is on, and it runs in the chat session instead of a dedicated task session. '
      + 'Do NOT use it for fixed reminders (imcron_remind) or registered scripts (imcron_run).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The instruction for the task session.' },
        at: AT_SCHEMA,
        cron: CRON_SCHEMA,
        every: EVERY_SCHEMA,
        timezone: TIMEZONE_SCHEMA,
        maxRuns: MAX_RUNS_SCHEMA,
        notify: { type: 'string', enum: ['always', 'never'], description: 'Defaults to always.' },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: 86_400,
          description: 'Per-run turn budget (1-86400 seconds); defaults to the plugin agent.timeoutSeconds.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema(CREATED_SCHEMA),
      render: (_args, value) => textResult(`已创建模型任务 ${value.id}：${value.schedule}，下次 ${value.nextRunAt}`),
    },
    async execute(args, exec) {
      const im = runtime()
      if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        throw new ToolError('empty-prompt', 'prompt 不能为空')
      }
      if (im.agent === null || im.agent === undefined || im.agent.available !== true) {
        throw new ToolError('agent-unavailable', '这个部署没有可用的 agent 运行时，无法创建模型任务')
      }
      const schedule = parseToolSchedule(im, args)
      const timeoutSeconds = validateTimeoutSeconds(args.timeoutSeconds)
      return await createJob({
        im,
        exec,
        schedule,
        payload: {
          kind: 'agent',
          prompt: args.prompt,
          ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        },
        deliver: validateNotify(args.notify, { allowed: ['always', 'never'], fallback: 'always', label: 'imcron_ask' }),
        maxRuns: validateMaxRuns(args.maxRuns),
      })
    },
  }

  tools.imcron_list = {
    name: 'imcron_list',
    description: 'List the scheduled jobs of this chat with their mode (reminder, command or model), next run and last result. '
      + 'Use it whenever the user asks what is scheduled, when something will run, or why a message did not arrive. '
      + 'It cannot see jobs created in other chats.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, jobs: { type: 'array', items: JOB_SCHEMA } },
        required: ['ok', 'jobs'],
        additionalProperties: false,
      },
      render: (_args, value) => textResult(value.jobs.length === 0
        ? '（这个聊天还没有定时任务）'
        : value.jobs.map((job) => `${job.id} ${job.name} · ${job.schedule} · ${payloadLabel(job)}${job.maxRuns === undefined ? '' : ` · 已跑 ${job.runsDone}/${job.maxRuns}`} · 下次 ${job.nextRunAt || '-'} · ${jobStatus(job)}${job.state === undefined ? '' : ` · ${jobStateLabel(job.state)}`}`).join('\n')),
    },
    async execute(_args, exec) {
      const im = runtime()
      const target = await existingTarget(im, sessionIdOf(exec))
      if (target === null) return { ok: true, jobs: [] }
      const runs = await im.store.readRuns({ limit: 500 })
      const lastByJob = new Map()
      for (const record of runs) {
        if (record?.jobId !== undefined) lastByJob.set(record.jobId, record)
      }
      const now = new Date()
      const jobs = jobsForTarget(im, target).map((job) => {
        const last = lastByJob.get(job.id)
        let next = ''
        if (job.enabled !== false && job.state === undefined && job.endedAt === undefined) {
          try {
            const due = nextDue(job.schedule, new Date(job.lastFiredFor ?? job.createdAt))
            next = due === undefined ? '' : due.toISOString()
          } catch {
            next = ''
          }
        }
        return {
          id: job.id,
          name: job.name ?? '',
          payload: job.payload?.kind ?? 'unknown',
          schedule: describeSchedule(job.schedule, { timezone: im.config.timezone ?? hostTimezone(now) }),
          nextRunAt: next,
          deliver: job.deliver ?? 'always',
          enabled: job.enabled !== false && job.endedAt === undefined,
          // Ended and paused are different states: a paused job can resume, a
          // finished one-shot never runs again.
          ended: job.endedAt !== undefined,
          ...(job.maxRuns === undefined ? {} : {
            maxRuns: job.maxRuns,
            runsDone: Number.isSafeInteger(job.runsDone) ? job.runsDone : 0,
          }),
          ...(job.state === undefined ? {} : { state: job.state }),
          ...(last === undefined ? {} : {
            lastRunAt: String(last.at ?? ''),
            lastResult: String(last.result?.kind ?? '') + (last.result?.reason === undefined ? '' : `/${last.result.reason}`),
            lastDeliver: String(last.deliver?.status ?? ''),
          }),
        }
      })
      return { ok: true, jobs }
    },
  }

  tools.imcron_update = {
    name: 'imcron_update',
    description: 'Change the schedule, the text/prompt, the notify policy or the run budget of an existing job of this chat. '
      + 'Every argument is optional: an omitted one keeps its current value, so send only what changes. '
      + 'The payload type can NOT be changed (delete and recreate to switch between reminder, command and model task), '
      + 'and the target chat can not be changed. '
      + 'Changing the schedule re-anchors it, so slots that belonged to the old schedule never fire; '
      + 'it also re-arms a job paused by a delivery error (needs-rebind). '
      + 'Use it for "move my daily report to 10:00" or "stop pushing the backup output", not for re-creating a task.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        at: AT_SCHEMA,
        cron: CRON_SCHEMA,
        every: EVERY_SCHEMA,
        timezone: TIMEZONE_SCHEMA,
        text: { type: 'string', description: 'New text, notify jobs only.' },
        prompt: { type: 'string', description: 'New prompt, agent jobs only.' },
        notify: { type: 'string', enum: ['always', 'on-failure', 'never'] },
        maxRuns: MAX_RUNS_SCHEMA,
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema(CREATED_SCHEMA),
      render: (_args, value) => textResult(`已更新 ${value.id}：${value.schedule}，下次 ${value.nextRunAt}`),
    },
    async execute(args, exec) {
      const im = runtime()
      const job = await ownJob(im, exec, args.id)
      const kind = job.payload?.kind
      const next = { ...job, payload: { ...job.payload } }

      const hasSchedule = args.at !== undefined || args.cron !== undefined || args.every !== undefined
      if (hasSchedule) {
        const schedule = parseToolSchedule(im, args)
        next.schedule = schedule
        // Re-anchor: never fire for a slot that existed under the old schedule.
        next.lastFiredFor = new Date().toISOString()
        delete next.endedAt
        // A schedule change is an explicit re-arm: clear a delivery-failure state
        // too, otherwise the job stays unrunnable until imcron_resume is called.
        if (next.state === 'needs-rebind') delete next.state
      }

      if (args.text !== undefined) {
        if (kind !== 'notify') throw new ToolError('payload-mismatch', `任务 ${job.id} 不是提醒任务，不能用 text`)
        validateNotifyText(im, args.text)
        next.payload.text = args.text
      }
      if (args.prompt !== undefined) {
        if (kind !== 'agent') throw new ToolError('payload-mismatch', `任务 ${job.id} 不是模型任务，不能用 prompt`)
        if (args.prompt.trim() === '') throw new ToolError('empty-prompt', 'prompt 不能为空')
        next.payload.prompt = args.prompt
      }

      if (args.notify !== undefined) {
        if (kind === 'notify') {
          if (args.notify !== 'always') throw new ToolError('bad-notify', '提醒任务总是发送，notify 只能是 always')
        } else if (kind === 'command') {
          next.deliver = validateNotify(args.notify, { allowed: ['always', 'on-failure', 'never'], fallback: job.deliver ?? 'on-failure', label: 'imcron_update' })
        } else {
          next.deliver = validateNotify(args.notify, { allowed: ['always', 'never'], fallback: job.deliver ?? 'always', label: 'imcron_update' })
        }
      }

      if (args.maxRuns !== undefined) {
        // A new budget restarts the count; keeping the old count could end the job
        // on the very next run.
        const budget = validateMaxRuns(args.maxRuns)
        next.maxRuns = budget
        next.runsDone = 0
        delete next.endedAt
      }

      const revives = hasSchedule || args.maxRuns !== undefined
      await im.scheduler.upsertJob(next, { clearEndedAt: revives })
      const next3 = nextThree(next.schedule, new Date())
      return {
        ok: true,
        id: next.id,
        name: next.name,
        schedule: describeSchedule(next.schedule),
        nextRunAt: next3[0] ?? '',
        next3,
      }
    },
  }

  tools.imcron_remove = {
    name: 'imcron_remove',
    description: 'Delete one scheduled job of this chat. The dsh-im delivery target is left in place because other jobs may use it. '
      + 'Use imcron_pause instead when the user may want the job back later.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ ok: { type: 'boolean' }, id: { type: 'string' } }),
      render: (_args, value) => textResult(`已删除任务 ${value.id}`),
    },
    async execute(args, exec) {
      const im = runtime()
      const job = await ownJob(im, exec, args.id)
      await im.scheduler.removeJob(job.id)
      return { ok: true, id: job.id }
    },
  }

  tools.imcron_pause = {
    name: 'imcron_pause',
    description: 'Pause one job of this chat while keeping its schedule and history. '
      + 'Missed slots while paused are NOT replayed when it resumes. '
      + 'Use imcron_remove to delete it instead.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ ok: { type: 'boolean' }, id: { type: 'string' }, enabled: { type: 'boolean' } }),
      render: (_args, value) => textResult(`已暂停任务 ${value.id}`),
    },
    async execute(args, exec) {
      const im = runtime()
      const job = await ownJob(im, exec, args.id)
      await im.scheduler.upsertJob({ ...job, enabled: false })
      return { ok: true, id: job.id, enabled: false }
    },
  }

  tools.imcron_resume = {
    name: 'imcron_resume',
    description: 'Resume a paused job of this chat. Slots missed while it was paused are skipped; the next future slot runs. '
      + 'It also clears the needs-rebind delivery state and recreates the chat\'s target if it was deleted. '
      + 'Use imcron_trigger to run it once immediately.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ ok: { type: 'boolean' }, id: { type: 'string' }, enabled: { type: 'boolean' } }),
      render: (_args, value) => textResult(`已恢复任务 ${value.id}`),
    },
    async execute(args, exec) {
      const im = runtime()
      const job = await ownJob(im, exec, args.id)
      if (job.endedAt !== undefined) {
        throw new ToolError('job-ended', `任务 ${job.id} 已经结束（一次性任务），请重新创建`)
      }
      const next = { ...job, enabled: true }
      if (next.state === 'needs-rebind') delete next.state

      // A deleted target cannot be repaired by clearing the flag alone. When this
      // job uses the chat's canonical target, recreate it (the id is deterministic
      // and therefore unchanged); custom target ids are left alone.
      const sessionId = sessionIdOf(exec)
      const current = await im.channel.describeTarget(sessionId)
      if (current !== null && current.targetId === job.target.targetId) {
        let target
        try {
          target = await im.channel.resolveTarget(sessionId, {
            jobName: job.name,
            allowChannels: im.config.allowChannels,
            allowGroup: typeof im.isGroupAllowed === 'function' ? im.isGroupAllowed() : im.config.allowGroup,
          })
        } catch (error) {
          throw new ToolError(error?.code ?? 'resolve-target-failed', error?.message ?? String(error))
        }
        next.target = { ...job.target, botId: target.botId, targetId: target.targetId, channel: target.channel }
      }
      await im.scheduler.upsertJob(next)
      return { ok: true, id: job.id, enabled: true }
    },
  }

  tools.imcron_trigger = {
    name: 'imcron_trigger',
    description: 'Run one job of this chat immediately, without changing its schedule or its next run. '
      + 'A model job (imcron_ask) really spends tokens here. Returns "running" when the job is already executing.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          status: { type: 'string' },
          result: { type: 'string' },
          deliver: { type: 'string' },
        },
        required: ['ok', 'id', 'status'],
        additionalProperties: false,
      },
      render: (_args, value) => textResult(`任务 ${value.id} 已立即执行：${value.status}${value.result === undefined ? '' : `（${value.result}）`}`),
    },
    async execute(args, exec) {
      const im = runtime()
      const job = await ownJob(im, exec, args.id)
      const outcome = await im.scheduler.runNow(job.id, 'manual')
      if (outcome.ok !== true) {
        throw new ToolError(outcome.reason === 'running' ? 'job-running' : 'trigger-failed', `任务 ${job.id} 未执行：${outcome.reason}`)
      }
      const record = outcome.record ?? {}
      return {
        ok: true,
        id: job.id,
        status: record.result?.kind ?? 'unknown',
        ...(record.result?.reason === undefined ? {} : { result: String(record.result.reason) }),
        ...(record.deliver?.status === undefined ? {} : { deliver: String(record.deliver.status) }),
      }
    },
  }

  return tools
}

export function apply(ctx) {
  const logger = ctx.logger?.('im-cron-tools')
  if (typeof ctx?.tools?.register !== 'function') {
    // Injection did not resolve: keep the failure loud instead of loading a
    // plugin that silently offers no tools.
    logger?.error?.('[im-cron] tools 服务不可用：imcron_* 工具未注册')
    return
  }
  let tools
  try {
    tools = createToolRuntime(ctx)
  } catch (error) {
    logger?.error?.(`[im-cron] 工具初始化失败：${String(error)}`)
    return
  }
  let registered = 0
  for (const definition of Object.values(tools)) {
    try {
      ctx.tools.register(definition)
      registered += 1
    } catch (error) {
      logger?.warn?.(`[im-cron] 注册工具 ${definition.name} 失败：${String(error)}`)
    }
  }
  logger?.info?.(`[im-cron] 已注册 ${registered} 个工具`)
  if (registered > 0) installRoutingHint(ctx, logger)
}

/** Guidance that keeps scheduled work on the imcron tools inside IM chats. */
export const ROUTING_HINT = 'Scheduled work that should arrive in a chat: use imcron_remind for a fixed reminder, '
  + 'imcron_run for an operator-registered script, and imcron_ask for a recurring model summary. '
  + 'Prefer them over schedule_* when the session is an IM chat (dsh-im): imcron_* pushes to the chat directly and '
  + 'runs agent work in a dedicated task session, while schedule_* runs inside the chat session and its answer is '
  + 'delivered only when the deployment enables deliverModelAnswers. '
  + 'Use schedule_* only for multi-turn work that needs this conversation\'s context. '
  + 'Pick exactly one schedule input: `at` for a single instant, `cron` whenever the user names weekdays, several times '
  + 'a day, a day of the month or a month, and `every` for a plain interval such as every 90 minutes or every 15 days. '
  + 'When an IM chat asks for something to happen later ("in 1 minute", "at 9 o\'clock", "every minute"), schedule '
  + 'it with imcron_ask, imcron_remind or imcron_run — never wait inline with `sleep`, which blocks this turn for '
  + 'its whole duration and runs under the chat session\'s restricted sandbox instead of the task session\'s '
  + 'configured one.'

/**
 * Sessions known to be IM chats. `describeConversationSync` only reads dsh-im's
 * in-memory memo, which is cold for a resumed session; the cache keeps the answer
 * for later assemblies after a sync hit or a background lookup settles.
 */
const IM_SESSIONS = new Set()
const IM_SESSION_CACHE_LIMIT = 500

function rememberImSession(sessionId) {
  if (IM_SESSIONS.has(sessionId)) return
  if (IM_SESSIONS.size >= IM_SESSION_CACHE_LIMIT) IM_SESSIONS.delete(IM_SESSIONS.values().next().value)
  IM_SESSIONS.add(sessionId)
}

function installRoutingHint(ctx, logger) {
  const systemPrompt = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.section !== 'function') {
    logger?.warn?.('[im-cron] systemPrompt 服务不可用，未注入定时任务路由提示')
    return
  }
  // Resolved per assembly: dsh-im provides `dshIm` asynchronously, so the channel
  // may not exist yet when this row loads.
  const channel = () => {
    const service = typeof ctx?.get === 'function' ? ctx.get('imCron') : undefined
    const found = service?.channel
    return found !== null && found !== undefined && typeof found.describeConversationSync === 'function'
      ? found
      : null
  }
  const probing = new Set()
  const isImSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (IM_SESSIONS.has(sessionId)) return true
    const im = channel()
    if (im === null) return false
    try {
      if (im.describeConversationSync(sessionId) !== null) {
        rememberImSession(sessionId)
        return true
      }
    } catch {
      // treat a throwing memo as unknown; the async lookup below decides
    }
    // Prompt assembly is synchronous, so warm the answer for the next assembly
    // instead of blocking this one.
    if (!probing.has(sessionId)) {
      probing.add(sessionId)
      Promise.resolve()
        .then(() => im.describeConversation(sessionId))
        .then((described) => { if (described !== null && described !== undefined) rememberImSession(sessionId) })
        .catch(() => {
          // an unresolved conversation stays absent from the hint; the tools/execute
          // guard still blocks native scheduling in that session
        })
        .finally(() => probing.delete(sessionId))
    }
    return false
  }
  try {
    const base = typeof systemPrompt.getSectionOrder === 'function'
      ? systemPrompt.getSectionOrder('TOOL_SCHEDULE')
      : null
    systemPrompt.section({
      name: 'tool:imcron',
      order: (typeof base === 'number' ? base : 2500) + 10,
      // Only IM chats get this guidance: elsewhere `schedule_*` is the correct
      // choice and the sleep warning does not apply.
      text: (assembly) => (isImSession(assembly?.agent?.session?.id) ? ROUTING_HINT : ''),
    })
  } catch (error) {
    logger?.warn?.(`[im-cron] 注入路由提示失败：${String(error?.message ?? error)}`)
  }
}

export { createToolRuntime, ToolError }
