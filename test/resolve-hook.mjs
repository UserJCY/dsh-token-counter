/**
 * Test-only module resolution.
 *
 * The plugin is installed into a DSH profile, where `@deepseek-ai/*` packages
 * are hoisted beside it and resolve normally. In a plain checkout they are not,
 * so the test run redirects those bare specifiers (and the React packages the
 * browser-half test renders with) at a module root discovered at runtime —
 * never a path baked into this file.
 *
 * Roots are tried in this order, and the first one that exists wins (preferring
 * one that actually contains React, which the client test imports):
 *
 *   1. `DSH_PROFILE_MODULES` — an explicit `node_modules` directory;
 *   2. `<repo>/node_modules` — what `npm install` gives you, and what CI uses;
 *   3. `<DSH_HOME>/profiles/node_modules` — a DSH installation's hoisted deps;
 *   4. `~/.dsh/profiles/node_modules` — the default DSH data directory.
 *
 * Nothing usable found → a readable error naming the variable to set, instead
 * of a bare `ERR_MODULE_NOT_FOUND` from deep inside a test file.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Read a non-empty environment variable, or undefined. */
function envPath(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Default DSH data directory when `DSH_HOME` is unset. */
function dshHome() {
  return envPath('DSH_HOME') ?? path.join(os.homedir(), '.dsh')
}

/** Every candidate module root, in priority order. */
function candidates() {
  const list = []
  const explicit = envPath('DSH_PROFILE_MODULES')
  if (explicit !== undefined) list.push({ root: explicit, label: 'DSH_PROFILE_MODULES' })
  list.push({ root: path.join(import.meta.dirname, '..', 'node_modules'), label: 'this checkout (npm install)' })
  list.push({ root: path.join(dshHome(), 'profiles', 'node_modules'), label: 'the DSH profile (DSH_HOME)' })
  list.push({ root: path.join(os.homedir(), '.dsh', 'profiles', 'node_modules'), label: 'the default DSH profile (~/.dsh)' })
  return list
}

/** Whether a directory holds an installed React (needed by the client test). */
function hasReact(root) {
  try {
    return fs.existsSync(path.join(root, 'react', 'package.json'))
  } catch {
    return false
  }
}

/** Whether a directory exists at all. */
function exists(root) {
  try {
    return fs.statSync(root).isDirectory()
  } catch {
    return false
  }
}

/**
 * Pick the module root to resolve through, or throw a readable error.
 *
 * React is required, not optional: the client test renders the browser half, so
 * a root without it cannot run the suite — saying so is friendlier than letting
 * the failure surface as `Cannot find package 'react'` from a temp file.
 */
function pickModulesRoot() {
  const all = candidates()
  const withReact = all.find((candidate) => exists(candidate.root) && hasReact(candidate.root))
  if (withReact !== undefined) return withReact.root
  const tried = all.map((candidate) => {
    const state = exists(candidate.root) ? (hasReact(candidate.root) ? 'react found' : 'no react') : 'missing'
    return `  - ${candidate.root}  (${candidate.label}: ${state})`
  })
  throw new Error(
    [
      'dsh-token-split tests: cannot find a module root that provides `react` and `react-dom`.',
      'Tried:',
      ...tried,
      '',
      'Fix it with either:',
      '  npm install                                       # installs the devDependencies in this repo',
      "  $env:DSH_PROFILE_MODULES='<path>/node_modules/'   # or point at a node_modules that has react",
      '',
      'The `@deepseek-ai/*` packages are only needed when a test imports them;',
      'the profile root is optional once `npm install` has run in this checkout.',
    ].join('\n'),
  )
}

const MODULES_ROOT = pickModulesRoot()

/** A parent URL inside the module root: Node resolves bare specifiers by walking up from it. */
const PARENT_URL = pathToFileURL(`${MODULES_ROOT.replace(/\/?$/, '/')}__dsh_test_parent__.js`).href

/**
 * Redirect `@deepseek-ai/*` imports to the profile's hoisted modules, plus the
 * React packages the browser-half test renders with.
 * @param {string} specifier - requested specifier.
 * @param {object} context - Node resolve context.
 * @param {(specifier: string, context: object) => Promise<object>} next - default resolver.
 * @returns {Promise<object>} the resolution.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') || specifier === 'react' || specifier === 'react-dom' || specifier.startsWith('react-dom/') || specifier.startsWith('react/')) {
    return next(specifier, { ...context, parentURL: PARENT_URL })
  }
  return next(specifier, context)
}
