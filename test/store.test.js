import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../core/store.js'

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'imcron-store-'))
  return { dir, store: new Store(dir) }
}

test('store: missing directory loads as empty', async () => {
  const { store } = await tempStore()
  const state = await store.load()
  assert.deepEqual(state.jobs, [])
})

test('store: round trip, atomic write and .bak of the previous copy', async () => {
  const { dir, store } = await tempStore()
  const first = { jobs: [{ id: 'imc-1', schedule: { kind: 'at', at: new Date().toISOString() }, payload: { kind: 'notify', text: 'a' }, deliver: 'always' }] }
  await store.save(first)
  assert.deepEqual((await store.load()).jobs.map((job) => job.id), ['imc-1'])

  const second = { jobs: [...first.jobs, { id: 'imc-2', schedule: { kind: 'at', at: new Date().toISOString() }, payload: { kind: 'notify', text: 'b' } }] }
  await store.save(second)
  const backup = JSON.parse(await readFile(join(dir, 'state.json.bak'), 'utf8'))
  assert.deepEqual(backup.jobs.map((job) => job.id), ['imc-1'])
  assert.deepEqual((await store.load()).jobs.map((job) => job.id), ['imc-1', 'imc-2'])
  const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('store: corrupt state is quarantined and the plugin starts empty', async () => {
  const { dir, store } = await tempStore()
  await writeFile(join(dir, 'state.json'), '{not json', 'utf8')
  const state = await store.load()
  assert.deepEqual(state.jobs, [])
  const names = await readdir(dir)
  assert.equal(names.some((name) => name.startsWith('state.json.corrupt-')), true)
  assert.match(store.corruptBackup, /state\.json\.corrupt-/u)
})

test('store: wrong shape is quarantined too', async () => {
  const { dir, store } = await tempStore()
  await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, jobs: 'nope' }), 'utf8')
  assert.deepEqual((await store.load()).jobs, [])
  assert.equal((await readdir(dir)).some((name) => name.startsWith('state.json.corrupt-')), true)
})

test('store: unknown job fields survive and invalid rows are dropped', async () => {
  const { dir, store } = await tempStore()
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    jobs: [
      { id: 'imc-keep', futureField: 42, schedule: { kind: 'at', at: '2030-01-01T00:00:00Z' }, payload: { kind: 'notify', text: 'x' } },
      { id: 'imc-drop', schedule: null, payload: null },
      { nope: true },
    ],
  }), 'utf8')
  const state = await store.load()
  assert.deepEqual(state.jobs.map((job) => job.id), ['imc-keep'])
  assert.equal(state.jobs[0].futureField, 42)
  assert.equal(state.jobs[0].deliver, 'always')
})

test('store: runs.jsonl appends and reads newest window with jobId filter', async () => {
  const { store } = await tempStore()
  for (let index = 0; index < 5; index += 1) {
    await store.appendRun({ at: `2026-11-20T00:0${index}:00.000Z`, jobId: index % 2 === 0 ? 'a' : 'b', mode: 'notify', result: { kind: 'ok' } })
  }
  const all = await store.readRuns({ limit: 3 })
  assert.deepEqual(all.map((record) => record.at), [
    '2026-11-20T00:02:00.000Z',
    '2026-11-20T00:03:00.000Z',
    '2026-11-20T00:04:00.000Z',
  ])
  const onlyA = await store.readRuns({ limit: 10, jobId: 'a' })
  assert.deepEqual(onlyA.map((record) => record.jobId), ['a', 'a', 'a'])
})

test('store: a torn runs.jsonl line is skipped instead of failing the read', async () => {
  const { dir, store } = await tempStore()
  await store.appendRun({ at: '2026-11-20T00:00:00.000Z', jobId: 'a', mode: 'notify', result: { kind: 'ok' } })
  await writeFile(join(dir, 'runs.jsonl'), `${JSON.stringify({ at: '2026-11-20T00:00:00.000Z', jobId: 'a' })}\n{broken\n`, 'utf8')
  const runs = await store.readRuns({ limit: 10 })
  assert.equal(runs.length, 1)
})