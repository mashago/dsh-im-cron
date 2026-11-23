/**
 * dsh-im delivery adapter.
 *
 * The only contract this plugin depends on:
 *   send(botId, targetId, text, {format}) -> {sent:true}
 *   describeConversation(sessionId)       -> {channel,botId,chatType,chatId,senderId}
 *   listTargets(botId)                    -> {botId,channel,targets:[{targetId,kind,route}]}
 *   createTarget(botId, {targetId,name,kind,route})
 *
 * Nothing from dsh-im is imported; every call is soft-probed so a missing or
 * upgraded service degrades to a log line instead of a crash.
 */
import { createHash } from 'node:crypto'
import { SUPPORTED_CHANNELS } from '../config.js'

export const REQUIRED_METHODS = Object.freeze(['send', 'describeConversation', 'createTarget', 'listTargets'])
const TARGET_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/
const TEXT_FORMAT = 'markdown'

/** Delivery codes that mean "try again later", never "this job is broken". */
export const PENDING_CODES = new Set(['bot-not-connected', 'cancelled', 'provider-unavailable'])
export const REBIND_CODES = new Set(['unknown-bot', 'unknown-target'])

/**
 * Soft-probe the channel service on `ctx`.
 * @param {object} ctx - plugin context.
 * @param {{ channel?: string }} config
 * @returns {{ available: true, service: object } | { available: false, reason: string }}
 */
export function probeDshIm(ctx, config = {}) {
  const id = config.channel ?? 'dshIm'
  let service = null
  try {
    service = typeof ctx?.get === 'function' ? ctx.get(id) : null
  } catch {
    service = null
  }
  if (service === null || service === undefined) return { available: false, reason: 'service-missing' }

  const missing = REQUIRED_METHODS.filter((method) => typeof service[method] !== 'function')
  if (missing.length > 0) return { available: false, reason: `missing:${missing.join(',')}` }

  const version = service.contractVersion
  if (version !== undefined && !(Number(version) >= 1)) {
    return { available: false, reason: `contract-version:${String(version)}` }
  }
  return { available: true, service }
}

export function targetIdFor({ botId, channel, kind, address }) {
  const digest = createHash('sha256').update(`${botId}|${channel}|${kind}|${address}`).digest('hex')
  return `cron-${digest.slice(0, 12)}`
}

function sameRoute(left, right) {
  const leftKeys = Object.keys(left ?? {}).sort()
  const rightKeys = Object.keys(right ?? {}).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function channelError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * dsh-im route shapes per channel. `user` is a direct chat, `group` a group
 * chat; a channel/kind without a builder cannot be addressed and is rejected.
 * Keep in sync with dsh-im's `normalizeRoute` (delivery-adapter.mjs).
 */
const ROUTE_BUILDERS = Object.freeze({
  qq: {
    user: (address) => ({ kind: 'user', route: { userOpenId: address } }),
    group: (address) => ({ kind: 'group', route: { groupOpenId: address } }),
  },
  feishu: {
    user: (address) => ({ kind: 'user', route: { openId: address } }),
  },
  weixin: {
    user: (address) => ({ kind: 'user', route: { toUserId: address } }),
  },
  dingtalk: {
    user: (address) => ({ kind: 'user', route: { userId: address } }),
    group: (address) => ({ kind: 'group', route: { openConversationId: address } }),
  },
  wecom: {
    user: (address) => ({ kind: 'user', route: { chatId: address } }),
    group: (address) => ({ kind: 'group', route: { chatId: address } }),
  },
})

/**
 * Translate one `describeConversation()` result into a dsh-im target shape.
 * Pure apart from the thrown errors; exported so the route table is testable
 * without a fake service.
 * @param {object | null | undefined} described
 * @param {{ allowChannels?: string[], allowGroup?: boolean }} [options]
 * @returns {{ botId: string, kind: 'user'|'group', route: object, address: string, channel: string, chatType: string }}
 */
export function routeForConversation(described, { allowChannels = SUPPORTED_CHANNELS, allowGroup = true } = {}) {
  if (described === null || described === undefined) {
    throw channelError('not-an-im-session', '当前会话不在任何 IM 渠道上，无法回推；请在 IM 聊天里创建')
  }
  const channel = described.channel
  if (typeof channel !== 'string' || channel === '') {
    throw channelError('channel-unsupported', '拿不到当前渠道标识，无法建立投递目标')
  }
  if (!allowChannels.includes(channel)) {
    throw channelError('channel-disabled', `当前渠道 ${channel} 未启用（allowChannels）`)
  }

  const chatType = described.chatType
  if (chatType === 'thread') {
    throw channelError('thread-unsupported', `${channel} 的话题会话暂不支持定时任务，请改用私聊`)
  }
  if (chatType !== 'dm' && chatType !== 'group') {
    throw channelError('unsupported-chat-type', `暂不支持的会话类型 ${String(chatType)}`)
  }
  const kind = chatType === 'group' ? 'group' : 'user'
  if (kind === 'group' && allowGroup === false) {
    throw channelError('group-disabled', '群聊任务已禁用（allowGroup: false）')
  }

  const builder = ROUTE_BUILDERS[channel]?.[kind]
  if (builder === undefined) {
    if (channel === 'feishu' && kind === 'group') {
      throw channelError('channel-unsupported', '飞书暂只支持私聊创建定时任务（群聊与话题暂不支持）')
    }
    throw channelError('channel-unsupported', `${channel} 暂不支持${kind === 'group' ? '群聊' : '私聊'}投递`)
  }

  // Groups expose `chatId`; direct chats expose `senderId` (wecom also sets
  // chatId to the same user id, so the fallback keeps it usable).
  const address = kind === 'group' ? described.chatId : (described.senderId ?? described.chatId)
  if (typeof address !== 'string' || address === '') {
    throw channelError('no-address', '拿不到聊天地址，无法建立投递目标')
  }
  const botId = described.botId
  if (typeof botId !== 'string' || botId === '') throw channelError('no-bot', '拿不到机器人身份')

  const built = builder(address)
  return { botId, kind: built.kind, route: built.route, address, channel, chatType }
}

/**
 * Delivery + target resolution against a live dsh-im service.
 * @param {object} service - `ctx.get('dshIm')`.
 * @param {{ logger?: object, format?: 'markdown'|'plain' }} [options]
 */
export function createDshImChannel(service, { logger = null, format = TEXT_FORMAT } = {}) {
  /**
   * Send one text to a job's frozen target.
   * @returns {Promise<{ status: 'sent'|'failed'|'pending', error?: string }>}
   */
  async function send(job, text, options = {}) {
    const target = job?.target
    if (target === null || target === undefined || typeof target.botId !== 'string' || typeof target.targetId !== 'string') {
      return { status: 'failed', error: 'no-target' }
    }
    try {
      await service.send(target.botId, target.targetId, text, { format: options.format ?? format })
      return { status: 'sent' }
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'delivery-failed'
      const status = PENDING_CODES.has(code) ? 'pending' : 'failed'
      logger?.warn?.(`[im-cron] 投递失败（${code}）target=${target.botId}/${target.targetId}`)
      return { status, error: code }
    }
  }

  /** Resolve one conversation's chat address into a delivery target shape. */
  function locate(described, options = {}) {
    return routeForConversation(described, {
      allowChannels: options.allowChannels ?? SUPPORTED_CHANNELS,
      allowGroup: options.allowGroup !== false,
    })
  }

  /**
   * Targets of one bot. The `dshIm` service returns the plain array
   * (`(await deliveryService.listTargets(id)).targets`); accept the
   * `{ targets }` wrapper as well so either shape keeps working.
   */
  async function listTargetsOf(botId) {
    const listed = await service.listTargets(botId)
    if (Array.isArray(listed)) return listed
    return Array.isArray(listed?.targets) ? listed.targets : []
  }

  /** Async conversation lookup: the authoritative "is this an IM chat" answer. */
  async function describeConversation(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    try {
      return (await service.describeConversation(sessionId)) ?? null
    } catch {
      return null
    }
  }

  /**
   * Synchronous conversation lookup when the service supports it (dsh-im binds
   * the conversation before the session exists, so this answers during
   * `agent/created`). Returns null when unsupported or unbound.
   */
  function describeConversationSync(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    if (typeof service.describeConversationSync !== 'function') return null
    try {
      return service.describeConversationSync(sessionId) ?? null
    } catch {
      return null
    }
  }

  /**
   * The saved target that already points at this session's chat, or null.
   * Never creates anything — management tools need this to scope a chat's jobs.
   */
  async function describeTarget(sessionId) {
    const described = await service.describeConversation(sessionId)
    if (described === null || described === undefined) return null
    let located
    try {
      located = locate(described)
    } catch {
      return null
    }
    let listed = []
    try {
      listed = await listTargetsOf(located.botId)
    } catch (error) {
      // A missing/unreadable target list must not hide this chat's jobs; fall
      // through to the canonical id so the management tools still work.
      logger?.warn?.(`[im-cron] 读取投递目标失败：${String(error?.message ?? error)}`)
    }
    const match = listed.find((target) => target?.kind === located.kind && sameRoute(target.route, located.route))
    if (match !== undefined) {
      return { botId: located.botId, targetId: match.targetId, channel: located.channel, chatType: located.chatType }
    }
    // The target may have been deleted (unknown-target -> needs-rebind). Jobs
    // created from a chat use this deterministic id, so returning it keeps them
    // visible and manageable instead of unreachable forever.
    return {
      botId: located.botId,
      targetId: targetIdFor({ botId: located.botId, channel: located.channel, kind: located.kind, address: located.address }),
      channel: located.channel,
      chatType: located.chatType,
    }
  }

  /**
   * Resolve (or create) the delivery target for a session's chat.
   * @param {string} sessionId
   * @param {{ jobName?: string, allowChannels?: string[], allowGroup?: boolean }} [options]
   * @returns {Promise<{ botId: string, targetId: string, channel: string, chatType: string }>}
   */
  async function resolveTarget(sessionId, options = {}) {
    const described = await service.describeConversation(sessionId)
    const located = locate(described, options)
    const { botId, kind, route, address, channel, chatType } = located

    const listed = await listTargetsOf(botId)
    const existing = listed.find((target) => target?.kind === kind && sameRoute(target.route, route))
    if (existing !== undefined) {
      return { botId, targetId: existing.targetId, channel, chatType }
    }

    const targetId = targetIdFor({ botId, channel, kind, address })
    const name = `定时任务 ${String(options.jobName ?? '').trim() || targetId}`.slice(0, 80)
    try {
      await service.createTarget(botId, { targetId, name, kind, route })
    } catch (error) {
      // createTarget is not idempotent: a concurrent creator yields target-conflict.
      // Re-read and adopt whatever target already holds this route.
      if (error?.code !== 'target-conflict') throw error
      const raced = await listTargetsOf(botId)
      const adopted = raced.find((target) => target?.kind === kind && sameRoute(target.route, route))
        ?? raced.find((target) => target?.targetId === targetId)
      if (adopted === undefined) throw error
      return { botId, targetId: adopted.targetId, channel, chatType }
    }
    return { botId, targetId, channel, chatType }
  }

  return { send, resolveTarget, describeTarget, describeConversation, describeConversationSync }
}

export default createDshImChannel