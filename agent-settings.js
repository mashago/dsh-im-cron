/**
 * Task-session settings for the `agent` payload.
 *
 * This module is also the Loader row `im-cron-agent`: its schemastery `Config`
 * gives the Plugins page a live form (Web → 插件 → dsh-im-cron → agent 任务会话),
 * and `apply` keeps the accepted config, which `core/agent-turn.js` reads at the
 * start of every run.
 *
 * The fields are `volatile()`, so the Loader commits a saved form change into
 * the same config reference without remounting the row: `getAgentSettings()`
 * re-reads those references on every call, so the change reaches the next task
 * run without a DSH restart.
 */
import z from '@deepseek-ai/schemastery'
import { diag, INSTANCE } from './diag.js'

export const name = 'im-cron-agent'

diag('module-load', { instance: INSTANCE })

export const FIELDS = Object.freeze(['cwd', 'agentPreset', 'provider', 'model', 'reasoningEffort', 'permissionPreset'])

/** Fallback presets for a deployment whose permission catalog cannot be read. */
export const FALLBACK_PERMISSION_PRESETS = Object.freeze(['workspace-write', 'danger-full-access'])

export const Config = z.object({
  cwd: z.string().description('任务会话的工作目录；留空 = DSH 进程 cwd').volatile(),
  agentPreset: z.string().description('任务会话的 preset；留空 = 部署默认').volatile(),
  provider: z.string().description('模型提供方，例如 deepseek-account；留空 = 跟随部署默认').volatile(),
  model: z.string().description('模型，例如 deepseek-flash；留空 = 跟随部署默认').volatile(),
  reasoningEffort: z.string().description('推理等级；留空 = 跟随 provider 默认').volatile(),
  permissionPreset: z.string()
    .description('任务会话的权限档（部署预设表里的名字，例如 workspace-write-strict）；留空 = 跟随部署默认')
    .volatile(),
})

/** Volatile schema fields arrive as `{ get() }` wrappers from the Loader. */
function readField(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** Normalize one accepted config into the settings shape. */
export function normalizeAgentSettings(config = {}) {
  const out = {}
  for (const field of FIELDS) {
    const value = readField(config?.[field])
    out[field] = typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  // Preset names live in the deployment's permission table, not here: an
  // unknown value is reported by the run, never silently dropped.
  return Object.freeze(out)
}

let source = {}
let current = normalizeAgentSettings({})
const listeners = new Set()

function sameSettings(left, right) {
  return FIELDS.every((field) => left[field] === right[field])
}

function commit(next) {
  if (sameSettings(next, current)) return current
  current = next
  diag('settings-updated', { normalized: current })
  for (const listener of [...listeners]) {
    try {
      listener(current)
    } catch {
      // a broken subscriber must not break the row apply
    }
  }
  return current
}

/**
 * The settings currently in force (read at every task run).
 *
 * The Loader commits volatile config updates in place, so re-normalizing the
 * retained reference is what makes a saved form change visible to the next run
 * without restarting DSH.
 */
export function getAgentSettings() {
  return commit(normalizeAgentSettings(source))
}

/** Replace the settings and notify subscribers. */
export function setAgentSettings(config = {}) {
  source = config ?? {}
  return commit(normalizeAgentSettings(source))
}

/** Observe settings changes; returns the disposer. */
export function subscribeAgentSettings(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Loader entry: the accepted config becomes the live task-session settings. */
export function apply(ctx, config = {}) {
  // Log the raw accepted config too: a volatile field arrives as a `{get()}` wrapper,
  // so a preset that never reaches the store shows up here as a missing/blank entry.
  diag('row-apply', { raw: Object.fromEntries(FIELDS.map((field) => [field, readField(config?.[field])])) })
  setAgentSettings(config)
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      diag('row-dispose', {})
      setAgentSettings({})
    })
  }
}
