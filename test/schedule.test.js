import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ScheduleError,
  addLocalDays,
  describeSchedule,
  nextDue,
  nextRuns,
  parseSchedule,
  wallClockToInstant,
} from '../core/schedule.js'

const NOW = new Date('2026-11-20T00:58:00+08:00')

test('at: RFC3339 with offset is stored as UTC and must be future', () => {
  const schedule = parseSchedule({ at: '2026-11-21T09:00:00+08:00' }, { now: NOW })
  assert.equal(schedule.kind, 'at')
  assert.equal(schedule.at, '2026-11-21T01:00:00.000Z')
  assert.equal(nextDue(schedule, NOW).toISOString(), '2026-11-21T01:00:00.000Z')
  assert.throws(
    () => parseSchedule({ at: '2026-11-19T09:00:00+08:00' }, { now: NOW }),
    (error) => error instanceof ScheduleError && error.code === 'time-in-past',
  )
})

test('at: local {date,time} needs a resolvable wall clock and rejects DST gaps', () => {
  const schedule = parseSchedule(
    { at: { date: '2026-11-21', time: '09:00', timezone: 'Asia/Shanghai' } },
    { now: NOW },
  )
  assert.equal(schedule.at, '2026-11-21T01:00:00.000Z')
  assert.throws(
    () => parseSchedule({ at: { date: '2026-03-08', time: '02:30', timezone: 'America/New_York' } }, { now: NOW }),
    (error) => error instanceof ScheduleError && error.code === 'dst-gap',
  )
  assert.throws(
    () => parseSchedule({ at: '2026-11-21 09:00' }, { now: NOW }),
    (error) => error instanceof ScheduleError && error.code === 'bad-schedule',
  )
})

test('schedule: exactly one of at/cron/every', () => {
  assert.throws(
    () => parseSchedule({ at: '2026-11-21T09:00:00Z', cron: '0 9 * * *' }, { now: NOW }),
    (error) => error.code === 'bad-schedule',
  )
  assert.throws(() => parseSchedule({}, { now: NOW }), (error) => error.code === 'bad-schedule')
})

test('cron: five fields only, no macros, no value+step', () => {
  const schedule = parseSchedule({ cron: '0 9 * * 1-5' }, { now: NOW, timezone: 'Asia/Shanghai' })
  assert.equal(schedule.kind, 'cron')
  const runs = nextRuns(schedule, NOW, 2)
  assert.deepEqual(runs.map((date) => date.toISOString()), [
    '2026-11-20T01:00:00.000Z',
    '2026-11-23T01:00:00.000Z',
  ])

  assert.throws(() => parseSchedule({ cron: '0 9 * * * *' }, { now: NOW }), (error) => error.code === 'bad-cron')
  assert.throws(() => parseSchedule({ cron: '@daily' }, { now: NOW }), (error) => error.code === 'bad-cron')
  assert.throws(() => parseSchedule({ cron: '0/15 9 * * *' }, { now: NOW }), (error) => error.code === 'bad-cron')
})

test('cron: last day of month and */3 hours work', () => {
  const lastDay = parseSchedule({ cron: '0 9 L * *' }, { now: NOW, timezone: 'Asia/Shanghai' })
  assert.equal(nextDue(lastDay, NOW).toISOString(), '2026-11-30T01:00:00.000Z')
  const every3h = parseSchedule({ cron: '0 */3 * * *' }, { now: NOW, timezone: 'Asia/Shanghai' })
  assert.equal(nextDue(every3h, NOW).toISOString(), '2026-11-19T19:00:00.000Z')
})

test('every day: anchored on the first future wall clock, then +N local days', () => {
  const schedule = parseSchedule(
    { every: { unit: 'day', count: 15, at: '06:00', timezone: 'Asia/Shanghai' } },
    { now: NOW },
  )
  assert.equal(schedule.anchor, '2026-11-20')
  assert.deepEqual(nextRuns(schedule, NOW, 3).map((date) => date.toISOString()), [
    '2026-11-19T22:00:00.000Z',
    '2026-12-04T22:00:00.000Z',
    '2026-12-19T22:00:00.000Z',
  ])
})

test('every week: count weeks between occurrences', () => {
  const schedule = parseSchedule(
    { every: { unit: 'week', count: 2, at: '10:00', timezone: 'Asia/Shanghai' } },
    { now: NOW },
  )
  const runs = nextRuns(schedule, NOW, 3).map((date) => date.toISOString())
  assert.deepEqual(runs, [
    '2026-11-20T02:00:00.000Z',
    '2026-12-04T02:00:00.000Z',
    '2026-12-18T02:00:00.000Z',
  ])
})

test('every day: occurrences continue past the old 1000-step horizon', () => {
  const schedule = parseSchedule(
    { every: { unit: 'day', count: 1, at: '06:00', timezone: 'Asia/Shanghai' } },
    { now: NOW },
  )
  const occurrence = (days) => wallClockToInstant(addLocalDays({ y: 2026, m: 11, d: 20 }, days), '06:00', 'Asia/Shanghai').ms

  // 999 days after the anchor was the last occurrence the old loop could reach;
  // the next call returned undefined, so the scheduler ended a live job.
  assert.equal(nextDue(schedule, new Date(occurrence(999))).getTime(), occurrence(1_000))
  assert.equal(nextDue(schedule, new Date(occurrence(10_000))).getTime(), occurrence(10_001))
})

test('every week: a far-future water mark still resolves', () => {
  const schedule = parseSchedule(
    { every: { unit: 'week', count: 1, at: '10:00', timezone: 'Asia/Shanghai' } },
    { now: NOW },
  )
  // 1100 weeks is past the old 1000-step loop as well (each step is one week).
  const occurrence = (weeks) => wallClockToInstant(addLocalDays({ y: 2026, m: 11, d: 20 }, weeks * 7), '10:00', 'Asia/Shanghai').ms
  assert.equal(nextDue(schedule, new Date(occurrence(1_100))).getTime(), occurrence(1_101))
})

test('every hour is instant based and keeps its spacing across DST', () => {
  const schedule = parseSchedule(
    { every: { unit: 'hour', count: 3, timezone: 'America/New_York' } },
    { now: new Date('2026-03-08T05:30:00Z') },
  )
  const runs = nextRuns(schedule, new Date('2026-03-08T05:30:00Z'), 3).map((date) => date.toISOString())
  // Anchored on the creation minute (05:30Z), so the first run is 3h later and
  // the spacing stays exactly 3h across the DST change.
  assert.deepEqual(runs, [
    '2026-03-08T08:30:00.000Z',
    '2026-03-08T11:30:00.000Z',
    '2026-03-08T14:30:00.000Z',
  ])
})

test('every validation: unit, count range, at only for day/week', () => {
  assert.throws(
    () => parseSchedule({ every: { unit: 'second', count: 5 } }, { now: NOW }),
    (error) => error.code === 'bad-every',
  )
  assert.throws(
    () => parseSchedule({ every: { unit: 'minute', count: 0 } }, { now: NOW }),
    (error) => error.code === 'bad-every',
  )
  assert.throws(
    () => parseSchedule({ every: { unit: 'minute', count: 1441 } }, { now: NOW }),
    (error) => error.code === 'bad-every',
  )
  assert.throws(
    () => parseSchedule({ every: { unit: 'minute', count: 5, at: '09:00' } }, { now: NOW }),
    (error) => error.code === 'bad-every',
  )
  assert.throws(
    () => parseSchedule({ every: { unit: 'day', count: 0 } }, { now: NOW }),
    (error) => error.code === 'bad-every',
  )
  assert.throws(
    () => parseSchedule({ every: { unit: 'day', count: 400 } }, { now: NOW }),
    (error) => error.code === 'bad-every',
  )
  assert.throws(
    () => parseSchedule({ every: { unit: 'hour', count: 3, at: '06:00' } }, { now: NOW }),
    (error) => error.code === 'bad-every',
  )
})

test('DST: gap reports the first valid instant, overlap resolves to the earlier one', () => {
  const gap = wallClockToInstant({ y: 2026, m: 3, d: 8 }, '02:30', 'America/New_York')
  assert.equal(gap.kind, 'gap')
  assert.equal(new Date(gap.gapAfter).toISOString(), '2026-03-08T07:00:00.000Z')

  const overlap = wallClockToInstant({ y: 2026, m: 10, d: 25 }, '01:30', 'Europe/London')
  assert.equal(overlap.kind, 'overlap')
  assert.equal(new Date(overlap.ms).toISOString(), '2026-10-25T00:30:00.000Z')
})

test('every day across a DST change keeps the wall clock time', () => {
  const schedule = parseSchedule(
    { every: { unit: 'day', count: 15, at: '06:00', timezone: 'America/New_York' } },
    { now: new Date('2026-02-20T00:00:00Z') },
  )
  const runs = nextRuns(schedule, new Date('2026-02-20T00:00:00Z'), 4)
  assert.deepEqual(runs.map((date) => date.toISOString()), [
    '2026-02-20T11:00:00.000Z',
    '2026-03-07T11:00:00.000Z',
    '2026-03-22T10:00:00.000Z',
    '2026-04-06T10:00:00.000Z',
  ])
})

test('every: a wall clock inside a gap slides to the first valid instant', () => {
  const date = addLocalDays({ y: 2026, m: 3, d: 7 }, 1)
  const resolved = wallClockToInstant(date, '02:30', 'America/New_York')
  assert.equal(resolved.kind, 'gap')
})

test('describeSchedule renders readable Chinese', () => {
  const every = parseSchedule(
    { every: { unit: 'day', count: 15, at: '06:00', timezone: 'Asia/Shanghai' } },
    { now: NOW },
  )
  assert.match(describeSchedule(every), /每 15 天 06:00/u)
  const at = parseSchedule({ at: '2026-11-21T09:00:00+08:00' }, { now: NOW })
  assert.match(describeSchedule(at), /一次性/u)
  const cron = parseSchedule({ cron: '0 9 * * *', timezone: 'Asia/Shanghai' }, { now: NOW })
  assert.match(describeSchedule(cron), /cron 0 9 \* \* \*/u)
})
test('every minute: instant-based intervals, including non-hour multiples', () => {
  const now = new Date('2026-11-20T09:00:30+08:00')
  const s = parseSchedule({ every: { unit: 'minute', count: 90 } }, { timezone: 'Asia/Shanghai', now })
  assert.equal(s.unit, 'minute')
  assert.equal(s.at, null)
  // Anchored on the current whole minute, then straight arithmetic.
  assert.equal(s.anchor, '2026-11-20T01:00:00.000Z')
  const first = nextDue(s, new Date(s.anchor))
  assert.equal(first.toISOString(), '2026-11-20T02:30:00.000Z')
  const second = nextDue(s, first)
  assert.equal(second.toISOString(), '2026-11-20T04:00:00.000Z')
})

test('every minute: count boundaries', () => {
  const now = new Date('2026-11-20T09:00:00+08:00')
  assert.equal(parseSchedule({ every: { unit: 'minute', count: 1 } }, { now }).count, 1)
  assert.equal(parseSchedule({ every: { unit: 'minute', count: 1440 } }, { now }).count, 1440)
  assert.throws(() => parseSchedule({ every: { unit: 'minute', count: 1441 } }, { now }), (error) => error.code === 'bad-every')
})

test('describeSchedule: every unit renders without undefined holes', () => {
  const now = new Date('2026-11-20T09:00:00+08:00')
  const cases = [
    [{ every: { unit: 'minute', count: 2 } }, '每 2 分钟'],
    [{ every: { unit: 'hour', count: 3 } }, '每 3 小时'],
    [{ every: { unit: 'day', count: 15, at: '06:00', timezone: 'Asia/Shanghai' } }, '每 15 天 06:00（Asia/Shanghai）'],
    [{ every: { unit: 'week', count: 2, at: '10:00', timezone: 'Asia/Shanghai' } }, '每 2 周 10:00（Asia/Shanghai）'],
  ]
  for (const [input, expected] of cases) {
    const text = describeSchedule(parseSchedule(input, { timezone: 'Asia/Shanghai', now }))
    assert.equal(text, expected)
    assert.doesNotMatch(text, /undefined|null/u)
  }
})

test('config: scriptDir defaults under stateDir and honors an override', async () => {
  const { parseConfig } = await import('../config.js')
  const dir = await mkdtemp(join(tmpdir(), 'imcron-config-'))
  assert.equal(parseConfig({ stateDir: dir }).config.scriptDir, join(dir, 'workspace'))
  assert.equal(parseConfig({ stateDir: dir, scriptDir: '/custom/scripts' }).config.scriptDir, '/custom/scripts')
  // Pointing it at the state dir itself is refused, not silently accepted.
  const same = parseConfig({ stateDir: dir, scriptDir: dir })
  assert.equal(same.config.scriptDir, join(dir, 'workspace'))
  assert.match(same.warnings.join('\n'), /scriptDir 不能等于 stateDir/u)
})
