import assert from 'node:assert/strict'
import { chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { test } from 'node:test'
import { isDirectlyExecutable, isInsideDirectory, resolveScriptPath } from '../core/scripts.js'

test('scripts: containment rejects cross-drive and parent escapes on Windows', () => {
  assert.equal(isInsideDirectory('C:\\root', 'C:\\root\\a\\run.exe', win32), true)
  // A different drive yields an absolute relative path; it must not count as inside.
  assert.equal(isInsideDirectory('C:\\root', 'D:\\run.exe', win32), false)
  assert.equal(isInsideDirectory('C:\\root', 'C:\\root\\..\\run.exe', win32), false)
  assert.equal(isInsideDirectory('C:\\root', 'C:\\root2\\run.exe', win32), false)
  assert.equal(isInsideDirectory('C:\\root', 'C:\\root', win32), false)
})

test('scripts: containment handles prefix-like sibling names on POSIX', () => {
  assert.equal(isInsideDirectory('/root', '/root/run.sh', posix), true)
  assert.equal(isInsideDirectory('/root', '/root/..foo', posix), true, 'not a parent segment')
  assert.equal(isInsideDirectory('/root', '/root/../etc/passwd', posix), false)
  assert.equal(isInsideDirectory('/root', '/root2/x', posix), false)
  assert.equal(isInsideDirectory('/root', '/root', posix), false)
})

test('scripts: Windows accepts native executables without a POSIX execute bit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-scripts-'))
  await writeFile(join(dir, 'tool.exe'), 'not really a PE image')
  await chmod(join(dir, 'tool.exe'), 0o644) // Windows has no execute bit
  const resolved = await resolveScriptPath(dir, 'tool.exe', { platform: 'win32' })
  assert.equal(resolved, join(await realpath(dir), 'tool.exe'))

  await writeFile(join(dir, 'task.sh'), '#!/bin/sh\n')
  await assert.rejects(
    () => resolveScriptPath(dir, 'task.sh', { platform: 'win32' }),
    (error) => error.code === 'script-platform-unsupported',
  )
})

test('scripts: the POSIX branch still requires the execute bit', () => {
  assert.equal(isDirectlyExecutable('/tmp/a.sh', { platform: 'linux', mode: 0o755 }), true)
  assert.equal(isDirectlyExecutable('/tmp/a.sh', { platform: 'linux', mode: 0o644 }), false)
  assert.equal(isDirectlyExecutable('C:\\a.exe', { platform: 'win32', mode: 0o644 }), true)
  assert.equal(isDirectlyExecutable('C:\\a.sh', { platform: 'win32', mode: 0o755 }), false)
})
