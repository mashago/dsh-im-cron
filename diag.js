/**
 * Opt-in diagnostic sink for the scheduler and the task-session settings.
 *
 * Off by default: set `IMCRON_DIAG=1` before starting DSH to trace a run. Every
 * line names the module instance that wrote it, so a duplicated module shows up
 * as two ids. Tests never write (`NODE_TEST_CONTEXT` is present under `node --test`).
 *
 * Output: `<ISO> [<instance>] <event> {<detail>}` appended to
 * `$IMCRON_DIAG_FILE` when set, else `/tmp/imcron_diag/incident.log` on POSIX and
 * `%TEMP%\imcron_diag\incident.log` on Windows.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_FILE = process.platform === 'win32'
  ? join(tmpdir(), 'imcron_diag', 'incident.log')
  : '/tmp/imcron_diag/incident.log'

export const INSTANCE = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Whether diagnostics are wanted for this process. */
export function diagEnabled() {
  if (process.env.NODE_TEST_CONTEXT !== undefined) return false
  const flag = process.env.IMCRON_DIAG
  return flag === '1' || flag === 'true'
}

/** Append one JSON line; diagnostics must never break the plugin. */
export function diag(event, detail = {}) {
  if (!diagEnabled()) return
  const file = process.env.IMCRON_DIAG_FILE ?? DEFAULT_FILE
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} [${INSTANCE}] ${event} ${JSON.stringify(detail)}\n`)
  } catch {
    // an unwritable path is not worth failing a task run over
  }
}