import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const shipped = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).files

async function jsFiles(dir) {
  const entries = await readdir(join(root, dir), { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...await jsFiles(path))
    else if (entry.name.endsWith('.js')) found.push(path)
  }
  return found
}

/**
 * A module that is imported at runtime but left out of `files` only fails after
 * the package is installed from npm or a tarball: a linked checkout hides it.
 */
test('package: engines.dsh gates the required host version', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.match(pkg.engines.dsh, /^>=0\.2\.2-rc\.0 <0\.3\.0$/u)
  assert.match(pkg.engines.node, /^>=24\.9\.0$/u)
})

test('package: every runtime module is listed in "files"', async () => {
  const top = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
  const modules = [...top, ...await jsFiles('core'), ...await jsFiles('channel')]
  assert.ok(modules.length > 5)
  for (const file of modules) {
    const covered = shipped.some((entry) => file === entry || file.startsWith(`${entry}/`))
    assert.ok(covered, `${file} is missing from package.json "files"`)
  }
})