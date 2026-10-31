import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { emptyLedger, LEDGER_VERSION, Ledger, ledgerPath } from '../lib/ledger.js'
import { usageKey } from '../lib/fold.js'
import { tempDir } from './helpers.mjs'

/** A sample with sane defaults. */
function sample(overrides = {}) {
  return {
    key: usageKey('s1', 1, 1),
    sessionId: 's1',
    turn: 1,
    step: 1,
    at: 1_700_000_000_000,
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    user: 'jerry',
    final: true,
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    ...overrides,
  }
}

test('emptyLedger carries the schema version and empty tables', () => {
  const ledger = emptyLedger(1234)
  assert.equal(ledger.version, LEDGER_VERSION)
  assert.deepEqual(ledger.records, {})
  assert.deepEqual(ledger.sessions, {})
  assert.equal(ledger.meta.createdAt, 1234)
})

test('a missing ledger file loads as empty without warnings', () => {
  const warnings = []
  const ledger = new Ledger(tempDir(), { warn: (message) => warnings.push(message) }).load()
  assert.equal(ledger.size, 0)
  assert.deepEqual(warnings, [])
})

test('records survive a flush and reload', async () => {
  const dir = tempDir()
  const ledger = new Ledger(dir).load()
  assert.equal(ledger.putRecord(sample()), true)
  await ledger.flush()

  const reloaded = new Ledger(dir).load()
  assert.equal(reloaded.size, 1)
  assert.equal(reloaded.records()[0].input, 100)
  assert.equal(reloaded.session('s1'), undefined)
})

test('putRecord applies step precedence', () => {
  const ledger = new Ledger(tempDir()).load()
  assert.equal(ledger.putRecord(sample({ final: false, input: 900 })), true)
  assert.equal(ledger.putRecord(sample({ final: true, input: 100 })), true)
  assert.equal(ledger.putRecord(sample({ final: false, input: 50 })), false)
  assert.equal(ledger.records()[0].input, 100)
})

test('putRecord is idempotent for a repeated finalized sample', () => {
  const ledger = new Ledger(tempDir()).load()
  assert.equal(ledger.putRecord(sample()), true)
  assert.equal(ledger.putRecord(sample()), false)
  assert.equal(ledger.size, 1)
})

test('putSession merges metadata and keeps the time span', () => {
  const ledger = new Ledger(tempDir()).load()
  ledger.putSession({ id: 's1', createdAt: 10, cwd: 'D:/work', firstAt: 500, lastAt: 900 })
  ledger.putSession({ id: 's1', title: '账单重构', firstAt: 400, lastAt: 1200 })
  const stored = ledger.session('s1')
  assert.equal(stored.createdAt, 10)
  assert.equal(stored.cwd, 'D:/work')
  assert.equal(stored.title, '账单重构')
  assert.equal(stored.firstAt, 400)
  assert.equal(stored.lastAt, 1200)
})

test('putSession ignores an entry without an id', () => {
  const ledger = new Ledger(tempDir()).load()
  assert.equal(ledger.putSession({ title: 'no id' }), false)
})

test('backfill markers are per lifecycle, not per id', () => {
  const ledger = new Ledger(tempDir()).load()
  assert.equal(ledger.isBackfilled('s1', 10), false)
  ledger.markBackfilled('s1', 10)
  assert.equal(ledger.isBackfilled('s1', 10), true)
  assert.equal(ledger.isBackfilled('s1', 11), false)
})

test('recordsBetween is a half-open window', () => {
  const ledger = new Ledger(tempDir()).load()
  ledger.putRecord(sample({ key: 'a', at: 100 }))
  ledger.putRecord(sample({ key: 'b', at: 200 }))
  ledger.putRecord(sample({ key: 'c', at: 300 }))
  assert.deepEqual(ledger.recordsBetween(100, 300).map((record) => record.key), ['a', 'b'])
})

test('an unreadable document is moved aside instead of overwritten', async () => {
  const dir = tempDir()
  const file = ledgerPath(dir)
  fs.writeFileSync(file, '{not json', 'utf8')
  const warnings = []
  const ledger = new Ledger(dir, { warn: (message) => warnings.push(message) }).load()
  assert.equal(ledger.size, 0)
  assert.equal(warnings.length, 1)
  assert.equal(fs.existsSync(file), false)
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt.bak.json'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{not json')

  ledger.putRecord(sample())
  await ledger.flush()
  assert.equal(new Ledger(dir).load().size, 1)
})

test('a document from another schema version is preserved', () => {
  const dir = tempDir()
  fs.writeFileSync(ledgerPath(dir), JSON.stringify({ version: 99, records: {} }), 'utf8')
  const warnings = []
  new Ledger(dir, { warn: (message) => warnings.push(message) }).load()
  assert.equal(warnings.length, 1)
  assert.equal(fs.existsSync(ledgerPath(dir)), false)
  assert.equal(fs.existsSync(ledgerPath(dir).replace(/\.json$/, '.v99.bak.json')), true)
})

test('the ledger is written atomically with private permissions', async () => {
  const dir = tempDir()
  const ledger = new Ledger(dir).load()
  ledger.putRecord(sample())
  await ledger.flush()
  const stat = fs.statSync(ledgerPath(dir))
  if (os.platform() !== 'win32') assert.equal(stat.mode & 0o777, 0o600)
  assert.ok(stat.size > 0)
})

test('dispose flushes a pending debounced write', async () => {
  const dir = tempDir()
  const ledger = new Ledger(dir).load()
  ledger.putRecord(sample())
  ledger.dispose()
  await ledger.flush()
  assert.equal(fs.existsSync(ledgerPath(dir)), true)
})
