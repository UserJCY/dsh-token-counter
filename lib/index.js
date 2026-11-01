/**
 * dsh-token-split — per-machine OpenCode Go accounting, priced with the Go
 * rate card, plus the subscription split that follows from it.
 *
 * The plugin is a host-composition row:
 *
 *  - it observes every committed `session/event` and folds provider usage into
 *    one ledger record per `(session, turn, step)`;
 *  - it backfills history through `ctx.sessionQuery` once;
 *  - it prices usage with `lib/pricing.js` (USD per 1M tokens, DeepSeek
 *    peak/off-peak aware) and only counts the configured provider routes
 *    (`opencode-go` by default), so usage from other providers on this
 *    machine never enters the bill;
 *  - it registers the `token_usage` tool and a read-only JSON route that the
 *    browser half (`lib/client.js`) renders in the sidebar.
 *
 * It imports nothing from `@deepseek-ai/*` on purpose. app-boot gates a
 * plugin's `engines.dsh` / `@deepseek-ai/dsh-*` peers against the running
 * runtime, and those packages are also resolved from the profile's
 * node_modules, which can be a different release than the desktop app's own
 * copy. A self-contained plugin mounts on either.
 *
 * @module dsh-token-split
 */
import os from 'node:os'
import path from 'node:path'
import { dshHome, dshHomePath, writeFileAtomic } from './fsutil.js'
import { listSessionLogs, readSessionLog } from './history.js'
import { Ledger } from './ledger.js'
import { foldSessionEvents, sampleFromEvent } from './fold.js'
import { ALLOWANCE_CAPS, loadPriceTable, PLANS } from './pricing.js'
import { aggregate, computeSplit, dateKey, DETAILS, formatPercent, formatUsd, PERIODS, renderReport, resolveWindow, toCsv } from './report.js'
import { buildTimeline, createSessionResolver } from './timeline.js'

/** Cordis plugin name (also the row id used by the bundle patch). */
export const name = 'token-split'

/** Browser-side route the panel polls. */
export const SUMMARY_ROUTE = '/api/token-split/summary'

/**
 * Every path the summary is served on, in the order the panel tries them.
 * The `/api/` spelling is the one the desktop renderer's fetch bridge is known
 * to forward (the market's own routes live there); the bare path is the plain
 * web-server spelling for a browser or headless shell.
 */
export const SUMMARY_ROUTES = ['/api/token-split/summary', '/token-split/summary']

/** Browser-side route the detailed usage page reads. */
export const TIMELINE_ROUTE = '/token-split/timeline'

/** Every path the timeline is served on, same two spellings as the summary. */
export const TIMELINE_ROUTES = ['/api/token-split/timeline', '/token-split/timeline']

/**
 * Window used when the caller names none: a rolling 30 days. The allowance
 * percentages are aggregated separately — the live calendar month for `month`
 * and the trailing seven days for `week` — so a rolling window cannot skew them.
 */
export const DEFAULT_PERIOD = 'last30'

/** OS account name, the default attribution label for this machine. */
function defaultUser() {
  try {
    return os.userInfo().username
  } catch {
    return 'unknown'
  }
}

/** Defaults for every configuration field. */
export const DEFAULTS = {
  user: defaultUser(),
  providers: ['opencode-go'],
  plan: 'go',
  monthlyFee: PLANS.go,
  cycleStartDay: 1,
  fxRate: 0,
  pricingFile: '',
  includeSubagents: true,
  backfill: true,
  reportDir: '',
}

/**
 * Apply defaults and coerce one row config. A patch layer may carry only the
 * fields it overrides, and a hand-edited value that makes no sense falls back
 * to its default instead of taking the plugin down.
 * @param {object | undefined} raw - row config.
 * @returns {object} resolved settings.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULTS, providers: [...DEFAULTS.providers] }
  if (typeof input.user === 'string' && input.user.trim() !== '') config.user = input.user.trim()
  if (Array.isArray(input.providers)) {
    config.providers = input.providers.filter((provider) => typeof provider === 'string' && provider.trim() !== '').map((provider) => provider.trim())
  }
  if (input.plan === 'go' || input.plan === 'plus' || input.plan === 'teams') config.plan = input.plan
  if (Number.isFinite(input.monthlyFee) && input.monthlyFee >= 0) config.monthlyFee = input.monthlyFee
  if (Number.isFinite(input.fxRate) && input.fxRate >= 0) config.fxRate = input.fxRate
  if (Number.isInteger(input.cycleStartDay) && input.cycleStartDay >= 1 && input.cycleStartDay <= 28) config.cycleStartDay = input.cycleStartDay
  if (typeof input.pricingFile === 'string') config.pricingFile = input.pricingFile
  if (typeof input.reportDir === 'string') config.reportDir = input.reportDir
  if (typeof input.includeSubagents === 'boolean') config.includeSubagents = input.includeSubagents
  if (typeof input.backfill === 'boolean') config.backfill = input.backfill
  return config
}

/**
 * Register the usage ledger, the pricing route, and the reporting tool.
 * @param {object} ctx - registrant cordis context.
 * @param {object} [rawConfig] - row config from the composition.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger
  const warn = (message) => {
    if (logger && typeof logger.warn === 'function') logger.warn(message)
    else console.warn(message)
  }
  const info = (message) => {
    if (logger && typeof logger.info === 'function') logger.info(message)
    else console.log(message)
  }

  const dir = dshHomePath('token-split')
  const ledger = new Ledger(dir, { warn })
  ledger.load()
  // Materialize the ledger at boot so "did the plugin mount?" has an
  // observable answer even before the first billable step.
  ledger.touch()
  void ledger.flush().catch((error) => warn(`token-split: cannot create ${ledger.file}: ${String(error)}`))
  info(`token-split: active (user=${config.user}, providers=${config.providers.join(',') || 'all'}, backfill=${config.backfill})`)

  /** Most recent route per session, used to label usage chunks that never reached a message. */
  const routes = new Map()
  /** Sessions whose display metadata is already in the ledger. */
  const knownSessions = new Set()
  /** Rate-limit repeated warnings so one broken log cannot flood the host log. */
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  const rememberSession = (session) => {
    if (knownSessions.has(session.id)) return
    knownSessions.add(session.id)
    const header = session.header ?? {}
    ledger.putSession({
      id: session.id,
      createdAt: header.createdAt,
      cwd: header.cwd,
      depth: header.delegationDepth ?? 0,
      parent: header.parentSession,
    })
  }

  /** Fold one live event into the ledger. Must stay synchronous and cheap. */
  const observe = (session, event) => {
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'request/context' && event.data) {
      routes.set(session.id, { provider: event.data.provider ?? '', model: event.data.model ?? '' })
      return
    }
    if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      ledger.putSession({ id: session.id, title: event.data.title })
      return
    }
    if (event.type === 'turn/end') {
      void ledger.flush().catch((error) => warnOnce('flush', `token-split: ledger flush failed: ${String(error)}`))
      return
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/chunk') return
    const sample = sampleFromEvent(session.id, event, routes.get(session.id))
    if (!sample) return
    if (!config.includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return
    rememberSession(session)
    sample.user = config.user
    ledger.putRecord(sample)
  }

  ctx.on('session/event', (session, event) => {
    try {
      observe(session, event)
    } catch (error) {
      warnOnce(`event:${event?.type ?? 'unknown'}`, `token-split: failed to record ${event?.type}: ${String(error)}`)
    }
  })

  ctx.on('session/disposed', () => {
    void ledger.flush().catch((error) => warnOnce('flush-dispose', `token-split: ledger flush failed: ${String(error)}`))
  })

  ctx.effect(() => () => ledger.dispose())

  // ---- history backfill ---------------------------------------------------
  // One pass over the persisted logs on disk, so the bill covers sessions from
  // before the plugin existed. Idempotent: the ledger key makes a re-run a
  // no-op, and `meta.backfilled` skips lifecycles already folded.
  //
  // It reads the files instead of `ctx.sessionQuery` because that service is
  // not guaranteed to be mounted when this row applies, and a missing service
  // silently turned the fold into a no-op on the first real boot.
  if (config.backfill) {
    ctx.effect(() => {
      let cancelled = false
      void (async () => {
        const logs = listSessionLogs(path.join(dshHome(), 'sessions'))
        let folded = 0
        for (const log of logs) {
          if (cancelled) return
          let parsed
          try {
            parsed = readSessionLog(log.file)
          } catch (error) {
            ledger.data.meta.lastBackfillError = `${log.id}: ${String(error)}`
            warnOnce(`backfill:${log.id}`, `token-split: cannot read session log ${log.id}: ${String(error)}`)
            continue
          }
          const header = parsed.header ?? {}
          const sessionId = typeof header.id === 'string' && header.id.length > 0 ? header.id : log.id
          const createdAt = typeof header.createdAt === 'number' ? header.createdAt : 0
          if (ledger.isBackfilled(sessionId, createdAt)) continue
          try {
            const result = foldSessionEvents({
              sessionId,
              events: parsed.events,
              user: config.user,
              includeSubagents: config.includeSubagents,
              delegationDepth: header.delegationDepth ?? 0,
            })
            for (const sample of result.records) ledger.putRecord(sample)
            ledger.putSession({
              id: sessionId,
              createdAt: header.createdAt,
              cwd: header.cwd,
              depth: header.delegationDepth ?? 0,
              parent: header.parentSession,
              title: result.title,
              firstAt: result.firstAt,
              lastAt: result.lastAt,
            })
            ledger.markBackfilled(sessionId, createdAt)
            folded += 1
            if (folded % 20 === 0) await ledger.flush()
          } catch (error) {
            ledger.data.meta.lastBackfillError = `${sessionId}: ${String(error)}`
            warnOnce(`backfill:${sessionId}`, `token-split: cannot fold session ${sessionId}: ${String(error)}`)
          }
        }
        ledger.data.meta.lastBackfillAt = Date.now()
        await ledger.flush()
        info(`token-split: backfill scanned ${logs.length} log(s), folded ${folded}`)
      })().catch((error) => warn(`token-split: backfill failed: ${String(error)}`))
      return () => {
        cancelled = true
      }
    })
  }

  // ---- shared aggregation -------------------------------------------------
  /** Reload the price table on every read so a pricing.json edit lands without a restart. */
  const priceTable = () => {
    try {
      return loadPriceTable({ dataDir: dir, file: config.pricingFile, warn })
    } catch (error) {
      warn(`token-split: falling back to built-in prices: ${String(error)}`)
      return loadPriceTable({})
    }
  }

  /**
   * Build the root-session resolver for this read.
   *
   * It is rebuilt per request instead of being kept process-wide: a session's
   * `parent`/`depth` metadata is written with its first event, so a memo created
   * before that event could remember the wrong root. The walk is cheap and only
   * happens for sessions that actually have records in the window.
   * @returns {(sessionId: string) => string} memoized session → root session.
   */
  const sessionResolver = () => createSessionResolver((sessionId) => ledger.session(sessionId))

  /**
   * Aggregate one window.
   * @param {object} selection - window selection.
   * @returns {{ table: object, window: object, aggregation: object }} priced aggregation.
   */
  const readWindow = (selection) => {
    const table = priceTable()
    const window = resolveWindow({
      period: selection.period ?? DEFAULT_PERIOD,
      since: selection.since,
      until: selection.until,
      cycleStartDay: config.cycleStartDay,
    })
    const aggregation = aggregate(ledger.records(), {
      start: window.start,
      end: window.end,
      priceTable: table,
      providers: config.providers,
      resolveSession: sessionResolver(),
    })
    return { table, window, aggregation }
  }

  /** The provider part of a user-facing note. */
  const providersText = () => (config.providers.length > 0 ? `仅 ${config.providers.join(', ')}` : '全部 provider')

  /**
   * Count the models the ledger knows but the requested window never touched.
   *
   * The panel shows "另有 N 个模型本月未使用" from it. This is a second pass over
   * the in-memory ledger (≈1–2 ms at today's 4.7k records, once per panel poll);
   * keeping it here means `aggregate()` and the timeline stay unaware of models
   * outside the window they were asked about.
   * @param {{ byModel: readonly { key: string }[] }} aggregation - the window aggregation.
   * @returns {number} distinct `provider/model` keys seen in history but not in the window.
   */
  const countUnusedModels = (aggregation) => {
    const used = new Set(aggregation.byModel.map((row) => row.key))
    const allowed = Array.isArray(config.providers)
      ? config.providers.filter((provider) => typeof provider === 'string' && provider.length > 0)
      : []
    const unused = new Set()
    for (const record of ledger.records()) {
      if (allowed.length > 0 && !allowed.includes(record.provider)) continue
      // Same grouping key `aggregate()` uses, so the two sets are comparable.
      const key = `${record.provider ?? ''}/${record.model || '未知模型'}`
      if (!used.has(key)) unused.add(key)
    }
    return unused.size
  }

  /** The note under the panel: the machine/provider scope plus the window's name. */
  const scopeNote = (window) => {
    const scope = `本机口径 · ${providersText()}`
    if (window.period === 'month') return `${scope} · 本自然月`
    if (window.period === 'last30') return `${scope} · 近 30 天`
    return `${scope} · ${window.label}`
  }

  // ---- browser route ------------------------------------------------------
  // The panel is a browser half; it reads this route. Loopback-only and
  // read-only: it never writes, and it exposes aggregates rather than records.
  // Both spellings are registered because the desktop renderer's fetch bridge
  // is only proven to forward `/api/*`, while a plain browser needs the bare
  // path; an exact route also wins over the connection plugin's `/api` prefix.
  const handler = (req, res) => {
      try {
        // POST is accepted as well as GET: the renderer's fetch bridge is not
        // documented to forward GET to a custom `/api` route, and this route
        // is read-only either way.
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        if (!isLoopback(req)) {
          sendJson(res, 403, { ok: false, error: 'loopback-only' })
          return
        }
        const url = new URL(req.url ?? SUMMARY_ROUTE, 'http://127.0.0.1')
        const { window, aggregation } = readWindow({
          period: url.searchParams.get('period') ?? DEFAULT_PERIOD,
          since: url.searchParams.get('since') ?? undefined,
          until: url.searchParams.get('until') ?? undefined,
        })
        // The panel's own window rolls, but the allowance line is always about
        // the live billed month and the trailing seven days, so those two are
        // aggregated on their own instead of reusing `window`.
        const month = readWindow({ period: 'month' })
        const week = readWindow({ period: 'last7' })
        const allowances = { ...aggregation.allowances }
        if (month.aggregation.totals.limitKnown !== false) {
          allowances.month = {
            cost: month.aggregation.totals.cost,
            share: month.aggregation.totals.share,
            cap: ALLOWANCE_CAPS.month,
          }
        }
        info(
          `token-split: summary served (${aggregation.totals.calls} calls, ${window.label}, ${formatPercent(aggregation.totals.share)})`,
        )
        sendJson(res, 200, {
          ok: true,
          generatedAt: Date.now(),
          user: config.user,
          providers: config.providers,
          plan: config.plan,
          monthlyFee: config.monthlyFee,
          cycleStartDay: config.cycleStartDay,
          fxRate: config.fxRate,
          window,
          totals: aggregation.totals,
          models: aggregation.byModel.map((row) => ({
            // `model` keeps its old value (the plain model id); `key` carries the
            // provider-qualified grouping key so two providers never merge.
            model: row.model,
            key: row.key,
            provider: row.provider,
            label: row.label,
            calls: row.calls,
            tokens: row.tokens,
            cost: row.cost,
            sessions: row.sessions,
            limit: Number.isFinite(row.limit) ? row.limit : null,
            share: row.share ?? null,
            priced: row.priced,
            free: row.free,
            costShare: row.costShare,
          })),
          unpriced: aggregation.unpriced,
          // Models known from other months (0 hides the panel's hint row).
          unusedCount: countUnusedModels(aggregation),
          allowances,
          // Trailing seven days, shown under the headline alongside the window.
          last7: {
            cost: week.aggregation.totals.cost,
            calls: week.aggregation.totals.calls,
            tokens: week.aggregation.totals.tokens,
          },
          days: aggregation.byDay.slice(-14).map((row) => ({ day: row.key, cost: row.cost, tokens: row.tokens })),
          note: scopeNote(window),
        })
      } catch (error) {
        warn(`token-split: summary route failed: ${String(error)}`)
        sendJson(res, 500, { ok: false, error: String(error) })
      }
    }

  // ---- detailed-page route ------------------------------------------------
  // One read answers the whole modal: month, day and per-session series for the
  // total and for every model. Computed per request from the in-memory ledger —
  // `observe()` must stay cheap, and the page is only opened on demand.
  const timelineHandler = (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback-only' })
        return
      }
      const url = new URL(req.url ?? TIMELINE_ROUTE, 'http://127.0.0.1')
      const body = buildTimeline({
        records: ledger.records(),
        priceTable: priceTable(),
        providers: config.providers,
        month: url.searchParams.get('month') ?? undefined,
        date: url.searchParams.get('date') ?? undefined,
        sessionOf: (id) => ledger.session(id),
        // Same resolver the summary uses, so both views count sessions alike.
        resolveSession: sessionResolver(),
      })
      info(`token-split: timeline served (${body.month.key}, ${body.models.length} model(s), ${body.total.calls} calls)`)
      sendJson(res, 200, body)
    } catch (error) {
      warn(`token-split: timeline route failed: ${String(error)}`)
      sendJson(res, 500, { ok: false, error: String(error) })
    }
  }
    // Declared through `ctx.inject`, never `ctx.get`: this host's guard treats
    // an undeclared service read as a plugin fault, and the throw aborted the
    // rest of `apply` (no route, no tool) with nothing in the log.
    try {
      ctx.inject(['webServer'], (webCtx) => {
        const server = webCtx.webServer
        /** Register one path set; a duplicate or unsupported path only costs a warning. */
        const install = (paths, routeHandler) => {
          for (const routePath of paths) {
            try {
              webCtx.effect(() => server.register({ kind: 'exact', path: routePath, handler: routeHandler }), `token-split: route ${routePath}`)
              info(`token-split: route registered ${routePath}`)
            } catch (error) {
              warn(`token-split: cannot register ${routePath}: ${String(error)}`)
            }
          }
        }
        install(SUMMARY_ROUTES, handler)
        install(TIMELINE_ROUTES, timelineHandler)
      })
      info('token-split: summary route installed')
    } catch (error) {
      warn(`token-split: cannot install the summary route: ${String(error)}`)
    }

  // ---- the reporting tool -------------------------------------------------
  try {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.tools.register({
      name: 'token_usage',
      description:
        'Report this machine\'s OpenCode Go token usage and its dollar cost from the local ledger, and split the monthly subscription by usage. ' +
        'Only usage from the configured providers (opencode-go by default) is counted, and cost comes from the Go rate card in lib/pricing.js ' +
        '(DeepSeek V4.1 Flash / V4 Pro peak and off-peak included). Model rows show spend and the share of that model\'s monthly allowance used ' +
        '(`$0.446 / 0.45%`); the total is the sum of those shares, which is what locks the plan. ' +
        'Defaults to the current calendar month. Pass otherCost with the other person\'s cost for the same window to get the split; the ledger only sees this machine, ' +
        'so that number must come from them. Set save=true to also write a Markdown report and a per-step CSV.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          period: {
            type: 'string',
            enum: PERIODS,
            description: 'Relative window: month (current calendar month, default), cycle (current billing cycle), today, last7, last30, all.',
          },
          since: { type: 'string', description: 'Explicit lower bound, YYYY-MM-DD (inclusive). Overrides period.' },
          until: { type: 'string', description: 'Explicit upper bound, YYYY-MM-DD (inclusive). Overrides period.' },
          detail: { type: 'string', enum: DETAILS, description: 'Extra table: summary (default, includes the model table), daily, models, sessions.' },
          otherCost: { type: 'number', description: 'The other person\'s usage in USD for the same window (their Go-cost figure).' },
          monthlyFee: { type: 'number', description: 'Override the configured monthly fee for this report.' },
          basis: { type: 'string', enum: ['cost', 'tokens'], description: 'Split by Go cost (default, fair) or by raw token count.' },
          save: { type: 'boolean', description: 'Write token-usage-<window>.md and .csv next to the session workspace.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { report: { type: 'string' } },
          required: ['report'],
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const period = PERIODS.includes(input.period) ? input.period : DEFAULT_PERIOD
        const detail = DETAILS.includes(input.detail) ? input.detail : 'summary'
        const basis = input.basis === 'tokens' ? 'tokens' : 'cost'
        const otherCost = Number.isFinite(input.otherCost) && input.otherCost >= 0 ? input.otherCost : undefined
        const fee = Number.isFinite(input.monthlyFee) && input.monthlyFee >= 0 ? input.monthlyFee : config.monthlyFee

        const { window, aggregation } = readWindow({
          period,
          since: typeof input.since === 'string' ? input.since : undefined,
          until: typeof input.until === 'string' ? input.until : undefined,
        })
        const split =
          otherCost === undefined
            ? null
            : computeSplit({
                mine: basis === 'tokens' ? aggregation.totals.tokens : aggregation.totals.cost,
                other: otherCost,
                fee,
              })
        const report = renderReport({
          window,
          aggregation,
          detail,
          config: { ...config, monthlyFee: fee },
          split,
          otherCost,
          basis,
          ledger,
          dataFile: ledger.file,
        })
        const withRate =
          config.fxRate > 0
            ? `${report}\n\n> 按汇率 ${config.fxRate} 折算：本机 ${formatCny(aggregation.totals.cost, config.fxRate)}。`
            : report
        if (input.save !== true) return { report: withRate }
        const targetDir = config.reportDir || exec?.agent?.session?.header?.cwd || process.cwd()
        const stem = `token-usage-${dateKey(Number.isFinite(window.start) ? window.start : Date.now())}`
        const markdownFile = path.join(targetDir, `${stem}.md`)
        const csvFile = path.join(targetDir, `${stem}.csv`)
        await writeFileAtomic(markdownFile, `${withRate}\n`, { mode: 0o644, dirMode: 0o755 })
        await writeFileAtomic(csvFile, `${toCsv(ledger.recordsBetween(window.start, window.end), ledger)}\n`, { mode: 0o644, dirMode: 0o755 })
        return { report: `${withRate}\n\n已保存：\n- \`${markdownFile}\`\n- \`${csvFile}\`` }
      },
    })
      info('token-split: token_usage tool registered')
    })
  } catch (error) {
    warn(`token-split: cannot register the token_usage tool: ${String(error)}`)
  }
}

/** Whether a request came from this machine. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** USD → CNY display helper. */
function formatCny(usd, rate) {
  return `¥${(usd * rate).toFixed(2)}`
}
