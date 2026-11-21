/**
 * Task-session settings for the `agent` payload.
 *
 * This module is also the Loader row `im-cron-agent`: its schemastery `Config`
 * gives the Plugins page a live form (Web → 插件 → dsh-im-cron → agent 任务会话),
 * and `apply` pushes the accepted values into this module's store, which
 * `core/agent-turn.js` reads at the start of every run.
 *
 * A saved form change needs a DSH restart before it reaches a run. Saving writes
 * the profile patch, but this module is a singleton: a hot reload replaces the
 * row's instance while `core/agent-turn.js` keeps its original import, so the
 * running task keeps reading the previous values.
 */
import z from '@deepseek-ai/schemastery'
import { diag, INSTANCE } from './diag.js'

export const name = 'im-cron-agent'

diag('module-load', { instance: INSTANCE })

export const FIELDS = Object.freeze(['cwd', 'agentPreset', 'provider', 'model', 'reasoningEffort', 'permissionPreset'])

/** The permission presets this form may pin on a task session; blank follows the deployment. */
export const PERMISSION_PRESETS = Object.freeze(['workspace-write', 'danger-full-access'])

export const Config = z.object({
  cwd: z.string().description('任务会话的工作目录；留空 = DSH 进程 cwd').volatile(),
  agentPreset: z.string().description('任务会话的 preset；留空 = 部署默认').volatile(),
  provider: z.string().description('模型提供方，例如 deepseek-account；留空 = 跟随部署默认').volatile(),
  model: z.string().description('模型，例如 deepseek-flash；留空 = 跟随部署默认').volatile(),
  reasoningEffort: z.string().description('推理等级；留空 = 跟随 provider 默认').volatile(),
  permissionPreset: z.union([z.const('workspace-write'), z.const('danger-full-access')])
    .description('任务会话的权限档；留空 = 跟随部署默认。danger-full-access 会同时关闭沙箱与审批')
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
  // An unknown preset name would only warn on every run; treat it as unset.
  if (!PERMISSION_PRESETS.includes(out.permissionPreset)) out.permissionPreset = undefined
  return Object.freeze(out)
}

let current = normalizeAgentSettings({})
const listeners = new Set()

/** The settings currently in force (read at every task run). */
export function getAgentSettings() {
  return current
}

/** Replace the settings and notify subscribers. */
export function setAgentSettings(config = {}) {
  current = normalizeAgentSettings(config)
  diag('set-settings', { normalized: current })
  for (const listener of [...listeners]) {
    try {
      listener(current)
    } catch {
      // a broken subscriber must not break the row apply
    }
  }
  return current
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
