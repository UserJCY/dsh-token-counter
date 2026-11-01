/**
 * Timeline data for the detailed usage page.
 *
 * One request answers the whole page: the selected calendar month, the selected
 * day's 24 hours, the month's per-day series, and the month's per-session bars —
 * for the total and for every model that saw usage in the month.
 *
 * Everything is derived from a **single** pass over the ledger records. Building
 * one series per model by rescanning the ledger would be O(models × records) on
 * a 4k-record ledger; the page must stay fast enough to open on every click.
 *
 * Two attribution rules from the spec (host side):
 *  - models are keyed by `provider/model`, never by model alone;
 *  - a sub-session's money belongs to its root session, but the sub-session does
 *    not add to that root's session count — a model counts a session only when
 *    the root session itself produced a call with that model.
 *
 * All bucketing is done in local time (`getFullYear`/`getMonth`/`getDate`/
 * `getHours`), matching the window rules in `report.js`.
 *
 * @module dsh-token-split/timeline
 */
import { billableTokens } from './fold.js'
import { shareOf, sumShares } from './pricing.js'
import { dateKey, parseDateKey, startOfDay } from './report.js'

/** Parsed shape of a `YYYY-MM` month key. */
const MONTH_KEY = /^(\d{4})-(\d{2})$/

/**
 * Read the panel's default month reference from an instant.
 * @param {number} at - epoch milliseconds.
 * @returns {{ year: number, monthIndex: number }} local year and zero-based month.
 */
function monthOf(at) {
  const date = new Date(at)
  return { year: date.getFullYear(), monthIndex: date.getMonth() }
}

/**
 * Parse a `YYYY-MM` month key. Out-of-range months are rejected rather than
 * rolled over by the Date constructor.
 * @param {string | undefined} text - the query value.
 * @returns {{ year: number, monthIndex: number } | undefined} parsed month.
 */
export function parseMonthKey(text) {
  if (typeof text !== 'string') return undefined
  const match = MONTH_KEY.exec(text.trim())
  if (!match) return undefined
  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  if (monthIndex < 0 || monthIndex > 11) return undefined
  return { year, monthIndex }
}

/**
 * Local bounds of one calendar month plus its metadata.
 * @param {number} year - full year.
 * @param {number} monthIndex - zero-based month.
 * @returns {{ start: number, end: number, label: string, key: string, days: number }} bounds and labels.
 */
export function monthBounds(year, monthIndex) {
  const start = new Date(year, monthIndex, 1).getTime()
  const end = new Date(year, monthIndex + 1, 1).getTime()
  const days = new Date(year, monthIndex + 1, 0).getDate()
  return {
    start,
    end,
    key: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    label: `${year}年${monthIndex + 1}月`,
    days,
  }
}

/** A 24-slot hour series for one day. */
function emptyHours() {
  return Array.from({ length: 24 }, (_, hour) => ({ h: hour, cost: 0, tokens: 0, calls: 0 }))
}

/** A per-day series covering the whole month. */
function emptyDays(dayMeta) {
  return dayMeta.map((day) => ({ key: day.key, cost: 0, tokens: 0, calls: 0 }))
}

/** Fold one record into a `{cost, tokens, calls}` point. */
function bump(point, cost, tokens) {
  point.calls += 1
  point.tokens += tokens
  point.cost += cost
}

/**
 * Build the one root-session resolver both the summary and the timeline use.
 *
 * A sub-session (`delegationDepth > 0`) is attributed to the session at the top
 * of its `parent` chain, so the same money is never counted twice and the
 * session count does not grow with delegation. The chain walk is bounded and
 * cycle-guarded: a malformed `parent` loop terminates instead of hanging, and an
 * unknown parent simply becomes the root.
 *
 * @param {Record<string, object> | Map<string, object> | ((id: string) => object | undefined)} sessions - ledger sessions, or a lookup.
 * @returns {(sessionId: string) => string} memoized `sessionId → rootSessionId`.
 */
export function createSessionResolver(sessions) {
  const lookup =
    typeof sessions === 'function'
      ? sessions
      : sessions instanceof Map
        ? (id) => sessions.get(id)
        : (id) => (sessions !== null && typeof sessions === 'object' ? sessions[id] : undefined)
  const info = (id) => {
    const entry = lookup(id)
    return entry !== null && typeof entry === 'object' ? entry : undefined
  }
  const cache = new Map()
  return (sessionId) => {
    const id = String(sessionId)
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    const own = info(id)
    const depth = Number.isFinite(own?.depth) ? own.depth : 0
    let rootId = id
    if (depth > 0) {
      let current = id
      const seen = new Set([id])
      for (let hop = 0; hop < 32; hop += 1) {
        const parent = info(current)?.parent
        if (typeof parent !== 'string' || parent.length === 0 || seen.has(parent)) break
        current = parent
        seen.add(current)
        rootId = current
        const parentDepth = info(current)?.depth
        if (!(Number.isFinite(parentDepth) && parentDepth > 0)) break
      }
    }
    cache.set(id, rootId)
    return rootId
  }
}

/**
 * Build one month of timeline data.
 * @param {object} input - timeline input.
 * @param {readonly object[]} input.records - ledger records.
 * @param {object} input.priceTable - {@link import('./pricing.js').PriceTable}.
 * @param {readonly string[]} [input.providers] - provider routes to count; empty/undefined counts every provider.
 * @param {string} [input.month] - `YYYY-MM`; defaults to the month containing `now`.
 * @param {string} [input.date] - `YYYY-MM-DD` inside that month; defaults to today (or the 1st for a past month).
 * @param {number | Date} [input.now] - reference instant, injectable for tests.
 * @param {(id: string) => object | undefined} [input.sessionOf] - ledger session lookup, used for the root session's title.
 * @param {(sessionId: string) => string} [input.resolveSession] - shared root resolver; defaults to one built from `sessionOf`.
 * @returns {object} the `/token-split/timeline` payload.
 */
export function buildTimeline({
  records,
  priceTable,
  providers,
  month,
  date,
  now = Date.now(),
  sessionOf = () => undefined,
  resolveSession = createSessionResolver(sessionOf),
}) {
  const nowAt = now instanceof Date ? now.getTime() : Number.isFinite(now) ? now : Date.now()
  const monthRef = parseMonthKey(month) ?? monthOf(nowAt)
  const bounds = monthBounds(monthRef.year, monthRef.monthIndex)
  const allowed = Array.isArray(providers) ? providers.filter((provider) => typeof provider === 'string' && provider.length > 0) : []

  const dayMeta = Array.from({ length: bounds.days }, (_, index) => {
    const day = index + 1
    const at = new Date(monthRef.year, monthRef.monthIndex, day).getTime()
    // Monday = 0 … Sunday = 6, the weekday order the detailed page labels with.
    return { key: dateKey(at), day, weekday: (new Date(at).getDay() + 6) % 7 }
  })

  // The selected day must exist inside the selected month: an explicit date from
  // another month (or a malformed one) falls back to today when that is in the
  // month, otherwise to the 1st.
  const todayInMonth = nowAt >= bounds.start && nowAt < bounds.end
  const parsedDate = parseDateKey(date)
  const dateInMonth = parsedDate !== undefined && parsedDate >= bounds.start && parsedDate < bounds.end
  const selectedStart = dateInMonth ? parsedDate : todayInMonth ? startOfDay(new Date(nowAt)) : bounds.start
  const selectedIndex = new Date(selectedStart).getDate() - 1

  const titleOf = (sessionId) => {
    const title = sessionOf(sessionId)?.title
    return typeof title === 'string' && title.length > 0 ? title : sessionId
  }

  const total = { calls: 0, tokens: 0, cost: 0, hour: emptyHours(), day: emptyDays(dayMeta) }
  const rootSessions = new Set()
  const unpricedModels = new Set()
  let unpricedCalls = 0
  let unpricedTokens = 0
  /** @type {Map<string, object>} provider/model → per-model series. */
  const models = new Map()
  /**
   * provider/model → all-history summary, for the model list of the dialog.
   *
   * This is the one place the traversal deliberately looks outside the selected
   * month: a model that was used last month and not this one must still be
   * reachable (the user can step back a month). `months` keeps the cost per
   * local month, so the most recent month with usage survives records that are
   * not stored in chronological order.
   * @type {Map<string, { provider: string, model: string, calls: number, tokens: number, cost: number, lastAt: number, unpricedCalls: number, months: Map<string, number> }>}
   */
  const known = new Map()

  for (const record of records) {
    const at = record.at
    if (allowed.length > 0 && !allowed.includes(record.provider)) continue

    // Priced and bucketed once, then shared by the all-history roll-up and (when
    // it falls inside the window) the month series.
    const priced = priceTable.price(record)
    const tokens = billableTokens(record)
    const provider = record.provider ?? ''
    const model = record.model || '未知模型'
    const key = `${provider}/${model}`
    const when = new Date(at)

    let knownEntry = known.get(key)
    if (knownEntry === undefined) {
      knownEntry = { provider, model, calls: 0, tokens: 0, cost: 0, lastAt: 0, unpricedCalls: 0, months: new Map() }
      known.set(key, knownEntry)
    }
    knownEntry.calls += 1
    knownEntry.tokens += tokens
    knownEntry.cost += priced.usd
    if (at > knownEntry.lastAt) knownEntry.lastAt = at
    if (priced.row === undefined) knownEntry.unpricedCalls += 1
    const monthKey = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`
    knownEntry.months.set(monthKey, (knownEntry.months.get(monthKey) ?? 0) + priced.usd)

    if (!(at >= bounds.start && at < bounds.end)) continue

    const dayIndex = when.getDate() - 1
    const hourIndex = when.getHours()

    let entry = models.get(key)
    if (entry === undefined) {
      entry = {
        key,
        provider,
        model,
        calls: 0,
        tokens: 0,
        cost: 0,
        unpricedCalls: 0,
        unpricedTokens: 0,
        hour: emptyHours(),
        day: emptyDays(dayMeta),
        sessions: new Map(),
      }
      models.set(key, entry)
    }

    entry.calls += 1
    entry.tokens += tokens
    entry.cost += priced.usd
    bump(entry.day[dayIndex], priced.usd, tokens)
    if (dayIndex === selectedIndex) bump(entry.hour[hourIndex], priced.usd, tokens)
    if (priced.row === undefined) {
      entry.unpricedCalls += 1
      entry.unpricedTokens += tokens
      unpricedCalls += 1
      unpricedTokens += tokens
      unpricedModels.add(key)
    }

    total.calls += 1
    total.tokens += tokens
    total.cost += priced.usd
    bump(total.day[dayIndex], priced.usd, tokens)
    if (dayIndex === selectedIndex) bump(total.hour[hourIndex], priced.usd, tokens)

    // Money follows the root session, and a sub-session never becomes a session
    // of its own: one resolved root serves both the bucket and the count. The
    // same shared resolver drives `aggregate()`, so the panel and the dialog
    // cannot disagree on the number.
    const rootId = resolveSession(record.sessionId)
    let session = entry.sessions.get(rootId)
    if (session === undefined) {
      session = { sessionId: rootId, title: titleOf(rootId), cost: 0, tokens: 0, calls: 0, lastAt: 0 }
      entry.sessions.set(rootId, session)
    }
    session.calls += 1
    session.tokens += tokens
    session.cost += priced.usd
    if (at > session.lastAt) session.lastAt = at
    rootSessions.add(rootId)
  }

  const modelRows = [...models.values()]
    .map((entry) => {
      const limit = priceTable.limitOf(entry.model)
      const share = shareOf(entry.cost, limit)
      return {
        key: entry.key,
        provider: entry.provider,
        model: entry.model,
        label: priceTable.labelOf(entry.model),
        limit: Number.isFinite(limit) ? limit : null,
        share: share ?? null,
        priced: entry.unpricedCalls === 0,
        free: priceTable.isFree(entry.model),
        month: {
          calls: entry.calls,
          tokens: entry.tokens,
          cost: entry.cost,
          sessions: entry.sessions.size,
          share: share ?? null,
        },
        hour: entry.hour,
        day: entry.day,
        session: [...entry.sessions.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
      }
    })
    .sort((a, b) => Number(a.free || !a.priced) - Number(b.free || !b.priced) || b.month.cost - a.month.cost || b.month.tokens - a.month.tokens)

  const providerText = allowed.length > 0 ? `仅 ${allowed.join(', ')}` : '全部 provider'
  const paidRows = modelRows.filter((row) => row.priced && !row.free)
  // Whether the total percentage is complete: every paid model carries an
  // allowance. The client hides the total share when this is false.
  const limitKnown = paidRows.every((row) => Number.isFinite(row.limit) && row.limit > 0)
  const knownModels = [...known.entries()]
    .map(([key, entry]) => {
      let lastMonthKey = ''
      for (const monthKey of entry.months.keys()) {
        if (monthKey > lastMonthKey) lastMonthKey = monthKey
      }
      const limit = priceTable.limitOf(entry.model)
      return {
        key,
        provider: entry.provider,
        model: entry.model,
        label: priceTable.labelOf(entry.model),
        limit: Number.isFinite(limit) ? limit : null,
        free: priceTable.isFree(entry.model),
        priced: entry.unpricedCalls === 0,
        lastAt: entry.lastAt,
        lastMonthKey,
        lastMonthCost: entry.months.get(lastMonthKey) ?? 0,
        totalCost: entry.cost,
        totalCalls: entry.calls,
        totalTokens: entry.tokens,
      }
    })
    .sort((a, b) => b.totalCost - a.totalCost || b.lastAt - a.lastAt)
  return {
    ok: true,
    generatedAt: nowAt,
    month: bounds,
    date: dateKey(selectedStart),
    hours: Array.from({ length: 24 }, (_, hour) => hour),
    days: dayMeta,
    total: {
      calls: total.calls,
      tokens: total.tokens,
      cost: total.cost,
      sessions: rootSessions.size,
      share: sumShares(modelRows),
      limitKnown,
      hour: total.hour,
      day: total.day,
      session: [],
    },
    models: modelRows,
    knownModels,
    unpriced: { calls: unpricedCalls, tokens: unpricedTokens, models: [...unpricedModels] },
    note: `本机口径 · ${providerText}`,
  }
}
