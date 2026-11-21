/**
 * dsh-im-cron plugin entry.
 *
 * `apply` never throws: a broken configuration, a missing channel, or an
 * unreadable state file degrades to log lines while DSH keeps running.
 */
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { hostTimezone, parseConfig } from './config.js'
import { Store } from './core/store.js'
import { createJobRunner } from './core/job.js'
import { createScheduler } from './core/scheduler.js'
import { parseSchedule } from './core/schedule.js'
import { createDshImChannel, probeDshIm } from './channel/dsh-im.js'
import { createAgentTurn } from './core/agent-turn.js'

export const name = 'im-cron'
export const inject = []

/**
 * The Plugins page form for this row. `allowGroup` is the one runtime switch:
 * marking it volatile lets a save land in place, and the tools read the live
 * reference instead of the startup snapshot.
 */
export const Config = z.object({
  allowGroup: z.boolean().default(false).volatile()
    .description('群聊里是否允许使用定时任务；默认关闭'),
})

/** Native scheduling is unreliable inside a chat; imcron_* owns those tools there. */
export const NATIVE_SCHEDULE_TOOLS = Object.freeze([
  'schedule_create',
  'schedule_edit',
  'schedule_list',
  'schedule_view',
])

function resolveLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') return ctx.logger('im-cron')
    if (ctx?.logger !== undefined && ctx.logger !== null) return ctx.logger
  } catch {
    // fall through to console
  }
  return console
}

function declarationId(decl) {
  const digest = createHash('sha256')
    .update(`${decl.name ?? ''}|${JSON.stringify(decl.payload ?? {})}`)
    .digest('hex')
  return `decl-${digest.slice(0, 10)}`
}

function defaultDeliver(kind) {
  if (kind === 'command') return 'on-failure'
  return 'always'
}

/**
 * Resolve the dsh-im service on demand.
 *
 * `dshIm` may be provided by dsh-im's own async `apply`, which can finish after
 * this plugin starts. Probing once at startup therefore races the provider, so
 * every use retries until the service answers.
 */
export function createLazyChannel(ctx, config, logger) {
  let built = null
  let lastReason = 'service-missing'
  const probe = () => {
    const result = probeDshIm(ctx, config)
    if (!result.available) {
      lastReason = result.reason
      return null
    }
    lastReason = null
    built = createDshImChannel(result.service, { logger })
    return built
  }
  const current = () => built ?? probe()
  return {
    get available() { return current() !== null },
    get reason() { return lastReason },
    send(job, text, options) {
      const channel = current()
      return channel === null
        ? Promise.resolve({ status: 'failed', error: 'channel-unavailable' })
        : channel.send(job, text, options)
    },
    resolveTarget(sessionId, options) {
      const channel = current()
      if (channel === null) {
        const error = new Error('dsh-im 渠道尚未就绪')
        error.code = 'channel-unavailable'
        return Promise.reject(error)
      }
      return channel.resolveTarget(sessionId, options)
    },
    describeTarget(sessionId) {
      const channel = current()
      return channel === null ? Promise.resolve(null) : channel.describeTarget(sessionId)
    },
    describeConversation(sessionId) {
      const channel = current()
      return channel === null ? Promise.resolve(null) : channel.describeConversation(sessionId)
    },
    describeConversationSync(sessionId) {
      const channel = current()
      return channel === null ? null : channel.describeConversationSync(sessionId)
    },
  }
}

/**
 * Block native schedule calls that come from an IM-bound session.
 *
 * Hiding the tools is the first line of defence (`installImSchedulePolicy`), but
 * tool visibility can lag an agent's creation. This `tools/execute` guard is the
 * deterministic backstop: the model gets a normal tool error naming the imcron
 * alternative, and the call never runs.
 * @returns {() => void} disposer
 */
export function installImScheduleGuard(ctx, channel, logger) {
  if (channel === null || channel === undefined || typeof channel.describeConversationSync !== 'function') {
    return () => {}
  }
  if (typeof ctx?.on !== 'function') return () => {}
  const denied = new Set(NATIVE_SCHEDULE_TOOLS)
  const message = '在 IM 聊天里 schedule_* 不可用：它的回答默认不会推送到聊天。'
    + '请改用 imcron_remind（固定提醒）、imcron_run（跑脚本）或 imcron_ask（模型汇总）。'
  const listener = async (exec, next) => {
    if (!denied.has(exec?.name)) return next()
    const sessionId = exec?.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return next()
    // Sync lookup is the fast path; the async reverse lookup is authoritative
    // (the sync memo in dsh-im can be cold for a resumed session).
    let described = null
    try {
      described = channel.describeConversationSync(sessionId)
    } catch {
      described = null
    }
    if (described === null) {
      try {
        described = await channel.describeConversation(sessionId)
      } catch {
        described = null
      }
    }
    if (described === null) return next()
    logger?.info?.(`[im-cron] 拦截 IM 会话 ${sessionId} 里的 ${exec.name} 调用`)
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
      error: { message, info: { name: 'ImCronRoutingError', code: 'IMCRON_SCHEDULE_DISABLED' } },
    }
  }
  try {
    return ctx.on('tools/execute', listener, { global: true })
  } catch (error) {
    logger?.warn?.(`[im-cron] 无法注册 tools/execute 守卫：${String(error?.message ?? error)}`)
    return () => {}
  }
}

/**
 * Deny the native schedule tools for agents whose session belongs to a chat.
 * dsh-im binds the conversation before the session exists, so the synchronous
 * lookup answers during `agent/created` and the first prompt already sees the
 * restricted set. Web/desktop sessions keep the native tools.
 * @returns {() => void} disposer (no-op when the policy cannot be installed)
 */
export function installImSchedulePolicy(ctx, channel, logger) {
  if (channel === null || channel === undefined || typeof channel.describeConversationSync !== 'function') {
    return () => {}
  }
  if (typeof ctx?.on !== 'function') return () => {}
  const deny = { deny: [...NATIVE_SCHEDULE_TOOLS] }
  const listener = async (payload) => {
    const agent = payload?.agent
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    try {
      let described = channel.describeConversationSync(sessionId)
      if (described === null) described = await channel.describeConversation(sessionId)
      if (described === null) return
      agent.ctx?.tools?.restrict?.(deny)
      logger?.info?.(`[im-cron] IM 会话 ${sessionId} 已屏蔽原生 schedule_*`)
    } catch (error) {
      logger?.warn?.(`[im-cron] 屏蔽原生 schedule_* 失败（${sessionId}）：${String(error?.message ?? error)}`)
    }
  }
  try {
    return ctx.on('agent/created', listener, { global: true })
  } catch (error) {
    logger?.warn?.(`[im-cron] 无法监听 agent/created：${String(error?.message ?? error)}`)
    return () => {}
  }
}

/**
 * Parse and upsert operator-declared jobs from configuration. A malformed row
 * disables only that row.
 */
export async function applyDeclaredJobs(scheduler, config, logger, now = new Date()) {
  const timezone = config.timezone ?? hostTimezone(now)
  let applied = 0
  for (const decl of config.jobs ?? []) {
    let schedule
    try {
      schedule = parseSchedule(decl.schedule ?? {}, { timezone, now })
    } catch (error) {
      logger?.warn?.(`[im-cron] 声明任务 "${decl.name ?? '?'}" 排期非法，已跳过：${error?.message ?? error}`)
      continue
    }
    const id = decl.id ?? declarationId(decl)
    const existing = scheduler.getJob(id)
    const payload = decl.payload ?? {}
    const job = {
      id,
      name: decl.name ?? id,
      schedule,
      payload,
      deliver: decl.deliver ?? defaultDeliver(payload.kind),
      enabled: decl.enabled !== false,
      createdAt: existing?.createdAt ?? now.toISOString(),
      declared: true,
      ...(decl.target === undefined ? {} : { target: { channel: 'qq', ...decl.target } }),
      ...(existing?.lastFiredFor === undefined ? {} : { lastFiredFor: existing.lastFiredFor }),
      // A declared one-shot job that already ran must stay finished after a restart.
      ...(existing?.endedAt === undefined ? {} : { endedAt: existing.endedAt }),
      ...(existing?.task === undefined ? {} : { task: existing.task }),
    }
    await scheduler.upsertJob(job)
    applied += 1
  }
  return applied
}

/**
 * Build and start the plugin runtime.
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [rawConfig]
 */
export function startPlugin(ctx, rawConfig = {}, deps = {}) {
  const logger = deps.logger ?? resolveLogger(ctx)
  const clock = deps.now ?? (() => new Date())
  const { config, warnings } = parseConfig(rawConfig)
  for (const warning of warnings) logger.warn?.(`[im-cron] ${warning}`)

  // The Loader's resolved config object: a volatile save updates these
  // references in place, so the group switch needs no restart.
  const liveConfig = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  const liveGroupAllowed = () => {
    const value = liveConfig.allowGroup
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
      try {
        return value.get() === true
      } catch {
        return config.allowGroup
      }
    }
    return value === undefined ? config.allowGroup : value === true
  }

  const store = new Store(config.stateDir, { logger, now: clock })
  const initial = probeDshIm(ctx, config)
  const im = createLazyChannel(ctx, config, logger)
  if (!initial.available) {
    logger.warn?.(`[im-cron] delivery=pending（${initial.reason}）—— 每次使用时会重试探测`)
    if (config.requireChannel) logger.warn?.('[im-cron] requireChannel=true：不会创建需要投递的任务')
  }

  const agentTurn = createAgentTurn({ ctx, config, logger, now: clock, pollMs: (config.pollSeconds ?? 30) * 1000 })
  if (!agentTurn.available) logger.warn?.(`[im-cron] agent=unavailable（${agentTurn.reason}）`)

  const disposeSchedulePolicy = installImSchedulePolicy(ctx, im, logger)
  const disposeScheduleGuard = installImScheduleGuard(ctx, im, logger)

  const runner = createJobRunner({
    store,
    config,
    logger,
    now: clock,
    send: im.send,
    // Passed unconditionally: the runtime re-probes its services on every run, so
    // a provider that loads late is still picked up.
    agent: agentTurn,
  })
  const scheduler = createScheduler({ store, config, runner, logger, now: clock })

  const stop = () => {
    try {
      scheduler.stop()
    } catch (error) {
      logger.warn?.(`[im-cron] 停止调度器失败：${String(error)}`)
    }
    try {
      agentTurn.detach()
    } catch (error) {
      logger.warn?.(`[im-cron] 卸载回合运行时失败：${String(error)}`)
    }
    for (const dispose of [disposeSchedulePolicy, disposeScheduleGuard]) {
      try {
        dispose()
      } catch (error) {
        logger.warn?.(`[im-cron] 卸载工具策略失败：${String(error)}`)
      }
    }
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => stop)
  }

  const ready = scheduler
    .ensureLoaded()
    .then(() => applyDeclaredJobs(scheduler, config, logger, clock()))
    .then((count) => {
      logger.info?.(`[im-cron] delivery=${im.available ? 'dshIm' : 'pending'} agent=${agentTurn.available ? 'on' : 'off'} jobs=${count} stateDir=${config.stateDir}`)
      return count
    })
    .catch((error) => {
      logger.error?.(`[im-cron] 初始化失败：${String(error?.message ?? error)}`)
      return 0
    })

  scheduler.start()

  const service = {
    version: 1,
    scheduler,
    store,
    config,
    channel: im,
    agent: agentTurn,
    isGroupAllowed: liveGroupAllowed,
    get available() { return im.available },
    get reason() { return im.reason },
  }
  if (typeof ctx?.provide === 'function') ctx.provide('imCron', Object.freeze(service))

  return {
    scheduler,
    store,
    config,
    channel: im,
    agent: agentTurn,
    stop,
    ready,
    get available() { return im.available },
    get reason() { return im.reason },
  }
}

export function apply(ctx, rawConfig = {}) {
  try {
    startPlugin(ctx, rawConfig)
  } catch (error) {
    const logger = resolveLogger(ctx)
    logger.error?.(`[im-cron] 插件加载失败（DSH 继续运行）：${String(error?.message ?? error)}`)
  }
}

