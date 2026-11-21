#!/usr/bin/env node
/**
 * Offline CLI for dsh-im-cron.
 *
 *   node cli.js doctor                state dir health, job counts, last runs
 *   node cli.js list [--verbose]      jobs with schedule, next run, last result
 *   node cli.js run <id>              execute one job now (no channel delivery)
 *   node cli.js log [--job id] [-n N] tail of runs.jsonl
 *
 * Options: --state-dir DIR, --config FILE (JSON copy of the plugin config;
 * needed by `run` so command names resolve).
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseConfig, hostTimezone } from './config.js'
import { Store } from './core/store.js'
import { createJobRunner } from './core/job.js'
import { describeSchedule, nextDue } from './core/schedule.js'

function parseArgs(argv) {
  const options = { stateDir: null, config: null, verbose: false, limit: 20, job: null, _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--verbose') options.verbose = true
    else if (arg === '--state-dir') options.stateDir = argv[++index] ?? null
    else if (arg === '--config') options.config = argv[++index] ?? null
    else if (arg === '--job') options.job = argv[++index] ?? null
    else if (arg === '-n' || arg === '--limit') options.limit = Number(argv[++index] ?? 20)
    else if (arg.startsWith('--state-dir=')) options.stateDir = arg.slice('--state-dir='.length)
    else if (arg.startsWith('--config=')) options.config = arg.slice('--config='.length)
    else if (!arg.startsWith('-')) options._.push(arg)
  }
  return options
}

async function loadRawConfig(options) {
  if (options.config === null) return {}
  const text = await readFile(resolve(options.config), 'utf8')
  return JSON.parse(text)
}

function isoOrDash(value) {
  return value === undefined || value === null ? '-' : String(value)
}

function scheduleText(job) {
  try {
    return describeSchedule(job.schedule)
  } catch {
    return '(无法描述)'
  }
}

/** The script directory the plugin would use for this state dir. */
async function resolveScriptDir(stateDir) {
  return join(stateDir, 'workspace')
}

async function cmdDoctor(store, options) {
  const state = await store.load()
  const runs = await store.readRuns({ limit: 1 })
  let stateFileSize = 'missing'
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(store.statePath)
    stateFileSize = `${info.size} bytes`
  } catch {
    stateFileSize = 'missing'
  }
  const counts = { total: state.jobs.length, enabled: 0, paused: 0, ended: 0, broken: 0 }
  for (const job of state.jobs) {
    if (job.endedAt !== undefined) counts.ended += 1
    else if (job.enabled === false) counts.paused += 1
    else if (job.state !== undefined) counts.broken += 1
    else counts.enabled += 1
  }
  console.log(`stateDir      ${store.dir}`)
  console.log(`state.json    ${stateFileSize}${store.corruptBackup === null ? '' : `（本次运行已隔离损坏文件：${store.corruptBackup}）`}`)
  console.log(`jobs          ${counts.total}（启用 ${counts.enabled} / 暂停 ${counts.paused} / 已结束 ${counts.ended} / 异常 ${counts.broken}）`)
  console.log(`runs.jsonl    最后一条：${runs.length === 0 ? '（空）' : isoOrDash(runs[0]?.at)}`)
  console.log(`host timezone ${hostTimezone()}`)
  const scriptDir = await resolveScriptDir(store.dir)
  let scriptNote = ''
  try {
    const { readdir } = await import('node:fs/promises')
    const names = (await readdir(scriptDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
    scriptNote = names.length === 0 ? '（空）' : names.slice(0, 8).join(' ')+(names.length > 8 ? ` …共 ${names.length} 个` : '')
  } catch {
    scriptNote = '不存在，脚本任务无法创建（请手动创建）'
  }
  console.log(`scriptDir     ${scriptDir} ${scriptNote}`)
  if (options.config !== null) console.log(`config        ${resolve(options.config)}`)
  return 0
}

async function cmdList(store, options) {
  const state = await store.load()
  const now = new Date()
  if (state.jobs.length === 0) {
    console.log('（没有任务）')
    return 0
  }
  const runs = await store.readRuns({ limit: 500 })
  const lastByJob = new Map()
  for (const record of runs) {
    if (record?.jobId !== undefined) lastByJob.set(record.jobId, record)
  }
  for (const job of state.jobs) {
    const next = job.endedAt !== undefined || job.enabled === false || job.state !== undefined
      ? '-'
      : (() => {
        try {
          const due = nextDue(job.schedule, new Date(job.lastFiredFor ?? job.createdAt ?? now.toISOString()))
          return due === undefined ? '-' : due.toISOString()
        } catch {
          return '!'
        }
      })()
    const last = lastByJob.get(job.id)
    const flags = []
    if (job.enabled === false) flags.push('paused')
    if (job.endedAt !== undefined) flags.push('ended')
    if (job.state !== undefined) flags.push(job.state)
    console.log(`${job.id}  ${job.name ?? ''}`)
    console.log(`  排期 ${scheduleText(job)}  下次 ${next}  投递 ${job.deliver ?? 'always'}${flags.length > 0 ? `  [${flags.join(',')}]` : ''}`)
    if (last !== undefined) {
      const delivered = last.deliver?.status ?? 'n/a'
      console.log(`  上次 ${last.at}  ${last.result?.kind ?? '?'}${last.result?.reason === undefined ? '' : `/${last.result.reason}`}  deliver=${delivered}`)
    }
    if (options.verbose) {
      console.log(`  载荷 ${JSON.stringify(job.payload)}`)
      if (job.target !== undefined) console.log(`  目标 ${job.target.botId}/${job.target.targetId}（${job.target.channel ?? '?'}）`)
      if (job.task?.sessionId !== undefined) console.log(`  会话 ${job.task.sessionId}`)
      if (last?.sessionId !== undefined) console.log(`  上次会话 ${last.sessionId}`)
    }
  }
  return 0
}

async function cmdRun(store, options) {
  const id = options._[1]
  if (id === undefined) {
    console.error('用法：imcron run <jobId>')
    return 1
  }
  const state = await store.load()
  const job = state.jobs.find((candidate) => candidate.id === id)
  if (job === undefined) {
    console.error(`找不到任务 ${id}`)
    return 2
  }
  const rawConfig = await loadRawConfig(options)
  const { config } = parseConfig({ ...rawConfig, stateDir: store.dir })
  const runner = createJobRunner({ store, config, logger: console, send: null })
  const { record } = await runner.run({ job, occurrence: new Date(), trigger: 'manual' })
  console.log(JSON.stringify(record, null, 2))
  console.log('提示：CLI 没有 dsh-im 通道，投递会记为 skipped；真正的投递只在 DSH 进程里发生。')
  return 0
}

async function cmdLog(store, options) {
  const runs = await store.readRuns({ limit: options.limit, jobId: options.job })
  if (runs.length === 0) {
    console.log('（没有运行记录）')
    return 0
  }
  for (const record of runs) {
    console.log(JSON.stringify(record))
  }
  return 0
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const command = options._[0] ?? 'doctor'
  const { config } = parseConfig({ stateDir: options.stateDir ?? undefined })
  const store = new Store(options.stateDir !== null ? resolve(options.stateDir) : config.stateDir, { logger: console })

  switch (command) {
    case 'doctor':
      return await cmdDoctor(store, options)
    case 'list':
      return await cmdList(store, options)
    case 'run':
      return await cmdRun(store, options)
    case 'log':
      return await cmdLog(store, options)
    default:
      console.error(`未知命令：${command}\n可用：doctor / list / run / log`)
      return 1
  }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
if (isEntry || process.argv[1]?.endsWith('/cli.js') === true) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(`imcron 出错：${String(error?.message ?? error)}`)
    process.exitCode = 1
  })
}

export default main