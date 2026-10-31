/**
 * Filesystem helpers the plugin needs, implemented locally.
 *
 * Deliberately no `@deepseek-ai/*` imports: this plugin must load against any
 * dsh runtime the desktop app ships. Those packages are also gated by
 * app-boot's `unmetRequirements`, which compares a plugin's `engines.dsh` /
 * `@deepseek-ai/dsh-*` peers against the running runtime version — a plugin
 * built against one release would simply not mount on another.
 *
 * @module dsh-token-split/fsutil
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Resolve the DeepSeek Harness home: `$DSH_HOME`, else `~/.dsh`.
 * @param {Record<string, string | undefined>} [env] - environment mapping.
 * @returns {string} absolute home path.
 */
export function dshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured.length > 0 ? path.resolve(configured) : path.join(os.homedir(), '.dsh')
}

/**
 * Join path segments onto the harness home.
 * @param {...string} segments - path segments.
 * @returns {string} absolute path.
 */
export function dshHomePath(...segments) {
  return path.join(dshHome(), ...segments)
}

/**
 * Replace a file atomically: write a random-suffix sibling, then rename it
 * over the target, so a reader sees either the old or the new complete file.
 * @param {string} filename - final path.
 * @param {string} content - complete next content.
 * @param {object} [options] - write options.
 * @param {number} [options.mode] - permission bits for the new file.
 * @param {number} [options.dirMode] - permission bits for created directories.
 * @returns {Promise<void>} resolution after the rename.
 */
export async function writeFileAtomic(filename, content, { mode = 0o600, dirMode = 0o700 } = {}) {
  const dir = path.dirname(filename)
  await fs.promises.mkdir(dir, { recursive: true, mode: dirMode })
  const suffix = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`
  const temporary = path.join(dir, `.${path.basename(filename)}.${suffix}.tmp`)
  await fs.promises.writeFile(temporary, content, { mode, flag: 'wx' })
  try {
    await fs.promises.rename(temporary, filename)
  } catch (error) {
    await fs.promises.rm(temporary, { force: true })
    throw error
  }
}
