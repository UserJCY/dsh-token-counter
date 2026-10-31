/**
 * Reading persisted session logs straight off disk.
 *
 * Backfill used to go through `ctx.sessionQuery`, but that service is not
 * necessarily mounted when a host plugin applies — the desktop composition
 * activates rows in service-availability order — so the fold silently never
 * ran. The session store's on-disk format is simple and stable enough to read
 * directly: one directory per session under `<dsh home>/sessions`, and a log
 * that is either plain JSONL or a sequence of independent zstd frames (one per
 * append batch), so the decoder walks frame magic instead of trusting a single
 * stream.
 *
 * @module dsh-token-split/history
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** The zstd frame magic, `28 B5 2F FD`. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Log file names to try, newest format first. */
const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']

/**
 * Decode a session log made of concatenated zstd frames.
 * @param {Buffer} buffer - raw file bytes.
 * @returns {string} the concatenated JSONL text.
 */
export function decodeFrames(buffer) {
  const offsets = []
  let index = 0
  for (;;) {
    const found = buffer.indexOf(ZSTD_MAGIC, index)
    if (found < 0) break
    offsets.push(found)
    index = found + ZSTD_MAGIC.length
  }
  if (offsets.length === 0) return buffer.toString('utf8')
  const parts = []
  for (let frame = 0; frame < offsets.length; frame += 1) {
    const start = offsets[frame]
    const end = frame + 1 < offsets.length ? offsets[frame + 1] : buffer.length
    parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
  }
  return parts.join('')
}

/**
 * Read one session log as a header plus its events. The leading
 * `type: "session"` line is the header, not an event.
 * @param {string} file - absolute log path.
 * @returns {{ header: object | undefined, events: object[] }} parsed log.
 */
export function readSessionLog(file) {
  const text = file.endsWith('.zstd') ? decodeFrames(fs.readFileSync(file)) : fs.readFileSync(file, 'utf8')
  let header
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object') continue
    if (value.type === 'session') {
      header = value
      continue
    }
    events.push(value)
  }
  return { header, events }
}

/**
 * List every persisted session log under the session root.
 * @param {string} root - `<dsh home>/sessions`.
 * @returns {{ id: string, workspace: string, file: string }[]} logs, unsorted.
 */
export function listSessionLogs(root) {
  const logs = []
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return logs
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = path.join(root, workspace.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = path.join(workspaceDir, session.name)
      for (const name of LOG_NAMES) {
        const file = path.join(dir, name)
        if (fs.existsSync(file)) {
          logs.push({ id: session.name, workspace: workspace.name, file })
          break
        }
      }
    }
  }
  return logs
}
