import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregate,
  computeSplit,
  cycleStartAt,
  dateKey,
  formatAllowanceLine,
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
import { MODEL_PRICING, PriceTable } from '../lib/pricing.js'
import { usageKey } from '../lib/fold.js'
import { createSessionResolver } from '../lib/timeline.js'

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
  user = 'alice',
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
  assert.equal(result.byModel[0].key, 'opencode-go/kimi-k3')
  assert.equal(result.byModel[0].provider, 'opencode-go')
  assert.equal(result.byModel[0].model, 'kimi-k3')
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
  const result = aggregate([sample({ at, user: 'alice' }), sample({ at, user: 'friend', turn: 2 })], {
    start: 0,
    end: Number.POSITIVE_INFINITY,
    priceTable: TABLE,
  })
  assert.deepEqual(result.byUser.map((row) => row.key).sort(), ['alice', 'friend'])
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
  // Below $1 the shared rule is three decimals; from $100 whole dollars.
  assert.equal(formatUsd(0.00234), '$0.002')
  assert.equal(formatUsd(0.2345), '$0.234')
  assert.equal(formatUsd(12.345), '$12.35')
  assert.equal(formatUsd(1234.5), '$1235')
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
  const config = { user: 'alice', monthlyFee: 10, providers: ['opencode-go'] }
  const split = computeSplit({ mine: aggregation.totals.cost, other: 0.25, fee: 10 })
  const report = renderReport({ window, aggregation, detail: 'summary', config, split, otherCost: 0.25, basis: 'cost', ledger: undefined, dataFile: '<data-dir>/token-split/ledger.json' })
  assert.match(report, /本机用量/)
  assert.match(report, /来源 `opencode-go`/)
  assert.match(report, /\$0\.750/)
  assert.match(report, /你应付/)
  assert.match(report, /\$0\.750 \/ 0\.75%/)
  assert.match(report, /占 Go 月度额度/)
  assert.match(report, /额度窗口（占月额度）：5h/)
  assert.match(report, /DeepSeek V4\.1 Flash/)
  assert.match(report, /<data-dir>\/token-split\/ledger\.json/)
})

test('renderReport warns about unpriced calls', () => {
  const start = new Date(2026, 9, 1).getTime()
  const end = new Date(2026, 10, 1).getTime()
  const window = { start, end, label: 'x', period: 'cycle', explicit: false }
  const aggregation = aggregate([sample({ at: start + DAY, model: 'mystery' })], { start, end, priceTable: TABLE })
  const config = { user: 'alice', monthlyFee: 0, providers: ['opencode-go'] }
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
  const config = { user: 'alice', monthlyFee: 0, providers: [] }
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

test('aggregate groups models by provider/model so one alias cannot share a row', () => {
  const at = offPeak()
  const records = [
    sample({ at, provider: 'opencode-go' }),
    sample({ at, provider: 'deepseek-official', sessionId: 's2', turn: 2 }),
  ]
  const result = aggregate(records, { start: 0, end: Number.POSITIVE_INFINITY, priceTable: TABLE, providers: [] })
  assert.deepEqual(result.byModel.map((row) => row.key).sort(), [
    'deepseek-official/deepseek-v4.1-flash',
    'opencode-go/deepseek-v4.1-flash',
  ])
  assert.deepEqual(result.byModel.map((row) => row.provider).sort(), ['deepseek-official', 'opencode-go'])
  assert.deepEqual([...new Set(result.byModel.map((row) => row.model))], ['deepseek-v4.1-flash'])
})

test('the plan share is the sum of per-model shares, not totalCost over summed limits', () => {
  const at = offPeak()
  // V4.1 Flash: $0.15/M input against a $100 allowance; Kimi K3: $3/M against $15.
  const result = aggregate(
    [
      sample({ at, input: 10_000_000 }), // $1.50 → 1.5%
      sample({ at, input: 1_000_000, model: 'kimi-k3', sessionId: 's2', turn: 2 }), // $3 → 20%
    ],
    { start: 0, end: Number.POSITIVE_INFINITY, priceTable: TABLE },
  )
  const deepseek = result.byModel.find((row) => row.model === 'deepseek-v4.1-flash')
  const kimi = result.byModel.find((row) => row.model === 'kimi-k3')
  assert.equal(Number(deepseek.share.toFixed(6)), 0.015)
  assert.equal(Number(kimi.share.toFixed(6)), 0.2)
  assert.equal(Number(result.totals.share.toFixed(6)), 0.215)
  assert.equal(result.totals.limitKnown, true)
  // The wrong formula — totalCost / Σlimit = 4.5 / 115 — would read 3.91%.
  assert.notEqual(Number(result.totals.share.toFixed(4)), Number((4.5 / 115).toFixed(4)))
  assert.equal(result.byModel[0].key, 'opencode-go/kimi-k3')
  assert.equal(result.byModel[0].priced, true)
  assert.equal(result.byModel[0].free, false)
  assert.equal(result.byModel[0].tokenShare, 1 / 11)
})

test('unpriced and free models stay out of the plan share', () => {
  const at = offPeak()
  const result = aggregate(
    [
      sample({ at, input: 1_000_000 }),
      sample({ at, input: 5_000_000, model: 'beam-free', sessionId: 's2', turn: 2 }),
      sample({ at, input: 2_000_000, model: 'mystery', sessionId: 's3', turn: 3 }),
    ],
    { start: 0, end: Number.POSITIVE_INFINITY, priceTable: TABLE },
  )
  assert.equal(Number(result.totals.share.toFixed(6)), 0.0015)
  assert.deepEqual(result.unpriced, { calls: 1, tokens: 2_000_000 })
  const free = result.byModel.find((row) => row.model === 'beam-free')
  assert.equal(free.free, true)
  assert.equal(free.priced, true)
  assert.equal(free.cost, 0)
  assert.equal(free.share, undefined)
  assert.equal(free.limit, undefined)
  const unpriced = result.byModel.find((row) => row.model === 'mystery')
  assert.equal(unpriced.priced, false)
  assert.equal(unpriced.share, undefined)
  assert.equal(unpriced.limit, undefined)
  assert.equal(result.byModel.at(-1).model, 'mystery')
})

test('limitKnown turns false when a priced model has no allowance', () => {
  const table = new PriceTable({
    models: [...MODEL_PRICING, { id: 'house-model', label: 'House', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
  })
  const result = aggregate([sample({ at: offPeak(), model: 'house-model' })], {
    start: 0,
    end: Number.POSITIVE_INFINITY,
    priceTable: table,
  })
  assert.equal(result.byModel[0].priced, true)
  assert.equal(result.byModel[0].limit, undefined)
  assert.equal(result.byModel[0].share, undefined)
  assert.equal(result.totals.share, 0)
  assert.equal(result.totals.limitKnown, false)
})

test('month is the local calendar month and equals cycle when the cycle starts on the 1st', () => {
  const now = new Date(2026, 10, 15, 9, 30)
  const month = resolveWindow({ period: 'month', now })
  assert.equal(month.start, new Date(2026, 10, 1).getTime())
  assert.equal(month.end, new Date(2026, 11, 1).getTime())
  assert.equal(month.label, '2026-11-01 ~ 2026-11-30')
  // Local midnight, not UTC midnight.
  assert.equal(new Date(month.start).getHours(), 0)
  assert.equal(new Date(month.start).getDate(), 1)
  const cycle = resolveWindow({ period: 'cycle', cycleStartDay: 1, now })
  assert.deepEqual(cycle, { ...month, period: 'cycle' })
  // A mid-month cycle start is the only case where the two windows differ.
  const late = resolveWindow({ period: 'cycle', cycleStartDay: 15, now })
  assert.notEqual(late.start, month.start)
})

test('formatPercent follows the shared display rules', () => {
  assert.equal(formatPercent(0), '0.00%')
  assert.equal(formatPercent(0.00005), '<0.01%')
  assert.equal(formatPercent(0.0001), '0.01%')
  assert.equal(formatPercent(0.004459), '0.45%')
  assert.equal(formatPercent(0.005), '0.50%')
  assert.equal(formatPercent(0.05), '5.0%')
  assert.equal(formatPercent(0.954), '95.4%')
  assert.equal(formatPercent(1), '100%')
  assert.equal(formatPercent(1.05), '105%')
  assert.equal(formatPercent(undefined), '—')
})

test('allowances use the rolling 5h and 7d windows against the monthly allowance', () => {
  const now = new Date(2026, 10, 1, 12).getTime()
  const fiveHourAgo = now - 60 * 60 * 1000
  const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000
  const records = [
    sample({ at: fiveHourAgo, input: 1_000_000 }), // $0.15 → 0.15%
    sample({ at: twoDaysAgo, input: 1_000_000, sessionId: 's2', turn: 2 }), // $0.15, previous month
  ]
  const monthStart = new Date(2026, 10, 1).getTime()
  const monthEnd = new Date(2026, 11, 1).getTime()
  const result = aggregate(records, { start: monthStart, end: monthEnd, priceTable: TABLE, now })
  assert.equal(result.totals.calls, 1) // the 2-day-old sample is outside the month window
  assert.equal(Number(result.allowances.fiveHour.cost.toFixed(6)), 0.15)
  assert.equal(Number(result.allowances.fiveHour.share.toFixed(8)), 0.0015)
  assert.equal(result.allowances.fiveHour.cap, 0.2)
  assert.equal(Number(result.allowances.weekly.cost.toFixed(6)), 0.3)
  assert.equal(Number(result.allowances.weekly.share.toFixed(8)), 0.003)
  assert.equal(result.allowances.weekly.cap, 0.5)
  assert.equal(formatAllowanceLine(result.allowances), '5h 0.15%/20% · 周 0.30%/50%')
})

test('aggregate folds a sub-session into its root session', () => {
  const at = offPeak()
  const sessions = new Map([
    ['root', { id: 'root', depth: 0 }],
    ['sub', { id: 'sub', depth: 1, parent: 'root' }],
  ])
  const resolveSession = createSessionResolver(sessions)
  assert.equal(resolveSession('sub'), 'root')
  assert.equal(resolveSession('root'), 'root')

  const records = [
    sample({ at, sessionId: 'root', input: 1_000_000 }),
    sample({ at, sessionId: 'sub', input: 2_000_000, turn: 2 }),
  ]
  const result = aggregate(records, { start: 0, end: Number.POSITIVE_INFINITY, priceTable: TABLE, resolveSession })

  // Two sessions on disk, one session of work: the sub's calls and money land
  // on the root, and the counts stay at one.
  assert.equal(result.totals.calls, 2)
  assert.equal(result.totals.tokens, 3_000_000)
  assert.equal(result.totals.sessions, 1)
  assert.equal(result.byModel[0].sessions, 1)
  assert.equal(result.bySession.length, 1)
  assert.equal(result.bySession[0].key, 'root')
  assert.equal(result.bySession[0].calls, 2)
  assert.equal(result.bySession[0].tokens, 3_000_000)

  // Without a resolver the legacy behaviour is unchanged: raw session ids.
  const raw = aggregate(records, { start: 0, end: Number.POSITIVE_INFINITY, priceTable: TABLE })
  assert.equal(raw.totals.sessions, 2)
  assert.deepEqual(raw.bySession.map((row) => row.key).sort(), ['root', 'sub'])
})

test('aggregate survives a cyclic parent chain', () => {
  const at = offPeak()
  const resolveSession = createSessionResolver({
    a: { id: 'a', depth: 1, parent: 'b' },
    b: { id: 'b', depth: 1, parent: 'a' },
  })
  const rootId = resolveSession('a')
  assert.equal(rootId === 'a' || rootId === 'b', true)
  const result = aggregate([sample({ at, sessionId: 'a' })], {
    start: 0,
    end: Number.POSITIVE_INFINITY,
    priceTable: TABLE,
    resolveSession,
  })
  assert.equal(result.totals.sessions, 1)
  assert.equal(result.bySession[0].key, rootId)
})


