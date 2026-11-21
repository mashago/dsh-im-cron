import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  Config,
  FIELDS,
  PERMISSION_PRESETS,
  apply,
  getAgentSettings,
  normalizeAgentSettings,
  setAgentSettings,
  subscribeAgentSettings,
} from '../agent-settings.js'

test('agent settings: normalization trims values and treats blanks as unset', () => {
  assert.deepEqual(normalizeAgentSettings({}), {
    cwd: undefined, agentPreset: undefined, provider: undefined, model: undefined, reasoningEffort: undefined,
    permissionPreset: undefined,
  })
  assert.deepEqual(normalizeAgentSettings({ cwd: '  /tmp/x  ', provider: '', model: null }), {
    cwd: '/tmp/x', agentPreset: undefined, provider: undefined, model: undefined, reasoningEffort: undefined,
    permissionPreset: undefined,
  })
  assert.equal(Object.isFrozen(normalizeAgentSettings({})), true)
})

test('agent settings: apply exposes the config and subscribers see changes', () => {
  setAgentSettings({})
  const seen = []
  const off = subscribeAgentSettings((value) => seen.push(value.cwd))
  apply({ effect: () => {} }, { cwd: '/tmp/task', agentPreset: 'standard' })
  assert.equal(getAgentSettings().cwd, '/tmp/task')
  assert.equal(getAgentSettings().agentPreset, 'standard')
  setAgentSettings({ cwd: '/tmp/next' })
  off()
  setAgentSettings({ cwd: '/tmp/ignored' })
  assert.deepEqual(seen, ['/tmp/task', '/tmp/next'])
  setAgentSettings({})
})

test('agent settings: the Config schema exposes exactly the six live fields', () => {
  assert.deepEqual(FIELDS, ['cwd', 'agentPreset', 'provider', 'model', 'reasoningEffort', 'permissionPreset'])
  for (const field of FIELDS) {
    assert.ok(Object.hasOwn(Config.dict, field), field)
    assert.equal(Config.dict[field].meta.volatile, true, `${field} must be volatile`)
  }
  const accepted = Config['~standard'].validate({ cwd: '/tmp/a', provider: 'deepseek-account' })
  assert.equal(accepted.issues, undefined)
  // Volatile fields are wrapped by the Loader; normalization unwraps them.
  assert.deepEqual(normalizeAgentSettings(accepted.value), {
    cwd: '/tmp/a', agentPreset: undefined, provider: 'deepseek-account', model: undefined, reasoningEffort: undefined,
    permissionPreset: undefined,
  })
  assert.equal(accepted.value.cwd.get(), '/tmp/a')
})

test('agent settings: a volatile update reaches the next read without a re-apply', () => {
  const disposers = []
  let cwd = '/tmp/before'
  const ref = { get: () => cwd }
  apply({ effect: (fn) => { disposers.push(fn()) } }, { cwd: ref })
  assert.equal(getAgentSettings().cwd, '/tmp/before')
  // A saved form change is committed into the same volatile reference by the
  // Loader; the next run must see it without the row being applied again.
  cwd = '/tmp/after'
  assert.equal(getAgentSettings().cwd, '/tmp/after')
  for (const fn of disposers) fn()
  assert.equal(getAgentSettings().cwd, undefined)
})

test('agent settings: unloading the row clears the settings', () => {
  const disposers = []
  apply({ effect: (fn) => { disposers.push(fn()) } }, { cwd: '/tmp/live' })
  assert.equal(getAgentSettings().cwd, '/tmp/live')
  for (const fn of disposers) fn()
  assert.equal(getAgentSettings().cwd, undefined)
})

test('agent settings: the permission preset accepts only known presets and blanks as unset', () => {
  assert.equal(normalizeAgentSettings({ permissionPreset: 'danger-full-access' }).permissionPreset, 'danger-full-access')
  assert.equal(normalizeAgentSettings({ permissionPreset: 'workspace-write' }).permissionPreset, 'workspace-write')
  assert.equal(normalizeAgentSettings({ permissionPreset: '  ' }).permissionPreset, undefined)
  // An unknown name would only warn on every run, so it normalizes to unset.
  assert.equal(normalizeAgentSettings({ permissionPreset: 'not-a-preset' }).permissionPreset, undefined)
  assert.deepEqual(PERMISSION_PRESETS, ['workspace-write', 'danger-full-access'])
  const accepted = Config['~standard'].validate({ permissionPreset: 'danger-full-access' })
  assert.equal(accepted.issues, undefined)
  assert.equal(normalizeAgentSettings(accepted.value).permissionPreset, 'danger-full-access')
  assert.notEqual(Config['~standard'].validate({ permissionPreset: 'not-a-preset' }).issues, undefined)
})
