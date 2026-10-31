import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { costWithRow, isPeak, loadPriceTable, MODEL_PRICING, PLANS, PriceTable } from '../lib/pricing.js'

/** A usage sample at a fixed instant. */
function sample({ model = 'deepseek-v4.1-flash', at = Date.UTC(2026, 9, 31, 12), input = 1_000_000, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  return { model, at, input, output, cacheRead, cacheWrite }
}

test('the built-in table covers the documented Go models', () => {
  const ids = MODEL_PRICING.map((row) => row.id)
  assert.ok(ids.includes('deepseek-v4.1-flash'))
  assert.ok(ids.includes('deepseek-v4-pro'))
  assert.ok(ids.includes('kimi-k3.1-pro'))
  assert.ok(ids.includes('gemini-4-argon'))
  assert.equal(ids.length, 30)
  assert.equal(PLANS.go, 10)
  assert.equal(PLANS.plus, 40)
})

test('isPeak follows the DeepSeek UTC weekday windows', () => {
  // 2026-10-30 is a Friday.
  assert.equal(isPeak(Date.UTC(2026, 9, 30, 2, 30)), true)
  assert.equal(isPeak(Date.UTC(2026, 9, 30, 7, 30)), true)
  assert.equal(isPeak(Date.UTC(2026, 9, 30, 5, 0)), false)
  assert.equal(isPeak(Date.UTC(2026, 9, 30, 12, 0)), false)
  // Weekend, even inside a peak hour.
  assert.equal(isPeak(Date.UTC(2026, 9, 31, 2, 30)), false)
  assert.equal(isPeak(Date.UTC(2026, 10, 1, 7, 30)), false)
})

test('costWithRow prices each bucket per 1M tokens', () => {
  const row = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 }
  assert.equal(costWithRow({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }, row), 0.753)
})

test('a DeepSeek sample is priced off-peak or peak by its timestamp', () => {
  const table = new PriceTable()
  const offPeak = table.price(sample({ at: Date.UTC(2026, 9, 31, 12) }))
  const peak = table.price(sample({ at: Date.UTC(2026, 9, 30, 7) }))
  assert.equal(offPeak.peak, false)
  assert.equal(peak.peak, true)
  assert.equal(offPeak.usd, 0.15)
  assert.equal(peak.usd, 0.3)
})

test('a model without peak pricing ignores the timestamp', () => {
  const table = new PriceTable()
  const row = table.price(sample({ model: 'kimi-k3', at: Date.UTC(2026, 9, 30, 7) }))
  assert.equal(row.peak, false)
  assert.equal(row.usd, 3)
})

test('resolve follows exact ids, aliases, build suffixes and prefixes', () => {
  const table = new PriceTable()
  assert.equal(table.resolve('deepseek-v4.1-flash').viaAlias, false)
  assert.equal(table.resolve('deepseek-flash').matchedId, 'deepseek-v4.1-flash')
  assert.equal(table.resolve('deepseek-flash').viaAlias, true)
  assert.equal(table.resolve('deepseek-v4.1-flash-1017').matchedId, 'deepseek-v4.1-flash')
  assert.equal(table.resolve('kimi-k3-2026').matchedId, 'kimi-k3')
  assert.equal(table.resolve('totally-unknown'), undefined)
  assert.equal(table.resolve(''), undefined)
})

test('resolve prefers the longest prefix so pro never wins over flash', () => {
  const table = new PriceTable()
  assert.equal(table.resolve('deepseek-v4.1-flash-extra').matchedId, 'deepseek-v4.1-flash')
})

test('price reports an unpriced model as zero cost with no row', () => {
  const priced = new PriceTable().price(sample({ model: 'unknown-model' }))
  assert.equal(priced.row, undefined)
  assert.equal(priced.usd, 0)
})

test('limitOf returns the monthly Go allowance', () => {
  const table = new PriceTable()
  assert.equal(table.limitOf('deepseek-v4.1-flash'), 100)
  assert.equal(table.limitOf('kimi-k3'), 15)
  assert.equal(table.limitOf('unknown'), undefined)
})

test('labelOf falls back to the raw id', () => {
  const table = new PriceTable()
  assert.equal(table.labelOf('deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash')
  assert.equal(table.labelOf('mystery'), 'mystery')
})

test('user overrides merge over the built-in table', () => {
  const table = new PriceTable({
    models: [...MODEL_PRICING, { id: 'my-model', label: 'My Model', input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, monthlyLimit: 5 }],
    aliases: { 'deepseek-flash': 'my-model' },
  })
  assert.equal(table.limitOf('my-model'), 5)
  assert.equal(table.resolve('deepseek-flash').matchedId, 'my-model')
})

test('loadPriceTable reads a pricing.json from the data directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-pricing-'))
  fs.writeFileSync(
    path.join(dir, 'pricing.json'),
    JSON.stringify({ models: { 'house-model': { label: 'House', input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0, monthlyLimit: 12 } } }),
  )
  const table = loadPriceTable({ dataDir: dir })
  assert.equal(table.limitOf('house-model'), 12)
  assert.equal(table.resolve('deepseek-v4.1-flash').matchedId, 'deepseek-v4.1-flash')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadPriceTable survives a broken override file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dts-pricing-'))
  fs.writeFileSync(path.join(dir, 'pricing.json'), '{oops')
  const warnings = []
  const table = loadPriceTable({ dataDir: dir, warn: (message) => warnings.push(message) })
  assert.equal(table.limitOf('deepseek-v4.1-flash'), 100)
  assert.equal(warnings.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})
