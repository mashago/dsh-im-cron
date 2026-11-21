import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshImChannel, probeDshIm } from '../channel/dsh-im.js'

function fakeService(overrides = {}) {
  const calls = { send: [], createTarget: [], listTargets: [] }
  const service = {
    contractVersion: 1,
    async send(botId, targetId, text, options) {
      calls.send.push({ botId, targetId, text, options })
      return { sent: true }
    },
    async describeConversation() {
      return { channel: 'qq', botId: 'bot-1', chatType: 'dm', chatId: null, senderId: 'OPENID-1' }
    },
    async listTargets(botId) {
      calls.listTargets.push(botId)
      // The live `dshIm` service unwraps deliveryService.listTargets and
      // returns the plain array; the wrapper shape is covered by its own test.
      return []
    },
    async createTarget(botId, target) {
      calls.createTarget.push({ botId, target })
      return target
    },
    ...overrides,
  }
  return { service, calls }
}

test('probe: a complete contract is available', () => {
  const { service } = fakeService()
  const result = probeDshIm({ get: () => service }, { channel: 'dshIm' })
  assert.equal(result.available, true)
})

test('probe: missing service or method is reported, not thrown', () => {
  assert.deepEqual(probeDshIm({ get: () => undefined }, {}), { available: false, reason: 'service-missing' })
  const { service } = fakeService({ send: undefined })
  const result = probeDshIm({ get: () => service }, {})
  assert.equal(result.available, false)
  assert.match(result.reason, /missing:send/u)
  assert.equal(probeDshIm({ get: () => ({ ...service, contractVersion: 0 }) }, {}).available, false)
})

test('resolveTarget: private chat uses senderId, not chatId', async () => {
  const { service, calls } = fakeService()
  const channel = createDshImChannel(service)
  const target = await channel.resolveTarget('session-1', { jobName: '日报' })
  assert.equal(target.botId, 'bot-1')
  assert.match(target.targetId, /^cron-[0-9a-f]{12}$/u)
  assert.equal(calls.createTarget.length, 1)
  assert.equal(calls.createTarget[0].target.kind, 'user')
  assert.deepEqual(calls.createTarget[0].target.route, { userOpenId: 'OPENID-1' })
  assert.equal(calls.createTarget[0].target.name, '定时任务 日报')
})

test('resolveTarget: group chat uses chatId as groupOpenId', async () => {
  const { service, calls } = fakeService({
    async describeConversation() {
      return { channel: 'qq', botId: 'bot-1', chatType: 'group', chatId: 'GROUP-1', senderId: 'MEMBER' }
    },
  })
  const channel = createDshImChannel(service)
  const target = await channel.resolveTarget('session-1', { allowGroup: true })
  assert.equal(target.chatType, 'group')
  assert.equal(calls.createTarget[0].target.kind, 'group')
  assert.deepEqual(calls.createTarget[0].target.route, { groupOpenId: 'GROUP-1' })
})

test('resolveTarget: an existing target is reused without creating another', async () => {
  const { service, calls } = fakeService({
    async listTargets(botId) {
      calls.listTargets.push(botId)
      return [{ targetId: 'cron-existing', kind: 'user', route: { userOpenId: 'OPENID-1' }, sessionSync: { enabled: false, state: 'off' } }]
    },
  })
  const channel = createDshImChannel(service)
  const target = await channel.resolveTarget('session-1')
  assert.equal(target.targetId, 'cron-existing')
  assert.equal(calls.createTarget.length, 0)
})

test('resolveTarget: target-conflict is recovered by re-reading', async () => {
  let listCalls = 0
  const { service } = fakeService({
    async listTargets(botId) {
      listCalls += 1
      return listCalls === 1 ? [] : [{ targetId: 'cron-raced', kind: 'user', route: { userOpenId: 'OPENID-1' } }]
    },
    async createTarget() {
      const error = new Error('Target already exists')
      error.code = 'target-conflict'
      throw error
    },
  })
  const channel = createDshImChannel(service)
  const target = await channel.resolveTarget('session-1')
  // Two listTargets calls: the pre-create check and the conflict re-read.
  assert.equal(listCalls, 2)
  // The re-read adopts the target that already holds this route.
  assert.equal(target.targetId, 'cron-raced')
})

test('resolveTarget: non-IM session and disabled group are explicit errors', async () => {
  const { service } = fakeService({ async describeConversation() { return null } })
  const channel = createDshImChannel(service)
  await assert.rejects(() => channel.resolveTarget('web-session'), (error) => error.code === 'not-an-im-session')

  const group = fakeService({
    async describeConversation() {
      return { channel: 'qq', botId: 'bot-1', chatType: 'group', chatId: 'GROUP-1', senderId: null }
    },
  })
  await assert.rejects(
    () => createDshImChannel(group.service).resolveTarget('session-1', { allowGroup: false }),
    (error) => error.code === 'group-disabled',
  )
})

test('send: success, pending and terminal codes are mapped', async () => {
  const job = { target: { botId: 'bot-1', targetId: 'cron-1' } }
  const ok = createDshImChannel(fakeService().service)
  assert.deepEqual(await ok.send(job, 'hi'), { status: 'sent' })

  const offline = createDshImChannel(fakeService({
    async send() { const error = new Error('offline'); error.code = 'bot-not-connected'; throw error },
  }).service)
  assert.deepEqual(await offline.send(job, 'hi'), { status: 'pending', error: 'bot-not-connected' })

  const unknown = createDshImChannel(fakeService({
    async send() { const error = new Error('gone'); error.code = 'unknown-target'; throw error },
  }).service)
  assert.deepEqual(await unknown.send(job, 'hi'), { status: 'failed', error: 'unknown-target' })
})

test('send: a job without a frozen target is skipped, never thrown', async () => {
  const channel = createDshImChannel(fakeService().service)
  assert.deepEqual(await channel.send({}, 'hi'), { status: 'failed', error: 'no-target' })
})

test('channel: the synchronous conversation lookup is exposed when supported', async () => {
  const { service } = fakeService({ describeConversationSync: () => ({ chatType: 'dm' }) })
  const channel = createDshImChannel(service)
  assert.deepEqual(channel.describeConversationSync('session-1'), { chatType: 'dm' })
  assert.equal(channel.describeConversationSync(''), null)

  const bare = createDshImChannel(fakeService().service)
  assert.equal(bare.describeConversationSync('session-1'), null)
})


test('channel: the async conversation lookup is exposed', async () => {
  const { service } = fakeService()
  const channel = createDshImChannel(service)
  assert.deepEqual(await channel.describeConversation('session-1'), {
    channel: 'qq', botId: 'bot-1', chatType: 'dm', chatId: null, senderId: 'OPENID-1',
  })
  assert.equal(await channel.describeConversation(''), null)
  const broken = createDshImChannel(fakeService({
    async describeConversation() { throw new Error('down') },
  }).service)
  assert.equal(await broken.describeConversation('session-1'), null)
})


test('channel: the { targets } wrapper shape is accepted too', async () => {
  const { service } = fakeService({
    async listTargets(botId) {
      return { botId, channel: 'qq', targets: [{ targetId: 'cron-wrapped', kind: 'user', route: { userOpenId: 'OPENID-1' } }] }
    },
  })
  const channel = createDshImChannel(service)
  const target = await channel.resolveTarget('session-1')
  assert.equal(target.targetId, 'cron-wrapped')
})
