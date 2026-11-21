import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OUTPUT_TAIL_BYTES, runCommand } from '../core/exec.js'

test('exec: exit code, stdout and stderr are captured', async () => {
  const result = await runCommand({ command: 'printf hello; printf world >&2; exit 3' })
  assert.equal(result.exitCode, 3)
  assert.equal(result.stdout, 'hello')
  assert.equal(result.stderr, 'world')
  assert.equal(result.timedOut, false)
  assert.equal(result.spawnError, undefined)
})

test('exec: argv mode bypasses the shell', async () => {
  const result = await runCommand({ argv: [process.execPath, '-e', 'console.log("argv-ok")'] })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), 'argv-ok')
})

test('exec: timeout kills the process tree and reports timedOut', async () => {
  const started = Date.now()
  const result = await runCommand({ command: 'sleep 10' }, { timeoutSeconds: 1 })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
  assert.ok(Date.now() - started < 8_000, 'timeout should not wait for the child')
})

test('exec: missing binary reports spawnError instead of throwing', async () => {
  const result = await runCommand({ argv: ['definitely-not-a-real-binary-xyz'] })
  assert.equal(result.exitCode, null)
  assert.equal(typeof result.spawnError, 'string')
})

test('exec: output keeps only the tail within the byte budget', async () => {
  const bytes = OUTPUT_TAIL_BYTES + 100 * 1024
  const result = await runCommand({ argv: [process.execPath, '-e', `process.stdout.write('x'.repeat(${bytes}))`] })
  assert.equal(result.exitCode, 0)
  assert.ok(result.stdout.length <= OUTPUT_TAIL_BYTES)
  assert.ok(result.stdoutDropped > 0)
})

test('exec: aborted signal terminates the run', async () => {
  const controller = new AbortController()
  const promise = runCommand({ command: 'sleep 10' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  const result = await promise
  assert.equal(result.aborted, true)
})

test('exec: empty entry is rejected without spawning', async () => {
  const result = await runCommand({})
  assert.equal(result.spawnError, 'command-empty')
})