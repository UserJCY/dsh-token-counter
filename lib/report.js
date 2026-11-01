/**
 * Pure reporting: period windows, aggregation over the OpenCode Go price
 * table, the subscription split, and the Markdown/CSV renderings.
 *
 * Money is the primary unit here, not tokens: a Go plan's allowance is
 * denominated in dollars per model, so the dollar cost of a window is what
 * "how much of the plan did this person use" actually means. Token counts
 * stay visible for reconciliation with the provider dashboard.
 *
 * @module dsh-token-split/report
 */
import { billableTokens } from './fold.js'
import { ALLOWANCE_CAPS, shareOf, sumShares } from './pricing.js'

/** Selectable relative periods, in the order the tool schema lists them. */
export const PERIODS = ['today', 'cycle', 'month', 'last7', 'last30', 'all']

/** Selectable detail tables. */
export const DETAILS = ['summary', 'daily', 'models', 'sessions']

/** Length of the rolling 5h allowance window. */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

/** Length of the rolling weekly allowance window. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Local midnight of the day containing `date`. */
export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Local midnight `days` days after the day containing `date`. */
function dayShift(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime()
}

/** `YYYY-MM-DD` in local time. */
export function dateKey(at) {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Parse a local `YYYY-MM-DD` date, or undefined when the text is not one. */
export function parseDateKey(text) {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  const date = new Date(year, month, day)
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return undefined
  return date.getTime()
}

/**
 * The local start of the billing cycle containing `now`.
 * @param {Date} now - reference instant.
 * @param {number} cycleStartDay - day of month the cycle restarts (1–28).
 * @returns {number} epoch milliseconds at local midnight.
 */
export function cycleStartAt(now, cycleStartDay) {
  const day = Math.min(Math.max(Math.trunc(cycleStartDay) || 1, 1), 28)
  const year = now.getFullYear()
  const month = now.getMonth()
  if (now.getDate() >= day) return new Date(year, month, day).getTime()
  return new Date(year, month - 1, day).getTime()
}

/**
 * Resolve a reporting window.
 * @param {object} [options] - window selection.
 * @param {string} [options.period] - one of {@link PERIODS}.
 * @param {string} [options.since] - explicit `YYYY-MM-DD` lower bound (inclusive).
 * @param {string} [options.until] - explicit `YYYY-MM-DD` upper bound (inclusive).
 * @param {number} [options.cycleStartDay] - billing cycle restart day.
 * @param {Date} [options.now] - reference instant.
 * @returns {{ start: number, end: number, label: string, period: string, explicit: boolean }} the window.
 */
export function resolveWindow({ period = 'cycle', since, until, cycleStartDay = 1, now = new Date() } = {}) {
  const sinceAt = parseDateKey(since)
  const untilAt = parseDateKey(until)
  if (sinceAt !== undefined || untilAt !== undefined) {
    const start = sinceAt ?? 0
    const end = untilAt === undefined ? dayShift(now, 1) : dayShift(new Date(untilAt), 1)
    return { start, end, label: windowLabel(start, end), period: 'custom', explicit: true }
  }
  switch (period) {
    case 'today': {
      const start = startOfDay(now)
      return { start, end: dayShift(now, 1), label: windowLabel(start, dayShift(now, 1)), period, explicit: false }
    }
    case 'month': {
      // The calendar month, local midnight to local midnight. With the default
      // `cycleStartDay = 1` this is exactly the `cycle` window; the two only
      // drift apart once the billing cycle restarts mid-month.
      const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()
      return { start, end, label: windowLabel(start, end), period, explicit: false }
    }
    case 'last7':
    case 'last30': {
      const days = period === 'last7' ? 7 : 30
      const start = dayShift(now, -(days - 1))
      const end = dayShift(now, 1)
      return { start, end, label: windowLabel(start, end), period, explicit: false }
    }
    case 'all':
      return { start: 0, end: Number.POSITIVE_INFINITY, label: '全部历史', period, explicit: false }
    case 'cycle':
    default: {
      const start = cycleStartAt(now, cycleStartDay)
      const startDate = new Date(start)
      const end = new Date(startDate.getFullYear(), startDate.getMonth() + 1, startDate.getDate()).getTime()
      return { start, end, label: windowLabel(start, end), period: 'cycle', explicit: false }
    }
  }
}

/** Human label for a half-open window, inclusive of its last day. */
export function windowLabel(start, end) {
  if (start === 0 && !Number.isFinite(end)) return '全部历史'
  const last = Number.isFinite(end) ? end - 1 : Date.now()
  if (start === 0) return `截至 ${dateKey(last)}`
  return `${dateKey(start)} ~ ${dateKey(last)}`
}

/** An empty aggregation bucket. */
function newBucket() {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    tokens: 0,
    cost: 0,
    unpricedTokens: 0,
    unpricedCalls: 0,
    sessions: new Set(),
  }
}

/** Fold one sample into a bucket, attributing it to an already-resolved session. */
function addTo(bucket, sample, priced, sessionKey) {
  bucket.calls += 1
  bucket.input += sample.input
  bucket.output += sample.output
  bucket.cacheRead += sample.cacheRead
  bucket.cacheWrite += sample.cacheWrite
  bucket.reasoning += sample.reasoning ?? 0
  bucket.tokens += billableTokens(sample)
  bucket.cost += priced.usd
  if (priced.row === undefined) {
    bucket.unpricedTokens += billableTokens(sample)
    bucket.unpricedCalls += 1
  }
  bucket.sessions.add(sessionKey)
}

/** Sortable, deterministic bucket view for rendering. */
function bucketView(bucket) {
  return {
    calls: bucket.calls,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    reasoning: bucket.reasoning,
    tokens: bucket.tokens,
    cost: bucket.cost,
    unpricedTokens: bucket.unpricedTokens,
    unpricedCalls: bucket.unpricedCalls,
    sessions: bucket.sessions.size,
  }
}

/**
 * Aggregate samples inside `[start, end)`, plus the two rolling allowance
 * windows (`[now-5h, now]` and `[now-7d, now]`).
 *
 * Models are grouped by `provider/model`, not by model alone: the same model id
 * can be reached through more than one provider (and through price aliases),
 * and grouping by model would merge those rows and double their allowance.
 *
 * All three windows come out of one traversal of `records`.
 *
 * @param {readonly object[]} records - usage samples.
 * @param {object} options - aggregation options.
 * @param {number} options.start - inclusive lower bound (epoch ms).
 * @param {number} options.end - exclusive upper bound (epoch ms).
 * @param {object} options.priceTable - {@link import('./pricing.js').PriceTable}.
 * @param {readonly string[]} [options.providers] - provider routes to count; empty/undefined counts every provider.
 * @param {number | Date} [options.now] - reference instant for the rolling windows, injectable for tests.
 * @param {(sessionId: string) => string} [options.resolveSession] - maps a record's session to the session that owns it; a sub-session resolves to its root. Defaults to the identity, so a caller without session metadata keeps the raw ids.
 * @returns {object} totals plus per-day, per-model, per-session and per-user breakdowns.
 */
export function aggregate(records, { start, end, priceTable, providers, now = Date.now(), resolveSession = (sessionId) => sessionId }) {
  const allowed = Array.isArray(providers) ? providers.filter((provider) => typeof provider === 'string' && provider.length > 0) : []
  const totals = newBucket()
  const byDay = new Map()
  const byModel = new Map()
  const bySession = new Map()
  const byUser = new Map()
  const nowAt = now instanceof Date ? now.getTime() : Number.isFinite(now) ? now : Date.now()
  const fiveStart = nowAt - FIVE_HOURS_MS
  const weekStart = nowAt - WEEK_MS
  /** model id → USD spent inside a rolling window. */
  const fiveHourCost = new Map()
  const weeklyCost = new Map()

  for (const record of records) {
    const at = record.at
    const inWindow = at >= start && at < end
    const inFiveHour = at >= fiveStart && at <= nowAt
    const inWeekly = at >= weekStart && at <= nowAt
    if (!inWindow && !inFiveHour && !inWeekly) continue
    if (allowed.length > 0 && !allowed.includes(record.provider)) continue
    const priced = priceTable.price(record)
    if (inFiveHour) addCost(fiveHourCost, record.model, priced.usd)
    if (inWeekly) addCost(weeklyCost, record.model, priced.usd)
    if (!inWindow) continue
    // Delegate money lands on the root session, and a sub-session must not add
    // a second session to any count: one resolved key serves every bucket.
    const sessionKey = resolveSession(record.sessionId)
    addTo(totals, record, priced, sessionKey)

    const day = dateKey(record.at)
    if (!byDay.has(day)) byDay.set(day, newBucket())
    addTo(byDay.get(day), record, priced, sessionKey)

    const provider = record.provider ?? ''
    const model = record.model || '未知模型'
    const modelKey = `${provider}/${model}`
    if (!byModel.has(modelKey)) byModel.set(modelKey, { provider, model, bucket: newBucket() })
    addTo(byModel.get(modelKey).bucket, record, priced, sessionKey)

    if (!bySession.has(sessionKey)) bySession.set(sessionKey, newBucket())
    addTo(bySession.get(sessionKey), record, priced, sessionKey)

    const user = record.user || '未标记'
    if (!byUser.has(user)) byUser.set(user, newBucket())
    addTo(byUser.get(user), record, priced, sessionKey)
  }

  const modelRows = [...byModel.entries()]
    .map(([key, entry]) => {
      const view = bucketView(entry.bucket)
      const limit = priceTable.limitOf(entry.model)
      const free = priceTable.isFree(entry.model)
      return {
        key,
        label: priceTable.labelOf(entry.model),
        provider: entry.provider,
        model: entry.model,
        ...view,
        // Token share of the window, kept beside the allowance share so the two
        // are never confused (`share` is the allowance one).
        tokenShare: totals.tokens > 0 ? view.tokens / totals.tokens : 0,
        share: shareOf(view.cost, limit),
        costShare: totals.cost > 0 ? view.cost / totals.cost : 0,
        limit,
        priced: view.unpricedCalls === 0,
        free,
      }
    })
    .sort((a, b) => Number(a.free || !a.priced) - Number(b.free || !b.priced) || b.cost - a.cost || b.tokens - a.tokens)

  // The plan-level percentage is the sum of the per-model shares, not
  // `totalCost / Σlimit`: Go treats the allowances as one shared pool.
  const totalShare = sumShares(modelRows)
  const paidRows = modelRows.filter((row) => row.priced && !row.free)
  const limitKnown = paidRows.every((row) => Number.isFinite(row.limit) && row.limit > 0)

  return {
    totals: { ...bucketView(totals), share: totalShare, limitKnown },
    unpriced: { calls: totals.unpricedCalls, tokens: totals.unpricedTokens },
    allowances: {
      fiveHour: { ...rollupCost(fiveHourCost, priceTable), cap: ALLOWANCE_CAPS.fiveHour },
      weekly: { ...rollupCost(weeklyCost, priceTable), cap: ALLOWANCE_CAPS.weekly },
    },
    byDay: [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, ...bucketView(value) })),
    byModel: modelRows,
    bySession: [...bySession.entries()]
      .sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens)
      .map(([key, value]) => ({ key, ...bucketView(value) })),
    byUser: [...byUser.entries()].sort(([, a], [, b]) => b.cost - a.cost).map(([key, value]) => ({ key, ...bucketView(value) })),
  }
}

/** Add one priced sample's cost to a per-model rolling total. */
function addCost(map, model, usd) {
  const key = model || '未知模型'
  map.set(key, (map.get(key) ?? 0) + usd)
}

/** Cost and allowance share of one rolling window. */
function rollupCost(map, priceTable) {
  let cost = 0
  let share = 0
  for (const [model, value] of map) {
    cost += value
    const modelShare = priceTable.shareOf(model, value)
    if (modelShare !== undefined) share += modelShare
  }
  return { cost, share }
}

/**
 * Split a fixed fee by usage share.
 * @param {object} input - split input.
 * @param {number} input.mine - this machine's usage on the chosen basis.
 * @param {number} input.other - the other person's usage on the same basis.
 * @param {number} input.fee - fee to split.
 * @returns {{ share: number, mine: number, other: number } | null} split, or null when both sides are zero.
 */
export function computeSplit({ mine, other, fee }) {
  const total = mine + other
  if (!(total > 0)) return null
  const share = mine / total
  return { share, mine: fee * share, other: fee * (1 - share) }
}

/** Group digits for readability without locale surprises. */
export function formatNumber(value) {
  const rounded = Math.round(value)
  const sign = rounded < 0 ? '-' : ''
  const digits = String(Math.abs(rounded))
  let out = ''
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ','
    out += digits[index]
  }
  return sign + out
}

/**
 * Format a USD amount with the shared display rule: below $1 three decimals,
 * $1–$100 two decimals, from $100 whole dollars. `$0` stays short instead of
 * rendering `$0.000`.
 * @param {number} usd - amount in USD.
 * @returns {string} `$0.446` style text.
 */
export function formatUsd(usd) {
  const value = Number.isFinite(usd) ? usd : 0
  if (value === 0) return '$0'
  const magnitude = Math.abs(value)
  if (magnitude < 1) return `$${value.toFixed(3)}`
  if (magnitude < 100) return `$${value.toFixed(2)}`
  return `$${Math.round(value)}`
}

/** Format a money amount with two decimals. */
export function formatMoney(value, symbol) {
  return `${symbol}${value.toFixed(2)}`
}

/**
 * Format a share as a percentage with the shared display rule:
 * `<0.01%` below one basis point, two decimals under 1%, one decimal under
 * 100%, and a whole number from 100% up (the client paints that one as an
 * alert). The input is a fraction (`0.004459` → `0.45%`).
 * @param {number} share - fraction of an allowance.
 * @returns {string} `0.45%` style text, or `—` when the share is unknown.
 */
export function formatPercent(share) {
  if (!Number.isFinite(share)) return '—'
  const percent = share * 100
  if (percent > 0 && percent < 0.01) return '<0.01%'
  if (percent < 1) return `${percent.toFixed(2)}%`
  if (percent < 100) return `${percent.toFixed(1)}%`
  return `${Math.round(percent)}%`
}

/**
 * The `5h 0.1%/20% · 周 0.3%/50%` small print: used share over the window cap,
 * both as a fraction of the monthly allowance.
 * @param {{ fiveHour: { share: number, cap: number }, weekly: { share: number, cap: number } } | undefined} allowances - {@link aggregate} allowances.
 * @returns {string} the line, or an empty string when allowances are missing.
 */
export function formatAllowanceLine(allowances) {
  if (!allowances || !allowances.fiveHour || !allowances.weekly) return ''
  const part = (label, entry) => `${label} ${formatPercent(entry.share)}/${Math.round(entry.cap * 100)}%`
  return `${part('5h', allowances.fiveHour)} · ${part('周', allowances.weekly)}`
}

/** The `$0.446 / 0.45%` cell of the model table. */
function amountWithShare(row) {
  if (row.free) return `${formatUsd(row.cost)} / 免费`
  if (row.priced === false) return `${formatUsd(row.cost)} / 未定价`
  if (row.share === undefined) return formatUsd(row.cost)
  return `${formatUsd(row.cost)} / ${formatPercent(row.share)}`
}

/** Escape a table cell's pipe characters and newlines. */
function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * Render the Markdown report.
 * @param {object} input - report input.
 * @param {object} input.window - resolved window.
 * @param {object} input.aggregation - {@link aggregate} result.
 * @param {string} input.detail - which detail table to append.
 * @param {object} input.config - resolved plugin config (user, monthlyFee, providers, symbol).
 * @param {object | null} input.split - {@link computeSplit} result, when both sides are known.
 * @param {number | undefined} input.otherCost - the other person's usage in USD, when supplied.
 * @param {string} [input.basis] - 'cost' (default) or 'tokens'.
 * @param {object} [input.ledger] - ledger access for session titles.
 * @param {string} [input.dataFile] - ledger path, shown in the footer.
 * @returns {string} Markdown report.
 */
export function renderReport({ window, aggregation, detail, config, split, otherCost, basis = 'cost', ledger, dataFile }) {
  const totals = aggregation.totals
  const providers = (config.providers ?? []).join(', ') || '全部 provider'
  const lines = []
  lines.push(`**本机用量** · ${window.label} · 用户 \`${config.user}\` · 来源 \`${providers}\``)
  lines.push('')
  lines.push('| 项目 | 数值 |')
  lines.push('| --- | ---: |')
  lines.push(`| 调用次数 | ${formatNumber(totals.calls)} |`)
  lines.push(`| 输入（未缓存） | ${formatNumber(totals.input)} |`)
  lines.push(`| 缓存读取 | ${formatNumber(totals.cacheRead)} |`)
  lines.push(`| 缓存写入 | ${formatNumber(totals.cacheWrite)} |`)
  lines.push(`| 输出 | ${formatNumber(totals.output)} |`)
  if (totals.reasoning > 0) lines.push(`| 其中推理 | ${formatNumber(totals.reasoning)} |`)
  lines.push(`| 合计 tokens | ${formatNumber(totals.tokens)} |`)
  lines.push(`| **按 Go 定价的金额** | **${formatUsd(totals.cost)}** |`)
  if (totals.limitKnown === true) {
    lines.push(`| **占 Go 月度额度** | **${formatPercent(totals.share)}** |`)
  } else if (Number.isFinite(totals.share)) {
    lines.push(`| 占 Go 月度额度 | ${formatPercent(totals.share)}（部分模型无额度，未计） |`)
  }
  lines.push(`| 会话数 | ${formatNumber(totals.sessions)} |`)

  const allowanceLine = formatAllowanceLine(aggregation.allowances)
  if (allowanceLine !== '') {
    lines.push('')
    lines.push(`> 额度窗口（占月额度）：${allowanceLine}`)
  }

  if (totals.unpricedCalls > 0) {
    lines.push('')
    lines.push(`> ⚠️ ${formatNumber(totals.unpricedCalls)} 次调用（${formatNumber(totals.unpricedTokens)} tokens）没有匹配到价目表，未计入金额。在 \`pricing.json\` 里补上模型单价即可。`)
  }

  if (detail === 'daily' && aggregation.byDay.length > 0) {
    lines.push('')
    lines.push('按天：')
    lines.push('')
    lines.push('| 日期 | 调用 | tokens | 金额 |')
    lines.push('| --- | ---: | ---: | ---: |')
    for (const row of aggregation.byDay) {
      lines.push(`| ${row.key} | ${formatNumber(row.calls)} | ${formatNumber(row.tokens)} | ${formatUsd(row.cost)} |`)
    }
  }

  if ((detail === 'models' || detail === 'summary') && aggregation.byModel.length > 0) {
    lines.push('')
    lines.push('按模型（额度 = 本周期已用 / Go 月额度）：')
    lines.push('')
    lines.push('| 模型 | 调用 | tokens | 金额 / 额度占用 | 构成 | 额度 |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
    for (const row of aggregation.byModel) {
      const limit = row.limit === undefined ? '—' : formatUsd(row.limit)
      lines.push(
        `| ${row.label} | ${formatNumber(row.calls)} | ${formatNumber(row.tokens)} | ${amountWithShare(row)} | ${formatPercent(row.costShare)} | ${limit} |`,
      )
    }
  }

  if (detail === 'sessions' && aggregation.bySession.length > 0) {
    lines.push('')
    lines.push('按会话（前 15）：')
    lines.push('')
    lines.push('| 会话 | 调用 | tokens | 金额 |')
    lines.push('| --- | ---: | ---: | ---: |')
    for (const row of aggregation.bySession.slice(0, 15)) {
      // `row.key` is already the root session (aggregate resolves delegation),
      // so the title lookup and the fallback both name the session that owns
      // the work.
      const title = ledger?.session?.(row.key)?.title || row.key
      lines.push(`| ${escapeCell(title)} | ${formatNumber(row.calls)} | ${formatNumber(row.tokens)} | ${formatUsd(row.cost)} |`)
    }
  }

  lines.push('')
  lines.push(renderSplit({ config, split, otherCost, basis, totals }))

  if (dataFile) {
    lines.push('')
    lines.push(`> 账本：\`${dataFile}\` · 只统计本机、只统计 \`${providers}\`。`)
  }
  return lines.join('\n')
}

/** The split section: the actual "who pays what" answer. */
function renderSplit({ config, split, otherCost, basis, totals }) {
  const fee = config.monthlyFee
  const lines = []
  if (!(fee > 0)) {
    lines.push('**分摊**：未配置月费（`monthlyFee`）。把月费写进插件配置后，这里会直接给出每人应付金额。')
    return lines.join('\n')
  }
  if (otherCost === undefined) {
    lines.push(
      `**分摊**：月费 ${formatUsd(fee)}。还需要朋友那台机器在同一周期、同一口径下的用量金额，把数字发给我即可算出各自应付。`,
    )
    return lines.join('\n')
  }
  const mine = basis === 'tokens' ? totals.tokens : totals.cost
  if (!split) {
    lines.push(`**分摊**：月费 ${formatUsd(fee)}。两边用量都是 0，无需分摊。`)
    return lines
  }
  lines.push(`**分摊**（月费 ${formatUsd(fee)}，按${basis === 'tokens' ? ' token 数' : '金额'}占比）：`)
  lines.push('')
  lines.push(`- 你的用量：${basis === 'tokens' ? `${formatNumber(mine)} tokens` : formatUsd(mine)}`)
  lines.push(`- 朋友用量：${basis === 'tokens' ? `${formatNumber(otherCost)} tokens` : formatUsd(otherCost)}`)
  lines.push(`- 你的占比：**${formatPercent(split.share)}**`)
  lines.push(`- 你应付：**${formatUsd(split.mine)}** · 朋友应付：**${formatUsd(split.other)}**`)
  return lines.join('\n')
}

/**
 * Render the samples of one window as CSV, for comparing with the other
 * machine's export or for a spreadsheet.
 * @param {readonly object[]} records - samples inside the window.
 * @param {object} [ledger] - ledger access for session titles.
 * @returns {string} CSV text with a header row.
 */
export function toCsv(records, ledger) {
  const header = [
    'date',
    'time',
    'session',
    'title',
    'turn',
    'step',
    'provider',
    'model',
    'user',
    'input',
    'cacheRead',
    'cacheWrite',
    'output',
    'reasoning',
    'tokens',
  ]
  const rows = [header.join(',')]
  for (const record of records) {
    const cells = [
      dateKey(record.at),
      new Date(record.at).toISOString(),
      record.sessionId,
      ledger?.session?.(record.sessionId)?.title ?? '',
      String(record.turn),
      String(record.step),
      record.provider,
      record.model,
      record.user,
      String(record.input),
      String(record.cacheRead),
      String(record.cacheWrite),
      String(record.output),
      String(record.reasoning ?? 0),
      String(billableTokens(record)),
    ]
    rows.push(cells.map(csvCell).join(','))
  }
  return rows.join('\n')
}

/** Quote one CSV cell when needed. */
function csvCell(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Re-exported so callers can price a window without importing fold.js. */
export { billableTokens }
