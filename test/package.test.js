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
/**
 * DSH reads a plugin's display metadata through `createRequire(...).resolve
 * ('<name>/package.json')`: a package that does not export its manifest shows
 * up in the Plugins page with no description at all.
 */
test('package: the manifest is exported for the Plugins page metadata', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.equal(typeof pkg.description, 'string')
  assert.ok(pkg.description.trim() !== '')
})

/**
 * The Plugins page renders `icon` as a data URI, so the file must ship inside
 * the package (declared in `files`), stay under the size cap, and not pull
 * anything from the network.
 */
test('package: the plugin icon is a shipped, self-contained asset', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(typeof pkg.icon, 'string')
  assert.match(pkg.icon, /^\.\/.+\.(?:svg|png|jpe?g|webp)$/u)
  assert.ok(pkg.files.some((entry) => pkg.icon.slice(2).startsWith(entry)),
    `icon ${pkg.icon} is not covered by "files"`)
  const bytes = await readFile(join(root, pkg.icon))
  assert.ok(bytes.length > 0)
  assert.ok(bytes.length <= 256 * 1024, 'icon exceeds the 256 KiB metadata cap')
  if (pkg.icon.endsWith('.svg')) {
    const text = bytes.toString('utf8')
    assert.match(text, /^<svg[\s>]/u)
    assert.doesNotMatch(text, /(?:href|src)\s*=\s*["']https?:/u, 'icon must not reference the network')
  }
})
