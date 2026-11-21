/**
 * Resolve a `command` payload's script to an absolute path inside the plugin's
 * script directory.
 *
 * The model names a script; it never composes a shell command. Only a directly
 * executable file that already exists under `scriptDir` is accepted, so the
 * reachable surface is the directory the operator chose — not the host.
 */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

/** A resolution failure the caller reports instead of running anything. */
export class ScriptError extends Error {
  /**
   * @param {string} code - stable machine-readable reason
   * @param {string} message - model-facing explanation
   */
  constructor(code, message) {
    super(message)
    this.name = 'ScriptError'
    this.code = code
  }
}

/**
 * Resolve one script reference.
 *
 * Identity-equality is required: a caller may write the directory once inside
 * the plugin's own data directory, and that includes the file the name resolves
 * to, in absolute form, so a later run does not depend on the caller's cwd.
 * @param {string} scriptDir - absolute directory that owns the scripts
 * @param {string} input - bare name, relative path, or absolute path
 * @returns {Promise<string>} canonical absolute path
 * @throws {ScriptError} when the directory is missing or the target escapes it
 */
export async function resolveScriptPath(scriptDir, input) {
  const name = typeof input === 'string' ? input.trim() : ''
  if (name === '' || name.includes('\0')) {
    throw new ScriptError('script-invalid', '脚本名不能为空')
  }
  let root
  try {
    root = await realpath(scriptDir)
  } catch {
    throw new ScriptError('script-dir-missing', `脚本目录 ${scriptDir} 不存在；请先创建它，再把脚本放进去`)
  }
  const wanted = isAbsolute(name) ? name : join(root, name)
  let target
  try {
    target = await realpath(wanted)
  } catch {
    throw new ScriptError('script-not-found', `脚本 ${name} 不存在（查找目录 ${scriptDir}）`)
  }
  const inside = target === root || relative(root, target).split(sep)[0] !== '..'
  if (!inside || target === root) {
    throw new ScriptError('script-outside-dir', `脚本 ${name} 不在允许的目录 ${scriptDir} 内`)
  }
  const info = await stat(target)
  if (!info.isFile()) {
    throw new ScriptError('script-not-a-file', `${name} 不是普通文件`)
  }
  // The executor runs the path directly, so it must be executable and carry its
  // own interpreter line; a bare .py/.js file would otherwise fail at run time.
  if ((info.mode & 0o111) === 0) {
    throw new ScriptError('script-not-executable', `脚本 ${name} 没有执行权限；请 chmod +x，并在首行写 shebang`)
  }
  return target
}