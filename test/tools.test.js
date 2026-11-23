import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseConfig } from '../config.js'
import { createDshImChannel } from '../channel/dsh-im.js'
import { createJobRunner } from '../core/job.js'
import { createScheduler } from '../core/scheduler.js'
import { Store } from '../core/store.js'
import { apply } from '../tools.js'

const NOW = new Date('2026-11-20T01:00:00+08:00')

function fakeDshIm({ chatType = 'dm' } = {}) {
  const targets = []
  const calls = { createTarget: [], send: [] }
  const described = () => (chatType === 'group'
    ? { channel: 'qq', botId: 'bot-1', chatType: 'group', chatId: 'GROUP-1', senderId: 'MEMBER' }
    : { channel: 'qq', botId: 'bot-1', chatType: 'dm', chatId: null, senderId: 'OPENID-1' })
  const service = {
    contractVersion: 1,
    async send(botId, targetId, text, options) {
      calls.send.push({ botId, targetId, text, options })
      return { sent: true }
    },
    describeConversationSync(sessionId) {
      return typeof sessionId === 'string' && sessionId !== '' ? described() : null
    },
    async describeConversation() {
      return described()
    },
    async listTargets(botId) {
      return { botId, channel: 'qq', targets: targets.map((target) => ({ ...target })) }
    },
    async createTarget(botId, target) {
      calls.createTarget.push({ botId, target })
      targets.push(target)
      return target
    },
  }
  return { service, targets, calls }
}

async function harness({ config: configOverrides = {}, chatType = 'dm', agentAvailable = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-tools-'))
  const { config } = parseConfig({
    stateDir: dir,
    timezone: 'Asia/Shanghai',

    ...configOverrides,
  })
  const store = new Store(dir)
  // A real workspace with real executables: the resolver requires both.
  await mkdir(join(dir, 'workspace'), { recursive: true })
  await writeFile(join(dir, 'workspace', 'echo.sh'), '#!/bin/sh\nprintf tool-output\n')
  await chmod(join(dir, 'workspace', 'echo.sh'), 0o755)
  await writeFile(join(dir, 'workspace', 'fail.sh'), '#!/bin/sh\nexit 1\n')
  await chmod(join(dir, 'workspace', 'fail.sh'), 0o755)
  const dshIm = fakeDshIm({ chatType })
  const channel = createDshImChannel(dshIm.service)
  const agent = {
    available: agentAvailable,
    async runTurn() {
      return { ok: true, text: 'model answer', sessionId: 'session-task-1', turn: 1, result: { kind: 'ok' } }
    },
  }
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send: channel.send, agent })
  const scheduler = createScheduler({ store, config, runner, logger: null, now: () => NOW, pollMs: 1_000 })
  await scheduler.ensureLoaded()

  const imCron = { version: 1, scheduler, store, config, channel, agent, available: true }
  const definitions = new Map()
  const warnings = []
  const sections = []
  const systemPrompt = {
    section(section) { sections.push(section); return () => {} },
    getSectionOrder: () => 2500,
  }
  const ctx = {
    get: (name) => (name === 'imCron' ? imCron : name === 'systemPrompt' ? systemPrompt : undefined),
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    logger: () => ({ warn: (message) => warnings.push(String(message)), info() {}, error() {} }),
  }
  apply(ctx)

  const exec = { agent: { session: { id: 'session-chat-1' } } }
  const call = async (name, args = {}) => {
    const definition = definitions.get(name)
    assert.ok(definition !== undefined, `tool ${name} should be registered`)
    return await definition.execute(args, exec)
  }
  return { dir, store, config, scheduler, dshIm, imCron, definitions, warnings, sections, exec, call }
}

test('tools: all eight tools register with model-facing descriptions', async () => {
  const { definitions } = await harness()
  assert.deepEqual([...definitions.keys()].sort(), [
    'imcron_ask', 'imcron_list', 'imcron_pause', 'imcron_remind', 'imcron_remove',
    'imcron_resume', 'imcron_run', 'imcron_trigger', 'imcron_update',
  ])
  assert.match(definitions.get('imcron_ask').description, /Do NOT use it/u)
  assert.match(definitions.get('imcron_remind').description, /Do NOT use it/u)
  for (const definition of definitions.values()) {
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('tools: creating a task needs a ready channel', async () => {
  const { call, imCron } = await harness()
  imCron.available = false
  await assert.rejects(
    () => call('imcron_remind', { text: 'x', cron: '0 9 * * *' }),
    (error) => error.code === 'channel-unavailable',
  )
})

test('tools: remind creates a notify job bound to the private chat address', async () => {
  const { call, scheduler, dshIm } = await harness()
  const result = await call('imcron_remind', { text: '写日报', cron: '0 9 * * *' })
  assert.equal(result.ok, true)
  assert.match(result.id, /^imc-[0-9a-f]{8}$/u)
  assert.equal(result.next3.length, 3)
  assert.equal(dshIm.calls.createTarget.length, 1)
  assert.deepEqual(dshIm.calls.createTarget[0].target.route, { userOpenId: 'OPENID-1' })

  const job = scheduler.getJob(result.id)
  assert.equal(job.payload.kind, 'notify')
  assert.equal(job.deliver, 'always')
  assert.deepEqual(job.target, {
    botId: 'bot-1',
    targetId: dshIm.targets[0].targetId,
    channel: 'qq',
    label: '写日报',
  })
})

test('tools: group chat uses the group openid', async () => {
  const { call, dshIm } = await harness({ chatType: 'group', config: { allowGroup: true } })
  await call('imcron_remind', { text: '开会', every: { unit: 'day', count: 1, at: '09:00' } })
  assert.deepEqual(dshIm.calls.createTarget[0].target.route, { groupOpenId: 'GROUP-1' })
  assert.equal(dshIm.calls.createTarget[0].target.kind, 'group')
})

test('tools: groups cannot create tasks by default', async () => {
  const { call } = await harness({ chatType: 'group' })
  await assert.rejects(
    () => call('imcron_remind', { text: '开会', every: { unit: 'day', count: 1, at: '09:00' } }),
    (error) => error.code === 'group-disabled',
  )
})

test('tools: the live group switch overrides the startup config', async () => {
  const { call, imCron } = await harness({ chatType: 'group', config: { allowGroup: false } })
  imCron.isGroupAllowed = () => true
  const result = await call('imcron_remind', { text: '开会', every: { unit: 'day', count: 1, at: '09:00' } })
  assert.equal(result.ok, true)
})

test('tools: ask stores the prompt, the timeout and the notify policy', async () => {
  const { call, scheduler } = await harness()
  const result = await call('imcron_ask', {
    prompt: '汇总新闻',
    cron: '0 9 * * *',
    notify: 'never',
    timeoutSeconds: 120,
  })
  const job = scheduler.getJob(result.id)
  assert.equal(job.payload.kind, 'agent')
  assert.equal(job.payload.prompt, '汇总新闻')
  assert.equal(job.payload.timeoutSeconds, 120)
  assert.equal(job.deliver, 'never')
})

test('tools: ask is rejected when no agent runtime is available', async () => {
  const { call } = await harness({ agentAvailable: false })
  await assert.rejects(() => call('imcron_ask', { prompt: 'x', cron: '0 9 * * *' }), (error) => error.code === 'agent-unavailable')
})

test('tools: run freezes the resolved script path and refuses anything outside the workspace', async () => {
  const { call, scheduler, dir } = await harness()
  await assert.rejects(
    () => call('imcron_run', { script: 'nope.sh', cron: '0 9 * * *' }),
    (error) => error.code === 'script-not-found',
  )
  // Escape attempts are refused, not silently clamped into the workspace.
  await assert.rejects(
    () => call('imcron_run', { script: '../outside.sh', cron: '0 9 * * *' }),
    (error) => error.code === 'script-not-found' || error.code === 'script-outside-dir',
  )
  await assert.rejects(
    () => call('imcron_run', { script: '/bin/sh', cron: '0 9 * * *' }),
    (error) => error.code === 'script-outside-dir',
  )
  const ok = await call('imcron_run', { script: 'echo.sh', cron: '0 2 * * *', notify: 'always' })
  const job = scheduler.getJob(ok.id)
  assert.equal(job.deliver, 'always')
  // The stored path is absolute, so a later run cannot depend on the caller's cwd.
  assert.equal(job.payload.script, join(await realpath(dir), 'workspace', 'echo.sh'))
  const defaulted = await call('imcron_run', { script: 'echo.sh', cron: '0 3 * * *' })
  assert.equal(scheduler.getJob(defaulted.id).deliver, 'on-failure')
})

test('tools: run refuses a non-executable script', async () => {
  const { call, dir } = await harness()
  await writeFile(join(dir, 'workspace', 'plain.sh'), '#!/bin/sh\necho hi\n')
  await chmod(join(dir, 'workspace', 'plain.sh'), 0o644)
  await assert.rejects(
    () => call('imcron_run', { script: 'plain.sh', cron: '0 9 * * *' }),
    (error) => error.code === 'script-not-executable',
  )
})

test('tools: a group chat refuses the command payload entirely', async () => {
  const { call } = await harness({ chatType: 'group', config: { allowGroup: true } })
  await assert.rejects(
    () => call('imcron_run', { script: 'echo.sh', cron: '0 9 * * *' }),
    (error) => error.code === 'command-not-allowed-in-group',
  )
})

test('tools: remind validates text length and empty payloads', async () => {
  const { call } = await harness({ config: { maxNotifyChars: 5 } })
  await assert.rejects(() => call('imcron_remind', { text: '   ', cron: '0 9 * * *' }), (error) => error.code === 'empty-text')
  await assert.rejects(() => call('imcron_remind', { text: '123456', cron: '0 9 * * *' }), (error) => error.code === 'text-too-long')
})

test('tools: schedules are validated before anything is written', async () => {
  const { call, scheduler } = await harness()
  await assert.rejects(
    () => call('imcron_remind', { text: 'x', at: '2020-01-01T00:00:00+08:00' }),
    (error) => error.code === 'time-in-past',
  )
  await assert.rejects(
    () => call('imcron_remind', { text: 'x', cron: '0 9 * * *', at: '2026-11-21T09:00:00+08:00' }),
    (error) => error.code === 'bad-schedule',
  )
  assert.equal(scheduler.listJobs().length, 0)
})

test('tools: the per-chat job limit is enforced', async () => {
  const { call } = await harness({ config: { maxJobsPerTarget: 1 } })
  await call('imcron_remind', { text: 'a', cron: '0 9 * * *' })
  await assert.rejects(() => call('imcron_remind', { text: 'b', cron: '0 10 * * *' }), (error) => error.code === 'too-many-jobs')
})

test('tools: the global job limit is enforced across chats', async () => {
  const { call } = await harness({ config: { maxJobs: 2, maxJobsPerTarget: 10 } })
  await call('imcron_remind', { text: 'a', cron: '0 9 * * *' })
  await call('imcron_remind', { text: 'b', cron: '0 10 * * *' })
  await assert.rejects(() => call('imcron_remind', { text: 'c', cron: '0 11 * * *' }), (error) => error.code === 'too-many-jobs')
})

test('tools: list only shows this chat and never exposes session ids', async () => {
  const { call, scheduler } = await harness()
  const mine = await call('imcron_remind', { text: 'mine', cron: '0 9 * * *' })
  await scheduler.upsertJob({
    id: 'imc-other',
    name: '别人的任务',
    target: { botId: 'bot-1', targetId: 'cron-other', channel: 'qq' },
    schedule: { kind: 'cron', expression: '0 8 * * *', timezone: 'Asia/Shanghai' },
    payload: { kind: 'notify', text: 'secret' },
    deliver: 'always',
    enabled: true,
    createdAt: NOW.toISOString(),
  })

  const result = await call('imcron_list')
  assert.equal(result.jobs.length, 1)
  assert.equal(result.jobs[0].id, mine.id)
  assert.equal('sessionId' in result.jobs[0], false)
  assert.match(result.jobs[0].nextRunAt, /Z$/u)
})

test('tools: update moves a schedule and refuses payload-type changes', async () => {
  const { call, scheduler } = await harness()
  const created = await call('imcron_remind', { text: '写日报', cron: '0 9 * * *' })
  const updated = await call('imcron_update', { id: created.id, cron: '0 10 * * *' })
  assert.equal(updated.id, created.id)
  const job = scheduler.getJob(created.id)
  assert.equal(job.schedule.expression, '0 10 * * *')
  assert.equal(job.lastFiredFor !== undefined, true)
  assert.equal(job.payload.text, '写日报')

  const runJob = await call('imcron_run', { script: 'echo.sh', cron: '0 2 * * *' })
  await assert.rejects(
    () => call('imcron_update', { id: runJob.id, text: 'not a reminder' }),
    (error) => error.code === 'payload-mismatch',
  )
})

test('tools: a schedule update re-arms a needs-rebind job and the list explains it', async () => {
  const { call, definitions, scheduler } = await harness()
  const created = await call('imcron_remind', { text: '日报', cron: '0 9 * * *' })
  await scheduler.upsertJob({ ...scheduler.getJob(created.id), state: 'needs-rebind' })

  const listed = await call('imcron_list')
  const text = definitions.get('imcron_list').output.render({}, listed)[0].text
  assert.match(text, /投递目标失效.*imcron_resume/u)

  await call('imcron_update', { id: created.id, cron: '0 10 * * *' })
  const job = scheduler.getJob(created.id)
  assert.equal(job.state, undefined)
  assert.equal(job.schedule.expression, '0 10 * * *')
})

test('tools: a text-only update leaves needs-rebind alone', async () => {
  const { call, scheduler } = await harness()
  const created = await call('imcron_remind', { text: '旧文案', cron: '0 9 * * *' })
  await scheduler.upsertJob({ ...scheduler.getJob(created.id), state: 'needs-rebind' })

  await call('imcron_update', { id: created.id, text: '新文案' })
  assert.equal(scheduler.getJob(created.id).state, 'needs-rebind')
  assert.equal(scheduler.getJob(created.id).payload.text, '新文案')
})

test('tools: a job whose target was deleted stays listable and can be resumed', async () => {
  const { call, scheduler, dshIm } = await harness()
  const created = await call('imcron_remind', { text: '日报', cron: '0 9 * * *' })
  await scheduler.upsertJob({ ...scheduler.getJob(created.id), state: 'needs-rebind' })

  // The target was deleted from dsh-im (unknown-target): the job must not vanish.
  dshIm.targets.length = 0
  const listed = await call('imcron_list')
  assert.equal(listed.jobs.length, 1)
  assert.equal(listed.jobs[0].id, created.id)

  const createsBefore = dshIm.calls.createTarget.length
  await call('imcron_resume', { id: created.id })
  assert.equal(scheduler.getJob(created.id).state, undefined)
  assert.equal(dshIm.calls.createTarget.length, createsBefore + 1, 'resume recreates the canonical target')
  assert.equal(dshIm.calls.createTarget.at(-1).target.route.userOpenId, 'OPENID-1')
  assert.equal(dshIm.targets.length, 1)
})

test('tools: timeoutSeconds is range-checked on creation', async () => {
  const { call, scheduler } = await harness()
  for (const timeoutSeconds of [0, -1, 86_401, 1.5]) {
    await assert.rejects(
      () => call('imcron_run', { script: 'echo.sh', cron: '0 9 * * *', timeoutSeconds }),
      (error) => error.code === 'bad-timeout',
    )
    await assert.rejects(
      () => call('imcron_ask', { prompt: 'x', cron: '0 9 * * *', timeoutSeconds }),
      (error) => error.code === 'bad-timeout',
    )
  }
  const accepted = await call('imcron_run', { script: 'echo.sh', cron: '0 9 * * *', timeoutSeconds: 30 })
  assert.equal(accepted.ok, true)
  assert.equal(scheduler.getJob(accepted.id).payload.timeoutSeconds, 30)
})

test('tools: a schedule update revives an ended job', async () => {
  const { call, scheduler } = await harness()
  const created = await call('imcron_remind', { text: '一次', at: new Date(Date.now() + 3_600_000).toISOString() })
  await scheduler.upsertJob({ ...scheduler.getJob(created.id), endedAt: new Date().toISOString() })
  await call('imcron_update', { id: created.id, cron: '0 10 * * *' })
  assert.equal(scheduler.getJob(created.id).endedAt, undefined)
})

test('tools: another chat job id is indistinguishable from missing', async () => {
  const { call, scheduler } = await harness()
  // Give this chat its own target so the comparison is about ownership, not about
  // a chat that never had a job.
  await call('imcron_remind', { text: 'mine', cron: '0 7 * * *' })
  await scheduler.upsertJob({
    id: 'imc-other',
    name: '别人的',
    target: { botId: 'bot-1', targetId: 'cron-other', channel: 'qq' },
    schedule: { kind: 'cron', expression: '0 8 * * *', timezone: 'Asia/Shanghai' },
    payload: { kind: 'notify', text: 'x' },
    deliver: 'always',
    enabled: true,
    createdAt: NOW.toISOString(),
  })
  for (const tool of ['imcron_update', 'imcron_remove', 'imcron_pause', 'imcron_resume', 'imcron_trigger']) {
    await assert.rejects(
      () => call(tool, { id: 'imc-other' }),
      (error) => error.code === 'job-not-found',
      `${tool} must not touch another chat's job`,
    )
  }
  await assert.rejects(() => call('imcron_remove', { id: 'imc-nope' }), (error) => error.code === 'job-not-found')
})

test('tools: pause and resume toggle the flag without touching the schedule', async () => {
  const { call, scheduler } = await harness()
  const created = await call('imcron_remind', { text: 'x', cron: '0 9 * * *' })
  await call('imcron_pause', { id: created.id })
  assert.equal(scheduler.getJob(created.id).enabled, false)
  await call('imcron_resume', { id: created.id })
  assert.equal(scheduler.getJob(created.id).enabled, true)
  assert.equal(scheduler.getJob(created.id).schedule.expression, '0 9 * * *')
})

test('tools: remove deletes the job but keeps the delivery target', async () => {
  const { call, scheduler, dshIm } = await harness()
  const created = await call('imcron_remind', { text: 'x', cron: '0 9 * * *' })
  const removed = await call('imcron_remove', { id: created.id })
  assert.deepEqual(removed, { ok: true, id: created.id })
  assert.equal(scheduler.getJob(created.id), undefined)
  assert.equal(dshIm.targets.length, 1)
})

test('tools: trigger runs once and keeps the water mark', async () => {
  const { call, scheduler, store } = await harness()
  const created = await call('imcron_remind', { text: 'ping', cron: '0 9 * * *' })
  const outcome = await call('imcron_trigger', { id: created.id })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.status, 'ok')
  assert.equal(scheduler.getJob(created.id).lastFiredFor, undefined)
  const runs = await store.readRuns({ limit: 5 })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].trigger, 'manual')
})

test('tools: a non-IM session cannot create or list jobs', async () => {
  const { call, imCron } = await harness()
  // Replace the channel with one that cannot resolve a conversation.
  imCron.channel = {
    async describeTarget() { return null },
    async resolveTarget() {
      const error = new Error('当前会话不在任何 IM 渠道上')
      error.code = 'not-an-im-session'
      throw error
    },
  }
  await assert.rejects(() => call('imcron_remind', { text: 'x', cron: '0 9 * * *' }), (error) => error.code === 'not-an-im-session')
  const listed = await call('imcron_list')
  assert.deepEqual(listed, { ok: true, jobs: [] })
  await assert.rejects(() => call('imcron_ask', { prompt: 'x', cron: '0 9 * * *' }), (error) => error.code === 'not-an-im-session')
})

test('tools: the routing hint is registered right after the schedule section', async () => {
  const { sections } = await harness()
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:imcron')
  assert.equal(sections[0].order, 2510)
  assert.equal(typeof sections[0].text, 'function')
})

test('tools: the routing hint only applies to IM chat sessions', async () => {
  const { sections } = await harness()
  const textOf = (sessionId) => sections[0].text({ agent: { session: { id: sessionId } } })
  // A bound chat session gets the guidance.
  const hint = textOf('session-1')
  assert.match(hint, /imcron_remind/u)
  assert.match(hint, /schedule_\*/u)
  assert.match(hint, /deliverModelAnswers/u)
  assert.match(hint, /sleep/u)
  // No agent, or a session dsh-im does not know, contributes nothing.
  assert.equal(sections[0].text({}), '')
  assert.equal(sections[0].text({ agent: { session: { id: '' } } }), '')
})

test('tools: an unbound session gets no routing hint even when the async lookup agrees', async () => {
  const { sections, dshIm } = await harness()
  dshIm.service.describeConversationSync = () => null
  dshIm.service.describeConversation = async () => null
  assert.equal(sections[0].text({ agent: { session: { id: 'session-unbound' } } }), '')
  // The background lookup must not label an unbound session on a later assembly.
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(sections[0].text({ agent: { session: { id: 'session-unbound' } } }), '')
})

test('tools: a missing systemPrompt service is tolerated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-tools-'))
  const { config } = parseConfig({ stateDir: dir })
  const store = new Store(dir)
  const dshIm = fakeDshIm()
  const channel = createDshImChannel(dshIm.service)
  const scheduler = createScheduler({
    store, config, runner: { run: async () => ({ record: {}, patch: {} }) }, logger: null, pollMs: 1_000,
  })
  await scheduler.ensureLoaded()
  const definitions = new Map()
  const warnings = []
  const ctx = {
    get: (name) => (name === 'imCron' ? { scheduler, store, config, channel, agent: null, available: true } : undefined),
    tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {} } },
    logger: () => ({ warn: (m) => warnings.push(String(m)), info() {}, error() {} }),
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(definitions.size, 9)
  assert.match(warnings.join('\n'), /systemPrompt/u)
})

test('tools: list distinguishes a finished one-shot from a paused job', async () => {
  const { call, definitions, scheduler } = await harness()
  await call('imcron_remind', { text: '已结束的', cron: '0 9 * * *' })
  const paused = await call('imcron_remind', { text: '暂停的', cron: '0 10 * * *' })
  await call('imcron_pause', { id: paused.id })

  // No cron job ends on its own, so mark one finished the way a one-shot would be.
  const finished = (await call('imcron_list')).jobs.find((job) => job.name === '已结束的')
  await scheduler.upsertJob({ ...scheduler.getJob(finished.id), endedAt: new Date().toISOString() })

  const after = await call('imcron_list')
  const byName = new Map(after.jobs.map((job) => [job.name, job]))
  assert.equal(byName.get('暂停的').enabled, false)
  assert.equal(byName.get('暂停的').ended, false)
  assert.equal(byName.get('已结束的').ended, true)
  assert.equal(byName.get('已结束的').enabled, false)

  const text = definitions.get('imcron_list').output.render({}, after)[0].text
  assert.match(text, /暂停的.*· 暂停/u)
  assert.match(text, /已结束的.*· 已结束/u)
  assert.doesNotMatch(text, /已结束的.*· 暂停/u)
})

test('tools: list renders each job mode so the answer can name it', async () => {
  const { call, definitions } = await harness()
  await call('imcron_remind', { text: '喝水', cron: '0 9 * * *' })
  await call('imcron_ask', { prompt: '汇总新闻', cron: '0 10 * * *' })
  await call('imcron_run', { script: 'echo.sh', cron: '0 11 * * *' })

  const listed = await call('imcron_list')
  const modes = new Map(listed.jobs.map((job) => [job.name, job.payload]))
  assert.equal(modes.get('喝水'), 'notify')
  assert.equal(modes.get('汇总新闻'), 'agent')
  assert.equal(modes.get('脚本 echo.sh'), 'command')

  const text = definitions.get('imcron_list').output.render({}, listed)[0].text
  assert.match(text, /喝水.*· 提醒 ·/u)
  assert.match(text, /汇总新闻.*· 模型 ·/u)
  assert.match(text, /脚本 echo\.sh.*· 命令 ·/u)
})

test('tools: maxRuns is stored, shown in the list, and rejected outside 1-10000', async () => {
  const { call, definitions, scheduler } = await harness()
  const created = await call('imcron_remind', { text: '跑三次', cron: '0 9 * * *', maxRuns: 3 })
  const job = scheduler.getJob(created.id)
  assert.equal(job.maxRuns, 3)
  assert.equal(job.runsDone, 0)

  const listed = await call('imcron_list')
  const entry = listed.jobs.find((candidate) => candidate.id === created.id)
  assert.equal(entry.maxRuns, 3)
  assert.equal(entry.runsDone, 0)
  const text = definitions.get('imcron_list').output.render({}, listed)[0].text
  assert.match(text, /已跑 0\/3/u)

  await assert.rejects(() => call('imcron_remind', { text: 'x', cron: '0 9 * * *', maxRuns: 0 }), (error) => error.code === 'bad-max-runs')
  await assert.rejects(() => call('imcron_remind', { text: 'x', cron: '0 9 * * *', maxRuns: 10_001 }), (error) => error.code === 'bad-max-runs')
})

test('tools: updating maxRuns restarts the count', async () => {
  const { call, scheduler } = await harness()
  const created = await call('imcron_remind', { text: '跑三次', cron: '0 9 * * *', maxRuns: 3 })
  const job = scheduler.getJob(created.id)
  await scheduler.upsertJob({ ...job, runsDone: 2 })
  await call('imcron_update', { id: created.id, maxRuns: 5 })
  const after = scheduler.getJob(created.id)
  assert.equal(after.maxRuns, 5)
  assert.equal(after.runsDone, 0)
})

test('tools: every accepts a minute interval', async () => {
  const { call, scheduler } = await harness()
  const created = await call('imcron_remind', { text: '每90分钟', every: { unit: 'minute', count: 90 } })
  const job = scheduler.getJob(created.id)
  assert.equal(job.schedule.unit, 'minute')
  assert.equal(job.schedule.count, 90)
})

test('tools: schedule descriptions tell the three inputs apart', async () => {
  const { definitions } = await harness()
  const params = definitions.get('imcron_remind').parameters.properties

  // `at` is an instant and says so; it no longer reads like the every-time field.
  const atText = params.at.oneOf[0].description
  assert.match(atText, /RFC3339/u)
  assert.match(atText, /strictly in the future/u)
  assert.match(atText, /Use `cron` for anything recurring/u)

  // cron forbids the UTC conversion models like to apply, and warns about */N.
  assert.match(params.cron.description, /never convert it to UTC/u)
  assert.match(params.cron.description, /weekdays/u)
  assert.match(params.cron.description, /not every 15 days/u)
  assert.match(params.cron.description, /"0 9 \* \* 1-5"/u)

  // The every-time field is a wall clock, not an instant, and states the anchor rule.
  const everyAt = params.every.properties.at.description
  assert.match(everyAt, /HH:mm/u)
  assert.match(everyAt, /not an instant/u)
  assert.match(everyAt, /NEXT occurrence/u)
  assert.match(everyAt, /minute\/hour/u)

  assert.match(params.every.description, /[Ii]nterval cadence/u)
  assert.match(params.timezone.description, /Asia\/Shanghai/u)
})

test('tools: update says omitted arguments are preserved', async () => {
  const { definitions } = await harness()
  const description = definitions.get('imcron_update').description
  assert.match(description, /omitted one keeps its current value/u)
  assert.match(description, /re-anchors/u)
})

test('tools: schedule descriptions tell the three inputs apart', async () => {
  const { definitions } = await harness()
  const params = definitions.get('imcron_remind').parameters.properties

  // `at` is an instant and says so; it no longer reads like the every-time field.
  const atText = params.at.oneOf[0].description
  assert.match(atText, /RFC3339/u)
  assert.match(atText, /strictly in the future/u)
  assert.match(atText, /Use `cron` for anything recurring/u)

  // cron forbids the UTC conversion models like to apply, and warns about */N.
  assert.match(params.cron.description, /never convert it to UTC/u)
  assert.match(params.cron.description, /weekdays/u)
  assert.match(params.cron.description, /not every 15 days/u)
  assert.match(params.cron.description, /"0 9 \* \* 1-5"/u)

  // The every-time field is a wall clock, not an instant, and states the anchor rule.
  const everyAt = params.every.properties.at.description
  assert.match(everyAt, /HH:mm/u)
  assert.match(everyAt, /not an instant/u)
  assert.match(everyAt, /NEXT occurrence/u)
  assert.match(everyAt, /minute\/hour/u)

  assert.match(params.every.description, /[Ii]nterval cadence/u)
  assert.match(params.timezone.description, /Asia\/Shanghai/u)
})

test('tools: update says omitted arguments are preserved', async () => {
  const { definitions } = await harness()
  const description = definitions.get('imcron_update').description
  assert.match(description, /omitted one keeps its current value/u)
  assert.match(description, /re-anchors/u)
})

test('tools: the run schema names the real script directory before the first call', async () => {
  const { definitions, config } = await harness()
  const description = definitions.get('imcron_run').parameters.properties.script.description
  // The description shows the configured directory verbatim, not a realpath.
  const escaped = config.scriptDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  assert.match(description, new RegExp(escaped, 'u'))
  assert.match(description, /existing executable file with a shebang/u)
})

test('tools: without the service the run schema still describes the script requirement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-tools-'))
  const { config } = parseConfig({ stateDir: dir })
  const definitions = new Map()
  const ctx = {
    // The tool table is built before `imCron` exists; the description must survive it.
    get: () => undefined,
    tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {} } },
    logger: () => ({ warn() {}, info() {}, error() {} }),
  }
  apply(ctx)
  const description = definitions.get('imcron_run').parameters.properties.script.description
  assert.match(description, /plugin workspace directory/u)
  assert.doesNotMatch(description, /undefined/u)
  // No path was knowable, so the example falls back to a bare name.
  assert.match(description, /"stock-report\.sh"/u)
  assert.doesNotMatch(description, /null/u)
})
