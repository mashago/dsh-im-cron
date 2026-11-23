/**
 * Configuration for dsh-im-cron.
 *
 * Validation is strict for values we act on but never aborts the plugin load:
 * `parseConfig` returns defaults plus a warning list.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const JobDeclarationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u).optional(),
  name: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  schedule: z.unknown(),
  payload: z.record(z.string(), z.unknown()),
  deliver: z.enum(['always', 'on-failure', 'never']).optional(),
  target: z.object({
    botId: z.string().min(1),
    targetId: z.string().min(1),
    channel: z.string().min(1).optional(),
  }).optional(),
})

const AgentSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(30).max(86_400).optional(),
  stuckGraceSeconds: z.number().int().min(30).max(86_400).nullable().optional(),
  maxConcurrent: z.number().int().min(1).max(16).optional(),
  permissionPreset: z.string().nullable().optional(),
  taskSessionMaxAgeDays: z.number().int().min(1).max(3_650).optional(),
})

export const ConfigSchema = z.object({
  channel: z.string().min(1).optional(),
  stateDir: z.string().min(1).nullable().optional(),
  pollSeconds: z.number().int().min(5).max(3_600).optional(),
  defaultTimeoutSeconds: z.number().int().min(1).max(86_400).optional(),
  timezone: z.string().min(1).nullable().optional(),
  maxJobs: z.number().int().min(1).max(100_000).optional(),
  maxJobsPerTarget: z.number().int().min(1).max(10_000).optional(),
  activeHours: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
    end: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/u),
    timezone: z.string().min(1).nullable().optional(),
  }).nullable().optional(),
  endedRetentionHours: z.number().int().min(0).max(8_760).optional(),
  maxNotifyChars: z.number().int().min(1).max(20_000).optional(),
  allowChannels: z.array(z.string().min(1)).optional(),
  allowGroup: z.boolean().optional(),
  scriptDir: z.string().min(1).nullable().optional(),
  agent: AgentSchema.optional(),
  jobs: z.array(JobDeclarationSchema).optional(),
})

export const DEFAULT_CONFIG = Object.freeze({
  channel: 'dshIm',
  stateDir: null,
  pollSeconds: 30,
  defaultTimeoutSeconds: 600,
  timezone: null,
  maxJobs: 500,
  maxJobsPerTarget: 50,
  activeHours: null,
  endedRetentionHours: 24,
  maxNotifyChars: 2_000,
  allowChannels: ['qq'],
  allowGroup: false,
  scriptDir: null,
  jobs: [],
  agent: {
    enabled: true,
    timeoutSeconds: 900,
    stuckGraceSeconds: null,
    maxConcurrent: 2,
    permissionPreset: null,
    taskSessionMaxAgeDays: 30,
  },
})

/** Resolve `$DSH_HOME` (or `~/.dsh`) without touching the filesystem. */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME
  return configured && configured.trim() !== '' ? resolve(configured) : join(home, '.dsh')
}

/** A valid IANA zone, or null when the runtime cannot resolve it. */
export function normalizeTimezone(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** The zone used for parsing and display when a job carries none. */
export function hostTimezone(now = new Date()) {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.trim() !== '') return zone
  } catch {
    // fall through to UTC
  }
  return 'UTC'
}

/**
 * Validate and fill configuration.
 * @param {unknown} raw - loader-provided configuration.
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [io]
 * @returns {{ config: typeof DEFAULT_CONFIG, warnings: string[] }}
 */
/** Read one Loader-volatile value once, for the startup snapshot. */
function readVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** A configuration error the plugin reports by failing the row, not by degrading. */
export class ConfigError extends Error {
  /**
   * @param {string[]} warnings - the per-field problems found while parsing
   */
  constructor(warnings) {
    super(`配置无效（${warnings.length} 项）：\n- ${warnings.join('\n- ')}`)
    this.name = 'ConfigError'
    this.code = 'config-invalid'
    this.warnings = warnings
  }
}

export function parseConfig(raw = {}, { env = process.env, home = homedir() } = {}) {
  const warnings = []
  let degraded = false
  // Whether the `jobs` list can be trusted as the complete set of declared tasks.
  // Pruning keys off this flag, not off `degraded`: a bad `pollSeconds` must not
  // discard `stateDir` or freeze the declared-job sweep.
  let jobsTrusted = true
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (source !== raw) {
    degraded = true
    jobsTrusted = false
    warnings.push('配置不是对象，已按默认值启动')
  }
  // Schemastery marks `allowGroup` volatile: the Loader hands it over as a
  // reference the Plugins page updates in place. This snapshot keeps the value
  // read at startup; `tools.js` re-reads the live reference for the switch.
  const plain = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, readVolatile(value)]))

  if (plain.catchUp !== undefined) {
    warnings.push('catchUp 已移除：错过的槽一律跳过，不再补跑')
  }

  const issueText = (error) => String(error?.issues?.[0]?.message ?? error?.message ?? error).split('\n')[0]
  /** Validate one field; an invalid one falls back to its default and is reported. */
  const readField = (label, schema, value) => {
    const result = schema.safeParse(value)
    if (result.success) return result.data
    degraded = true
    warnings.push(`配置项 ${label} 不合法，已改用默认值：${issueText(result.error)}`)
    return undefined
  }

  // Validate field by field. A single bad value used to discard the whole config,
  // including `stateDir`, which silently pointed the plugin at the default
  // `$DSH_HOME/im-cron` and made the configured tasks look gone.
  const parsed = {}
  for (const [key, schema] of Object.entries(ConfigSchema.shape)) {
    if (key === 'agent' || key === 'jobs') continue
    if (plain[key] === undefined) continue
    const value = readField(key, schema, plain[key])
    if (value !== undefined) parsed[key] = value
    // An unusable stateDir means we may be looking at a different store than the
    // operator intended, so the declared-job sweep must not delete anything there.
    else if (key === 'stateDir') jobsTrusted = false
  }

  if (plain.agent !== undefined) {
    if (plain.agent !== null && typeof plain.agent === 'object' && !Array.isArray(plain.agent)) {
      const agent = {}
      for (const [key, schema] of Object.entries(AgentSchema.shape)) {
        if (plain.agent[key] === undefined) continue
        const value = readField(`agent.${key}`, schema, plain.agent[key])
        if (value !== undefined) agent[key] = value
      }
      parsed.agent = agent
    } else {
      degraded = true
      warnings.push('配置项 agent 不合法，已改用默认值')
    }
  }

  if (plain.jobs !== undefined) {
    if (!Array.isArray(plain.jobs)) {
      degraded = true
      jobsTrusted = false
      warnings.push('配置项 jobs 必须是数组，已改用空列表')
    } else {
      // One malformed declaration must not drop the others, but it does make the
      // list incomplete: skip pruning this start rather than guess what was meant.
      const jobs = []
      plain.jobs.forEach((entry, index) => {
        const result = JobDeclarationSchema.safeParse(entry)
        if (result.success) jobs.push(result.data)
        else {
          degraded = true
          jobsTrusted = false
          warnings.push(`配置项 jobs[${index}] 不合法，已跳过：${issueText(result.error)}`)
        }
      })
      parsed.jobs = jobs
    }
  }

  const config = {
    ...DEFAULT_CONFIG,
    ...parsed,
    agent: { ...DEFAULT_CONFIG.agent, ...(parsed.agent ?? {}) },
    jobs: parsed.jobs ?? [],
  }

  if (config.timezone !== null) {
    const zone = normalizeTimezone(config.timezone)
    if (zone === null) {
      warnings.push(`timezone "${config.timezone}" 不是合法 IANA 时区，改用宿主时区`)
      config.timezone = null
    } else {
      config.timezone = zone
    }
  }

  config.stateDir = config.stateDir
    ? resolve(config.stateDir)
    : join(resolveDshHome(env, home), 'im-cron')

  // The command payload runs a script from here. The plugin never creates the
  // directory: an absent directory simply means no script can be scheduled yet.
  config.scriptDir = config.scriptDir ? resolve(config.scriptDir) : join(config.stateDir, 'workspace')
  if (config.scriptDir === config.stateDir) {
    warnings.push(`scriptDir 不能等于 stateDir（${config.scriptDir}），已改用其下的 workspace 子目录`)
    config.scriptDir = join(config.stateDir, 'workspace')
  }

  return { config: Object.freeze(config), warnings, degraded, jobsTrusted }
}

export default parseConfig