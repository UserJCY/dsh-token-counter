#!/usr/bin/env node
/**
 * Offline cross-check of the fold against the session logs on this machine.
 *
 * Reads every persisted session log under `<dsh home>/sessions`, folds it with
 * the same `lib/fold.js` the plugin uses at runtime, and prints a per-day
 * table. Compare it with a ledger produced by another cost plugin (or with the
 * provider's own dashboard) to confirm the numbers agree before trusting a
 * bill.
 *
 *   node --import ./test/register.mjs scripts/verify-history.mjs [--since YYYY-MM-DD]
 *
 * The session store is a sequence of independent zstd frames, one per append
 * batch, so the decoder walks frame magic instead of trusting a single stream.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { dshHomePath } from '../lib/fsutil.js'
import { foldSessionEvents } from '../lib/fold.js'
import { PriceTable } from '../lib/pricing.js'
import { dateKey, formatNumber, formatUsd } from '../lib/report.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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
 * Read one session log as events (the leading `type: "session"` header line is
 * not an event).
 * @param {string} file - log path.
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
    if (value && value.type === 'session') {
      header = value
      continue
    }
    events.push(value)
  }
  return { header, events }
}

/** Every persisted session log under the DSH home. */
export function listSessionLogs(home = dshHomePath('sessions')) {
  const logs = []
  let workspaces = []
  try {
    workspaces = fs.readdirSync(home, { withFileTypes: true })
  } catch {
    return logs
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = path.join(home, workspace.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = path.join(workspaceDir, session.name)
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
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

/** Sum folded samples by local day, priced with the Go table. */
export function summarise(records, priceTable) {
  const days = new Map()
  for (const record of records) {
    const priced = priceTable.price(record)
    const day = dateKey(record.at)
    if (!days.has(day)) days.set(day, { day, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: new Set() })
    const entry = days.get(day)
    entry.calls += 1
    entry.input += record.input
    entry.output += record.output
    entry.cacheRead += record.cacheRead
    entry.cacheWrite += record.cacheWrite
    entry.cost += priced.usd
    entry.sessions.add(record.sessionId)
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
}

/** CLI entry point. */
function main() {
  const sinceIndex = process.argv.indexOf('--since')
  const since = sinceIndex > 0 ? new Date(`${process.argv[sinceIndex + 1]}T00:00:00`).getTime() : 0
  const providerIndex = process.argv.indexOf('--provider')
  const provider = providerIndex > 0 ? process.argv[providerIndex + 1] : 'opencode-go'
  const table = new PriceTable()
  const logs = listSessionLogs()
  const records = []
  let failed = 0
  for (const log of logs) {
    try {
      const { header, events } = readSessionLog(log.file)
      const folded = foldSessionEvents({
        sessionId: log.id,
        events,
        user: 'verify',
        includeSubagents: true,
        delegationDepth: header?.delegationDepth ?? 0,
      })
      records.push(...folded.records)
    } catch (error) {
      failed += 1
      console.warn(`skip ${log.id}: ${String(error)}`)
    }
  }
  const providers = new Map()
  for (const record of records) providers.set(record.provider || '(none)', (providers.get(record.provider || '(none)') ?? 0) + 1)
  const kept = records.filter((record) => (provider === 'all' ? true : record.provider === provider) && record.at >= since)
  const days = summarise(kept, table)
  console.log(`sessions=${logs.length} read_failed=${failed} steps=${records.length} kept=${kept.length} provider=${provider}`)
  console.log(`providers in history: ${[...providers.entries()].map(([name, count]) => `${name || '(none)'}=${count}`).join(' ')}`)
  console.log('day          calls      input     output  cacheRead cacheWrite     costUSD  sessions')
  for (const day of days) {
    console.log(
      `${day.day}  ${String(day.calls).padStart(6)}  ${formatNumber(day.input).padStart(10)}  ${formatNumber(day.output).padStart(9)}  ${formatNumber(day.cacheRead).padStart(10)}  ${formatNumber(day.cacheWrite).padStart(9)}  ${formatUsd(day.cost).padStart(10)}  ${String(day.sessions.size).padStart(8)}`,
    )
  }
  const total = days.reduce(
    (acc, day) => ({
      calls: acc.calls + day.calls,
      input: acc.input + day.input,
      output: acc.output + day.output,
      cacheRead: acc.cacheRead + day.cacheRead,
      cacheWrite: acc.cacheWrite + day.cacheWrite,
      cost: acc.cost + day.cost,
    }),
    { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  )
  console.log(
    `total     ${String(total.calls).padStart(6)}  ${formatNumber(total.input).padStart(10)}  ${formatNumber(total.output).padStart(9)}  ${formatNumber(total.cacheRead).padStart(10)}  ${formatNumber(total.cacheWrite).padStart(9)}  ${formatUsd(total.cost).padStart(10)}`,
  )

  const models = new Map()
  for (const record of kept) {
    const priced = table.price(record)
    const key = `${record.model} -> ${priced.matchedId ?? '(unpriced)'}`
    const entry = models.get(key) ?? { calls: 0, tokens: 0, cost: 0 }
    entry.calls += 1
    entry.tokens += record.input + record.output + record.cacheRead + record.cacheWrite
    entry.cost += priced.usd
    models.set(key, entry)
  }
  console.log('\nmodel -> price row                          calls        tokens      costUSD   limit')
  for (const [key, entry] of [...models.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    const modelId = key.split(' -> ')[0]
    const limit = table.limitOf(modelId)
    console.log(
      `${key.padEnd(44)} ${String(entry.calls).padStart(6)}  ${formatNumber(entry.tokens).padStart(12)}  ${formatUsd(entry.cost).padStart(10)}  ${limit === undefined ? '—' : Number.isFinite(limit) ? `$${limit}` : '∞'}`,
    )
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
