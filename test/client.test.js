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
