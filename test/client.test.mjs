import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** The bundle the module loader received. */
let bundle

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      bundle = definition
    },
  },
}

await import('../lib/client.js')

/**
 * Materialize the browser half the way the module loader does. Each call gets
 * a fresh module closure — and therefore a fresh timeline cache, which keeps
 * the cache tests independent.
 */
function materialize() {
  const required = []
  const exports = bundle.factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  })
  return { exports, required }
}

/** A fake client `slots` service. */
function fakeSlots() {
  const registrations = []
  return {
    registrations,
    inject(name, callback) {
      registrations.push({ injected: name })
      callback()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  }
}

/** Render one element to static markup. */
function render(element) {
  return renderToStaticMarkup(element)
}

/** How many times `pattern` occurs in the markup. */
function occurrences(html, pattern) {
  return (html.match(pattern) || []).length
}

/** Zero-pad a day number. */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** The month bounds every dialog block is given in tests. */
const LIMITS = { currentMonth: '2026-11', today: '2026-11-01' }

/** Seed the module cache with one (month, date) payload before a render. */
function seed(exports, month, date, payload) {
  return exports.loadTimeline(month, date, async () => payload)
}

/** A summary payload shaped like SPEC §4.1. */
function summaryData() {
  return {
    ok: true,
    user: 'alice',
    providers: ['opencode-go'],
    plan: 'go',
    monthlyFee: 10,
    cycleStartDay: 1,
    fxRate: 0,
    window: { label: '2026-11-01 ~ 2026-11-30', start: 0, end: 1, period: 'month' },
    totals: { calls: 374, tokens: 26_484_419, cost: 0.467, sessions: 28, share: 0.0059, limitKnown: true },
    byModel: [
      {
        key: 'opencode-go/deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        calls: 372,
        tokens: 26_347_053,
        cost: 0.4459,
        sessions: 28,
        limit: 100,
        share: 0.004459,
        priced: true,
        free: false,
        costShare: 0.954,
      },
      {
        key: 'opencode-go/beam-free',
        label: 'Beam Free',
        provider: 'opencode-go',
        model: 'beam-free',
        calls: 2,
        tokens: 137_366,
        cost: 0.0211,
        sessions: 1,
        limit: 0,
        share: null,
        priced: true,
        free: true,
        costShare: 0.046,
      },
    ],
    unpriced: { calls: 0, tokens: 0 },
    allowances: {
      fiveHour: { cost: 0.003, share: 0.00003, cap: 0.2 },
      weekly: { cost: 0.21, share: 0.0021, cap: 0.5 },
      month: { cost: 1.2, share: 0.012, cap: 1 },
    },
    last7: { cost: 0.42, calls: 37, tokens: 1_000_000 },
    note: '本机口径 · 仅 opencode-go · 近 30 天',
  }
}

/**
 * A timeline payload shaped like SPEC §4.2.
 * @param {string} [month] - month key, default `2026-11`.
 * @param {{ omitModels?: boolean }} [options] - drop the model rows (a month
 *   where that model never ran).
 */
function timelineData(month = '2026-11', options = {}) {
  const daysInMonth = Number(month.slice(5, 7)) === 2 ? 28 : 30
  const days = Array.from({ length: daysInMonth }, (_unused, index) => ({
    key: `${month}-${pad2(index + 1)}`,
    day: index + 1,
    weekday: (index + 6) % 7,
  }))
  const hours = Array.from({ length: 24 }, (_unused, hour) => ({
    h: hour,
    cost: hour === 9 ? 0.031 : 0,
    tokens: hour === 9 ? 1_200_000 : 0,
    calls: hour === 9 ? 7 : 0,
  }))
  const dayRows = days.map((entry, index) => ({
    key: entry.key,
    cost: index === 0 ? 0.2 : 0,
    tokens: index === 0 ? 9_000_000 : 0,
    calls: index === 0 ? 120 : 0,
  }))
  const sessions = [
    { sessionId: 'session-a', title: 'PCL2 1020事件及下载现状', cost: 0.21, tokens: 9_800_000, calls: 130, lastAt: 1 },
    { sessionId: 'session-b', title: '插件改造', cost: 0.12, tokens: 5_000_000, calls: 90, lastAt: 2 },
    { sessionId: 'session-c', title: '小会话', cost: 0.05, tokens: 1_000_000, calls: 20, lastAt: 3 },
  ]
  const models =
    options.omitModels === true
      ? []
      : [
          {
            key: 'opencode-go/deepseek-v4.1-flash',
            provider: 'opencode-go',
            model: 'deepseek-v4.1-flash',
            label: 'DeepSeek V4.1 Flash',
            limit: 100,
            share: 0.004459,
            priced: true,
            free: false,
            month: { calls: 372, tokens: 26_347_053, cost: 0.4459, sessions: 28, share: 0.004459 },
            hour: hours,
            day: dayRows,
            session: sessions,
          },
        ]
  return {
    ok: true,
    month: { key: month, start: 0, end: 1, label: `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`, days: daysInMonth },
    date: `${month}-01`,
    hours: hours.map((entry) => entry.h),
    days,
    total: {
      calls: 374,
      tokens: 26_484_419,
      cost: 0.467,
      sessions: 28,
      share: 0.0059,
      hour: hours,
      day: dayRows,
      session: [],
    },
    models,
    unpriced: { calls: 0, tokens: 0, models: [] },
    note: '本机口径 · 仅 opencode-go',
  }
}

/** A `base` descriptor for the dialog (its model list). */
function baseOf(payload) {
  return { state: { status: 'ready', data: payload, error: null }, month: payload.month.key, date: payload.date }
}

/** A range payload: 30 daily points with one busy day. */
function rangeData() {
  const points = Array.from({ length: 30 }, (_, index) => ({
    key: `2026-11-${pad2(index + 1)}`,
    label: `11-${pad2(index + 1)}`,
    cost: index === 29 ? 0.467 : 0,
    calls: index === 29 ? 374 : 0,
    tokens: index === 29 ? 26_484_419 : 0,
  }))
  return {
    ok: true,
    range: { key: 'last30', label: '近 30 天', start: 0, end: 1, hourly: false },
    total: { cost: 0.467, calls: 374, tokens: 26_484_419, sessions: 28, share: 0.0059, limitKnown: true, points },
    models: [
      {
        key: 'opencode-go/deepseek-v4.1-flash',
        model: 'deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        cost: 0.446,
        calls: 372,
        tokens: 26_347_053,
        limit: 100,
        share: 0.0045,
        priced: true,
        free: false,
        points,
      },
    ],
    unpriced: { calls: 0, tokens: 0 },
    note: '本机口径 · 仅 opencode-go',
  }
}

/** A summary hook state for the dialog. */
function summaryState() {
  return { status: 'ready', data: summaryData(), error: null }
}

/** Two models the host knows about but that did not run this month. */
function knownModels() {
  return [
    {
      key: 'opencode-go/claude-haiku-5-5',
      provider: 'opencode-go',
      model: 'claude-haiku-5-5',
      label: 'Claude Haiku 5.5',
      limit: 15,
      free: false,
      priced: true,
      lastAt: 1_793_449_000_000,
      lastMonthKey: '2026-10',
      lastMonthCost: 0.0209,
      totalCost: 0.0209,
      totalCalls: 18,
      totalTokens: 535_483,
    },
    {
      key: 'opencode-go/qwen3-coder',
      provider: 'opencode-go',
      model: 'qwen3-coder',
      label: 'Qwen3 Coder',
      limit: 20,
      free: false,
      priced: true,
      lastAt: 1_793_400_000_000,
      lastMonthKey: '2026-09',
      lastMonthCost: 0.3,
      totalCost: 0.3,
      totalCalls: 40,
      totalTokens: 1_200_000,
    },
  ]
}

/** An October payload that also contains the Haiku row (its last-used month). */
function octoberPayload() {
  const payload = timelineData('2026-10')
  payload.models.push({
    key: 'opencode-go/claude-haiku-5-5',
    provider: 'opencode-go',
    model: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    limit: 15,
    share: 0.0014,
    priced: true,
    free: false,
    month: { calls: 18, tokens: 535_483, cost: 0.0209, sessions: 3, share: 0.0014 },
    hour: payload.models[0].hour,
    day: payload.models[0].day,
    session: payload.models[0].session,
  })
  return payload
}

test('the bundle registers a lazy-CJS factory under its package id', () => {
  assert.equal(bundle.id, 'dsh-token-split')
  assert.equal(typeof bundle.factory, 'function')
})

test('the factory requires only react and exports apply/inject', () => {
  const { exports, required } = materialize()
  assert.deepEqual(required, ['react'])
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('apply registers one sidebar footer action', () => {
  const { exports } = materialize()
  const slots = fakeSlots()
  exports.apply({ slots })
  const injected = slots.registrations.find((entry) => entry.injected !== undefined)
  assert.equal(injected.injected, 'sidebar.footer.action')
  const registration = slots.registrations.find((entry) => entry.options !== undefined)
  assert.equal(registration.options.name, 'sidebar.footer.action')
  assert.equal(registration.options.id, 'token-split')
  assert.equal(typeof registration.Component, 'function')
})

test('the closed trigger renders a compact chip without fetching', () => {
  const { exports } = materialize()
  const html = render(React.createElement(exports.TokenSplitAction, { wide: true }))
  assert.match(html, /dts-trigger/)
  assert.match(html, /用量/)
  assert.doesNotMatch(html, /dts-panel/)
  assert.doesNotMatch(html, /详细用量/)
})

test('the collapsed trigger drops the label', () => {
  const { exports } = materialize()
  const html = render(React.createElement(exports.TokenSplitAction, { wide: false }))
  assert.match(html, /dts-trigger-dot/)
  assert.doesNotMatch(html, />用量</)
})

test('the panel shows the month cost with its quota share on the same line', () => {
  const { exports } = materialize()
  const html = render(
    React.createElement(exports.PanelBody, {
      summary: { status: 'ready', data: summaryData(), error: null },
      onRefresh: () => {},
      refreshing: false,
      onOpenDetails: () => {},
    }),
  )
  assert.match(html, /dts-big-row/)
  assert.match(html, /\$0\.467/)
  assert.match(html, /0\.59%/)
  const row = html.slice(html.indexOf('dts-big-row'), html.indexOf('dts-sub'))
  assert.match(row, /\$0\.467/)
  assert.match(row, /0\.59%/)
})

test('every model row renders `$cost / share` and tags models without a quota', () => {
  const { exports } = materialize()
  const data = summaryData()
  data.byModel.push({
    key: 'opencode-go/mystery',
    label: 'Mystery Model',
    provider: 'opencode-go',
    model: 'mystery',
    calls: 3,
    tokens: 100,
    cost: 0,
    sessions: 1,
    limit: null,
    share: null,
    priced: false,
    free: false,
    costShare: 0,
  })
  const html = render(
    React.createElement(exports.PanelBody, {
      summary: { status: 'ready', data, error: null },
      onRefresh: () => {},
      refreshing: false,
    }),
  )
  assert.match(html, /DeepSeek V4\.1 Flash/)
  assert.match(html, /\$0\.446 \/ 0\.45%/)
  assert.match(html, /Beam Free/)
  assert.match(html, /免费/)
  assert.match(html, /未定价/)
  assert.match(html, /dts-bar-fill is-muted/)
})

test('the panel footnote carries the note, the week cap and the month share', () => {
  const { exports } = materialize()
  const html = render(
    React.createElement(exports.PanelBody, {
      summary: { status: 'ready', data: summaryData(), error: null },
      onRefresh: () => {},
      refreshing: false,
    }),
  )
  assert.match(html, /本机口径 · 仅 opencode-go/)
  assert.match(html, /5h &lt;0\.01%\/20% · week 0\.21%\/50% · month 1\.2%/)
})

test('the panel header offers refresh and the `⋯` detail button', () => {
  const { exports } = materialize()
  const html = render(
    React.createElement(exports.PanelBody, {
      summary: { status: 'ready', data: summaryData(), error: null },
      onRefresh: () => {},
      refreshing: false,
      onOpenDetails: () => {},
    }),
  )
  assert.match(html, /dts-head-actions/)
  assert.match(html, /⟳/)
  assert.match(html, /⋯/)
  assert.match(html, /dts-more/)
})

test('the panel shows an error state with a retry action', () => {
  const { exports } = materialize()
  const html = render(
    React.createElement(exports.PanelBody, {
      summary: { status: 'error', data: null, error: '统计服务未就绪' },
      onRefresh: () => {},
      refreshing: false,
    }),
  )
  assert.match(html, /统计服务未就绪/)
  assert.match(html, /重试/)
})

test('the panel reports unpriced calls instead of hiding them', () => {
  const { exports } = materialize()
  const data = summaryData()
  data.unpriced = { calls: 3, tokens: 120 }
  const html = render(
    React.createElement(exports.PanelBody, {
      summary: { status: 'ready', data, error: null },
      onRefresh: () => {},
      refreshing: false,
    }),
  )
  assert.match(html, /未匹配价目表/)
})

test('opening the dialog (the click on `⋯`) renders the centered 详细用量 card', () => {
  const { exports } = materialize()
  const closed = render(React.createElement(exports.TokenSplitAction, { wide: true }))
  assert.doesNotMatch(closed, /详细用量/)

  const opened = render(React.createElement(exports.TokenSplitAction, { wide: true, detailsOpen: true }))
  assert.match(opened, /dts-modal/)
  assert.match(opened, /详细用量/)
  assert.match(opened, /✕/)
})

test('the dialog centres itself with the SPEC §5.3 geometry and no month in its heading', async () => {
  const { exports } = materialize()
  const payload = timelineData()
  await seed(exports, '2026-11', '2026-11-01', payload)
  exports.seedRange('last30', rangeData())
  const html = render(
    React.createElement(exports.UsageModal, {
      open: true,
      base: baseOf(payload),
      limits: LIMITS,
      summary: summaryState(),
      onClose: () => {},
    }),
  )
  assert.match(html, /class="dts-modal"/)
  assert.match(html, /dts-modal-card/)
  // Blocks navigate independently, so the heading carries no month…
  assert.match(html, /本机口径 · 仅 opencode-go/)
  assert.doesNotMatch(html, /\d{4}年\d{1,2}月 · 本机口径/)
  // …and says so.
  assert.match(html, /各图可独立切换时间范围/)
  // Total block: `$0.467 / 0.59%` plus the gray meta line.
  assert.match(html, /\$0\.467 \/ 0\.59%/)
  assert.match(html, /26,484,419 tokens · 374 次调用 · 28 个会话/)
  // Per-model block: `$0.446 / 0.45%` plus its own meta line.
  assert.match(html, /DeepSeek V4\.1 Flash/)
  assert.match(html, /\$0\.446 \/ 0\.45%/)
  assert.match(html, /26,347,053 tokens · 372 次调用/)
  // Console-style header: three KPI cards, a model picker and an export button.
  assert.match(html, /dts-kpi-row/)
  assert.match(html, /消费金额/)
  assert.match(html, /API 请求次数/)
  assert.match(html, />Tokens</)
  assert.match(html, /全部模型/)
  assert.match(html, /dts-export[^>]*>导出</)
  // The time dimension drives every block; there is no per-block stepper.
  assert.match(html, /aria-label="时间维度"/)
  assert.match(html, /近 30 天/)
  assert.doesNotMatch(html, /dts-date-nav/)
  // The model blocks draw the requests/tokens pair, the total a cost card.
  assert.equal(occurrences(html, /dts-chart-title">API 请求次数</g), 1)
  assert.equal(occurrences(html, /dts-chart-title">Tokens</g), 1)
  assert.equal(occurrences(html, /dts-chart-title">消费金额</g), 1)
})

test('two blocks can show different months at the same time', async () => {
  const { exports } = materialize()
  await seed(exports, '2026-10', '2026-10-01', timelineData('2026-10'))
  await seed(exports, '2026-09', '2026-09-01', timelineData('2026-09'))
  const html = render(
    React.createElement(
      'div',
      null,
      React.createElement(exports.UsageBlock, {
        kind: 'total',
        title: '总用量',
        emphasis: true,
        limits: LIMITS,
        mode: 'month',
        initialMonth: '2026-10',
        initialDate: '2026-10-01',
      }),
      React.createElement(exports.UsageBlock, {
        kind: 'model',
        modelKey: 'opencode-go/deepseek-v4.1-flash',
        title: 'DeepSeek V4.1 Flash',
        limits: LIMITS,
        mode: 'month',
        initialMonth: '2026-09',
        initialDate: '2026-09-01',
      }),
    ),
  )
  const blocks = html.split(/<div class="dts-block"/).slice(1)
  assert.equal(blocks.length, 2)
  // The total block stayed in October while the model block sits in September —
  // neither label leaks into the other block.
  assert.match(blocks[0], /2026年10月/)
  assert.doesNotMatch(blocks[0], /2026年9月/)
  assert.match(blocks[1], /2026年9月/)
  assert.doesNotMatch(blocks[1], /2026年10月/)
})

test('each block keeps its own month when the other one moves', async () => {
  const { exports } = materialize()
  await seed(exports, '2026-11', '2026-11-01', timelineData('2026-11'))
  await seed(exports, '2026-09', '2026-09-01', timelineData('2026-09'))
  const pair = (totalMonth, totalDate) =>
    render(
      React.createElement(
        'div',
        null,
        React.createElement(exports.UsageBlock, {
          kind: 'total',
          title: '总用量',
          limits: LIMITS,
          mode: 'month',
          initialMonth: totalMonth,
          initialDate: totalDate,
        }),
        React.createElement(exports.UsageBlock, {
          kind: 'model',
          modelKey: 'opencode-go/deepseek-v4.1-flash',
          title: 'DeepSeek V4.1 Flash',
          limits: LIMITS,
          mode: 'month',
        }),
      ),
    ).split(/<div class="dts-block"/)
    .slice(1)

  const moved = pair('2026-09', '2026-09-01')
  assert.match(moved[0], /2026年9月/)
  // The untouched second block still defaults to the current month…
  assert.match(moved[1], /2026年11月/)

  // …and its markup is byte-identical whether or not the first block moved:
  // one block's selection cannot leak into another's.
  const still = pair('2026-11', '2026-11-01')
  assert.equal(moved[1], still[1])
})

test('the timeline cache serves a repeated selection once and joins in-flight requests', async () => {
  const { exports } = materialize()
  exports.clearTimelineCache()
  let calls = 0
  const fetcher = async () => {
    calls += 1
    return timelineData()
  }

  const first = exports.loadTimeline('2026-11', '2026-11-01', fetcher)
  const parallel = exports.loadTimeline('2026-11', '2026-11-01', fetcher)
  const [a, b] = await Promise.all([first, parallel])
  assert.equal(calls, 1, 'the in-flight request is shared')
  assert.equal(a, b)
  assert.equal(a.status, 'ready')

  // A later hit comes straight from the cache.
  const again = await exports.loadTimeline('2026-11', '2026-11-01', fetcher)
  assert.equal(calls, 1, 'a cached selection issues no request')
  assert.equal(again, a)

  // A different day is a different key.
  await exports.loadTimeline('2026-11', '2026-11-02', fetcher)
  assert.equal(calls, 2)

  // Failures are not cached: a retry really retries.
  let failures = 0
  const broken = async () => {
    failures += 1
    throw new Error('boom')
  }
  const failed = await exports.loadTimeline('2026-12', '2026-12-01', broken)
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /boom/)
  await exports.loadTimeline('2026-12', '2026-12-01', broken)
  assert.equal(failures, 2)
})

test('the timeline cache evicts the oldest entry past 24 selections', async () => {
  const { exports } = materialize()
  exports.clearTimelineCache()
  let calls = 0
  const fetcher = async () => {
    calls += 1
    return timelineData()
  }
  for (let month = 1; month <= 25; month += 1) {
    const key = `2026-${pad2(month)}`
    await exports.loadTimeline(key, `${key}-01`, fetcher)
  }
  assert.equal(calls, 25)
  // January was the oldest and is gone; February is still cached.
  await exports.loadTimeline('2026-02', '2026-02-01', fetcher)
  assert.equal(calls, 25)
  await exports.loadTimeline('2026-01', '2026-01-01', fetcher)
  assert.equal(calls, 26)
})

test('the three modes render 24 dots, one dot per day, and one bar per session', async () => {
  const { exports } = materialize()
  const payload = timelineData()
  await seed(exports, '2026-11', '2026-11-01', payload)
  const blockProps = {
    kind: 'model',
    modelKey: 'opencode-go/deepseek-v4.1-flash',
    title: 'DeepSeek V4.1 Flash',
    limits: LIMITS,
  }

  // A model block draws two charts (requests and tokens), so every bucket in
  // the series appears twice.
  const day = render(React.createElement(exports.UsageBlock, { ...blockProps, mode: 'day' }))
  assert.equal(occurrences(day, /class="dts-dot"/g), 48)

  const month = render(React.createElement(exports.UsageBlock, { ...blockProps, mode: 'month' }))
  assert.equal(occurrences(month, /class="dts-dot"/g), 60)

  const session = render(React.createElement(exports.UsageBlock, { ...blockProps, mode: 'session' }))
  assert.equal(occurrences(session, /class="dts-session-bar"/g), 6)
  // 28px bars, 12px gaps, and never stretched across the dialog.
  assert.equal(occurrences(session, /width="28"/g), 6)
  assert.match(session, /width="400"/)
})

test('a chart with usage in the month keeps its axis when a bucket is empty', () => {
  const { exports } = materialize()
  const data = timelineData()
  const keys = exports.seriesKeys(data)
  const series = exports.buildSeries(data.models[0], keys)
  const html = render(React.createElement(exports.UsageChart, { mode: 'day', points: series.hour }))
  assert.match(html, /dts-chart-svg/)
  assert.match(html, /dts-line/)
  assert.match(html, /00:00/)
  assert.match(html, /23:00/)
  // 09:00 is the only non-zero bucket: it rises above the baseline while every
  // other dot sits on it (the y-scale tops out above the largest value).
  const heights = [...html.matchAll(/class="dts-dot"[^>]*cy="([\d.]+)"/g)].map((match) => Number(match[1]))
  assert.equal(heights.length, 24)
  assert.ok(Math.min(...heights) < 120)
  assert.equal(heights.filter((height) => height === 120).length, 23)
})

test('a month without usage shows the empty note but keeps the steppers', async () => {
  const { exports } = materialize()
  const payload = timelineData('2026-10')
  payload.models[0].month = { calls: 0, tokens: 0, cost: 0, sessions: 0, share: 0 }
  payload.models[0].hour = []
  payload.models[0].day = []
  payload.models[0].session = []
  payload.total = { calls: 0, tokens: 0, cost: 0, sessions: 0, share: 0, hour: [], day: [], session: [] }
  await seed(exports, '2026-10', '2026-10-01', payload)
  const html = render(
    React.createElement(exports.UsageBlock, {
      kind: 'model',
      modelKey: 'opencode-go/deepseek-v4.1-flash',
      title: 'DeepSeek V4.1 Flash',
      limits: LIMITS,
      mode: 'month',
      initialMonth: '2026-10',
      initialDate: '2026-10-01',
    }),
  )
  assert.match(html, /本月暂无用量/)
  assert.match(html, /2026年10月/)
  assert.match(html, /title="上个月"/)
  assert.match(html, /aria-pressed/)
  assert.doesNotMatch(html, /dts-chart-svg/)
})

test('a model absent from the selected month keeps its block at $0 / 0.00%', async () => {
  const { exports } = materialize()
  await seed(exports, '2026-09', '2026-09-01', timelineData('2026-09', { omitModels: true }))
  const html = render(
    React.createElement(exports.UsageBlock, {
      kind: 'model',
      modelKey: 'opencode-go/deepseek-v4.1-flash',
      title: 'DeepSeek V4.1 Flash',
      limits: LIMITS,
      mode: 'month',
      initialMonth: '2026-09',
      initialDate: '2026-09-01',
    }),
  )
  // The block is still there, in its original place, with zeroes and an empty chart.
  assert.match(html, /class="dts-block"/)
  assert.match(html, /DeepSeek V4\.1 Flash/)
  assert.match(html, /\$0 \/ 0\.00%/)
  assert.match(html, /0 tokens · 0 次调用 · 0 个会话/)
  assert.match(html, /本月暂无用量/)
  assert.match(html, /2026年9月/)
  assert.doesNotMatch(html, /dts-chart-svg/)
})

test('one slow block shows its own skeleton while another keeps its chart', async () => {
  const { exports } = materialize()
  exports.clearTimelineCache()
  await seed(exports, '2026-10', '2026-10-01', timelineData('2026-10'))
  const html = render(
    React.createElement(
      'div',
      null,
      React.createElement(exports.UsageBlock, {
        kind: 'total',
        title: '总用量',
        limits: LIMITS,
        mode: 'month',
        initialMonth: '2026-10',
        initialDate: '2026-10-01',
      }),
      React.createElement(exports.UsageBlock, {
        kind: 'model',
        modelKey: 'opencode-go/deepseek-v4.1-flash',
        title: 'DeepSeek V4.1 Flash',
        limits: LIMITS,
        mode: 'month',
        initialMonth: '2026-08',
        initialDate: '2026-08-01',
      }),
    ),
  )
  const blocks = html.split(/<div class="dts-block"/).slice(1)
  assert.match(blocks[0], /dts-chart-svg/)
  assert.doesNotMatch(blocks[0], /dts-skeleton/)
  assert.match(blocks[1], /dts-skeleton/)
  assert.doesNotMatch(blocks[1], /dts-chart-svg/)
})

test('`›` is disabled on the current month and enabled on a past one', async () => {
  const { exports } = materialize()
  await seed(exports, '2026-11', '2026-11-01', timelineData('2026-11'))
  await seed(exports, '2026-10', '2026-10-01', timelineData('2026-10'))
  const current = render(
    React.createElement(exports.UsageBlock, {
      kind: 'total',
      title: '总用量',
      limits: LIMITS,
      mode: 'month',
    }),
  )
  assert.match(current, /title="下个月" disabled=""/)

  const past = render(
    React.createElement(exports.UsageBlock, {
      kind: 'total',
      title: '总用量',
      limits: LIMITS,
      mode: 'month',
      initialMonth: '2026-10',
      initialDate: '2026-10-01',
    }),
  )
  assert.match(past, /2026年10月/)
  assert.doesNotMatch(past, /title="下个月" disabled/)
})

test('flipping to the previous month refetches that month and day', () => {
  const { exports } = materialize()
  const limits = { currentMonth: '2026-11', today: '2026-11-01' }
  const next = exports.shiftCursor({ month: '2026-11', date: '2026-11-01' }, { kind: 'month', delta: -1 }, limits)
  assert.deepEqual(next, { month: '2026-10', date: '2026-10-01' })
  assert.equal(exports.timelinePath(next.month, next.date), '/token-split/timeline?month=2026-10&date=2026-10-01')

  assert.deepEqual(
    exports.shiftCursor({ month: '2026-11', date: '2026-11-30' }, { kind: 'month', delta: -1 }, limits),
    { month: '2026-10', date: '2026-10-30' },
  )
  assert.deepEqual(
    exports.shiftCursor({ month: '2026-03', date: '2026-03-31' }, { kind: 'month', delta: -1 }, limits),
    { month: '2026-02', date: '2026-02-28' },
  )
  assert.deepEqual(
    exports.shiftCursor({ month: '2026-10', date: '2026-10-30' }, { kind: 'month', delta: 1 }, limits),
    { month: '2026-11', date: '2026-11-01' },
  )
  assert.equal(exports.addMonths('2026-01', -1), '2025-12')
  assert.equal(exports.canShiftMonth('2026-10', 1, '2026-11'), true)
})

test('the future is off limits: no month past the current one, no day past today', () => {
  const { exports } = materialize()
  const limits = { currentMonth: '2026-11', today: '2026-11-01' }
  assert.equal(exports.canShiftMonth('2026-11', 1, '2026-11'), false)
  assert.deepEqual(
    exports.shiftCursor({ month: '2026-11', date: '2026-11-01' }, { kind: 'month', delta: 1 }, limits),
    { month: '2026-11', date: '2026-11-01' },
  )
  assert.deepEqual(
    exports.shiftCursor({ month: '2026-11', date: '2026-11-01' }, { kind: 'date', delta: 1 }, limits),
    { month: '2026-11', date: '2026-11-01' },
  )
})

test('a day arrow crossing a month boundary moves the month with it', () => {
  const { exports } = materialize()
  const limits = { currentMonth: '2026-11', today: '2026-11-01' }
  const back = exports.shiftCursor({ month: '2026-11', date: '2026-11-01' }, { kind: 'date', delta: -1 }, limits)
  assert.deepEqual(back, { month: '2026-10', date: '2026-10-31' })
  assert.equal(exports.timelinePath(back.month, back.date), '/token-split/timeline?month=2026-10&date=2026-10-31')

  assert.deepEqual(
    exports.shiftCursor({ month: '2026-10', date: '2026-10-31' }, { kind: 'date', delta: 1 }, limits),
    { month: '2026-11', date: '2026-11-01' },
  )
  assert.equal(exports.addDays('2026-02-28', 1), '2026-03-01')
})

test('the session tooltip is a sibling of the scroll container, not inside it', () => {
  const { exports } = materialize()
  const data = timelineData()
  const series = exports.buildSeries(data.models[0], exports.seriesKeys(data))
  const html = render(
    React.createElement(exports.UsageChart, { mode: 'session', points: series.session, forceHover: 0 }),
  )
  assert.match(html, /dts-bars-wrap/)
  assert.match(html, /dts-bars-scroll/)
  // The bubble follows the close of the inner + scroll containers, i.e. it is
  // a direct child of the wrap — an `overflow:auto` box would clip it.
  assert.match(html, /<\/svg><\/div><\/div><div class="dts-tooltip" data-side="/)
  assert.match(html, /PCL2 1020事件及下载现状/)
})

test('the session tooltip stays inside the visible strip at both ends', () => {
  const { exports } = materialize()
  const data = timelineData()
  data.models[0].session = Array.from({ length: 20 }, (_unused, index) => ({
    sessionId: `session-${index}`,
    title: `会话 ${index}`,
    cost: 0.3 - index * 0.005,
    tokens: 1000,
    calls: 2,
    lastAt: index,
  }))
  const series = exports.buildSeries(data.models[0], exports.seriesKeys(data))
  const first = render(React.createElement(exports.UsageChart, { mode: 'session', points: series.session, forceHover: 0 }))
  const last = render(
    React.createElement(exports.UsageChart, { mode: 'session', points: series.session, forceHover: 19 }),
  )
  // Index 0 would sit at x=14 and index 19 at x=774: both are pulled inside
  // [64, 760-64] so the bubble never runs off the strip.
  assert.match(first, /style="left:64px;top:\d+(\.\d+)?px"/)
  assert.match(last, /style="left:696px;top:\d+(\.\d+)?px"/)
  // The tallest bar has no room above it, so its bubble flips below.
  assert.match(first, /data-side="below"/)
  assert.match(last, /data-side="above"/)

  const tops = [...first.matchAll(/class="dts-tooltip"[^>]*top:([\d.]+)px/g)].map((match) => Number(match[1]))
  for (const top of tops) assert.ok(top >= 2 && top <= 116, `tooltip top ${top} within [2, 116]`)
})

test('the line tooltip is clamped inside the chart too', () => {
  const { exports } = materialize()
  const data = timelineData()
  const series = exports.buildSeries(data.models[0], exports.seriesKeys(data))
  const html = render(React.createElement(exports.UsageChart, { mode: 'day', points: series.hour, forceHover: 0 }))
  assert.match(html, /class="dts-tooltip"/)
  const tops = [...html.matchAll(/class="dts-tooltip"[^>]*top:([\d.]+)px/g)].map((match) => Number(match[1]))
  assert.equal(tops.length, 1)
  assert.ok(tops[0] >= 2 && tops[0] <= 116)
})

test('more than ten sessions scroll horizontally at the fixed bar pitch', () => {
  const { exports } = materialize()
  const data = timelineData()
  data.models[0].session = Array.from({ length: 12 }, (_unused, index) => ({
    sessionId: `session-${index}`,
    title: `会话 ${index}`,
    cost: 0.3 - index * 0.01,
    tokens: 1000,
    calls: 2,
    lastAt: index,
  }))
  const keys = exports.seriesKeys(data)
  const series = exports.buildSeries(data.models[0], keys)
  const html = render(React.createElement(exports.UsageChart, { mode: 'session', points: series.session }))
  assert.equal(occurrences(html, /class="dts-session-bar"/g), 12)
  // 12 bars * 40px pitch = 480px of scrollable content.
  assert.match(html, /width="480"/)
  assert.match(html, /dts-bars-scroll/)
})

test('niceScale tops out on a readable number with 3–4 ticks', () => {
  const { exports } = materialize()
  // An empty series gets one baseline tick, not a column of zeroes.
  assert.deepEqual(exports.niceScale(0), { max: 0, ticks: [0] })
  assert.deepEqual(exports.niceScale(-1), { max: 0, ticks: [0] })

  const tiny = exports.niceScale(0.037)
  assert.equal(tiny.max, 0.04)
  assert.equal(tiny.ticks.length, 3)
  assert.deepEqual(tiny.ticks, [0, 0.02, 0.04])

  const share = exports.niceScale(0.467)
  assert.equal(share.max, 0.6)
  assert.equal(share.ticks.length, 4)
  assert.deepEqual(share.ticks, [0, 0.2, 0.4, 0.6])

  const whole = exports.niceScale(100)
  assert.equal(whole.max, 100)
  assert.deepEqual(whole.ticks, [0, 50, 100])

  // Every sample: starts at 0, monotonic, 3–4 ticks, no float noise.
  for (const max of [0.0003, 0.005, 0.031, 0.037, 0.467, 1.2, 9.9, 100]) {
    const scale = exports.niceScale(max)
    assert.equal(scale.ticks[0], 0, `ticks start at 0 for ${max}`)
    assert.ok(scale.ticks.length >= 3 && scale.ticks.length <= 4, `3–4 ticks for ${max}`)
    assert.ok(scale.max >= max, `axis covers ${max}`)
    assert.equal(scale.ticks[scale.ticks.length - 1], scale.max)
    for (const tick of scale.ticks) assert.ok(String(tick).length <= 8, `no float noise: ${tick}`)
  }
})

test('the line chart draws y-axis ticks and labels for them', () => {
  const { exports } = materialize()
  const data = timelineData()
  const series = exports.buildSeries(data.models[0], exports.seriesKeys(data))
  const html = render(React.createElement(exports.UsageChart, { mode: 'day', points: series.hour }))
  // 0.031 → axis top 0.04: `$0`, `$0.020`, `$0.040` (formatUsd's 3-decimal rule).
  assert.equal(occurrences(html, /dts-axis-y/g), 3)
  assert.match(html, /text-anchor="end">\$0<\/text>/)
  assert.match(html, /text-anchor="end">\$0\.020<\/text>/)
  assert.match(html, /text-anchor="end">\$0\.040<\/text>/)
  // One grid line per tick, and the 0 tick is the baseline.
  assert.equal(occurrences(html, /class="dts-grid is-base"/g), 1)
  assert.equal(occurrences(html, /class="dts-grid"/g), 2)
  // The plot starts after the gutter, so the labels cannot overlap the x ticks.
  assert.match(html, /class="dts-grid is-base" x1="46"/)
})

test('the bar chart keeps its y-axis in a fixed layer beside the scroll area', () => {
  const { exports } = materialize()
  const data = timelineData()
  const series = exports.buildSeries(data.models[0], exports.seriesKeys(data))
  const html = render(
    React.createElement(exports.UsageChart, { mode: 'session', points: series.session, forceHover: 0 }),
  )
  const axisAt = html.indexOf('class="dts-bars-axis"')
  const labelAt = html.indexOf('dts-axis-y')
  const scrollAt = html.indexOf('class="dts-bars-scroll"')
  assert.ok(axisAt >= 0, 'there is an axis layer')
  assert.ok(labelAt > axisAt, 'the labels live in the axis layer')
  assert.ok(scrollAt > labelAt, 'the scroll area comes after the axis, so labels never scroll')
  // Axis (46) + scroll area (760 - 46) = the measured container width.
  assert.match(html, /class="dts-bars-axis" style="width:46px"/)
  assert.match(html, /class="dts-bars-scroll" style="width:714px"/)
  assert.equal(46 + 714, 760)
  // The grid lines sit in their own fixed layer over the plot, not in the scroller.
  const gridAt = html.indexOf('class="dts-bars-grid"')
  assert.ok(gridAt > axisAt && gridAt < scrollAt)
  // 0.21 tops out at 0.3 → four grid lines, the bottom one being the baseline.
  assert.equal(occurrences(html, /class="dts-grid-line/g), 4)
  assert.equal(occurrences(html, /class="dts-grid-line is-base"/g), 1)
  assert.match(html, /text-anchor="end">\$0\.300<\/text>/)
})

test('the bar tooltip starts after the axis gutter', () => {
  const { exports } = materialize()
  const data = timelineData()
  data.models[0].session = Array.from({ length: 20 }, (_unused, index) => ({
    sessionId: `session-${index}`,
    title: `会话 ${index}`,
    cost: 0.3 - index * 0.005,
    tokens: 1000,
    calls: 2,
    lastAt: index,
  }))
  const series = exports.buildSeries(data.models[0], exports.seriesKeys(data))
  const html = render(
    React.createElement(exports.UsageChart, { mode: 'session', points: series.session, forceHover: 0 }),
  )
  const left = Number((html.match(/class="dts-tooltip"[^>]*left:([\d.]+)px/) || [])[1])
  assert.ok(left >= 46 + 18, `tooltip left ${left} clears the 46px axis`)
})

/**
 * A 24-point hourly series with an arbitrary cost curve (day → day transitions).
 * @param {number} factor - cost multiplier.
 */
function hours24(factor) {
  return Array.from({ length: 24 }, (_unused, hour) => ({
    key: String(hour),
    label: `${pad2(hour)}:00`,
    tip: `2026-11-01 ${pad2(hour)}:00`,
    cost: hour === 9 ? 0.02 * factor : hour === 15 ? 0.01 * factor : 0,
    tokens: 0,
    calls: 0,
    share: null,
  }))
}

/** A selection pair for the reducer, as `useChartFrame` builds it. */
function selection(mode, points) {
  return { mode, points, signature: `${mode}|${points.length}|${points.map((p) => p.cost).join(',')}` }
}

/** An animation state at an arbitrary progress. */
function stateAt(fromMode, fromPoints, toMode, toPoints, progress, shape) {
  return {
    phase: 'morph',
    progress,
    from: selection(fromMode, fromPoints),
    to: selection(toMode, toPoints),
    seq: 1,
    shape: shape === undefined ? null : shape,
  }
}

test('easing is cubic, monotonic and pins the endpoints', () => {
  const { exports } = materialize()
  assert.equal(exports.easeInOutCubic(0), 0)
  assert.equal(exports.easeInOutCubic(0.5), 0.5)
  assert.equal(exports.easeInOutCubic(1), 1)
  assert.equal(exports.easeInCubic(0), 0)
  assert.equal(exports.easeInCubic(1), 1)
  assert.equal(exports.easeOutCubic(0), 0)
  assert.equal(exports.easeOutCubic(1), 1)
  // Slow start for ease-in, fast start for ease-out.
  assert.ok(exports.easeInCubic(0.5) < 0.5)
  assert.ok(exports.easeOutCubic(0.5) > 0.5)

  let previous = -1
  for (let step = 0; step <= 100; step += 1) {
    const value = exports.easeInOutCubic(step / 100)
    assert.ok(value >= previous, `monotonic at ${step}`)
    previous = value
  }
  assert.equal(exports.TRANSITION_MS, 100)
})

test('resamplePoints gives both a 24- and a 31-point series 96 even samples', () => {
  const { exports } = materialize()
  const data = timelineData()
  const series = exports.buildSeries(data.models[0], exports.seriesKeys(data))
  const short = exports.resamplePoints(series.hour, 96)
  const long = exports.resamplePoints(series.day, 96)
  assert.equal(short.length, 96)
  assert.equal(long.length, 96)
  for (const shape of [short, long]) {
    assert.equal(shape[0].x, 0)
    assert.equal(shape[shape.length - 1].x, 1)
    for (let index = 1; index < shape.length; index += 1) {
      const step = shape[index].x - shape[index - 1].x
      assert.ok(Math.abs(step - 1 / 95) < 1e-9, `even x steps (${step})`)
    }
  }
  // The endpoints keep the original first/last values.
  assert.equal(short[0].value, series.hour[0].cost)
  assert.equal(short[95].value, series.hour[23].cost)
  assert.equal(long[0].value, series.day[0].cost)
  assert.equal(long[95].value, series.day[29].cost)
})

test('lerpPoints is exact at both ends and blends in between', () => {
  const { exports } = materialize()
  const a = [
    { x: 0, value: 0 },
    { x: 0.5, value: 1 },
    { x: 1, value: 2 },
  ]
  const b = [
    { x: 0, value: 4 },
    { x: 0.5, value: 5 },
    { x: 1, value: 6 },
  ]
  assert.deepEqual(exports.lerpPoints(a, b, 0), a)
  assert.deepEqual(exports.lerpPoints(a, b, 1), b)
  assert.deepEqual(exports.lerpPoints(a, b, 0.5), [
    { x: 0, value: 2 },
    { x: 0.5, value: 3 },
    { x: 1, value: 4 },
  ])
})

test('transitionPlan lasts 100ms in every branch', () => {
  const { exports } = materialize()
  assert.deepEqual(exports.transitionPlan('day', 'month'), {
    kind: 'morph',
    phases: ['morph'],
    duration: 100,
  })
  assert.deepEqual(exports.transitionPlan('month', 'session'), {
    kind: 'collapse',
    phases: ['collapse', 'rise'],
    duration: 100,
  })
  assert.deepEqual(exports.transitionPlan('session', 'day'), {
    kind: 'collapse',
    phases: ['collapse', 'rise'],
    duration: 100,
  })
  assert.deepEqual(exports.transitionPlan('day', 'day'), { kind: 'none', phases: [], duration: 0 })
})

test('day → day (same point count) lerps the line and keeps the dots on it', () => {
  const { exports } = materialize()
  const from = hours24(1)
  const to = hours24(2)
  const frame = exports.frameOf(stateAt('day', from, 'day', to, 0.5))
  assert.equal(frame.kind, 'line-lerp')
  // Halfway through, every node sits between its two positions.
  for (let index = 0; index < from.length; index += 1) {
    const expected = (from[index].cost + to[index].cost) / 2
    assert.ok(Math.abs(frame.linePoints[index].value - expected) < 1e-9, `node ${index} midway`)
  }
  // The dots ride the line: they share its positions and never fade.
  const html = render(React.createElement(exports.ChartFrameView, { frame }))
  assert.doesNotMatch(html, /opacity=/)
  const ys = [...html.matchAll(/class="dts-dot"[^>]*cy="([\d.]+)"/g)].map((match) => Number(match[1]))
  assert.equal(ys.length, 24)
})

test('month → month (31 → 30 points) morphs through 96 samples with fading dots', () => {
  const { exports } = materialize()
  const base = timelineData()
  const series = exports.buildSeries(base.models[0], exports.seriesKeys(base))
  const from = series.day
  const to = series.day.slice(0, 30).map((point, index) => ({ ...point, cost: index === 3 ? 0.15 : 0 }))
  assert.equal(from.length, 30)
  assert.equal(to.length, 30)
  // Different counts: 30 vs a 31-point month.
  const longer = [...from, { ...from[0], key: '2026-11-31', cost: 0.02 }]
  const state = stateAt('month', longer, 'month', to, 0.1)
  const early = exports.frameOf(state)
  assert.equal(early.kind, 'line-morph')
  assert.ok(early.linePoints.length === 96)
  assert.equal(early.dotOpacityTo, 0, 'the new dots have not started')
  assert.ok(early.dotOpacityFrom < 1, 'the old dots are fading')
  // The line exists from the very first frame.
  assert.ok(early.linePoints.every((point) => Number.isFinite(point.value)))

  const late = exports.frameOf({ ...state, progress: 0.9 })
  assert.ok(late.dotOpacityTo > 0.8, `new dots nearly visible (${late.dotOpacityTo})`)
  assert.ok(late.dotOpacityFrom < 0.05, 'old dots almost gone')

  const html = render(React.createElement(exports.ChartFrameView, { frame: early }))
  assert.equal(occurrences(html, /class="dts-chart-wrap/g), 1, 'a morph is a single chart')
  assert.match(html, /opacity="0"/)
})

test('line ↔ bars collapses on the baseline then rises inside the same 100ms', () => {
  const { exports } = materialize()
  const base = timelineData()
  const series = exports.buildSeries(base.models[0], exports.seriesKeys(base))
  const middle = exports.frameOf(stateAt('day', series.hour, 'session', series.session, 0.25))
  assert.equal(middle.kind, 'collapse')
  assert.equal(middle.mode, 'day')
  assert.ok(middle.scale > 0 && middle.scale < 1)

  const bottom = exports.frameOf(stateAt('day', series.hour, 'session', series.session, 0.5))
  assert.equal(bottom.kind, 'rise')
  assert.equal(bottom.scale, 0)

  const rising = exports.frameOf(stateAt('day', series.hour, 'session', series.session, 0.75))
  assert.equal(rising.kind, 'rise')
  assert.ok(rising.scale > 0 && rising.scale < 1)

  // The last animated frame is the bar chart at full scale; the reducer is what
  // hands over to `idle` once the timeline completes.
  const last = exports.frameOf(stateAt('day', series.hour, 'session', series.session, 1))
  assert.equal(last.kind, 'rise')
  assert.equal(last.scale, 1)
  const done = exports.frameOf(
    exports.chartFrame(stateAt('day', series.hour, 'session', series.session, 0.9), { type: 'tick', progress: 1 }),
  )
  assert.equal(done.kind, 'idle')
  assert.equal(done.mode, 'session')
})

test('an interrupting animation starts from the shape already on screen', () => {
  const { exports } = materialize()
  const base = timelineData()
  const series = exports.buildSeries(base.models[0], exports.seriesKeys(base))
  const running = stateAt('month', series.day, 'month', series.day.slice().reverse(), 0.6)
  const shape = exports.frameOf(running).linePoints
  const interrupted = exports.chartFrame(running, {
    type: 'data',
    to: selection('day', series.hour),
    animate: true,
  })
  assert.equal(interrupted.phase, 'morph')
  assert.equal(interrupted.progress, 0)
  assert.equal(interrupted.to.mode, 'day')
  assert.deepEqual(interrupted.shape, shape)
  // The new run starts at progress 0 from that captured shape: it is resampled
  // to 96 samples, its ends are unchanged, and it is not the target's shape.
  const first = exports.frameOf(interrupted)
  assert.equal(first.kind, 'line-morph')
  assert.equal(first.linePoints.length, 96)
  assert.equal(first.linePoints[0].value, shape[0].value)
  assert.equal(first.linePoints[95].value, shape[shape.length - 1].value)
  assert.notEqual(first.linePoints[0].value, series.hour[0].cost + 1)
})

test('rapid changes settle on the last target', () => {
  const { exports } = materialize()
  const base = timelineData()
  const series = exports.buildSeries(base.models[0], exports.seriesKeys(base))
  let state = exports.idleFrame(selection('day', series.hour))
  state = exports.chartFrame(state, { type: 'data', to: selection('month', series.day), animate: true })
  state = exports.chartFrame(state, { type: 'tick', progress: 0.4 })
  state = exports.chartFrame(state, { type: 'data', to: selection('session', series.session), animate: true })
  state = exports.chartFrame(state, { type: 'tick', progress: 0.3 })
  state = exports.chartFrame(state, { type: 'data', to: selection('day', series.hour), animate: true })
  assert.equal(state.to.mode, 'day')
  // …and finishing that run lands exactly on the last requested selection.
  state = exports.chartFrame(state, { type: 'tick', progress: 1 })
  assert.equal(state.phase, 'idle')
  assert.equal(state.to.mode, 'day')
  assert.equal(exports.frameOf(state).kind, 'idle')
})

test('a month flip while in session mode lerps the bars bar by bar', () => {
  const { exports } = materialize()
  const from = Array.from({ length: 4 }, (_unused, index) => ({
    key: `s${index}`,
    label: `s${index}`,
    tip: `会话 ${index}`,
    cost: 0.2 - index * 0.04,
    tokens: 0,
    calls: 1,
    share: null,
  }))
  const to = from.map((point) => ({ ...point, cost: point.cost * 2 }))
  const frame = exports.frameOf(stateAt('session', from, 'session', to, 0.5))
  assert.equal(frame.kind, 'bars-lerp')
  assert.equal(frame.mode, 'session')
  for (let index = 0; index < from.length; index += 1) {
    assert.ok(Math.abs(frame.points[index].cost - (from[index].cost + to[index].cost) / 2) < 1e-9)
  }
  // Rendered as one bar chart, no second layer.
  const html = render(React.createElement(exports.ChartFrameView, { frame }))
  assert.equal(occurrences(html, /dts-session-bar/g), 4)
  assert.equal(occurrences(html, /dts-bars-wrap/g), 1)
})

test('a selection that did not change does not start an animation', () => {
  const { exports } = materialize()
  const base = timelineData()
  const series = exports.buildSeries(base.models[0], exports.seriesKeys(base))
  const resting = exports.idleFrame(selection('day', series.hour))
  const again = exports.chartFrame(resting, { type: 'data', to: selection('day', series.hour), animate: true })
  assert.equal(again, resting)
})

test('a loading month keeps the previous chart on screen', async () => {
  const { exports } = materialize()
  const payload = timelineData('2026-10')
  exports.clearTimelineCache()
  // The merge rule: a load without data keeps the previous payload.
  const merged = exports.mergeTimelineState(
    { status: 'ready', data: payload, error: null },
    { status: 'loading', data: null, error: null },
  )
  assert.equal(merged.data, payload)
  assert.equal(merged.status, 'loading')

  // And a block that is loading with data renders the chart, not a skeleton.
  exports.seedTimelineState('2026-10', '2026-10-01', { status: 'loading', data: payload, error: null })
  const html = render(
    React.createElement(exports.UsageBlock, {
      kind: 'model',
      modelKey: 'opencode-go/deepseek-v4.1-flash',
      title: 'DeepSeek V4.1 Flash',
      limits: LIMITS,
      mode: 'month',
      initialMonth: '2026-10',
      initialDate: '2026-10-01',
    }),
  )
  assert.match(html, /dts-chart-svg/)
  assert.doesNotMatch(html, /dts-skeleton/)
  assert.match(html, /aria-busy="true"/)
})

test('a failed refresh keeps the chart and offers a retry', async () => {
  const { exports } = materialize()
  const payload = timelineData('2026-10')
  exports.clearTimelineCache()
  const merged = exports.mergeTimelineState(
    { status: 'ready', data: payload, error: null },
    { status: 'error', data: null, error: 'boom' },
  )
  assert.equal(merged.data, payload)
  assert.equal(merged.error, 'boom')

  exports.seedTimelineState('2026-10', '2026-10-01', { status: 'error', data: payload, error: 'boom' })
  const html = render(
    React.createElement(exports.UsageBlock, {
      kind: 'model',
      modelKey: 'opencode-go/deepseek-v4.1-flash',
      title: 'DeepSeek V4.1 Flash',
      limits: LIMITS,
      mode: 'month',
      initialMonth: '2026-10',
      initialDate: '2026-10-01',
    }),
  )
  assert.match(html, /dts-chart-svg/)
  assert.match(html, /dts-block-error/)
  assert.match(html, /重试/)
  assert.doesNotMatch(html, /dts-skeleton/)
})

test('the axis keeps the larger of the two ranges mid-transition', () => {
  const { exports } = materialize()
  const small = hours24(0.002)
  const big = hours24(1)
  const frame = exports.frameOf(stateAt('day', small, 'day', big, 0.5))
  const smallAxis = exports.niceScale(exports.frameOf(exports.idleFrame(selection('day', small))).axisMax).max
  const bigAxis = exports.niceScale(exports.frameOf(exports.idleFrame(selection('day', big))).axisMax).max
  assert.equal(frame.axisMax, Math.max(smallAxis, bigAxis))
  assert.ok(frame.axisMax >= bigAxis)
})

test('a server render is idle: one chart, no animation wrapper', () => {
  const { exports } = materialize()
  const data = timelineData()
  const series = exports.buildSeries(data.models[0], exports.seriesKeys(data))
  const line = render(React.createElement(exports.UsageChart, { mode: 'day', series }))
  assert.equal(occurrences(line, /class="dts-chart-wrap/g), 1)
  assert.doesNotMatch(line, /dts-chart-stage/)
  assert.doesNotMatch(line, /data-transition/)
  assert.equal(occurrences(line, /class="dts-dot"/g), 24)

  const bars = render(React.createElement(exports.UsageChart, { mode: 'session', series }))
  assert.equal(occurrences(bars, /class="dts-bars-wrap/g), 1)
  assert.equal(occurrences(bars, /class="dts-session-bar"/g), 3)
})

test('tooltips are suppressed while a chart is animating', () => {
  const { exports } = materialize()
  const data = timelineData()
  const series = exports.buildSeries(data.models[0], exports.seriesKeys(data))
  const idle = render(React.createElement(exports.LineChart, { points: series.hour, mode: 'day', forceHover: 0 }))
  assert.match(idle, /class="dts-tooltip"/)
  const animating = render(
    React.createElement(exports.LineChart, {
      points: series.hour,
      mode: 'day',
      scale: 0.5,
      hoverable: false,
      forceHover: 0,
    }),
  )
  assert.doesNotMatch(animating, /class="dts-tooltip"/)
})
test('formatting mirrors SPEC §1 on both sides', () => {
  const { exports } = materialize()
  assert.equal(exports.formatUsd(0.4459), '$0.446')
  assert.equal(exports.formatUsd(1.2345), '$1.23')
  assert.equal(exports.formatUsd(100), '$100')
  assert.equal(exports.formatUsd(1234.5), '$1235')
  assert.equal(exports.formatPercent(0.0059), '0.59%')
  assert.equal(exports.formatPercent(0.004459), '0.45%')
  assert.equal(exports.formatPercent(0.00003), '<0.01%')
  assert.equal(exports.formatPercent(0.5), '50.0%')
  assert.equal(exports.formatPercent(1.2), '120%')
})

test('splitModels degrades gracefully and sorts both groups', () => {
  const { exports } = materialize()
  const payload = timelineData()

  // Older hosts (or a failed request) send no `knownModels`: used only.
  const bare = exports.splitModels({ ...payload, models: payload.models })
  assert.equal(bare.used.length, 1)
  assert.deepEqual(bare.unused, [])
  assert.deepEqual(exports.splitModels(null), { used: [], unused: [] })
  assert.deepEqual(exports.splitModels({ models: [], knownModels: [] }), { used: [], unused: [] })

  // Used models sort by this month's cost, unused by last-month cost, then lastAt.
  const usedRows = [
    { key: 'a', model: 'a', month: { cost: 0.1 } },
    { key: 'b', model: 'b', month: { cost: 0.4 } },
    { key: 'c', model: 'c', month: { cost: 0.2 } },
  ]
  const known = [
    { key: 'x', model: 'x', lastMonthCost: 0.02, lastAt: 5 },
    { key: 'y', model: 'y', lastMonthCost: 0.3, lastAt: 1 },
    { key: 'z', model: 'z', lastMonthCost: 0.02, lastAt: 9 },
    { key: 'b', model: 'b', lastMonthCost: 9, lastAt: 9 },
  ]
  const groups = exports.splitModels({ models: usedRows, knownModels: known })
  assert.deepEqual(
    groups.used.map((row) => row.key),
    ['b', 'c', 'a'],
  )
  // `b` already ran this month, so it is not in the unused group…
  assert.deepEqual(
    groups.unused.map((row) => row.key),
    ['y', 'z', 'x'],
  )
})

test('the dialog renders only the models the range actually used', () => {
  const { exports } = materialize()
  const payload = { ...timelineData(), knownModels: knownModels() }
  exports.seedRange('last30', rangeData())
  const html = render(
    React.createElement(exports.UsageModal, {
      open: true,
      base: baseOf(payload),
      limits: LIMITS,
      summary: summaryState(),
      onClose: () => {},
    }),
  )
  // The rolling range only carries models that ran in it, so the unused group
  // has nothing to hide any more.
  assert.doesNotMatch(html, /本月未使用/)
  assert.doesNotMatch(html, /dts-unused-head/)
  assert.match(html, /DeepSeek V4\.1 Flash/)
  // The model picker lists the same set.
  assert.match(html, /全部模型/)
  assert.match(html, /aria-label="模型筛选"/)
})

test('expanding lists the unused blocks after the used ones, sorted by last cost', async () => {
  const { exports } = materialize()
  const payload = { ...timelineData(), knownModels: knownModels() }
  const { unused } = exports.splitModels(payload)
  assert.deepEqual(
    unused.map((entry) => entry.label),
    ['Qwen3 Coder', 'Claude Haiku 5.5'],
  )

  const october = octoberPayload()
  await seed(exports, '2026-10', '2026-10-01', october)
  const html = render(
    React.createElement(exports.UnusedGroup, {
      entries: unused,
      limits: LIMITS,
      expanded: true,
      onToggle: () => {},
    }),
  )
  // Both blocks render, in the sorted order the group was given.
  assert.ok(html.indexOf('Qwen3 Coder') < html.indexOf('Claude Haiku 5.5'))
  assert.match(html, /dts-unused-caret is-open/)
})

test('an unused block opens on its last-used month, at $0 for this month', async () => {
  const { exports } = materialize()
  const october = octoberPayload()
  await seed(exports, '2026-10', '2026-10-01', october)
  const { unused } = exports.splitModels({ ...timelineData(), knownModels: knownModels() })
  const haiku = unused.find((entry) => entry.model === 'claude-haiku-5-5')
  const html = render(
    React.createElement(exports.UnusedGroup, {
      entries: [haiku],
      limits: LIMITS,
      expanded: true,
      onToggle: () => {},
    }),
  )
  // Headline stays on this month's scale; the tag says when it last ran.
  assert.match(html, /\$0 \/ 0\.00%/)
  assert.match(html, /上次使用 2026年10月/)
  // The block's own cursor starts in October, and that is the month it asks for.
  assert.match(html, /2026年10月/)
  const cursor = exports.startCursor(LIMITS, '2026-10')
  assert.deepEqual(cursor, { month: '2026-10', date: '2026-10-01' })
  assert.equal(exports.timelinePath(cursor.month, cursor.date), '/token-split/timeline?month=2026-10&date=2026-10-01')
  // And it already renders October's chart from that payload.
  assert.match(html, /dts-chart-svg/)
  assert.match(html, /18 次调用/)
})

test('an unusable lastMonthKey falls back to this month instead of crashing', async () => {
  const { exports } = materialize()
  await seed(exports, '2026-11', '2026-11-01', timelineData())
  const { unused } = exports.splitModels({ ...timelineData(), knownModels: knownModels() })
  const broken = { ...unused[0], lastMonthKey: undefined }
  const html = render(
    React.createElement(exports.UnusedGroup, {
      entries: [broken],
      limits: LIMITS,
      expanded: true,
      onToggle: () => {},
    }),
  )
  assert.match(html, /\$0 \/ 0\.00%/)
  assert.match(html, /本月未使用/)
  assert.equal(exports.usableMonthKey('nope'), null)
  assert.equal(exports.usableMonthKey('2026-10'), '2026-10')
})

test('the panel footnotes the models that did not run this month', () => {
  const { exports } = materialize()
  const withKnown = summaryData()
  withKnown.knownModels = knownModels()
  const shown = render(
    React.createElement(exports.PanelBody, {
      summary: { status: 'ready', data: withKnown, error: null },
      onRefresh: () => {},
      refreshing: false,
    }),
  )
  assert.match(shown, /另有 2 个模型本月未使用/)
  assert.equal(exports.unusedCountOf(withKnown), 2)

  const without = render(
    React.createElement(exports.PanelBody, {
      summary: { status: 'ready', data: summaryData(), error: null },
      onRefresh: () => {},
      refreshing: false,
    }),
  )
  assert.doesNotMatch(without, /模型本月未使用/)
  assert.equal(exports.unusedCountOf(summaryData()), 0)
})

test('a cached payload is served from memory but a forced load still asks', async () => {
  const { exports } = materialize()
  exports.clearTimelineCache()
  let calls = 0
  const fetcher = async () => {
    calls += 1
    return timelineData()
  }

  await exports.loadTimeline('2026-11', '2026-11-01', { fetcher })
  assert.equal(calls, 1)
  // A plain load is the cache hit the dialog paints on first.
  await exports.loadTimeline('2026-11', '2026-11-01', { fetcher })
  assert.equal(calls, 1, 'a cache hit issues no request')

  // A forced load is the revalidation: it skips the read but refreshes the cache.
  const fresh = timelineData()
  fresh.models[0].label = 'Refreshed'
  const forced = await exports.loadTimeline('2026-11', '2026-11-01', { force: true, fetcher: async () => {
    calls += 1
    return fresh
  } })
  assert.equal(calls, 2, 'force always hits the host')
  assert.equal(forced.data.models[0].label, 'Refreshed')

  // …and the refreshed payload is what the next cache hit returns.
  const after = await exports.loadTimeline('2026-11', '2026-11-01', { fetcher })
  assert.equal(calls, 2)
  assert.equal(after.data.models[0].label, 'Refreshed')
})

test('a forced load joins the in-flight request instead of duplicating it', async () => {
  const { exports } = materialize()
  exports.clearTimelineCache()
  let calls = 0
  let release
  const slow = new Promise((resolve) => {
    release = resolve
  })
  const fetcher = async () => {
    calls += 1
    await slow
    return timelineData()
  }

  const forced = exports.loadTimeline('2026-11', '2026-11-01', { force: true, fetcher })
  const plain = exports.loadTimeline('2026-11', '2026-11-01', { fetcher })
  const forcedAgain = exports.loadTimeline('2026-11', '2026-11-01', { force: true, fetcher })
  release()
  const [a, b, c] = await Promise.all([forced, plain, forcedAgain])
  assert.equal(calls, 1, 'three callers, one request')
  assert.equal(a, b)
  assert.equal(a, c)
})

test('revalidation brings a brand-new model into the used list', async () => {
  const { exports } = materialize()
  exports.clearTimelineCache()
  const before = timelineData('2026-11')
  before.models.push({ ...before.models[0], key: 'opencode-go/second', model: 'second', label: 'Second' })
  const after = timelineData('2026-11')
  after.models.push(
    { ...after.models[0], key: 'opencode-go/second', model: 'second', label: 'Second' },
    {
      ...after.models[0],
      key: 'opencode-go/mimo-v2.6-pro',
      model: 'mimo-v2.6-pro',
      label: 'MiMo v2.6 Pro',
      month: { calls: 3, tokens: 1000, cost: 0.004, sessions: 1, share: 0.0001 },
    },
  )

  // The dialog paints the stale payload first…
  const stale = await exports.loadTimeline('2026-11', '2026-11-01', { force: true, fetcher: async () => before })
  assert.equal(exports.splitModels(stale.data).used.length, 2)

  // …then the revalidation lands and the new model is there.
  const refreshed = await exports.loadTimeline('2026-11', '2026-11-01', {
    force: true,
    fetcher: async () => after,
  })
  const merged = exports.mergeTimelineState(stale, refreshed)
  const used = exports.splitModels(merged.data).used
  assert.equal(used.length, 3)
  assert.ok(used.some((model) => model.model === 'mimo-v2.6-pro'))
})

test('the dialog paints the cached payload without a skeleton and marks itself busy', async () => {
  const { exports } = materialize()
  const payload = timelineData('2026-10')
  exports.clearTimelineCache()
  await exports.loadTimeline('2026-10', '2026-10-01', { fetcher: async () => payload })
  const html = render(
    React.createElement(exports.UsageBlock, {
      kind: 'model',
      modelKey: 'opencode-go/deepseek-v4.1-flash',
      title: 'DeepSeek V4.1 Flash',
      limits: LIMITS,
      mode: 'month',
      initialMonth: '2026-10',
      initialDate: '2026-10-01',
    }),
  )
  // Stale data is still real data: the chart is drawn straight from the cache.
  assert.match(html, /dts-chart-svg/)
  assert.doesNotMatch(html, /dts-skeleton/)
  assert.equal(exports.REVALIDATE_MS, 30_000)
})

