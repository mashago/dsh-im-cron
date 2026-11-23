import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseConfig } from '../config.js'
import { createJobRunner } from '../core/job.js'
import { Store } from '../core/store.js'

const NOW = new Date('2026-11-20T01:00:00+08:00')

async function setup(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  // The command payload now spawns whatever script the payload names, so the
  // tests point at real executables the way the resolver requires.
  const scripts = join(dir, 'workspace')
  await mkdir(scripts, { recursive: true })
  const script = async (name, body) => {
    const file = join(scripts, name)
    await writeFile(file, `#!/bin/sh\n${body}\n`)
    await chmod(file, 0o755)
    return file
  }
  const paths = {
    echo: await script('echo.sh', 'printf hello'),
    fail: await script('fail.sh', 'printf "boom\\nline2" >&2; exit 2'),
    empty: await script('empty.sh', 'true'),
    slow: await script('slow.sh', 'sleep 5'),
  }
  const { config } = parseConfig({ stateDir: dir, ...overrides })
  const store = new Store(dir)
  const sent = []
  const sleeps = []
  const send = async (job, text) => {
    sent.push({ jobId: job.id, text })
    return { status: 'sent' }
  }
  const runner = createJobRunner({
    store,
    config,
    logger: null,
    now: () => NOW,
    send,
    sleep: async (ms) => { sleeps.push(ms) },
  })
  return { dir, paths, config, store, runner, sent, sleeps }
}

function job(overrides = {}) {
  return {
    id: 'imc-test',
    name: '测试任务',
    target: { botId: 'bot', targetId: 'cron-abc', channel: 'qq' },
    schedule: { kind: 'at', at: '2026-11-20T02:00:00.000Z' },
    payload: { kind: 'notify', text: '开会' },
    deliver: 'always',
    enabled: true,
    createdAt: NOW.toISOString(),
    ...overrides,
  }
}

test('job: notify sends its text and records the run', async () => {
  const { runner, sent, store } = await setup()
  const { record, patch } = await runner.run({ job: job(), occurrence: NOW })
  assert.deepEqual(sent, [{ jobId: 'imc-test', text: '开会' }])
  assert.equal(record.result.kind, 'ok')
  assert.equal(record.deliver.status, 'sent')
  assert.deepEqual(patch, {})
  const runs = await store.readRuns({ limit: 5 })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].mode, 'notify')
  assert.equal(runs[0].textTail, '开会')
})

test('job: notify with deliver "never" writes runs without sending', async () => {
  const { runner, sent, store } = await setup()
  const { record } = await runner.run({ job: job({ deliver: 'never' }), occurrence: NOW })
  assert.equal(sent.length, 0)
  assert.equal(record.deliver.status, 'skipped')
  assert.equal((await store.readRuns({ limit: 5 })).length, 1)
})

test('job: command success delivers stdout', async () => {
  const { runner, sent, paths } = await setup()
  const { record } = await runner.run({
    job: job({ payload: { kind: 'command', script: paths.echo } }),
    occurrence: NOW,
  })
  assert.equal(record.result.kind, 'ok')
  assert.equal(record.result.exit, 0)
  assert.equal(sent[0].text, 'hello')
})

test('job: command success with empty output sends the completion line', async () => {
  const { runner, sent, paths } = await setup()
  await runner.run({ job: job({ payload: { kind: 'command', script: paths.empty }, deliver: 'always' }), occurrence: NOW })
  assert.equal(sent[0].text, '✅ 测试任务 完成（无输出）')
})

test('job: command failure sends exit code and stderr tail under on-failure', async () => {
  const { runner, sent, paths } = await setup()
  const { record } = await runner.run({
    job: job({ payload: { kind: 'command', script: paths.fail }, deliver: 'on-failure' }),
    occurrence: NOW,
  })
  assert.equal(record.result.kind, 'failed')
  assert.equal(record.result.exit, 2)
  assert.match(sent[0].text, /exit 2/u)
  assert.match(sent[0].text, /line2/u)
  assert.equal(record.deliver.status, 'sent')
})

test('job: a command payload without a script disables the job instead of spawning', async () => {
  const { runner, sent } = await setup()
  const { record, patch } = await runner.run({
    job: job({ payload: { kind: 'command' }, deliver: 'on-failure' }),
    occurrence: NOW,
  })
  assert.equal(record.result.reason, 'script-missing')
  assert.equal(patch.state, 'invalid')
  assert.match(sent[0].text, /failed/u)
})

test('job: timeout is reported as a failure', async () => {
  const { runner, sent, paths } = await setup()
  const { record } = await runner.run({
    job: job({ payload: { kind: 'command', script: paths.slow, timeoutSeconds: 1 }, deliver: 'always' }),
    occurrence: NOW,
  })
  assert.equal(record.result.reason, 'timeout')
  assert.match(sent[0].text, /超时/u)
})

test('job: an invalid script timeout falls back to the configured default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const { config } = parseConfig({ stateDir: dir, defaultTimeoutSeconds: 600 })
  const store = new Store(dir)
  const seen = []
  const exec = async (_entry, options) => {
    seen.push(options.timeoutSeconds)
    return {
      exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 0,
      stdout: 'ok', stderr: '', stdoutDropped: 0, stderrDropped: 0,
    }
  }
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send: async () => ({ status: 'sent' }), exec })
  for (const timeoutSeconds of [-1, 0, 86_401, 10 ** 9, 30]) {
    await runner.run({ job: job({ payload: { kind: 'command', script: '/bin/true', timeoutSeconds } }), occurrence: NOW })
  }
  assert.deepEqual(seen, [600, 600, 600, 600, 30])
})

test('job: pending delivery is retried with backoff and can succeed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const { config } = parseConfig({ stateDir: dir })
  const store = new Store(dir)
  const attempts = []
  const send = async () => {
    attempts.push('try')
    return attempts.length === 1
      ? { status: 'pending', error: 'bot-not-connected' }
      : { status: 'sent' }
  }
  const sleeps = []
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send, sleep: async (ms) => sleeps.push(ms) })
  const { record } = await runner.run({ job: job(), occurrence: NOW })
  assert.equal(attempts.length, 2)
  assert.deepEqual(sleeps, [5_000])
  assert.equal(record.deliver.status, 'sent')
  assert.equal(record.deliver.attempts, 2)
})

test('job: a channel that is not ready is retried, not failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const { config } = parseConfig({ stateDir: dir })
  const store = new Store(dir)
  const attempts = []
  const send = async () => {
    attempts.push('try')
    return attempts.length === 1
      ? { status: 'failed', error: 'channel-unavailable' }
      : { status: 'sent' }
  }
  const sleeps = []
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send, sleep: async (ms) => sleeps.push(ms) })
  const { record } = await runner.run({ job: job(), occurrence: NOW })
  assert.equal(attempts.length, 2)
  assert.deepEqual(sleeps, [5_000])
  assert.equal(record.deliver.status, 'sent')
})

test('job: an unavailable channel ends as pending after the backoff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const { config } = parseConfig({ stateDir: dir })
  const store = new Store(dir)
  const attempts = []
  const send = async () => {
    attempts.push('try')
    return { status: 'failed', error: 'channel-unavailable' }
  }
  const sleeps = []
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send, sleep: async (ms) => sleeps.push(ms) })
  const { record } = await runner.run({ job: job(), occurrence: NOW })
  assert.equal(attempts.length, 3)
  assert.deepEqual(sleeps, [5_000, 30_000])
  assert.equal(record.deliver.status, 'pending')
  assert.equal(record.deliver.error, 'channel-unavailable')
})

test('job: a markdown refusal falls back to plain text once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const { config } = parseConfig({ stateDir: dir })
  const store = new Store(dir)
  const formats = []
  const send = async (_job, _text, options) => {
    formats.push(options?.format ?? 'markdown')
    return formats.length === 1
      ? { status: 'failed', error: 'delivery-failed' }
      : { status: 'sent' }
  }
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send })
  const { record } = await runner.run({ job: job(), occurrence: NOW })
  assert.deepEqual(formats, ['markdown', 'plain'])
  assert.equal(record.deliver.status, 'sent')
  assert.equal(record.deliver.attempts, 2)
})

test('job: an uncertain markdown failure is not retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const { config } = parseConfig({ stateDir: dir })
  const store = new Store(dir)
  let calls = 0
  const send = async () => {
    calls += 1
    return { status: 'failed', error: 'delivery-failed' }
  }
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send, sleep: async () => {} })
  const { record } = await runner.run({ job: job(), occurrence: NOW })
  // One markdown attempt plus one plain fallback; never a third.
  assert.equal(calls, 2)
  assert.equal(record.deliver.status, 'failed')
  assert.equal(record.deliver.error, 'delivery-failed')
})

test('job: needs-rebind delivery error marks the job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const { config } = parseConfig({ stateDir: dir })
  const store = new Store(dir)
  const send = async () => ({ status: 'failed', error: 'unknown-target' })
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send })
  const { patch } = await runner.run({ job: job(), occurrence: NOW })
  assert.equal(patch.state, 'needs-rebind')
})

test('job: no channel means delivery is skipped, the run still lands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const { config } = parseConfig({ stateDir: dir })
  const store = new Store(dir)
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send: null })
  const { record } = await runner.run({ job: job(), occurrence: NOW })
  assert.equal(record.deliver.status, 'skipped')
  assert.equal(record.deliver.error, 'channel-unavailable')
})

test('job: agent payload without a runtime is a failure, not a crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const { config } = parseConfig({ stateDir: dir })
  const store = new Store(dir)
  const runner = createJobRunner({ store, config, logger: null, now: () => NOW, send: null })
  const { record } = await runner.run({
    job: job({ payload: { kind: 'agent', prompt: 'do it' }, deliver: 'never' }),
    occurrence: NOW,
  })
  assert.equal(record.result.reason, 'agent-unavailable')
})

test('job: a script path containing a space runs, because the file is spawned directly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-job-'))
  const spaced = join(dir, 'a directory with spaces')
  await mkdir(spaced, { recursive: true })
  const file = join(spaced, 'spaced.sh')
  await writeFile(file, '#!/bin/sh\nprintf spaced-ok\n')
  await chmod(file, 0o755)
  const { config } = parseConfig({ stateDir: dir, scriptDir: spaced })
  const store = new Store(dir)
  const sent = []
  const runner = createJobRunner({
    store, config, logger: null, now: () => NOW,
    send: async (job, text) => { sent.push(text); return { status: 'sent' } },
  })
  const { record } = await runner.run({
    job: job({ payload: { kind: 'command', script: file }, deliver: 'always' }),
    occurrence: NOW,
  })
  // A shell would word-split the path and fail with exit 127 here.
  assert.equal(record.result.kind, 'ok')
  assert.equal(record.result.exit, 0)
  assert.equal(sent[0], 'spaced-ok')
})
