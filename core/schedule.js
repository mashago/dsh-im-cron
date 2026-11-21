/**
 * Schedule parsing and occurrence arithmetic for dsh-im-cron.
 *
 * Three expressions, one occurrence contract (`nextDue` returns the first
 * occurrence strictly after a given instant, or undefined when none remains):
 *
 *   at     one-shot, stored as a UTC instant
 *   cron   five-field expression evaluated by croner in the job's timezone
 *   every  calendar interval (hour = instant based, day/week = wall clock based)
 *
 * Wall-clock conversion uses Intl only. A target local time that does not exist
 * (spring-forward gap) is reported as `gap` together with the first valid
 * instant after it; a time that exists twice (fall-back) resolves to the
 * EARLIER instant, which requires probing both sides of the transition.
 */
import { Cron } from 'croner'

export class ScheduleError extends Error {
  /**
   * @param {string} code - stable machine code (`bad-schedule`, `time-in-past`, …).
   * @param {string} message - human/model facing explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ScheduleError'
    this.code = code
  }
}

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const formatterCache = new Map()

function formatterFor(timezone) {
  let formatter = formatterCache.get(timezone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timezone, formatter)
  }
  return formatter
}

/** Local calendar fields of one instant in `timezone`. */
export function localParts(ms, timezone) {
  const parts = {}
  for (const part of formatterFor(timezone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    H: Number(parts.hour) % 24,
    M: Number(parts.minute),
    S: Number(parts.second),
  }
}

function offsetMs(ms, timezone) {
  const seconds = Math.floor(ms / 1000) * 1000
  const p = localParts(seconds, timezone)
  return Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - seconds
}

function wallClockMatches(ms, date, hour, minute, timezone) {
  const p = localParts(ms, timezone)
  return p.y === date.y && p.m === date.m && p.d === date.d
    && p.H === hour && p.M === minute && p.S === 0
}

/** First instant after a spring-forward gap: the transition itself. */
function findTransition(around, timezone) {
  const lo = around - 36 * HOUR_MS
  const hi = around + 36 * HOUR_MS
  const before = offsetMs(lo, timezone)
  if (offsetMs(hi, timezone) === before) return null
  let a = lo
  let b = hi
  while (b - a > 1000) {
    const mid = Math.floor((a + b) / 2000) * 1000
    if (offsetMs(mid, timezone) === before) a = mid
    else b = mid
  }
  return b
}

/**
 * Convert a wall-clock date/time in `timezone` to an instant.
 * @param {{ y: number, m: number, d: number }} date - local calendar date.
 * @param {string} hhmm - `HH:mm`.
 * @param {string} timezone - IANA zone.
 * @returns {{ ms: number | null, kind: 'normal' | 'overlap' | 'gap', gapAfter?: number | null }}
 */
export function wallClockToInstant(date, hhmm, timezone) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(hhmm)
  if (match === null) throw new ScheduleError('bad-schedule', `时间必须是 HH:mm，收到 "${hhmm}"`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  const naive = Date.UTC(date.y, date.m - 1, date.d, hour, minute, 0)

  const candidates = []
  const seen = new Set()
  for (const probe of [naive - HOUR_MS, naive, naive + HOUR_MS]) {
    const candidate = naive - offsetMs(probe, timezone)
    if (seen.has(candidate)) continue
    seen.add(candidate)
    if (wallClockMatches(candidate, date, hour, minute, timezone)) candidates.push(candidate)
  }
  if (candidates.length > 0) {
    return { ms: Math.min(...candidates), kind: candidates.length > 1 ? 'overlap' : 'normal' }
  }
  return { ms: null, kind: 'gap', gapAfter: findTransition(naive, timezone) }
}

/** Parse `YYYY-MM-DD` into local calendar fields. */
export function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value))
  if (match === null) throw new ScheduleError('bad-schedule', `日期必须是 YYYY-MM-DD，收到 "${value}"`)
  const date = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
  const check = new Date(Date.UTC(date.y, date.m - 1, date.d))
  if (check.getUTCFullYear() !== date.y || check.getUTCMonth() + 1 !== date.m || check.getUTCDate() !== date.d) {
    throw new ScheduleError('bad-schedule', `日期不存在：${value}`)
  }
  return date
}

/** `YYYY-MM-DD` for one instant in `timezone`. */
export function localDateString(ms, timezone) {
  const p = localParts(ms, timezone)
  return `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

/** Add whole local calendar days (never hours — DST safe). */
export function addLocalDays(date, days) {
  const shifted = new Date(Date.UTC(date.y, date.m - 1, date.d + days))
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() }
}

function cronKey(expression, timezone) {
  return `${timezone}\u0000${expression}`
}

const cronCache = new Map()

/** Cached, timer-free croner instance for one expression/timezone pair. */
export function cronFor(expression, timezone) {
  const key = cronKey(expression, timezone)
  let cron = cronCache.get(key)
  if (cron === undefined) {
    cron = new Cron(expression, { mode: '5-part', timezone, paused: true })
    cronCache.set(key, cron)
  }
  return cron
}

const CRON_VALUE_STEP = /(^|,)\d+\//u

function validateCronExpression(expression) {
  const text = String(expression ?? '').trim()
  if (text === '') throw new ScheduleError('bad-cron', 'cron 表达式不能为空')
  if (text.startsWith('@')) throw new ScheduleError('bad-cron', '不支持 @daily 这类宏，请写 5 段表达式')
  const fields = text.split(/\s+/u)
  if (fields.length !== 5) {
    throw new ScheduleError('bad-cron', `cron 只接受 5 段（分 时 日 月 周），收到 ${fields.length} 段`)
  }
  if (CRON_VALUE_STEP.test(text)) {
    throw new ScheduleError('bad-cron', '不支持“值 + 步长”（如 0/15）；步长只能写成 */n 或 范围/n')
  }
  return text
}

const AT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/u

function parseAtValue(input, { timezone, now }) {
  const nowMs = now.getTime()
  if (typeof input === 'string') {
    const text = input.trim()
    if (text === '') throw new ScheduleError('bad-schedule', 'at 不能为空')
    if (!AT_OFFSET.test(text)) {
      throw new ScheduleError('bad-schedule', 'at 必须带时区偏移（Z 或 +08:00）；本地时间请用 {date,time,timezone}')
    }
    const ms = Date.parse(text)
    if (!Number.isFinite(ms)) throw new ScheduleError('bad-schedule', `无法解析时间 "${text}"`)
    if (ms <= nowMs) throw new ScheduleError('time-in-past', `现在是 ${now.toISOString()}，at 必须是未来时间`)
    return { kind: 'at', at: new Date(ms).toISOString(), timezone }
  }

  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const date = parseLocalDate(input.date)
    const hhmm = input.time ?? '00:00'
    const zone = input.timezone ?? timezone
    const resolved = wallClockToInstant(date, hhmm, zone)
    if (resolved.kind === 'gap') {
      throw new ScheduleError('dst-gap', `${zone} 在 ${input.date} ${hhmm} 处于夏令时缺口，请换一个时间`)
    }
    if (resolved.ms === null) throw new ScheduleError('bad-schedule', `无法解析 ${input.date} ${hhmm}`)
    if (resolved.ms <= nowMs) throw new ScheduleError('time-in-past', `现在是 ${now.toISOString()}，该时间已过去`)
    return { kind: 'at', at: new Date(resolved.ms).toISOString(), timezone: zone }
  }

  throw new ScheduleError('bad-schedule', 'at 必须是 RFC3339 字符串或 {date,time,timezone}')
}

function formatLocalDate(date) {
  return `${String(date.y).padStart(4, '0')}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`
}

function resolveEveryAnchor(unit, count, at, timezone, now) {
  if (unit === 'hour' || unit === 'minute') {
    const anchor = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS
    return { anchor: new Date(anchor).toISOString(), at: null }
  }
  const hhmm = at ?? '00:00'
  const nowMs = now.getTime()
  const nowParts = localParts(nowMs, timezone)
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const date = addLocalDays(nowParts, dayOffset)
    const resolved = wallClockToInstant(date, hhmm, timezone)
    const instant = resolved.kind === 'gap' ? resolved.gapAfter : resolved.ms
    if (instant !== null && instant !== undefined && instant > nowMs) {
      return { anchor: formatLocalDate(date), at: hhmm }
    }
  }
  // The next occurrence is at most two days away; reaching this point means the
  // wall-clock conversion is broken, so fail loudly rather than anchor wrongly.
  throw new ScheduleError('bad-schedule', '无法为 every 计算锚点日期')
}

function validateEvery(input, { timezone, now }) {
  const unit = input.unit
  if (!['minute', 'hour', 'day', 'week'].includes(unit)) {
    throw new ScheduleError('bad-every', 'every.unit 只支持 minute / hour / day / week')
  }
  const count = input.count
  const limits = { minute: [1, 1440], hour: [1, 168], day: [1, 365], week: [1, 52] }
  const [min, max] = limits[unit]
  if (!Number.isSafeInteger(count) || count < min || count > max) {
    throw new ScheduleError('bad-every', `every.count 必须是 ${min}-${max} 的整数（${unit}）`)
  }
  const zone = input.timezone ?? timezone
  if (unit === 'hour' || unit === 'minute') {
    if (input.at !== undefined) throw new ScheduleError('bad-every', `every{unit:"${unit}"} 不接受 at`)
    const { anchor } = resolveEveryAnchor(unit, count, null, zone, now)
    return { kind: 'every', unit, count, at: null, timezone: zone, anchor }
  }
  const at = input.at ?? '00:00'
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/u.test(at)) {
    throw new ScheduleError('bad-every', 'every.at 必须是 HH:mm')
  }
  const { anchor } = resolveEveryAnchor(unit, count, at, zone, now)
  return { kind: 'every', unit, count, at, timezone: zone, anchor }
}

/**
 * Validate one schedule input (`{at}` | `{cron}` | `{every}`) and normalize it.
 * @param {{ at?: unknown, cron?: unknown, every?: unknown }} input
 * @param {{ timezone?: string, now?: Date }} [options] - fallback zone and clock.
 */
export function parseSchedule(input, { timezone = 'UTC', now = new Date() } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ScheduleError('bad-schedule', '排期必须是 {at} / {cron} / {every} 之一')
  }
  const keys = ['at', 'cron', 'every'].filter((key) => input[key] !== undefined)
  if (keys.length !== 1) {
    throw new ScheduleError('bad-schedule', `at / cron / every 必须三选一，收到 ${keys.length} 个（${keys.join(', ') || '无'}）`)
  }
  const kind = keys[0]
  if (kind === 'at') return Object.freeze(parseAtValue(input.at, { timezone, now }))
  if (kind === 'cron') {
    const expression = validateCronExpression(input.cron)
    const zone = input.timezone ?? timezone
    try {
      cronFor(expression, zone)
    } catch (error) {
      throw new ScheduleError('bad-cron', `cron 表达式非法：${error?.message ?? expression}`)
    }
    return Object.freeze({ kind: 'cron', expression, timezone: zone })
  }
  if (input.every === null || typeof input.every !== 'object' || Array.isArray(input.every)) {
    throw new ScheduleError('bad-every', 'every 必须是 {unit,count,at?,timezone?}')
  }
  return Object.freeze(validateEvery(input.every, { timezone, now }))
}

/**
 * First occurrence strictly after `after`.
 * @param {object} schedule - normalized schedule.
 * @param {Date} after
 * @returns {Date | undefined}
 */
export function nextDue(schedule, after) {
  const afterMs = after.getTime()
  if (schedule.kind === 'at') {
    const ms = Date.parse(schedule.at)
    return ms > afterMs ? new Date(ms) : undefined
  }
  if (schedule.kind === 'cron') {
    const next = cronFor(schedule.expression, schedule.timezone).nextRun(after)
    return next === null ? undefined : new Date(next.getTime())
  }
  if (schedule.unit === 'hour' || schedule.unit === 'minute') {
    const anchor = Date.parse(schedule.anchor)
    if (!Number.isFinite(anchor)) return undefined
    const period = schedule.count * (schedule.unit === 'minute' ? MINUTE_MS : HOUR_MS)
    const k = Math.max(0, Math.floor((afterMs - anchor) / period) + 1)
    return new Date(anchor + k * period)
  }
  const step = schedule.unit === 'week' ? schedule.count * 7 : schedule.count
  const anchorDate = parseLocalDate(schedule.anchor)
  const hhmm = schedule.at ?? '00:00'
  for (let k = 0; k < 1_000; k += 1) {
    const date = addLocalDays(anchorDate, k * step)
    const resolved = wallClockToInstant(date, hhmm, schedule.timezone)
    const instant = resolved.kind === 'gap' ? resolved.gapAfter : resolved.ms
    if (instant !== null && instant !== undefined && instant > afterMs) return new Date(instant)
  }
  return undefined
}

/**
 * The next `count` occurrences strictly after `after`.
 * @param {object} schedule
 * @param {Date} after
 * @param {number} count
 * @returns {Date[]}
 */
export function nextRuns(schedule, after, count) {
  const runs = []
  let cursor = after
  for (let index = 0; index < count; index += 1) {
    const due = nextDue(schedule, cursor)
    if (due === undefined) break
    runs.push(due)
    cursor = due
  }
  return runs
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Human-readable Chinese description of a normalized schedule. */
export function describeSchedule(schedule, { timezone } = {}) {
  if (schedule.kind === 'at') {
    const zone = schedule.timezone ?? timezone ?? 'UTC'
    const p = localParts(Date.parse(schedule.at), zone)
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.H).padStart(2, '0')}:${String(p.M).padStart(2, '0')}（${zone}）· 一次性`
  }
  if (schedule.kind === 'cron') {
    return `cron ${schedule.expression}（${schedule.timezone}）`
  }
  const unitLabel = { minute: '分钟', hour: '小时', day: '天', week: '周' }[schedule.unit]
  if (schedule.unit === 'minute' || schedule.unit === 'hour') return `每 ${schedule.count} ${unitLabel}`
  return `每 ${schedule.count} ${unitLabel} ${schedule.at}（${schedule.timezone}）`
}

/** Weekday name for a wall-clock date, used by tool confirmations. */
export function weekdayName(date) {
  const day = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay()
  return WEEKDAYS[day]
}

export default { parseSchedule, nextDue, nextRuns, describeSchedule }