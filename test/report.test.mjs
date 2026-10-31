import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregate,
  computeSplit,
  cycleStartAt,
  dateKey,
  formatMoney,
  formatNumber,
  formatPercent,
  formatUsd,
  parseDateKey,
  renderReport,
  resolveWindow,
  toCsv,
  windowLabel,
} from '../lib/report.js'
import { PriceTable } from '../lib/pricing.js'
import { usageKey } from '../lib/fold.js'

const TABLE = new PriceTable()
const DAY = 24 * 60 * 60 * 1000

/** A sample at a fixed local time, off-peak by default. */
function sample({
  at,
  input = 1_000_000,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
  model = 'deepseek-v4.1-flash',
  provider = 'opencode-go',
  sessionId = 's1',
  user = 'jerry',
  turn = 1,
  step = 1,
} = {}) {
  return {
    key: usageKey(sessionId, turn, step),
    sessionId,
    turn,
    step,
    at,
    provider,
    model,
    user,
    final: true,
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: 0,
  }
}

/** An off-peak UTC noon instant on a weekday. */
function offPeak(at = new Date(2026, 9, 2, 20).getTime()) {
  return at
}

test('parseDateKey accepts real dates and rejects malformed ones', () => {
  assert.equal(parseDateKey('2026-10-31'), new Date(2026, 9, 31).getTime())
  assert.equal(parseDateKey('2026-02-30'), undefined)
  assert.equal(parseDateKey('2026/10/31'), undefined)
  assert.equal(parseDateKey(undefined), undefined)
})

test('dateKey renders local calendar days', () => {
  assert.equal(dateKey(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05')
})

test('cycleStartAt stays in the current month once the day has passed', () => {
  assert.equal(cycleStartAt(new Date(2026, 9, 20), 15), new Date(2026, 9, 15).getTime())
})

test('cycleStartAt falls back to the previous month before the day', () => {
  assert.equal(cycleStartAt(new Date(2026, 9, 3), 15), new Date(2026, 8, 15).getTime())
})

test('cycleStartAt wraps across the year boundary', () => {
  assert.equal(cycleStartAt(new Date(2026, 0, 3), 15), new Date(2025, 11, 15).getTime())
})

test('cycleStartAt clamps the configured day to 1–28', () => {
  assert.equal(cycleStartAt(new Date(2026, 9, 20), 99), new Date(2026, 8, 28).getTime())
  assert.equal(cycleStartAt(new Date(2026, 9, 30), 99), new Date(2026, 9, 28).getTime())
  assert.equal(cycleStartAt(new Date(2026, 9, 20), 0), new Date(2026, 9, 1).getTime())
})

test('resolveWindow returns the cycle window and a readable label', () => {
  const window = resolveWindow({ period: 'cycle', cycleStartDay: 15, now: new Date(2026, 9, 31) })
  assert.equal(window.start, new Date(2026, 9, 15).getTime())
  assert.equal(window.end, new Date(2026, 10, 15).getTime())
  assert.equal(window.label, '2026-10-15 ~ 2026-11-14')
})

test('resolveWindow supports today, month, rolling and all', () => {
  const now = new Date(2026, 9, 31, 12)
  const today = resolveWindow({ period: 'today', now })
  assert.equal(today.start, new Date(2026, 9, 31).getTime())
  assert.equal(today.end, new Date(2026, 10, 1).getTime())

  const month = resolveWindow({ period: 'month', now })
  assert.equal(month.start, new Date(2026, 9, 1).getTime())
  assert.equal(month.end, new Date(2026, 10, 1).getTime())

  const last7 = resolveWindow({ period: 'last7', now })
  assert.equal(last7.start, new Date(2026, 9, 25).getTime())
  assert.equal(last7.end, new Date(2026, 10, 1).getTime())

  const all = resolveWindow({ period: 'all', now })
  assert.equal(all.start, 0)
  assert.equal(all.end, Number.POSITIVE_INFINITY)
  assert.equal(all.label, '全部历史')
})

test('resolveWindow honours explicit since/until inclusively', () => {
  const window = resolveWindow({ since: '2026-10-01', until: '2026-10-31', now: new Date(2026, 10, 5) })
  assert.equal(window.start, new Date(2026, 9, 1).getTime())
  assert.equal(window.end, new Date(2026, 10, 1).getTime())
  assert.equal(window.period, 'custom')
  assert.equal(window.explicit, true)
})

test('windowLabel marks an open lower bound', () => {
  assert.equal(windowLabel(0, new Date(2026, 9, 31).getTime()), '截至 2026-10-30')
})

test('aggregate prices with the Go table and excludes samples outside the window', () => {
  const start = new Date(2026, 9, 1).getTime()
  const end = new Date(2026, 10, 1).getTime()
  const records = [
    sample({ at: start + DAY, input: 1_000_000, output: 100_000 }),
    sample({ at: start + DAY, input: 500_000, sessionId: 's2', turn: 2 }),
    sample({ at: start + 2 * DAY, input: 2_000_000, model: 'kimi-k3', sessionId: 's3' }),
    sample({ at: end + DAY, input: 9_000_000 }),
  ]
  const result = aggregate(records, { start, end, priceTable: TABLE })
  assert.equal(result.totals.calls, 3)
  assert.equal(result.totals.input, 3_500_000)
  assert.equal(result.totals.tokens, 3_600_000)
  assert.equal(result.totals.sessions, 3)
  // DeepSeek V4.1 Flash off-peak: $0.15/M input, $0.60/M output. Kimi K3: $3/M input.
  assert.equal(Number(result.totals.cost.toFixed(6)), 6.285)
  assert.equal(result.byDay.length, 2)
  assert.equal(result.byDay[0].key, '2026-10-02')
  assert.equal(result.byModel[0].key, 'kimi-k3')
  assert.equal(result.bySession[0].tokens, 2_000_000)
})

test('aggregate only counts the configured providers', () => {
  const at = offPeak()
  const records = [
    sample({ at, input: 1_000_000, provider: 'opencode-go' }),
    sample({ at, input: 5_000_000, provider: 'qianfan', sessionId: 's2', turn: 2 }),
  ]
  const only = aggregate(records, { start: 0, end: Number.POSITIVE_INFINITY, priceTable: TABLE, providers: ['opencode-go'] })
  assert.equal(only.totals.calls, 1)
  assert.equal(only.totals.input, 1_000_000)

  const all = aggregate(records, { start: 0, end: Number.POSITIVE_INFINITY, priceTable: TABLE, providers: [] })
  assert.equal(all.totals.calls, 2)
})

test('aggregate flags unpriced models without charging them', () => {
  const at = offPeak()
  const result = aggregate([sample({ at, model: 'mystery-model' })], { start: 0, end: Number.POSITIVE_INFINITY, priceTable: TABLE })
  assert.equal(result.totals.cost, 0)
  assert.equal(result.totals.unpricedCalls, 1)
  assert.equal(result.totals.unpricedTokens, 1_000_000)
  assert.equal(result.byModel[0].limit, undefined)
})

test('aggregate carries the monthly allowance on model rows', () => {
  const at = offPeak()
  const result = aggregate([sample({ at })], { start: 0, end: Number.POSITIVE_INFINITY, priceTable: TABLE })
  assert.equal(result.byModel[0].limit, 100)
  assert.equal(result.byModel[0].label, 'DeepSeek V4.1 Flash')
})

test('aggregate groups by user so a shared machine stays separable', () => {
  const at = offPeak()
  const result = aggregate([sample({ at, user: 'jerry' }), sample({ at, user: 'friend', turn: 2 })], {
    start: 0,
    end: Number.POSITIVE_INFINITY,
    priceTable: TABLE,
  })
  assert.deepEqual(result.byUser.map((row) => row.key).sort(), ['friend', 'jerry'])
})

test('computeSplit divides a fee by share', () => {
  const split = computeSplit({ mine: 0.75, other: 0.25, fee: 10 })
  assert.equal(split.share, 0.75)
  assert.equal(split.mine, 7.5)
  assert.equal(split.other, 2.5)
})

test('computeSplit refuses a zero total', () => {
  assert.equal(computeSplit({ mine: 0, other: 0, fee: 10 }), null)
})

test('formatting helpers are stable and locale-free', () => {
  assert.equal(formatNumber(1234567), '1,234,567')
  assert.equal(formatNumber(999), '999')
  assert.equal(formatMoney(18.5, '$'), '$18.50')
  assert.equal(formatPercent(0.6234), '62.3%')
  assert.equal(formatUsd(0), '$0')
  assert.equal(formatUsd(0.00234), '$0.0023')
  assert.equal(formatUsd(0.2345), '$0.234')
  assert.equal(formatUsd(12.345), '$12.35')
})

test('renderReport states the cost and the split', () => {
  const start = new Date(2026, 9, 1).getTime()
  const end = new Date(2026, 10, 1).getTime()
  const window = { start, end, label: '2026-10-01 ~ 2026-10-31', period: 'cycle', explicit: false }
  const aggregation = aggregate([sample({ at: start + DAY, input: 1_000_000, output: 1_000_000 })], {
    start,
    end,
    priceTable: TABLE,
  })
  const config = { user: 'jerry', monthlyFee: 10, providers: ['opencode-go'] }
  const split = computeSplit({ mine: aggregation.totals.cost, other: 0.25, fee: 10 })
  const report = renderReport({ window, aggregation, detail: 'summary', config, split, otherCost: 0.25, basis: 'cost', ledger: undefined, dataFile: 'C:/x/ledger.json' })
  assert.match(report, /本机用量/)
  assert.match(report, /来源 `opencode-go`/)
  assert.match(report, /\$0\.750/)
  assert.match(report, /你应付/)
  assert.match(report, /DeepSeek V4\.1 Flash/)
  assert.match(report, /C:\/x\/ledger\.json/)
})

test('renderReport warns about unpriced calls', () => {
  const start = new Date(2026, 9, 1).getTime()
  const end = new Date(2026, 10, 1).getTime()
  const window = { start, end, label: 'x', period: 'cycle', explicit: false }
  const aggregation = aggregate([sample({ at: start + DAY, model: 'mystery' })], { start, end, priceTable: TABLE })
  const config = { user: 'jerry', monthlyFee: 0, providers: ['opencode-go'] }
  const report = renderReport({ window, aggregation, detail: 'summary', config, split: null, otherCost: undefined, basis: 'cost' })
  assert.match(report, /没有匹配到价目表/)
  assert.match(report, /未配置月费/)
})

test('renderReport renders the session table with ledger titles', () => {
  const start = new Date(2026, 9, 1).getTime()
  const end = new Date(2026, 10, 1).getTime()
  const window = { start, end, label: 'x', period: 'cycle', explicit: false }
  const aggregation = aggregate([sample({ at: start + DAY, sessionId: 's1' })], { start, end, priceTable: TABLE })
  const ledger = { session: (id) => (id === 's1' ? { title: '账单重构' } : undefined) }
  const config = { user: 'jerry', monthlyFee: 0, providers: [] }
  const report = renderReport({ window, aggregation, detail: 'sessions', config, split: null, otherCost: undefined, basis: 'cost', ledger })
  assert.match(report, /账单重构/)
})

test('toCsv emits a header and one row per sample', () => {
  const ledger = { session: () => ({ title: '账单, 重构' }) }
  const csv = toCsv([sample({ at: new Date(2026, 9, 2, 10).getTime(), input: 10, output: 5 })], ledger)
  const lines = csv.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^date,time,session,title,turn,step,provider,model,user,input/)
  assert.match(lines[1], /"账单, 重构"/)
  assert.match(lines[1], /,15$/)
})

