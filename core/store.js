/**
 * Durable state for dsh-im-cron.
 *
 * Files (all under `config.stateDir`):
 *   state.json          `{ version: 1, jobs: [...] }`
 *   state.json.bak      previous good copy
 *   runs.jsonl          append-only run log (one JSON object per line)
 *
 * Writes are serialized, written to a temporary file, fsynced, then renamed so
 * a crash leaves either the old or the new file — never a torn one. A corrupt
 * state file is copied aside and the plugin starts empty instead of failing.
 */
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { diag } from '../diag.js'

export const STATE_VERSION = 1

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function timestampSlug(now) {
  return now.toISOString().replace(/[:.]/gu, '-')
}

/** Keep every field a job might grow later; only the identity is mandatory. */
function normalizeJob(job) {
  if (!isRecord(job) || typeof job.id !== 'string' || job.id === '') return null
  if (!isRecord(job.schedule) || !isRecord(job.payload)) return null
  const deliver = ['always', 'on-failure', 'never'].includes(job.deliver) ? job.deliver : 'always'
  return { ...job, deliver }
}

export class Store {
  /**
   * @param {string} dir - state directory (created lazily on first write).
   * @param {{ logger?: object, now?: () => Date }} [options]
   */
  constructor(dir, { logger = null, now = () => new Date() } = {}) {
    this.dir = dir
    this.logger = logger
    this.now = now
    this.statePath = join(dir, 'state.json')
    this.backupPath = join(dir, 'state.json.bak')
    this.runsPath = join(dir, 'runs.jsonl')
    this.queue = Promise.resolve()
    this.corruptBackup = null
  }

  /** Create the state directory (idempotent; used so startup has an on-disk footprint). */
  async ensureDir() {
    await mkdir(this.dir, { recursive: true })
  }

  /** Serialize one filesystem mutation behind the previous one. */
  #enqueue(task) {
    const next = this.queue.then(task, task)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Read state, repairing a corrupt file by copying it aside.
   * @returns {Promise<{ version: number, jobs: object[] }>}
   */
  async load() {
    let raw
    try {
      raw = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: STATE_VERSION, jobs: [] }
      throw error
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.#quarantine('unparseable JSON')
      return { version: STATE_VERSION, jobs: [] }
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) {
      await this.#quarantine('unexpected shape')
      return { version: STATE_VERSION, jobs: [] }
    }

    const jobs = []
    for (const candidate of parsed.jobs) {
      const job = normalizeJob(candidate)
      if (job === null) {
        this.logger?.warn?.(`[im-cron] 丢弃无法识别的任务记录：${JSON.stringify(candidate)?.slice(0, 200)}`)
        continue
      }
      jobs.push(job)
    }
    return { version: Number.isSafeInteger(parsed.version) ? parsed.version : STATE_VERSION, jobs }
  }

  async #quarantine(reason) {
    const target = `${this.statePath}.corrupt-${timestampSlug(this.now())}`
    try {
      await copyFile(this.statePath, target)
      this.corruptBackup = target
      this.logger?.warn?.(`[im-cron] state.json 损坏（${reason}），已备份到 ${target}，按空状态启动`)
    } catch (error) {
      this.logger?.warn?.(`[im-cron] state.json 损坏（${reason}）且备份失败：${String(error)}`)
    }
  }

  /**
   * Atomically persist state (tmp + fsync + rename, previous copy kept as .bak).
   * @param {{ jobs: object[] }} state
   */
  async save(state) {
    const payload = `${JSON.stringify({ version: STATE_VERSION, jobs: state.jobs ?? [] }, null, 2)}\n`
    diag('store:save', {
      jobs: (state.jobs ?? []).map((job) => ({ id: job.id, lastFiredFor: job.lastFiredFor ?? null, endedAt: job.endedAt ?? null })),
    })
    return this.#enqueue(async () => {
      await mkdir(this.dir, { recursive: true })
      try {
        await copyFile(this.statePath, this.backupPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') this.logger?.warn?.(`[im-cron] 备份 state.json 失败：${String(error)}`)
      }
      const tmp = `${this.statePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      const handle = await open(tmp, 'w')
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(tmp, this.statePath)
      } catch (error) {
        await rm(tmp, { force: true })
        throw error
      }
    })
  }

  /**
   * Append one run record. Rejects only on I/O failure; callers log and move on.
   * @param {object} record
   */
  async appendRun(record) {
    const line = `${JSON.stringify(record)}\n`
    return this.#enqueue(async () => {
      await mkdir(this.dir, { recursive: true })
      const handle = await open(this.runsPath, 'a')
      try {
        await handle.writeFile(line, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  }

  /**
   * Read the most recent run records (oldest first).
   * @param {{ limit?: number, jobId?: string }} [options]
   * @returns {Promise<object[]>}
   */
  async readRuns({ limit = 200, jobId = null } = {}) {
    let exists = true
    try {
      await stat(this.runsPath)
    } catch (error) {
      if (error?.code === 'ENOENT') exists = false
      else throw error
    }
    if (!exists) return []

    const kept = []
    const stream = createReadStream(this.runsPath, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (jobId !== null && record?.jobId !== jobId) continue
        kept.push(record)
        if (kept.length > limit) kept.shift()
      }
    } finally {
      lines.close()
      stream.destroy()
    }
    return kept
  }
}

export default Store