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
    if (described === null || described === undefined) {
      throw channelError('not-an-im-session', '当前会话不在任何 IM 渠道上，无法回推；请在 QQ 里创建')
    }
    const chatType = described.chatType
    if (!['dm', 'group'].includes(chatType)) {
      throw channelError('unsupported-chat-type', `暂不支持的会话类型 ${String(chatType)}`)
    }
    if (chatType === 'group' && options.allowGroup === false) {
      throw channelError('group-disabled', '群聊任务已禁用（allowGroup: false）')
    }
    const allowChannels = options.allowChannels ?? ['qq']
    if (typeof described.channel === 'string' && !allowChannels.includes(described.channel)) {
      throw channelError('channel-disabled', `当前渠道 ${described.channel} 未启用（allowChannels）`)
    }
    const isGroup = chatType === 'group'
    // QQ private chats store `c2c:<senderId>`: chatId is null and the address
    // lives in senderId. Groups store `group:<groupOpenId>` with chatId set.
    const address = isGroup ? described.chatId : described.senderId
    if (typeof address !== 'string' || address === '') {
      throw channelError('no-address', '拿不到聊天地址，无法建立投递目标')
    }
    const botId = described.botId
    if (typeof botId !== 'string' || botId === '') throw channelError('no-bot', '拿不到机器人身份')
    return {
      botId,
      kind: isGroup ? 'group' : 'user',
      route: isGroup ? { groupOpenId: address } : { userOpenId: address },
      address,
      channel: described.channel,
      chatType,
    }
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
    const listed = await listTargetsOf(located.botId)
    const match = listed.find((target) => target?.kind === located.kind && sameRoute(target.route, located.route))
    return match === undefined
      ? null
      : { botId: located.botId, targetId: match.targetId, channel: located.channel, chatType: located.chatType }
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