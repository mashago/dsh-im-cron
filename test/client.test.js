import assert from 'node:assert/strict'
import { test } from 'node:test'

// The client half is a browser module: it registers a factory on the module
// loader. Load the shipped file against a fake loader so the tests exercise
// the code that actually reaches the Plugins page.
const registrations = []
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
await import('../client.js')

const registration = registrations.at(-1)
const React = { createElement: () => null }
const exports = registration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected client require: ${spec}`)
})
const { internals } = exports

const catalogFixture = {
  groups: [
    {
      id: 'qwen-token-plan-cn',
      name: 'Qwen',
      models: [
        {
          id: 'deepseek-v4.1-flash-1017',
          name: 'DeepSeek V4.1 Flash',
          description: 'fast',
          reasoning: {
            efforts: [
              { id: 'high', name: 'High', description: 'more thinking' },
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'Duplicate' },
            ],
            defaultEffort: 'high',
          },
        },
      ],
    },
    { id: 'empty-provider', name: 'Empty', models: [] },
    {
      id: 'deepseek-account',
      name: 'DeepSeek Account',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    },
    { id: 'qwen-token-plan-cn', name: 'Duplicate provider', models: [{ id: 'deepseek-chat', name: 'x' }] },
  ],
  failures: [{ id: 'broken-provider', name: 'Broken', message: 'timeout' }],
}

test('client: the module registers one loader factory and declares its services', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registration.id, 'dsh-im-cron')
  // remote.session is a service face: reading it without declaring it trips
  // Cordis's "cannot get property ... without inject" guard.
  assert.deepEqual(exports.inject, ['slots', 'remote', 'remote.session'])
  assert.equal(typeof exports.apply, 'function')
})

test('client: FIELDS still drives values and saving for all six settings', () => {
  assert.deepEqual(internals.FIELDS.map(([field]) => field),
    ['cwd', 'agentPreset', 'provider', 'model', 'reasoningEffort', 'permissionPreset'])
})

test('client: the catalog is normalized for the picker', () => {
  const catalog = internals.normalizeCatalog(catalogFixture)
  assert.deepEqual(catalog.groups.map((group) => group.id), ['qwen-token-plan-cn', 'deepseek-account'])
  assert.equal(catalog.groups[0].models.length, 1)
  assert.deepEqual(catalog.groups[0].models[0].reasoning.efforts.map((level) => level.id), ['high', 'low'])
  assert.equal(catalog.groups[0].models[0].reasoning.defaultEffort, 'high')
  assert.equal(catalog.groups[1].models[0].reasoning, undefined)
  assert.deepEqual(catalog.failures, [{ id: 'broken-provider', name: 'Broken', message: 'timeout' }])
})

test('client: the catalog accepts the remote {ok,value} envelope', () => {
  const catalog = internals.normalizeCatalog({ ok: true, value: catalogFixture })
  assert.equal(catalog.groups.length, 2)
  const raw = internals.normalizeCatalog({ groups: [{ id: 'p', name: 'P', models: [{ id: 'm' }] }] })
  assert.equal(raw.groups[0].models[0].id, 'm')
})

test('client: an unusable effort default is dropped and junk ids are ignored', () => {
  const catalog = internals.normalizeCatalog({
    groups: [{
      id: 'p',
      models: [{ id: 'm', reasoning: { efforts: [{ id: '' }, { id: 'x' }], defaultEffort: 'y' } }],
    }],
  })
  assert.deepEqual(catalog.groups[0].models[0].reasoning.efforts, [{ id: 'x', name: 'x' }])
  assert.equal(catalog.groups[0].models[0].reasoning.defaultEffort, undefined)
  assert.deepEqual(internals.normalizeCatalog(null), { groups: [], failures: [] })
})

test('client: model and effort lookups match exact ids only', () => {
  const catalog = internals.normalizeCatalog(catalogFixture)
  const entry = internals.modelEntry(catalog, 'qwen-token-plan-cn', 'deepseek-v4.1-flash-1017')
  assert.equal(entry.name, 'DeepSeek V4.1 Flash')
  assert.equal(internals.modelEntry(catalog, 'qwen-token-plan-cn', 'missing'), undefined)
  assert.equal(internals.modelEntry(catalog, '', 'deepseek-chat'), undefined)
  assert.equal(internals.effortEntry(entry, 'low').name, 'Low')
  assert.equal(internals.effortEntry(entry, 'default'), undefined)
  assert.equal(internals.effortName(entry, 'high'), 'High')
  assert.equal(internals.effortName(entry, 'bogus'), 'bogus')
})

test('client: model options offer the deployment default, groups, and disabled failures', () => {
  const catalog = internals.normalizeCatalog(catalogFixture)
  const options = internals.modelOptions(catalog, { provider: '', model: '', reasoningEffort: 'high' })
  assert.equal(options[0].label, '跟随部署默认')
  assert.equal(options[0].selected, true)
  assert.deepEqual(options[1], { kind: 'heading', key: 'group:qwen-token-plan-cn', label: 'Qwen' })

  const partial = internals.modelOptions(catalog, {
    provider: 'qwen-token-plan-cn', model: '', reasoningEffort: 'high',
  })
  assert.equal(partial[0].selected, false, 'a half-filled provider/model pair is not "following the default"')
  const partialModel = internals.modelOptions(catalog, {
    provider: '', model: 'deepseek-chat', reasoningEffort: '',
  })
  assert.equal(partialModel[0].selected, false)

  const chosen = internals.modelOptions(catalog,
    { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'high' })
  const selected = chosen.find((option) => option.kind === 'option' && option.selected === true)
  assert.equal(selected.label, 'DeepSeek V4.1 Flash')
  assert.deepEqual(selected.patch,
    { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash-1017', reasoningEffort: '' })
  const failure = chosen.find((option) => option.key === 'failure:broken-provider')
  assert.equal(failure.disabled, true)
  assert.match(failure.label, /目录读取失败/u)
})

test('client: effort options follow the chosen model only', () => {
  const catalog = internals.normalizeCatalog(catalogFixture)
  const entry = internals.modelEntry(catalog, 'qwen-token-plan-cn', 'deepseek-v4.1-flash-1017')
  const options = internals.effortOptions(entry, 'low')
  assert.deepEqual(options.map((option) => option.key), ['effort:default', 'effort:high', 'effort:low'])
  assert.equal(options[0].selected, false)
  assert.match(options[0].description, /High/u)
  assert.deepEqual(options[0].patch, { reasoningEffort: '' })
  assert.deepEqual(options[1].patch, { reasoningEffort: 'high' })
  assert.equal(options[2].selected, true)
})

test('client: a model without reasoning yields only the follow-default effort row', () => {
  const catalog = internals.normalizeCatalog(catalogFixture)
  const entry = internals.modelEntry(catalog, 'deepseek-account', 'deepseek-chat')
  const options = internals.effortOptions(entry, '')
  assert.deepEqual(options.map((option) => option.key), ['effort:default'])
  assert.equal(options[0].selected, true)
  assert.equal(internals.effortOptions(undefined, '').length, 1)
})
/**
 * A client Context stand-in that enforces the same contract Cordis does:
 * reading `ctx.remote` or `ctx.remote.session` without declaring it in the
 * plugin's `inject` list throws instead of returning the service.
 */
function fakeCtx(inject, { response, onEvent } = {}) {
  const face = {
    modelCatalog: async () => response ?? { ok: true, value: catalogFixture },
  }
  const ctx = { inject }
  Object.defineProperty(ctx, 'remote', {
    enumerable: true,
    get() {
      if (!inject.includes('remote')) throw new Error('cannot get property "remote" without inject')
      const remote = {
        $on(event) {
          onEvent?.(event)
          return () => {}
        },
      }
      Object.defineProperty(remote, 'session', {
        enumerable: true,
        get() {
          if (!inject.includes('remote.session')) {
            throw new Error('cannot get property "remote.session" without inject')
          }
          return face
        },
      })
      return remote
    },
  })
  ctx.slots = { inject: (_name, factory) => factory(), register: () => undefined }
  ctx.effect = (factory) => {
    factory()
  }
  return ctx
}

test('client: the catalog is read through the declared remote services', async () => {
  await assert.rejects(() => internals.fetchCatalog(fakeCtx(['slots'])), /property "remote" without inject/u)
  await assert.rejects(() => internals.fetchCatalog(fakeCtx(['slots', 'remote'])), /remote\.session" without inject/u)
  const catalog = await internals.fetchCatalog(fakeCtx(exports.inject))
  assert.equal(catalog.groups.length, 2)
})

test('client: apply follows the Host events that can change the catalog', () => {
  const events = []
  const ctx = fakeCtx(exports.inject, { onEvent: (event) => events.push(event) })
  exports.apply(ctx)
  for (const event of [
    'llm/adapters-updated',
    'llm/models-updated',
    'settings/document-updated',
    'credentials/record-updated',
    'credentials/reference-updated',
  ]) {
    assert.ok(events.includes(event), `missing catalog subscription: ${event}`)
  }
})

test('client: catalog RPC failures and empty catalogs surface as errors', async () => {
  const failing = fakeCtx(exports.inject, {
    response: { ok: false, error: { code: 'gateway/internal', message: 'boom' } },
  })
  await assert.rejects(() => internals.fetchCatalog(failing), /gateway\/internal: boom/u)

  const empty = fakeCtx(exports.inject, { response: { ok: true, value: { groups: [], failures: [] } } })
  await assert.rejects(() => internals.fetchCatalog(empty), /模型目录为空/u)

  const raw = fakeCtx(exports.inject, {
    response: { groups: [{ id: 'p', models: [{ id: 'm' }] }] },
  })
  assert.equal((await internals.fetchCatalog(raw)).groups.length, 1)
})

test('client: the hovered menu row is highlighted; selected and disabled rows keep their own look', () => {
  const plain = internals.optionStyle({ key: 'model:a', selected: false }, null)
  assert.equal(plain.background, 'transparent')

  const hovered = internals.optionStyle({ key: 'model:a', selected: false }, 'model:a')
  assert.match(hovered.background, /interactive-bg-hover/u)

  const selected = internals.optionStyle({ key: 'model:a', selected: true }, 'model:a')
  assert.match(selected.background, /9%/u)
  assert.doesNotMatch(selected.background, /hover/u)

  const disabled = internals.optionStyle({ key: 'model:a', selected: false, disabled: true }, 'model:a')
  assert.equal(disabled.background, 'transparent')
  assert.equal(disabled.opacity, 0.5)
})

const permissionFixture = {
  options: [
    {
      value: 'workspace-write-strict',
      name: '工作区可写（不审批）',
      description: '无人值守任务推荐',
    },
    { value: 'workspace-write', name: '工作区可写（需审批）', description: '无人值守会挂到超时' },
    { value: 'danger-full-access', name: '全开（不审批）' },
    { value: '', name: 'ignored' },
    { value: 'workspace-write-strict', name: 'duplicate' },
  ],
  defaultOptions: [],
  defaultPreset: 'workspace-write',
}

test('client: the permission catalog is normalized for the picker', () => {
  const catalog = internals.normalizePermissionCatalog(permissionFixture)
  assert.deepEqual(catalog.options.map((option) => option.value),
    ['workspace-write-strict', 'workspace-write', 'danger-full-access'])
  assert.equal(catalog.options[0].name, '工作区可写（不审批）')
  assert.equal(catalog.options[0].description, '无人值守任务推荐')
  assert.equal(catalog.options[2].description, undefined)
  assert.equal(catalog.defaultPreset, 'workspace-write')

  const unwrapped = internals.normalizePermissionCatalog({ ok: true, value: permissionFixture })
  assert.equal(unwrapped.options.length, 3)
  const noDefault = internals.normalizePermissionCatalog({ ...permissionFixture, defaultPreset: 'gone' })
  assert.equal(noDefault.defaultPreset, '')
  assert.deepEqual(internals.normalizePermissionCatalog(null), { options: [], defaultPreset: '' })
})

test('client: permission options follow the deployment catalog and fall back when it is missing', () => {
  const catalog = internals.normalizePermissionCatalog(permissionFixture)
  const options = internals.permissionOptions(catalog, '')
  assert.equal(options[0].label, '跟随部署默认')
  assert.equal(options[0].selected, true)
  assert.match(options[0].description, /工作区可写（需审批）/u)
  assert.deepEqual(options[1].patch, { permissionPreset: 'workspace-write-strict' })
  assert.equal(options[1].description, '无人值守任务推荐')

  const chosen = internals.permissionOptions(catalog, 'danger-full-access')
  const selected = chosen.filter((option) => option.selected === true)
  assert.deepEqual(selected.map((option) => option.key), ['permission:danger-full-access'])

  const fallback = internals.permissionOptions(null, '')
  assert.deepEqual(fallback.map((option) => option.label).slice(1),
    ['workspace-write（沙箱内，需审批）', 'danger-full-access（无沙箱，不审批）'])
  assert.match(fallback[0].description, /部署的默认权限档/u)
})

test('client: a stored preset outside the catalog is labelled raw and flagged', () => {
  const catalog = internals.normalizePermissionCatalog(permissionFixture)
  assert.equal(internals.permissionLabel(catalog, ''), '跟随部署默认')
  assert.equal(internals.permissionLabel(catalog, 'workspace-write-strict'), '工作区可写（不审批）')
  assert.equal(internals.permissionLabel(catalog, 'gone-preset'), 'gone-preset')
  assert.equal(internals.permissionUnknown(catalog, ''), false)
  assert.equal(internals.permissionUnknown(catalog, 'workspace-write'), false)
  assert.equal(internals.permissionUnknown(catalog, 'gone-preset'), true)
  assert.equal(internals.permissionUnknown(null, 'gone-preset'), false)
  assert.equal(internals.permissionUnknown({ options: [], defaultPreset: '' }, 'gone-preset'), false)
  assert.equal(internals.permissionOptions(catalog, 'gone-preset')
    .some((option) => option.selected === true), false)
})

test('client: job status and the actions each status offers', () => {
  assert.equal(internals.jobStatusOf({ enabled: true }), 'active')
  assert.equal(internals.jobStatusOf({ enabled: false }), 'paused')
  assert.equal(internals.jobStatusOf({ enabled: true, ended: true }), 'ended')
  assert.equal(internals.jobStatusOf({ enabled: true, state: 'needs-rebind' }), 'failed')
  assert.equal(internals.jobStatusOf({ enabled: true, state: 'invalid' }), 'failed')

  assert.deepEqual(internals.jobActions('active'), ['pause', 'delete'])
  assert.deepEqual(internals.jobActions('paused'), ['resume', 'delete'])
  assert.deepEqual(internals.jobActions('ended'), ['delete'])
  assert.deepEqual(internals.jobActions('failed'), ['delete'])
  assert.deepEqual(internals.jobActions('unknown'), ['delete'])
})

test('client: jobs group by target then status, newest created first', () => {
  const job = (id, createdAt, extra = {}) => ({
    id,
    createdAt,
    target: { channel: 'qq', targetId: 't1', label: 'A群' },
    enabled: true,
    ...extra,
  })
  const groups = internals.groupJobs([
    job('a1', '2026-11-27T10:00:00.000Z'),
    job('a2', '2026-11-27T11:00:00.000Z', { enabled: false }),
    job('a3', '2026-11-27T09:00:00.000Z'),
    job('a4', '2026-11-27T12:00:00.000Z', { ended: true }),
    job('a5', '2026-11-27T13:00:00.000Z', { state: 'needs-rebind' }),
    {
      id: 'b1',
      createdAt: '2026-11-27T08:00:00.000Z',
      target: { channel: 'weixin', targetId: 't2', label: 'B私聊' },
      enabled: true,
    },
  ])

  assert.deepEqual(groups.map((group) => group.label), ['A群', 'B私聊'])
  assert.equal(groups[0].total, 5)
  assert.deepEqual(groups[0].statuses.map((bucket) => bucket.status), ['active', 'paused', 'ended', 'failed'])
  assert.deepEqual(groups[0].statuses[0].jobs.map((entry) => entry.id), ['a1', 'a3'])
  assert.deepEqual(groups[0].statuses[1].jobs.map((entry) => entry.id), ['a2'])
  assert.deepEqual(groups[0].statuses[2].jobs.map((entry) => entry.id), ['a4'])
  assert.deepEqual(groups[0].statuses[3].jobs.map((entry) => entry.id), ['a5'])
  assert.deepEqual(groups[1].statuses.map((bucket) => bucket.status), ['active'])

  assert.deepEqual(internals.groupJobs([]), [])
  assert.deepEqual(internals.groupJobs(undefined), [])
  assert.deepEqual(internals.groupJobs([{ id: 'lonely' }]).map((group) => group.key), [':'])
})

test('client: row details format relative time, duration, and active hours', () => {
  const now = Date.parse('2026-11-27T10:00:00.000Z')
  assert.equal(internals.formatRelative('2026-11-27T10:00:30.000Z', now), '')
  assert.equal(internals.formatRelative('2026-11-27T10:05:00.000Z', now), '5 分钟后')
  assert.equal(internals.formatRelative('2026-11-27T09:00:00.000Z', now), '1 小时前')
  assert.equal(internals.formatRelative('2026-11-29T10:00:00.000Z', now), '2 天后')
  assert.equal(internals.formatRelative(undefined, now), '')

  assert.equal(internals.formatDuration(0), '')
  assert.equal(internals.formatDuration(820), '820 ms')
  assert.equal(internals.formatDuration(1837), '1.8 s')
  assert.equal(internals.formatDuration(65000), '1 分钟')
  assert.equal(internals.formatDuration(undefined), '')

  assert.equal(internals.describeActiveHours({ start: 8, end: 22, timezone: 'Asia/Shanghai' }),
    '仅在 8–22 点（Asia/Shanghai）')
  assert.equal(internals.describeActiveHours({ start: 8, end: 22 }), '仅在 8–22 点')
  assert.equal(internals.describeActiveHours(null), '')
  assert.equal(internals.describeActiveHours({ start: 'x', end: 2 }), '')
})
