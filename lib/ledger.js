/**
 * The on-disk usage ledger.
 *
 * One JSON document per machine under `<dsh home>/token-split/ledger.json`:
 *
 *   { version, meta, sessions, records }
 *
 * `records` is keyed by `usageKey()` and holds one sample per billable step;
 * `sessions` holds the display metadata (title, cwd, depth) the report needs;
 * `meta.backfilled` remembers which session lifecycle was already folded from
 * history so a restart does not rescan every log.
 *
 * Writes are debounced and committed with an atomic rename, so a crash leaves
 * either the previous or the next complete document. The file is private to
 * the user account (`0o600`).
 *
 * @module dsh-token-split/ledger
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsutil.js'
import { shouldReplace } from './fold.js'

/** Schema version of the ledger document. */
export const LEDGER_VERSION = 1

/** File name inside the plugin's data directory. */
export const LEDGER_FILE = 'ledger.json'

/** Default debounce for coalescing live writes. */
export const SAVE_DELAY_MS = 1500

/**
 * A fresh, empty ledger document.
 * @param {number} now - current epoch milliseconds.
 * @returns {object} empty document.
 */
export function emptyLedger(now = Date.now()) {
  return {
    version: LEDGER_VERSION,
    meta: {
      createdAt: now,
      updatedAt: now,
      lastBackfillAt: 0,
      lastBackfillError: '',
      backfilled: {},
    },
    sessions: {},
    records: {},
  }
}

/**
 * Resolve the ledger file for one data directory.
 * @param {string} dir - plugin data directory.
 * @returns {string} absolute file path.
 */
export function ledgerPath(dir) {
  return path.join(dir, LEDGER_FILE)
}

/** Whether a value is a plain object (never an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The usage ledger: authoritative in-memory state plus a debounced atomic
 * writer. Every mutator is synchronous so it can run inside a session event
 * listener; only `flush()` touches the disk.
 */
export class Ledger {
  /**
   * @param {string} dir - plugin data directory (created on first save).
   * @param {object} [options] - construction options.
   * @param {(message: string) => void} [options.warn] - diagnostic sink.
   * @param {() => number} [options.now] - clock, injectable for tests.
   */
  constructor(dir, { warn = () => {}, now = Date.now } = {}) {
    this.dir = dir
    this.file = ledgerPath(dir)
    this.warn = warn
    this.now = now
    this.data = emptyLedger(now())
    this.dirty = false
    this.timer = undefined
    this.chain = Promise.resolve()
  }

  /**
   * Read the document from disk, tolerating absence. A document this build
   * cannot understand (other version, corrupt JSON) is moved aside instead of
   * being overwritten, so a downgrade never destroys the user's history.
   * @returns {this} the ledger, for chaining.
   */
  load() {
    let text
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') this.warn(`token-split: cannot read ${this.file}: ${String(error)}`)
      return this
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.setAside('corrupt')
      this.warn(`token-split: ledger at ${this.file} is not valid JSON, moved aside: ${String(error)}`)
      return this
    }
    if (!isPlainObject(parsed) || parsed.version !== LEDGER_VERSION) {
      this.setAside(`v${isPlainObject(parsed) ? String(parsed.version) : 'unknown'}`)
      this.warn(`token-split: ledger at ${this.file} has an unsupported version, moved aside`)
      return this
    }
    const base = emptyLedger(this.now())
    this.data = {
      version: LEDGER_VERSION,
      meta: { ...base.meta, ...(isPlainObject(parsed.meta) ? parsed.meta : {}) },
      sessions: isPlainObject(parsed.sessions) ? parsed.sessions : {},
      records: isPlainObject(parsed.records) ? parsed.records : {},
    }
    if (!isPlainObject(this.data.meta.backfilled)) this.data.meta.backfilled = {}
    return this
  }

  /** Rename an unusable document to a sibling backup so the next save cannot clobber it. */
  setAside(reason) {
    try {
      fs.renameSync(this.file, this.file.replace(/\.json$/, `.${reason}.bak.json`))
    } catch {
      // A backup is best effort: a missing file or a locked one must not stop the plugin.
    }
  }

  /** Number of recorded steps. */
  get size() {
    return Object.keys(this.data.records).length
  }

  /**
   * Record one usage sample, applying step precedence.
   * @param {object} sample - folded usage sample.
   * @returns {boolean} whether the ledger changed.
   */
  putRecord(sample) {
    const previous = this.data.records[sample.key]
    if (!shouldReplace(previous, sample)) return false
    this.data.records[sample.key] = sample
    this.touch()
    return true
  }

  /**
   * Merge display metadata for one session.
   * @param {object} entry - session metadata; `id` is required.
   * @returns {boolean} whether the ledger changed.
   */
  putSession(entry) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) return false
    const previous = this.data.sessions[entry.id] ?? { id: entry.id }
    const next = { ...previous }
    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined || value === null || value === '') continue
      next[key] = value
    }
    next.firstAt = minDefined(previous.firstAt, entry.firstAt)
    next.lastAt = maxDefined(previous.lastAt, entry.lastAt)
    if (sameJson(previous, next)) return false
    this.data.sessions[entry.id] = next
    this.touch()
    return true
  }

  /**
   * Remember that one session lifecycle was folded from history.
   * @param {string} sessionId - session id.
   * @param {number} createdAt - lifecycle marker from the session header.
   */
  markBackfilled(sessionId, createdAt) {
    this.data.meta.backfilled[sessionId] = createdAt
    this.data.meta.lastBackfillAt = this.now()
    this.touch()
  }

  /** Whether this exact lifecycle was already folded. */
  isBackfilled(sessionId, createdAt) {
    return this.data.meta.backfilled[sessionId] === createdAt
  }

  /** All recorded samples. */
  records() {
    return Object.values(this.data.records)
  }

  /** Recorded samples whose timestamp falls inside `[start, end)`. */
  recordsBetween(start, end) {
    return this.records().filter((record) => record.at >= start && record.at < end)
  }

  /** Display metadata for one session, if known. */
  session(sessionId) {
    return this.data.sessions[sessionId]
  }

  /** Mark the document dirty and arm the debounced writer. */
  touch() {
    this.data.meta.updatedAt = this.now()
    this.dirty = true
    this.scheduleSave()
  }

  /**
   * Arm the debounced writer. A pending timer is left alone so a burst of
   * events produces one write, not one per event.
   * @param {number} [delayMs] - debounce window.
   */
  scheduleSave(delayMs = SAVE_DELAY_MS) {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush().catch((error) => this.warn(`token-split: ledger save failed: ${String(error)}`))
    }, delayMs)
    // Never hold the host process open for a bookkeeping write.
    this.timer.unref?.()
  }

  /** Cancel a pending debounce and commit now. */
  async flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.chain = this.chain.catch(() => {}).then(() => this.write())
    return this.chain
  }

  /** One atomic commit of the whole document. */
  async write() {
    if (!this.dirty) return
    this.dirty = false
    const body = JSON.stringify(this.data)
    try {
      await writeFileAtomic(this.file, body, { mode: 0o600, dirMode: 0o700 })
    } catch (error) {
      this.dirty = true
      throw error
    }
  }

  /** Stop the timer and make a best-effort final commit (used on unload). */
  dispose() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty) return
    this.flush().catch((error) => this.warn(`token-split: final ledger save failed: ${String(error)}`))
  }
}

/** Smaller of two possibly-undefined numbers. */
function minDefined(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

/** Larger of two possibly-undefined numbers. */
function maxDefined(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

/** Structural comparison for small JSON records. */
function sameJson(a, b) {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
