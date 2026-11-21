/**
 * Process execution for the `command` payload.
 *
 * Only a resolved script path reaches this module: a caller passes the
 * normalized entry (`command` string or `argv` array) plus cwd/timeout/env, and
 * never a shell string from a model. Output keeps the last 256 KiB per stream;
 * the whole process tree is killed on timeout or cancellation.
 */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'

export const OUTPUT_TAIL_BYTES = 256 * 1024
const SIGTERM_GRACE_MS = 5_000

/** Bounded tail of one output stream. */
class TailBuffer {
  constructor(limit = OUTPUT_TAIL_BYTES) {
    this.limit = limit
    this.chunks = []
    this.size = 0
    this.dropped = 0
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    if (buffer.length >= this.limit) {
      this.dropped += this.size + buffer.length - this.limit
      this.chunks = [buffer.subarray(buffer.length - this.limit)]
      this.size = this.limit
      return
    }
    this.chunks.push(buffer)
    this.size += buffer.length
    while (this.size > this.limit) {
      const first = this.chunks[0]
      const excess = this.size - this.limit
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
        this.dropped += first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.size -= excess
        this.dropped += excess
      }
    }
  }

  toString() {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

let cachedShell = null

/** `bash` when this machine has it, otherwise `sh` (POSIX only). */
async function posixShell() {
  if (cachedShell !== null) return cachedShell
  for (const candidate of ['/bin/bash', '/usr/bin/bash']) {
    try {
      await access(candidate, fsConstants.X_OK)
      cachedShell = candidate
      return cachedShell
    } catch {
      // try the next candidate
    }
  }
  cachedShell = '/bin/sh'
  return cachedShell
}

function killTree(child, { force = false } = {}) {
  if (child === null || child === undefined || child.exitCode !== null) return
  const pid = child.pid
  if (typeof pid !== 'number') return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref()
    } catch {
      // best effort only
    }
    return
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

/**
 * Run one configured command.
 * @param {{ command?: string | null, argv?: string[] | null, shell?: string, cwd?: string | null, timeoutSeconds?: number, env?: Record<string, string> | null }} entry
 * @param {{ timeoutSeconds?: number, env?: Record<string, string>, signal?: AbortSignal, shell?: string }} [options]
 * @returns {Promise<{ exitCode: number | null, signal: string | null, timedOut: boolean, aborted: boolean, durationMs: number, stdout: string, stderr: string, stdoutDropped: number, stderrDropped: number, spawnError?: string }>}
 */
export async function runCommand(entry, options = {}) {
  const startedAt = Date.now()
  const stdout = new TailBuffer()
  const stderr = new TailBuffer()
  const timeoutSeconds = options.timeoutSeconds ?? entry.timeoutSeconds ?? null
  const timeoutMs = typeof timeoutSeconds === 'number' && timeoutSeconds > 0 ? timeoutSeconds * 1000 : null
  const shellPreference = options.shell ?? entry.shell ?? 'auto'
  const env = { ...process.env, ...(entry.env ?? {}), ...(options.env ?? {}) }

  let file
  let args
  if (Array.isArray(entry.argv) && entry.argv.length > 0) {
    file = entry.argv[0]
    args = entry.argv.slice(1)
  } else if (typeof entry.command === 'string' && entry.command !== '') {
    if (process.platform === 'win32') {
      file = env.ComSpec ?? 'cmd.exe'
      args = ['/d', '/s', '/c', entry.command]
    } else {
      file = shellPreference === 'auto' ? await posixShell()
        : shellPreference === 'bash' ? '/bin/bash'
          : '/bin/sh'
      args = ['-c', entry.command]
    }
  } else {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      durationMs: 0,
      stdout: '',
      stderr: '',
      stdoutDropped: 0,
      stderrDropped: 0,
      spawnError: 'command-empty',
    }
  }

  return await new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let aborted = false
    let child
    let killTimer = null
    let timeoutTimer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
      if (killTimer !== null) clearTimeout(killTimer)
      options.signal?.removeEventListener?.('abort', onAbort)
      resolve({
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutDropped: stdout.dropped,
        stderrDropped: stderr.dropped,
        ...result,
      })
    }

    const onAbort = () => {
      aborted = true
      killTree(child)
      killTimer = setTimeout(() => killTree(child, { force: true }), SIGTERM_GRACE_MS)
      killTimer.unref?.()
    }

    try {
      child = spawn(file, args, {
        cwd: entry.cwd ?? options.cwd ?? undefined,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        spawnError: String(error?.message ?? error),
      })
      return
    }

    child.on('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        spawnError: String(error?.code ?? error?.message ?? error),
      })
    })
    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))

    if (timeoutMs !== null) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        killTree(child)
        killTimer = setTimeout(() => killTree(child, { force: true }), SIGTERM_GRACE_MS)
        killTimer.unref?.()
      }, timeoutMs)
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('close', (code, signalName) => {
      finish({
        exitCode: typeof code === 'number' ? code : null,
        signal: signalName ?? null,
        timedOut,
        aborted,
      })
    })
  })
}

export default runCommand