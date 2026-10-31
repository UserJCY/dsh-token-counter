/**
 * Shared fixtures for the plugin tests: a minimal Cordis context stand-in and
 * session-event builders. Nothing here imports the plugin.
 */
import fs from 'node:fs'
import path from 'node:path'
import { after } from 'node:test'

/** Directories created by {@link tempDir}, removed when the file's tests finish. */
const created = []

after(() => {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // A leftover temp directory must never fail the suite.
    }
  }
})

/**
 * Create a throwaway directory inside the checkout and schedule its removal.
 * @param {string} [prefix] - directory name prefix.
 * @returns {string} absolute path.
 */
export function tempDir(prefix = 'tmp-') {
  const root = path.join(import.meta.dirname, '.tmp')
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, prefix))
  created.push(dir)
  return dir
}

/**
 * Build a fake host context exposing only what the plugin touches.
 * @param {object} [options] - fixture options.
 * @param {object} [options.services] - services `ctx.get()`/`ctx.inject()` resolve.
 * @returns {object} the fake context.
 */
export function createFakeContext({ services = {} } = {}) {
  const listeners = new Map()
  const disposers = []
  const warnings = []
  const registered = []

  const ctx = {
    // Like a real cordis context, services are reachable as properties; the
    // plugin uses `ctx.inject(...)` and then `webCtx.webServer`.
    ...services,
    logger: { warn: (message) => warnings.push(String(message)), info: (message) => warnings.push(String(message)) },
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(listener)
      return () => {}
    },
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    get(key) {
      return services[key]
    },
    inject(deps, factory) {
      const available = deps.every((dep) => (dep === 'tools' ? true : services[dep] !== undefined))
      if (available) factory(ctx)
      return () => {}
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    /** Deliver one event to every listener registered for it. */
    emit(type, ...args) {
      for (const listener of listeners.get(type) ?? []) listener(...args)
    },
    /** Run every effect disposer (plugin unload). */
    disposeAll() {
      for (const disposer of disposers.splice(0)) disposer()
    },
    warnings,
    registered,
    listeners,
  }
  return ctx
}

/** A live-session stand-in with the header fields the plugin reads. */
export function sessionStub({ id = 'session-1', depth = 0, cwd = 'D:/work', createdAt = 1_700_000_000_000, parent } = {}) {
  return {
    id,
    header: { id, createdAt, cwd, delegationDepth: depth, ...(parent === undefined ? {} : { parentSession: parent }) },
  }
}

/** A provider usage payload. */
export function usage({ input = 100, output = 20, cacheRead = 0, cacheWrite = 0, reasoning = 0 } = {}) {
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** An `assistant/message` event carrying provider usage. */
export function messageEvent({ turn = 1, step = 1, time = 1_700_000_001_000, provider = 'opencode-go', model = 'deepseek-v4.1-flash', usage: usageValue } = {}) {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: {
      turn,
      step,
      message: { source: { kind: 'model', provider, model } },
      usage: usageValue ?? usage(),
    },
  }
}

/** An `assistant/chunk` usage event. */
export function chunkEvent({ turn = 1, step = 1, time = 1_700_000_000_500, usage: usageValue } = {}) {
  return { type: 'assistant/chunk', seq: 1, time, data: { turn, step, chunk: { type: 'usage', usage: usageValue ?? usage() } } }
}

/** A `request/context` route event. */
export function contextEvent({ provider = 'opencode-go', model = 'deepseek-v4.1-flash', time = 1_700_000_000_000 } = {}) {
  return { type: 'request/context', seq: 1, time, data: { provider, model } }
}

/** A `session/title` event. */
export function titleEvent(title, time = 1_700_000_002_000) {
  return { type: 'session/title', seq: 1, time, data: { title, messageSeqs: [1], source: 'fallback' } }
}

/** Resolve after one macrotask plus a timer turn, enough for a debounced write. */
export function settle(ms = 120) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
