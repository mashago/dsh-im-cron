import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConfig } from '../config.js'

const IO = { env: {}, home: '/tmp/imcron-test-home' }

test('config: one invalid field no longer discards the rest of the config', () => {
  const { config, warnings, degraded, jobsTrusted } = parseConfig({
    stateDir: '/tmp/imcron-keep-state',
    scriptDir: '/tmp/imcron-keep-scripts',
    timezone: 'Asia/Shanghai',
    pollSeconds: 'not-a-number',
    activeHours: { start: '08:00', end: '22:00' },
  }, IO)

  // The bug: validation failure used to fall back to defaults wholesale, which
  // moved stateDir to $DSH_HOME/im-cron and made configured tasks look gone.
  assert.equal(config.stateDir, '/tmp/imcron-keep-state')
  assert.equal(config.scriptDir, '/tmp/imcron-keep-scripts')
  assert.equal(config.timezone, 'Asia/Shanghai')
  assert.deepEqual(config.activeHours, { start: '08:00', end: '22:00' })
  assert.equal(config.pollSeconds, 30, 'only the invalid field falls back')
  assert.equal(degraded, true)
  assert.equal(jobsTrusted, true)
  assert.match(warnings.join('\n'), /pollSeconds/u)
})

test('config: one invalid agent field keeps the other agent settings', () => {
  const { config, degraded } = parseConfig({
    agent: { timeoutSeconds: 300, maxConcurrent: 'many', permissionPreset: 'danger-full-access' },
  }, IO)
  assert.equal(config.agent.timeoutSeconds, 300)
  assert.equal(config.agent.maxConcurrent, 2)
  assert.equal(config.agent.permissionPreset, 'danger-full-access')
  assert.equal(degraded, true)
})

test('config: a malformed declaration keeps its valid siblings and blocks pruning, without failing the plugin', () => {
  const { config, warnings, degraded, jobsTrusted } = parseConfig({
    stateDir: '/tmp/imcron-jobs-state',
    jobs: [
      { id: 'ok', name: 'ok', schedule: { cron: '0 9 * * *' }, payload: { kind: 'notify', text: 'x' } },
      { id: 'bad', name: 'bad', schedule: {}, payload: 'not-a-record' },
    ],
  }, IO)

  assert.deepEqual(config.jobs.map((job) => job.id), ['ok'])
  assert.equal(config.stateDir, '/tmp/imcron-jobs-state')
  // A typo in one declaration must not take every running task down with it.
  assert.equal(degraded, false)
  // Incomplete list: the startup sweep must not treat the missing entry as removed.
  assert.equal(jobsTrusted, false)
  assert.match(warnings.join('\n'), /jobs\[1\]/u)
})

test('config: a non-array jobs value is rejected and blocks pruning', () => {
  const { config, warnings, jobsTrusted } = parseConfig({ jobs: { id: 'not-an-array' } }, IO)
  assert.deepEqual(config.jobs, [])
  assert.equal(jobsTrusted, false)
  assert.match(warnings.join('\n'), /jobs 必须是数组/u)
})

test('config: an explicit empty jobs list is trusted', () => {
  const { config, jobsTrusted, degraded } = parseConfig({ jobs: [] }, IO)
  assert.deepEqual(config.jobs, [])
  assert.equal(jobsTrusted, true)
  assert.equal(degraded, false)
})

test('config: the removed catchUp setting is ignored with a warning', () => {
  const { config, warnings, degraded, jobsTrusted } = parseConfig({ catchUp: 'once' }, IO)
  assert.equal(config.catchUp, undefined)
  assert.equal(degraded, false)
  assert.equal(jobsTrusted, true)
  assert.match(warnings.join('\n'), /catchUp 已移除/u)
  // A removed key keeps its specific message instead of a generic unknown one.
  assert.doesNotMatch(warnings.join('\n'), /未知配置项/u)
})

test('config: an unknown key is reported instead of being dropped silently', () => {
  const { config, warnings, degraded } = parseConfig({
    pollSecond: 10,
    agent: { timeOutSeconds: 60 },
  }, IO)

  assert.equal(config.pollSeconds, 30)
  assert.equal(config.agent.timeoutSeconds, 900)
  // A mistyped key name is a warning; only an invalid value fails the row.
  assert.equal(degraded, false)
  assert.match(warnings.join('\n'), /未知配置项 "pollSecond"/u)
  assert.match(warnings.join('\n'), /未知配置项 "agent\.timeOutSeconds"/u)
})

test('config: an invalid stateDir blocks pruning of the fallback store', () => {
  const { config, warnings, jobsTrusted } = parseConfig({ stateDir: 123, jobs: [] }, IO)
  assert.equal(config.stateDir, '/tmp/imcron-test-home/.dsh/im-cron')
  assert.equal(jobsTrusted, false)
  assert.match(warnings.join('\n'), /stateDir/u)
})

test('config: a non-object config falls back and blocks pruning', () => {
  const { config, warnings, degraded, jobsTrusted } = parseConfig(null, IO)
  assert.equal(config.stateDir, '/tmp/imcron-test-home/.dsh/im-cron')
  assert.equal(degraded, true)
  assert.equal(jobsTrusted, false)
  assert.match(warnings.join('\n'), /配置不是对象/u)
})