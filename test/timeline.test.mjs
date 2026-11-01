import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTimeline, createSessionResolver, monthBounds, parseMonthKey } from '../lib/timeline.js'
import { MODEL_PRICING, PriceTable } from '../lib/pricing.js'
import { aggregate } from '../lib/report.js'
import { usageKey } from '../lib/fold.js'

const TABLE = new PriceTable()

/** A sample at a fixed local time, off-peak unless the fixture says otherwise. */
function sample({
  at,
  input = 1_000_000,
  output = 0,
  model = 'deepseek-v4.1-flash',
  provider = 'opencode-go',
  sessionId = 's1',
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
    final: true,
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    user: 'alice',
  }
}

/** A ledger session lookup over a fixed list of entries. */
function sessionLookup(entries) {
  const map = new Map(entries.map((entry) => [entry.id, entry]))
  return (id) => map.get(id)
}

// 2026-11-01 is a Sunday; 12:00 local keeps every fixture outside the UTC peak
// windows unless a test deliberately picks another instant.
const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime()

test('monthBounds and parseMonthKey work in local time', () => {
  assert.deepEqual(parseMonthKey('2026-11'), { year: 2026, monthIndex: 10 })
  assert.equal(parseMonthKey('2026-13'), undefined)
  assert.equal(parseMonthKey('November'), undefined)
  assert.equal(parseMonthKey(undefined), undefined)

  const bounds = monthBounds(2026, 10)
  assert.equal(bounds.key, '2026-11')
  assert.equal(bounds.label, '2026年11月')
  assert.equal(bounds.start, new Date(2026, 10, 1).getTime())
  assert.equal(bounds.end, new Date(2026, 11, 1).getTime())
  assert.equal(bounds.days, 30)
  assert.equal(monthBounds(2024, 1).days, 29)
})

test('every hour and every day of the month is present even without records', () => {
  // Thursday 2026-11-05 20:30 local = 12:30 UTC, off-peak.
  const at = new Date(2026, 10, 5, 20, 30).getTime()
  const body = buildTimeline({
    records: [sample({ at })],
    priceTable: TABLE,
    providers: ['opencode-go'],
    month: '2026-11',
    date: '2026-11-05',
    now: NOW,
  })

  assert.equal(body.ok, true)
  assert.equal(body.month.key, '2026-11')
  assert.equal(body.month.label, '2026年11月')
  assert.equal(body.month.days, 30)
  assert.equal(body.date, '2026-11-05')
  assert.deepEqual(body.hours, Array.from({ length: 24 }, (_, hour) => hour))
  assert.equal(body.days.length, 30)
  // Monday = 0: 2026-11-01 is a Sunday, so the first day is 6.
  assert.deepEqual(body.days[0], { key: '2026-11-01', day: 1, weekday: 6 })
  assert.equal(body.days[29].key, '2026-11-30')
  assert.equal(body.days[29].day, 30)

  assert.equal(body.total.hour.length, 24)
  assert.deepEqual(body.total.hour.map((point) => point.h), body.hours)
  assert.equal(body.total.day.length, 30)
  assert.deepEqual(body.total.session, [])

  // The one record lands in its day (index 4) and hour; every other point is a
  // zero, not a missing point.
  const dayPoint = body.total.day[4]
  assert.equal(dayPoint.key, '2026-11-05')
  assert.equal(dayPoint.calls, 1)
  assert.equal(dayPoint.tokens, 1_000_000)
  assert.equal(Number(dayPoint.cost.toFixed(3)), 0.15)
  assert.equal(body.total.day.filter((point) => point.calls > 0).length, 1)
  assert.equal(body.total.hour[20].calls, 1)
  assert.equal(body.total.hour[20].tokens, 1_000_000)
  assert.equal(body.total.hour[19].calls, 0)
  assert.equal(body.total.hour[19].cost, 0)
  assert.equal(body.models.length, 1)
  assert.equal(body.models[0].hour[20].calls, 1)
  assert.equal(body.models[0].hour[19].calls, 0)
  assert.equal(body.models[0].day.length, 30)
})

test('the selected date falls back into the selected month', () => {
  // No date: today, because NOW is inside November 2026.
  assert.equal(buildTimeline({ records: [], priceTable: TABLE, month: '2026-11', now: NOW }).date, '2026-11-01')
  // A date from another month, for a month that does not contain today: the 1st.
  assert.equal(buildTimeline({ records: [], priceTable: TABLE, month: '2026-09', date: '2026-12-05', now: NOW }).date, '2026-09-01')
  // A valid date inside the month is honoured.
  assert.equal(buildTimeline({ records: [], priceTable: TABLE, month: '2026-09', date: '2026-09-17', now: NOW }).date, '2026-09-17')
  // No month: the month containing now; an unknown month key is ignored.
  assert.equal(buildTimeline({ records: [], priceTable: TABLE, now: NOW }).month.key, '2026-11')
  assert.equal(buildTimeline({ records: [], priceTable: TABLE, month: 'not-a-month', now: NOW }).month.key, '2026-11')
})

test('a sub-session folds its money into the root session without adding a session', () => {
  const rootAt = new Date(2026, 10, 5, 20, 0).getTime() // off-peak
  const subAt = new Date(2026, 10, 5, 21, 0).getTime() // off-peak
  const records = [
    sample({ at: rootAt, sessionId: 'root', input: 1_000_000 }), // $0.15 deepseek
    sample({ at: subAt, sessionId: 'sub', model: 'kimi-k3', input: 1_000_000 }), // $3.00 kimi
  ]
  const sessionOf = sessionLookup([
    { id: 'root', title: '乙方账单', depth: 0 },
    { id: 'sub', title: '子代理', depth: 1, parent: 'root' },
  ])
  const body = buildTimeline({
    records,
    priceTable: TABLE,
    providers: ['opencode-go'],
    month: '2026-11',
    date: '2026-11-05',
    now: NOW,
    sessionOf,
  })

  assert.equal(body.total.calls, 2)
  assert.equal(Number(body.total.cost.toFixed(3)), 3.15)
  // The sub-session must not inflate the root's session count.
  assert.equal(body.total.sessions, 1)

  const kimi = body.models.find((row) => row.model === 'kimi-k3')
  assert.equal(Number(kimi.month.cost.toFixed(3)), 3.0)
  // Money and the session count both belong to the root: the subagent is the
  // same session of work, not an extra one.
  assert.equal(kimi.month.sessions, 1)
  assert.equal(kimi.session.length, 1)
  assert.equal(kimi.session[0].sessionId, 'root')
  assert.equal(kimi.session[0].title, '乙方账单')
  assert.equal(Number(kimi.session[0].cost.toFixed(3)), 3.0)
  assert.equal(kimi.session[0].lastAt, subAt)

  const deepseek = body.models.find((row) => row.model === 'deepseek-v4.1-flash')
  assert.equal(deepseek.month.sessions, 1)
  assert.equal(body.models[0].model, 'kimi-k3') // cost descending
})

test('session bars sort by cost and the provider filter still applies', () => {
  const at = new Date(2026, 10, 6, 20, 0).getTime()
  const records = [
    sample({ at, input: 1_000_000, sessionId: 'cheap' }),
    sample({ at, input: 5_000_000, sessionId: 'pricey' }),
    sample({ at, input: 9_000_000, sessionId: 'other', provider: 'qianfan' }),
  ]
  const sessionOf = sessionLookup([
    { id: 'cheap', title: 'A', depth: 0 },
    { id: 'pricey', title: 'B', depth: 0 },
    { id: 'other', title: 'C', depth: 0 },
  ])
  const body = buildTimeline({
    records,
    priceTable: TABLE,
    providers: ['opencode-go'],
    month: '2026-11',
    date: '2026-11-06',
    now: NOW,
    sessionOf,
  })

  assert.equal(body.total.calls, 2)
  assert.equal(body.total.sessions, 2)
  assert.equal(body.models.length, 1)
  assert.deepEqual(body.models[0].session.map((entry) => entry.sessionId), ['pricey', 'cheap'])
  assert.equal(body.models[0].session[0].cost > body.models[0].session[1].cost, true)
})

test('free and unpriced models sort last and stay out of the total share', () => {
  const at = new Date(2026, 10, 7, 20, 0).getTime()
  const records = [
    sample({ at, input: 1_000_000 }), // $0.15 → 0.15%
    sample({ at, input: 5_000_000, model: 'beam-free', sessionId: 's2', turn: 2 }),
    sample({ at, input: 2_000_000, model: 'unknown-x', sessionId: 's3', turn: 3 }),
  ]
  const body = buildTimeline({
    records,
    priceTable: TABLE,
    providers: ['opencode-go'],
    month: '2026-11',
    date: '2026-11-07',
    now: NOW,
  })

  assert.equal(body.models[0].model, 'deepseek-v4.1-flash')
  assert.equal(body.models.at(-1).priced, false)
  assert.deepEqual(body.models.slice(1).map((row) => row.model).sort(), ['beam-free', 'unknown-x'])
  assert.equal(Number(body.total.share.toFixed(6)), 0.0015)
  assert.equal(body.total.limitKnown, true)
  assert.deepEqual(body.unpriced, { calls: 1, tokens: 2_000_000, models: ['opencode-go/unknown-x'] })

  const free = body.models.find((row) => row.model === 'beam-free')
  assert.equal(free.free, true)
  assert.equal(free.limit, null)
  assert.equal(free.share, null)
  assert.equal(free.month.share, null)

  const paid = body.models.find((row) => row.model === 'deepseek-v4.1-flash')
  assert.equal(paid.limit, 100)
  assert.equal(Number(paid.share.toFixed(6)), 0.0015)
  assert.equal(Number(paid.month.share.toFixed(6)), 0.0015)
})

test('the total quota flag turns false when a paid model has no allowance', () => {
  const table = new PriceTable({
    models: [...MODEL_PRICING, { id: 'house-model', label: 'House', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
  })
  const at = new Date(2026, 10, 8, 20, 0).getTime()
  const body = buildTimeline({
    records: [sample({ at, model: 'house-model' })],
    priceTable: table,
    providers: ['opencode-go'],
    month: '2026-11',
    date: '2026-11-08',
    now: NOW,
  })
  assert.equal(body.models[0].priced, true)
  assert.equal(body.models[0].share, null)
  assert.equal(body.total.share, 0)
  assert.equal(body.total.limitKnown, false)
})

test('the hour series only covers the selected date while the day series covers the month', () => {
  const day5 = new Date(2026, 10, 5, 20, 0).getTime()
  const day6 = new Date(2026, 10, 6, 20, 0).getTime()
  const body = buildTimeline({
    records: [sample({ at: day5, sessionId: 's1' }), sample({ at: day6, sessionId: 's2', turn: 2 })],
    priceTable: TABLE,
    providers: ['opencode-go'],
    month: '2026-11',
    date: '2026-11-05',
    now: NOW,
  })

  assert.equal(body.total.calls, 2)
  assert.equal(body.total.day.filter((point) => point.calls > 0).length, 2)
  assert.equal(
    body.total.hour.reduce((sum, point) => sum + point.calls, 0),
    1,
  )
})

test('aggregate and timeline agree on totals, per-model usage and session counts', () => {
  const rootAt = new Date(2026, 10, 5, 20, 0).getTime()
  const subAt = new Date(2026, 10, 5, 21, 0).getTime()
  const sessions = new Map([
    ['root', { id: 'root', title: '乙方账单', depth: 0 }],
    ['sub', { id: 'sub', title: '子代理', depth: 1, parent: 'root' }],
  ])
  const sessionOf = (id) => sessions.get(id)
  const resolveSession = createSessionResolver(sessions)
  const records = [
    sample({ at: rootAt, sessionId: 'root', input: 1_000_000 }),
    sample({ at: subAt, sessionId: 'sub', model: 'kimi-k3', input: 1_000_000 }),
  ]

  const timeline = buildTimeline({
    records,
    priceTable: TABLE,
    providers: ['opencode-go'],
    month: '2026-11',
    date: '2026-11-05',
    now: NOW,
    sessionOf,
    resolveSession,
  })
  const aggregation = aggregate(records, {
    start: timeline.month.start,
    end: timeline.month.end,
    priceTable: TABLE,
    providers: ['opencode-go'],
    now: NOW,
    resolveSession,
  })

  // The panel (summary) and the dialog (timeline) must show the same month.
  assert.equal(aggregation.totals.calls, timeline.total.calls)
  assert.equal(aggregation.totals.tokens, timeline.total.tokens)
  assert.equal(aggregation.totals.cost, timeline.total.cost)
  assert.equal(aggregation.totals.sessions, timeline.total.sessions)
  assert.equal(Number(aggregation.totals.share.toFixed(12)), Number(timeline.total.share.toFixed(12)))
  assert.equal(aggregation.bySession.length, 1)
  assert.equal(aggregation.bySession[0].key, 'root')

  assert.equal(aggregation.byModel.length, timeline.models.length)
  for (const model of timeline.models) {
    const row = aggregation.byModel.find((entry) => entry.key === model.key)
    assert.ok(row, `aggregate is missing ${model.key}`)
    assert.equal(row.calls, model.month.calls)
    assert.equal(row.tokens, model.month.tokens)
    assert.equal(row.cost, model.month.cost)
    // Same session count on both views, including models reached only through a
    // sub-session.
    assert.equal(row.sessions, model.month.sessions)
  }
})

test('knownModels keeps a model that was only used in an earlier month', () => {
  const novAt = new Date(2026, 10, 5, 20, 0).getTime()
  const octAt = new Date(2026, 9, 20, 20, 0).getTime()
  const records = [
    sample({ at: novAt, input: 1_000_000 }),
    sample({ at: octAt, input: 2_000_000, model: 'claude-haiku-5-5', sessionId: 's2', turn: 2 }),
  ]
  const body = buildTimeline({ records, priceTable: TABLE, providers: ['opencode-go'], month: '2026-11', date: '2026-11-05', now: NOW })

  // November itself only saw the DeepSeek model...
  assert.deepEqual(body.models.map((row) => row.model), ['deepseek-v4.1-flash'])
  // ...but Claude Haiku is still listed so the user can step back to October.
  const haiku = body.knownModels.find((row) => row.model === 'claude-haiku-5-5')
  assert.ok(haiku)
  assert.equal(haiku.key, 'opencode-go/claude-haiku-5-5')
  assert.equal(haiku.provider, 'opencode-go')
  assert.equal(haiku.label, 'Claude Haiku 5.5')
  assert.equal(haiku.limit, 15)
  assert.equal(haiku.free, false)
  assert.equal(haiku.priced, true)
  assert.equal(haiku.lastAt, octAt)
  assert.equal(haiku.lastMonthKey, '2026-10')
  assert.equal(Number(haiku.lastMonthCost.toFixed(3)), 0.2) // 2M input at $0.1/M
  assert.equal(haiku.totalCost, haiku.lastMonthCost)

  // lastMonthCost is exactly what the October aggregate reports for that model.
  const october = aggregate(records, {
    start: new Date(2026, 9, 1).getTime(),
    end: new Date(2026, 10, 1).getTime(),
    priceTable: TABLE,
    providers: ['opencode-go'],
    now: NOW,
  })
  const octoberRow = october.byModel.find((row) => row.key === 'opencode-go/claude-haiku-5-5')
  assert.equal(haiku.lastMonthCost, octoberRow.cost)
  assert.equal(haiku.totalCalls, octoberRow.calls)
  assert.equal(haiku.totalTokens, octoberRow.tokens)
})

test('knownModels does not depend on the selected month', () => {
  const records = [
    sample({ at: new Date(2026, 10, 5, 20, 0).getTime(), input: 1_000_000 }),
    sample({ at: new Date(2026, 9, 20, 20, 0).getTime(), input: 2_000_000, model: 'claude-haiku-5-5', sessionId: 's2', turn: 2 }),
    sample({ at: new Date(2026, 8, 9, 20, 0).getTime(), input: 20_000, model: 'kimi-k3', sessionId: 's3', turn: 3 }),
  ]
  const november = buildTimeline({ records, priceTable: TABLE, providers: ['opencode-go'], month: '2026-11', now: NOW })
  const october = buildTimeline({ records, priceTable: TABLE, providers: ['opencode-go'], month: '2026-10', now: NOW })
  const september = buildTimeline({ records, priceTable: TABLE, providers: ['opencode-go'], month: '2026-09', now: NOW })

  assert.deepEqual(november.knownModels, october.knownModels)
  assert.deepEqual(october.knownModels, september.knownModels)
  assert.deepEqual(november.knownModels.map((row) => row.model), ['claude-haiku-5-5', 'deepseek-v4.1-flash', 'kimi-k3'])
  // The month rows themselves do differ.
  assert.deepEqual(november.models.map((row) => row.model), ['deepseek-v4.1-flash'])
  assert.deepEqual(october.models.map((row) => row.model), ['claude-haiku-5-5'])
})

test('knownModels filters providers, keeps free models and totals match the full history', () => {
  const novAt = new Date(2026, 10, 5, 20, 0).getTime()
  const octAt = new Date(2026, 9, 20, 20, 0).getTime()
  const records = [
    sample({ at: novAt, input: 1_000_000 }),
    sample({ at: octAt, input: 2_000_000, model: 'claude-haiku-5-5', sessionId: 's2', turn: 2 }),
    sample({ at: octAt, input: 5_000_000, model: 'beam-free', sessionId: 's3', turn: 3 }),
    sample({ at: octAt, input: 9_000_000, provider: 'qianfan', sessionId: 's4', turn: 4 }),
  ]
  const body = buildTimeline({ records, priceTable: TABLE, providers: ['opencode-go'], month: '2026-11', now: NOW })

  // Outside the whitelist: never listed.
  assert.equal(body.knownModels.some((row) => row.provider === 'qianfan'), false)
  // A free model is listed, with no allowance and a zero last-month cost.
  const free = body.knownModels.find((row) => row.model === 'beam-free')
  assert.equal(free.free, true)
  assert.equal(free.limit, null)
  assert.equal(free.priced, true)
  assert.equal(free.lastMonthKey, '2026-10')
  assert.equal(free.lastMonthCost, 0)
  assert.equal(free.totalCost, 0)

  // The all-history totals are the same numbers the full-history aggregate gives.
  const all = aggregate(records, {
    start: 0,
    end: Number.POSITIVE_INFINITY,
    priceTable: TABLE,
    providers: ['opencode-go'],
    now: NOW,
  })
  const totalCalls = body.knownModels.reduce((sum, row) => sum + row.totalCalls, 0)
  const totalCost = body.knownModels.reduce((sum, row) => sum + row.totalCost, 0)
  const totalTokens = body.knownModels.reduce((sum, row) => sum + row.totalTokens, 0)
  assert.equal(totalCalls, all.totals.calls)
  assert.equal(totalTokens, all.totals.tokens)
  assert.equal(Number(totalCost.toFixed(9)), Number(all.totals.cost.toFixed(9)))

  // Sorted by total cost, descending.
  const costs = body.knownModels.map((row) => row.totalCost)
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a))
})
