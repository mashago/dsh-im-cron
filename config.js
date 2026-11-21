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
  attachWorkspace: z.boolean().optional(),
  echoToChat: z.boolean().optional(),
})

export const ConfigSchema = z.object({
  channel: z.string().min(1).optional(),
  requireChannel: z.boolean().optional(),
  stateDir: z.string().min(1).nullable().optional(),
  pollSeconds: z.number().int().min(5).max(3_600).optional(),
  defaultTimeoutSeconds: z.number().int().min(1).max(86_400).optional(),
  timezone: z.string().min(1).nullable().optional(),
  maxJobs: z.number().int().min(1).max(100_000).optional(),
  maxJobsPerTarget: z.number().int().min(1).max(10_000).optional(),
  catchUp: z.enum(['none', 'once']).optional(),
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
  requireChannel: true,
  stateDir: null,
  pollSeconds: 30,
  defaultTimeoutSeconds: 600,
  timezone: null,
  maxJobs: 500,
  maxJobsPerTarget: 50,
  catchUp: 'none',
  activeHours: null,
  endedRetentionHours: 24,
  maxNotifyChars: 2_000,
  allowChannels: ['qq'],
  allowGroup: true,
  scriptDir: null,
  jobs: [],
  agent: {
    enabled: true,
    timeoutSeconds: 900,
    stuckGraceSeconds: null,
    maxConcurrent: 2,
    permissionPreset: null,
    taskSessionMaxAgeDays: 30,
    attachWorkspace: false,
    echoToChat: false,
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
export function parseConfig(raw = {}, { env = process.env, home = homedir() } = {}) {
  const warnings = []
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (source !== raw) warnings.push('配置不是对象，已按默认值启动')

  const merged = {
    ...DEFAULT_CONFIG,
    ...source,
    stateDir: typeof source.stateDir === 'string' ? source.stateDir : null,
    scriptDir: null,
    jobs: Array.isArray(source.jobs) ? source.jobs : [],
    agent: { ...DEFAULT_CONFIG.agent, ...(source.agent && typeof source.agent === 'object' ? source.agent : {}) },
  }

  let parsed
  try {
    parsed = ConfigSchema.parse(merged)
  } catch (error) {
    warnings.push(`配置校验失败，已按默认值启动：${String(error?.message ?? error).split('\n')[0]}`)
    parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG })
  }

  const config = { ...DEFAULT_CONFIG, ...parsed, agent: { ...DEFAULT_CONFIG.agent, ...(parsed.agent ?? {}) } }

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

  return { config: Object.freeze(config), warnings }
}

export default parseConfig