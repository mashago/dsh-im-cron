import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/** Load `diag.js` fresh so each case sees the environment it sets. */
async function freshDiag() {
  return await import(`../diag.js?case=${Math.random()}`)
}

test('diag: silent unless IMCRON_DIAG enables it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-diag-'))
  const file = join(dir, 'nested', 'incident.log')
  t.after(() => { delete process.env.IMCRON_DIAG; delete process.env.IMCRON_DIAG_FILE; rmSync(dir, { recursive: true, force: true }) })

  process.env.IMCRON_DIAG_FILE = file
  // `NODE_TEST_CONTEXT` is set under node --test, so tests never write.
  const off = await freshDiag()
  assert.equal(off.diagEnabled(), false)
  off.diag('should-not-write', {})
  assert.equal(existsSync(file), false)

  delete process.env.NODE_TEST_CONTEXT
  try {
    process.env.IMCRON_DIAG = '0'
    assert.equal((await freshDiag()).diagEnabled(), false)

    process.env.IMCRON_DIAG = '1'
    const on = await freshDiag()
    assert.equal(on.diagEnabled(), true)
    on.diag('enabled', { hello: 1 })
    assert.equal(existsSync(file), true)
  } finally {
    process.env.NODE_TEST_CONTEXT = '1'
  }
})
