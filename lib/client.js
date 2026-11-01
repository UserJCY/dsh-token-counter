/**
 * Browser half of dsh-token-split.
 *
 * One sidebar footer action: this natural month's Go cost, a panel that breaks
 * it down per model with the quota share each model consumed, and a centered
 * "详细用量" dialog that draws the per-hour / per-day / per-session history with
 * hand-written SVG. Every chart in that dialog keeps its own time range, so one
 * can sit in September while another stays on this month; identical ranges are
 * fetched once and shared through a small LRU cache.
 *
 * Data comes from the host's read-only `GET /token-split/summary` (panel) and
 * `GET /token-split/timeline` (dialog), so the browser never touches the ledger
 * file and never recomputes pricing. Percentages arrive pre-computed
 * (`share = cost / limit`); this file only formats them — see SPEC §1.
 *
 * This file is a pre-built client bundle in the harness's lazy-CJS form:
 * executing it only registers a factory; the body runs on materialization.
 * `require` resolves the shared `react` module from the module table, and that
 * is deliberately the only dependency: no chart library, no icon font.
 *
 * @module dsh-token-split/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-split',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // Route spellings tried in order. The bare path is what the bundled market
    // fetches (`/dsh-market/check`) and is known to reach the host from the
    // desktop renderer; the `/api/` spelling is the same route under the
    // connection plugin's namespace. POST is a hedge for a bridge that only
    // forwards JSON posts — both handlers are read-only.
    const SUMMARY_ATTEMPTS = [
      { path: '/token-split/summary', method: 'GET' },
      { path: '/api/token-split/summary', method: 'GET' },
      { path: '/api/token-split/summary', method: 'POST' },
    ]
    const TIMELINE_ATTEMPTS = [
      { path: '/token-split/timeline', method: 'GET' },
      { path: '/api/token-split/timeline', method: 'GET' },
      { path: '/api/token-split/timeline', method: 'POST' },
    ]
    const STYLE_ID = 'dsh-token-split/panel.css'
    /** The panel's summary poll. */
    const REFRESH_MS = 60_000
    /** Background revalidation of the dialog's visible selections. */
    const REVALIDATE_MS = 30_000

    /** Chart geometry (SPEC §5.3/§5.4 are explicit about these numbers). */
    const CHART_HEIGHT = 140
    const BAR_WIDTH = 28
    const BAR_GAP = 12
    const BAR_STEP = BAR_WIDTH + BAR_GAP
    const BAR_MIN_SLOTS = 10
    const ACCENT = '#3b82f6'
    const ACCENT_HOT = '#1d4ed8'

    const MODES = [
      { id: 'day', label: '日' },
      { id: 'month', label: '月' },
      { id: 'session', label: '会话' },
    ]

    /** `日` reads the hourly series, `月` the daily one, `会话` the bars. */
    const SERIES_OF_MODE = { day: 'hour', month: 'day', session: 'session' }

    /**
     * Resolve one endpoint against the directory the host serves the UI from,
     * exactly as the market's own client does: root deployments resolve to `/`,
     * a sub-path deployment keeps its mount prefix. The query string survives.
     * @param {string} path - route path, optionally with a query.
     * @returns {string} the fetchable pathname.
     */
    function endpoint(path) {
      const relative = path.replace(/^\/+/, '')
      if (typeof document === 'undefined' || typeof document.baseURI !== 'string') return `/${relative}`
      try {
        const url = new URL(relative, document.baseURI)
        return `${url.pathname}${url.search}`
      } catch {
        return `/${relative}`
      }
    }

    const CSS = `
.dts-root{position:relative;display:flex;min-width:0}
.dts-trigger{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap}
.dts-trigger:hover,.dts-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dts-trigger-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);flex:none}
.dts-trigger-label{overflow:hidden;text-overflow:ellipsis;max-width:120px}
.dts-backdrop{position:fixed;inset:0;z-index:900;background:transparent}
/* Panel and dialog card are both opaque surfaces; every inner tone is derived
   from their own color with opacity, never from the host theme's translucent
   tokens (which assume the page background, not ours). */
.dts-panel,.dts-modal-card{box-sizing:border-box;border:1px solid #e4e4ea;border-radius:12px;background-color:#ffffff;background-image:none;color:#17171a;box-shadow:0 16px 40px rgba(0,0,0,.18);font-size:13px;line-height:1.45;isolation:isolate}
@media (prefers-color-scheme:dark){.dts-panel,.dts-modal-card{background-color:#1c1c1f;color:#ececf0;border-color:#3a3a42;box-shadow:0 16px 40px rgba(0,0,0,.55)}}
@supports (color:light-dark(#fff,#000)){.dts-panel,.dts-modal-card{background-color:light-dark(#ffffff,#1c1c1f);color:light-dark(#17171a,#ececf0);border-color:light-dark(#e4e4ea,#3a3a42);box-shadow:0 16px 40px light-dark(rgba(0,0,0,.18),rgba(0,0,0,.55))}}
.dts-panel{position:fixed;z-index:901;width:330px;max-width:calc(100vw - 24px);max-height:min(560px,calc(100vh - 32px));overflow:auto;padding:14px}
.dts-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:10px}
.dts-head-actions{display:flex;align-items:center;gap:2px;flex:none}
.dts-title{font-size:12px;color:inherit;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dts-close{border:0;background:transparent;color:inherit;opacity:.72;cursor:pointer;font-size:15px;line-height:1;padding:3px 5px;border-radius:6px}
.dts-close:hover{background:rgba(127,127,127,.16);opacity:1}
.dts-big-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.dts-big{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
.dts-pct{font-size:13px;font-variant-numeric:tabular-nums;color:inherit;opacity:.6;flex:none}
.dts-sub{margin-top:2px;color:inherit;opacity:.6;font-size:12px;font-variant-numeric:tabular-nums}
.dts-section{margin-top:14px;padding-top:12px;border-top:1px solid rgba(127,127,127,.22)}
.dts-section-title{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:inherit;opacity:.6;margin-bottom:8px}
.dts-row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:5px 0;align-items:baseline}
.dts-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dts-row-cost{font-variant-numeric:tabular-nums;color:inherit;opacity:.8;white-space:nowrap}
.dts-row-tag{color:inherit;opacity:.5}
.dts-bar{grid-column:1 / -1;height:3px;border-radius:2px;background:rgba(127,127,127,.22);overflow:hidden}
.dts-bar-fill{height:100%;border-radius:2px;background:currentColor;opacity:.55}
.dts-bar-fill.is-muted{opacity:.22}
.dts-note{margin-top:10px;color:inherit;opacity:.62;font-size:11px;line-height:1.5}
.dts-note-line{margin-top:2px;opacity:.9;font-variant-numeric:tabular-nums}
.dts-note-unused{margin-top:4px}
/* Collapsed group of models that did not run this month. */
.dts-unused{margin-top:14px;padding-top:12px;border-top:1px solid rgba(127,127,127,.22)}
.dts-unused-head{display:flex;align-items:center;gap:6px;width:100%;padding:4px 2px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:12px;opacity:.7;cursor:pointer;text-align:left}
.dts-unused-head:hover{background:rgba(127,127,127,.12);opacity:.95}
.dts-unused-caret{display:inline-block;transition:transform .12s ease;font-size:10px;opacity:.8}
.dts-unused-caret.is-open{transform:rotate(90deg)}
.dts-tag{margin-left:6px;padding:1px 6px;border-radius:999px;background:rgba(127,127,127,.18);font-size:10px;opacity:.75;white-space:nowrap}
.dts-error{margin-top:10px;color:#d33;font-size:12px}
.dts-skeleton{height:12px;border-radius:6px;background:rgba(127,127,127,.18);margin:6px 0}
.dts-retry{display:inline-block;margin:10px 0;padding:4px 12px;border:0;border-radius:6px;background:rgba(127,127,127,.18);color:inherit;font-size:12px;cursor:pointer}
.dts-retry:hover{background:rgba(127,127,127,.28)}
/* A failed refresh keeps the last chart on screen and offers a retry inline. */
.dts-block-error{display:flex;align-items:center;gap:6px;opacity:.75}
.dts-block-error .dts-retry{margin:0;padding:2px 10px}
/* ---- detailed usage dialog ---- */
.dts-modal{position:fixed;inset:0;z-index:950;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.45)}
.dts-modal-card{position:relative;width:min(880px,92vw);max-height:86vh;overflow:auto;padding:18px 20px 22px}
.dts-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dts-modal-title{font-size:16px;font-weight:600;letter-spacing:-0.01em}
.dts-modal-sub{margin-top:3px;font-size:12px;opacity:.6}
.dts-modal-hint{margin-top:2px;font-size:11px;opacity:.42}
.dts-block{margin-top:16px;padding-top:14px;border-top:1px solid rgba(127,127,127,.22)}
.dts-block:first-of-type{border-top:0;padding-top:2px}
.dts-block-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.dts-block-title{font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dts-block-cost{font-size:13px;font-variant-numeric:tabular-nums;opacity:.85;white-space:nowrap}
.dts-block-total{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-0.01em;white-space:nowrap}
.dts-block-meta{margin-top:3px;font-size:12px;opacity:.6;font-variant-numeric:tabular-nums}
.dts-date-nav{display:flex;align-items:center;gap:4px;margin:10px 0 2px;font-size:12px}
.dts-date-btn{border:0;background:transparent;color:inherit;opacity:.7;cursor:pointer;padding:2px 7px;border-radius:6px;font-size:14px;line-height:1}
.dts-date-btn:hover:enabled{background:rgba(127,127,127,.16);opacity:1}
.dts-date-btn:disabled{opacity:.25;cursor:default}
.dts-date-label{font-variant-numeric:tabular-nums;opacity:.8}
.dts-chart-wrap{position:relative;margin-top:4px;overflow:visible}
.dts-chart-svg{display:block;width:100%;height:${CHART_HEIGHT}px;overflow:visible}
/* The scroll container clips on both axes once one of them scrolls, so the
   tooltip lives on the wrap (outside it) and is positioned by hand. The y-axis
   column and the grid lines are outside the scroll container too: they must not
   drift when the bars scroll. */
.dts-bars-wrap{position:relative;display:flex;align-items:flex-start;overflow:visible;margin-top:4px}
.dts-bars-axis{flex:none;position:relative;height:${CHART_HEIGHT}px}
.dts-bars-axis-svg{display:block}
.dts-bars-grid{position:absolute;top:0;overflow:hidden;pointer-events:none}
.dts-grid-line{position:absolute;left:0;right:0;height:1px;background:currentColor;opacity:.14}
.dts-grid-line.is-base{opacity:.3}
.dts-bars-scroll{flex:none;overflow-x:auto;overflow-y:hidden;padding-bottom:2px}
.dts-bars-inner{position:relative}
.dts-bars-svg{display:block;height:${CHART_HEIGHT}px}
.dts-grid{stroke:currentColor;stroke-width:1;opacity:.14}
.dts-axis{stroke:currentColor;stroke-width:1;opacity:.3}
.dts-axis-label{fill:currentColor;opacity:.5;font-size:10px}
.dts-line{fill:none;stroke:${ACCENT};stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
.dts-area{fill:${ACCENT};fill-opacity:.12;stroke:none}
.dts-dot{fill:${ACCENT};stroke:none}
.dts-dot.is-hot{fill:${ACCENT_HOT}}
.dts-hit{fill:transparent;cursor:pointer}
/* Session bars get their own class: .dts-bar above is the 3px progress track,
   and SVG geometry (height) is a CSS property too — sharing the name would
   flatten every bar to 3px. */
.dts-session-bar{fill:${ACCENT}}
.dts-session-bar.is-hot{fill:${ACCENT_HOT}}
.dts-tooltip{position:absolute;top:0;transform:translate(-50%,0);padding:4px 8px;border-radius:6px;background:rgba(17,17,20,.92);color:#f4f4f6;font-size:11px;line-height:1.35;white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums;z-index:6}
.dts-empty{padding:34px 0;text-align:center;font-size:12px;opacity:.55}
.dts-seg{display:flex;justify-content:flex-end;gap:2px;margin-top:8px}
.dts-seg-btn{border:0;background:transparent;color:inherit;opacity:.55;cursor:pointer;font-size:12px;padding:3px 9px;border-radius:6px;line-height:1.3}
.dts-seg-btn:hover{opacity:.85;background:rgba(127,127,127,.12)}
.dts-seg-btn[aria-pressed="true"]{opacity:1;background:rgba(127,127,127,.2)}
`

    /** Inject the stylesheet once per page. */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-token-split'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------------
    // Formatting. The host exports formatUsd/formatPercent with the same
    // rules (SPEC §1); this copy must stay byte-for-byte equivalent in
    // output, but it cannot import host code.
    // ------------------------------------------------------------------

    /** Coerce anything to a finite number, defaulting to 0. */
    function num(value) {
      return Number.isFinite(value) ? value : 0
    }

    /**
     * `$0.446` — under 1 keeps 3 decimals, 1~99.99 keeps 2, 100+ rounds.
     * An exact zero prints `$0` (a `$0.000` reads like a broken price).
     * @param {number} value - USD amount.
     * @returns {string} money text.
     */
    function formatUsd(value) {
      const usd = num(value)
      if (usd === 0) return '$0'
      const magnitude = Math.abs(usd)
      if (magnitude < 1) return `$${usd.toFixed(3)}`
      if (magnitude < 100) return `$${usd.toFixed(2)}`
      return `$${Math.round(usd)}`
    }

    /**
     * `0.59%` — input is a fraction of the monthly quota (`share = cost/limit`).
     * Below 0.01% prints `<0.01%`, below 1% keeps 2 decimals, below 100% keeps
     * 1, and 100%+ rounds to a whole number.
     * @param {number} fraction - quota share, e.g. 0.0059.
     * @returns {string} percent text.
     */
    function formatPercent(fraction) {
      const percent = num(fraction) * 100
      if (percent > 0 && percent < 0.01) return '<0.01%'
      if (percent < 1) return `${percent.toFixed(2)}%`
      if (percent < 100) return `${percent.toFixed(1)}%`
      return `${Math.round(percent)}%`
    }

    /**
     * The window cap half of `5h 0.1%/20%`: a cap fraction rendered as a plain
     * percentage (`0.2` → `20%`).
     * @param {number} cap - cap fraction.
     * @returns {string} percent text.
     */
    function formatCap(cap) {
      const percent = num(cap) * 100
      return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`
    }

    /** Group digits without locale surprises. */
    function count(value) {
      const rounded = Math.round(num(value))
      return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** One amount plus its quota share: `$0.446 / 0.45%`, `$0 / 免费`. */
    function amountLine(cost, shareText) {
      return shareText === null || shareText === undefined ? formatUsd(cost) : `${formatUsd(cost)} / ${shareText}`
    }

    /**
     * Quota-share text for one model row, or its tag when it has no quota.
     * @param {object} entry - model row from summary/timeline.
     * @returns {string|null} `0.45%`, `免费`, `未定价`, or null when unknown.
     */
    function shareTextOf(entry) {
      if (entry === null || entry === undefined) return null
      if (entry.free === true) return '免费'
      if (entry.priced === false) return '未定价'
      if (!Number.isFinite(entry.share)) return null
      return formatPercent(entry.share)
    }

    /** `26,484,419 tokens · 374 次调用 · 28 个会话` for one aggregation block. */
    function metaLine(block) {
      const entry = block || {}
      return `${count(entry.tokens)} tokens · ${count(entry.calls)} 次调用 · ${count(entry.sessions)} 个会话`
    }

    /** Whether an aggregation block saw any usage at all this month. */
    function hasUsage(block) {
      if (block === null || block === undefined) return false
      return num(block.calls) > 0 || num(block.tokens) > 0 || num(block.cost) > 0
    }

    /**
     * The allowance footnote line, built from `summary.allowances`.
     * @param {object|null} allowances - `{ fiveHour, weekly, month }` blocks.
     * @returns {string|null} `5h 0.1%/20% · week 0.3%/50% · month 1.2%`, or null.
     */
    function allowanceText(allowances) {
      if (allowances === null || allowances === undefined) return null
      const parts = []
      if (allowances.fiveHour) {
        parts.push(`5h ${formatPercent(allowances.fiveHour.share)}/${formatCap(allowances.fiveHour.cap)}`)
      }
      if (allowances.weekly) {
        parts.push(`week ${formatPercent(allowances.weekly.share)}/${formatCap(allowances.weekly.cap)}`)
      }
      if (allowances.month) {
        parts.push(`month ${formatPercent(allowances.month.share)}`)
      }
      return parts.length === 0 ? null : parts.join(' · ')
    }

    // ------------------------------------------------------------------
    // Local-time date keys. The host defines the month as a local natural
    // month; the dialog only ever deals in `YYYY-MM` / `YYYY-MM-DD` strings.
    // ------------------------------------------------------------------

    /** Zero-pad to two digits. */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** `YYYY-MM-DD` in local time. */
    function dateKey(date) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    /** `YYYY-MM` in local time. */
    function monthKey(date) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
    }

    /** `2026年11月` for a `YYYY-MM` key. */
    function monthLabel(month) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''))
      if (match === null) return String(month || '')
      return `${match[1]}年${Number(match[2])}月`
    }

    /** Number of days in a `YYYY-MM` month. */
    function daysInMonth(month) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''))
      if (match === null) return 30
      return new Date(Number(match[1]), Number(match[2]), 0).getDate()
    }

    /** Keep a date inside a month, falling back to its first day. */
    function clampDateInMonth(key, month, days) {
      const head = `${month}-`
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
      if (match === null || !String(key).startsWith(head)) return `${month}-01`
      const day = Math.min(Math.max(1, Number(match[3])), Math.max(1, days))
      return `${head}${pad2(day)}`
    }

    /**
     * Shift a `YYYY-MM` key by whole months, rolling the year.
     * @param {string} month - e.g. `2026-01`.
     * @param {number} delta - month offset, may be negative.
     * @returns {string} the shifted month key.
     */
    function addMonths(month, delta) {
      const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''))
      if (match === null) return String(month || '')
      const total = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta
      const year = Math.floor(total / 12)
      return `${year}-${pad2(total - year * 12 + 1)}`
    }

    /**
     * Shift a `YYYY-MM-DD` key by whole days in local time — the dialog's day
     * arrows cross month boundaries rather than stopping at the 1st/last.
     * @param {string} key - date key.
     * @param {number} delta - day offset.
     * @returns {string} the shifted date key.
     */
    function addDays(key, delta) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
      if (match === null) return String(key || '')
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta)
      return dateKey(date)
    }

    /**
     * Whether the dialog may move one month in `delta` direction. The future is
     * off limits (the host can serve an empty month, but showing it is noise);
     * the past has no floor.
     * @param {string} month - selected month.
     * @param {number} delta - `-1` or `1`.
     * @param {string} currentMonth - this machine's natural month.
     * @returns {boolean} true when the target month is not in the future.
     */
    function canShiftMonth(month, delta, currentMonth) {
      if (delta < 0) return true
      return addMonths(month, 1) <= currentMonth
    }

    /**
     * Pure selection transition for one chart block. The block's single cursor
     * (`month` + `date`) is shared by that block's three chart modes, so a month
     * flip is reflected by its day chart and a day flip that crosses a month
     * boundary moves its month too — inside one block, `日` and `月` can never
     * disagree about which month they show. Blocks are independent of each
     * other; they each hold their own cursor.
     *
     * `date` rules: a month flip lands on today when the target is the current
     * month, otherwise on the same day-of-month clamped to the target's length
     * (11-30 → 2 月 = 28/29 日).
     * @param {{ month: string|null, date: string }} cursor - selected month
     *   (`null` = the current month) and date.
     * @param {{ kind: 'month'|'date', delta: number }} action - what moved.
     * @param {{ currentMonth: string, today: string }} limits - bounds.
     * @returns {{ month: string, date: string }} the next selection.
     */
    function shiftCursor(cursor, action, limits) {
      const resolved = cursor === null || cursor === undefined ? {} : cursor
      const month = typeof resolved.month === 'string' && resolved.month !== '' ? resolved.month : limits.currentMonth
      const date = clampDateInMonth(resolved.date, month, daysInMonth(month))
      if (action.kind === 'month') {
        const nextMonth = addMonths(month, action.delta)
        if (!canShiftMonth(month, action.delta, limits.currentMonth)) return { month, date }
        const wanted =
          nextMonth === limits.currentMonth
            ? Number(String(limits.today).slice(8, 10))
            : Number(date.slice(8, 10))
        const day = Math.min(Math.max(1, wanted), daysInMonth(nextMonth))
        return { month: nextMonth, date: `${nextMonth}-${pad2(day)}` }
      }
      const nextDate = addDays(date, action.delta)
      if (action.delta > 0 && nextDate > limits.today) return { month, date }
      return { month: nextDate.slice(0, 7), date: nextDate }
    }

    // ------------------------------------------------------------------
    // Transport.
    // ------------------------------------------------------------------

    /** Append a query string, skipping empty values. */
    function withQuery(path, query) {
      const pairs = []
      const source = query || {}
      for (const key of Object.keys(source)) {
        const value = source[key]
        if (value === undefined || value === null || value === '') continue
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      }
      if (pairs.length === 0) return path
      return `${path}${path.includes('?') ? '&' : '?'}${pairs.join('&')}`
    }

    /**
     * Read one endpoint as JSON, or throw a diagnostic that names the exact
     * HTTP status and body head — an empty body is the failure mode this panel
     * hit first, and "Unexpected end of JSON input" alone cannot tell a 404
     * from a 403.
     * @param {{ path: string, method: string }} attempt - endpoint and verb.
     * @param {object} query - query parameters.
     * @returns {Promise<object>} parsed payload.
     */
    async function fetchJson(attempt, query) {
      const label = withQuery(attempt.path, query)
      const response = await fetch(endpoint(label), {
        method: attempt.method,
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${attempt.method} ${label} → HTTP ${response.status} ${text.slice(0, 80)}`)
      if (text.trim() === '') throw new Error(`${attempt.method} ${label} → HTTP ${response.status} 空响应`)
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`${attempt.method} ${label} → 非 JSON（${text.slice(0, 80)}）`)
      }
      if (json === null || json.ok !== true) {
        throw new Error(`${attempt.method} ${label} → ${(json && json.error) || '统计服务未就绪'}`)
      }
      return json
    }

    /**
     * Try every registered route spelling before giving up, reporting all
     * failures at once so a diagnosis does not need a second run.
     * @param {Array<{ path: string, method: string }>} attempts - route list.
     * @param {object} query - query parameters.
     * @returns {Promise<object>} the first successful payload.
     */
    function fetchAny(attempts, query) {
      const problems = []
      const next = (index) => {
        if (index >= attempts.length) return Promise.reject(new Error(problems.join(' · ')))
        return fetchJson(attempts[index], query).catch((error) => {
          problems.push(error instanceof Error ? error.message : String(error))
          return next(index + 1)
        })
      }
      return next(0)
    }

    /**
     * Fetch the host summary for the current natural month, retrying every
     * `REFRESH_MS` while the panel is open.
     * @param {boolean} open - whether the panel is visible.
     * @returns {{ state: object, reload: () => void }} data state plus refresh.
     */
    function useSummary(open) {
      const [state, setState] = React.useState({ status: 'idle', data: null, error: null })
      const load = React.useCallback(() => {
        if (typeof fetch !== 'function') {
          setState({ status: 'error', data: null, error: '当前环境没有 fetch' })
          return
        }
        setState((previous) => ({ ...previous, status: previous.data === null ? 'loading' : 'refreshing' }))
        fetchAny(SUMMARY_ATTEMPTS, { period: 'month' }).then(
          (json) => setState({ status: 'ready', data: json, error: null }),
          (error) =>
            setState((previous) => ({
              status: 'error',
              data: previous.data,
              error: error instanceof Error ? error.message : String(error),
            })),
        )
      }, [])
      React.useEffect(() => {
        if (!open) return undefined
        load()
        const timer = setInterval(load, REFRESH_MS)
        return () => clearInterval(timer)
      }, [open, load])
      return { state, reload: load }
    }

    /**
     * The timeline request for one selection, exactly as `useTimeline` fetches
     * it. Exported so a test can assert the URL a month flip produces without a
     * DOM to click in.
     * @param {string} month - `YYYY-MM`.
     * @param {string} date - `YYYY-MM-DD`, inside `month`.
     * @returns {string} path plus query string.
     */
    function timelinePath(month, date) {
      return withQuery(TIMELINE_ATTEMPTS[0].path, { month, date })
    }

    /** Most timeline payloads kept in memory; one per (month, date) selection. */
    const TIMELINE_CACHE_LIMIT = 24
    /** `month|date` → resolved `{ status, data, error }`, oldest first (LRU). */
    const timelineCache = new Map()
    /** `month|date` → in-flight promise, so parallel blocks share one request. */
    const timelineInflight = new Map()

    /** Cache key for one selection. */
    function timelineKey(month, date) {
      return `${month}|${date}`
    }

    /** Drop the oldest entries until the cache is back under its bound. */
    function trimTimelineCache() {
      while (timelineCache.size > TIMELINE_CACHE_LIMIT) {
        const oldest = timelineCache.keys().next().value
        timelineCache.delete(oldest)
      }
    }

    /** Forget every cached and in-flight timeline (test seam, and a diagnostics aid). */
    function clearTimelineCache() {
      timelineCache.clear()
      timelineInflight.clear()
    }

    /**
     * Load one (month, date) timeline through the shared cache.
     *
     * Every dialog block asks for its own selection, and several of them often
     * ask for the same one (they start on "this month, today"), so the loader
     * both caches results (LRU, 24 entries) and joins an in-flight request for
     * the same key instead of firing a second one. Errors are never cached: a
     * retry must really retry.
     *
     * `force` is the stale-while-revalidate half: it skips the cache *read* (so
     * the caller really hits the host) while still refreshing the cache. The
     * in-flight join still applies, so a forced refresh and a normal read racing
     * on the same key share one request.
     * @param {string} month - `YYYY-MM`.
     * @param {string} date - `YYYY-MM-DD`.
     * @param {{ force?: boolean, fetcher?: () => Promise<object> } | (() => Promise<object>)} [options] -
     *   `force` to bypass the cached value; a bare function is accepted as the
     *   `fetcher` shortcut the tests use.
     * @returns {Promise<object>} `{ status, data, error }`.
     */
    function loadTimeline(month, date, options) {
      const config = typeof options === 'function' ? { fetcher: options } : options || {}
      const key = timelineKey(month, date)
      if (config.force !== true) {
        const cached = timelineCache.get(key)
        if (cached !== undefined) {
          // Touch: re-inserting moves the entry to the young end of the LRU.
          timelineCache.delete(key)
          timelineCache.set(key, cached)
          return Promise.resolve(cached)
        }
      }
      const pending = timelineInflight.get(key)
      if (pending !== undefined) return pending
      const request =
        typeof config.fetcher === 'function' ? config.fetcher : () => fetchAny(TIMELINE_ATTEMPTS, { month, date })
      const promise = Promise.resolve()
        .then(request)
        .then(
          (json) => {
            const next = { status: 'ready', data: json, error: null }
            timelineCache.set(key, next)
            trimTimelineCache()
            return next
          },
          (error) => ({
            status: 'error',
            data: null,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .then((next) => {
          timelineInflight.delete(key)
          return next
        })
      timelineInflight.set(key, promise)
      return promise
    }

    /**
     * Merge a fresh load result into the previous state.
     *
     * A new selection must never blank the chart: while it loads (or if it
     * fails) the previous payload stays, so the block keeps drawing what the user
     * is already looking at and only swaps when real data arrives.
     * @param {object} previous - current state.
     * @param {{ status: string, data: object|null, error: string|null }} next - the load result.
     * @returns {object} merged state.
     */
    function mergeTimelineState(previous, next) {
      const data = next.data === null || next.data === undefined ? previous.data : next.data
      return { status: next.status, data, error: next.error }
    }

    /**
     * Fetch the whole dialog payload for one selection.
     *
     * A block owns its own (month, date), so this hook is instantiated once per
     * block; identical selections are served from {@link loadTimeline} without
     * a second request, and a slow block never blocks another one.
     * @param {boolean} open - whether the block is visible.
     * @param {string} month - `YYYY-MM`.
     * @param {string} date - `YYYY-MM-DD`, inside `month`.
     * @returns {{ state: object, reload: () => void, busy: boolean }} data state,
     *   a manual refresh, and whether a background revalidation is in flight.
     */
    function useTimeline(open, month, date) {
      const key = timelineKey(month, date)
      const [state, setState] = React.useState(
        () => timelineCache.get(key) || { status: 'idle', data: null, error: null },
      )
      const [busy, setBusy] = React.useState(false)
      const [nonce, setNonce] = React.useState(0)
      const reload = React.useCallback(() => {
        timelineCache.delete(key)
        setNonce((previous) => previous + 1)
      }, [key])

      // Stale-while-revalidate: show whatever the cache has (no skeleton, no
      // flash) and always ask the host again. The cached entry is never shown as
      // a substitute for the request — "we looked at this dialog an hour ago"
      // must not freeze the numbers.
      React.useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        const cached = timelineCache.get(key)
        if (cached !== undefined) setState(cached)
        setBusy(true)
        loadTimeline(month, date, { force: true })
          .then((next) => {
            if (!cancelled) setState((previous) => mergeTimelineState(previous, next))
          })
          .finally(() => {
            if (!cancelled) setBusy(false)
          })
        return () => {
          cancelled = true
        }
      }, [open, key, month, date, nonce])

      // While the dialog is open, keep the visible selection fresh. One timer per
      // visible block; a hidden tab does not poll.
      React.useEffect(() => {
        if (!open) return undefined
        if (typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden === true) return
          setNonce((previous) => previous + 1)
        }, REVALIDATE_MS)
        return () => clearInterval(timer)
      }, [open])

      return { state, reload, busy }
    }

    // ------------------------------------------------------------------
    // Series building: host rows → chart points.
    //
    // A point is `{ key, label, tip, cost, tokens, calls, share }`; `share` is
    // that bucket's quota usage (cost/limit) or null when the model has no
    // quota to compare against (free / unpriced).
    // ------------------------------------------------------------------

    /** Per-bucket quota share, or null when this model has no monthly quota. */
    function bucketShare(cost, model) {
      if (model === null || model === undefined) return null
      if (model.free === true || model.priced === false) return null
      const limit = num(model.limit)
      if (limit <= 0) return null
      return num(cost) / limit
    }

    /**
     * The canonical x-axis of the dialog: the selected date plus the month's
     * day keys (from `timeline.days`, falling back to the month length).
     * @param {object} data - timeline payload.
     * @returns {{ date: string, days: string[] }} keys.
     */
    function seriesKeys(data) {
      const today = dateKey(new Date())
      const date = data !== null && data !== undefined && typeof data.date === 'string' ? data.date : today
      const month = data !== null && data !== undefined && data.month && data.month.key ? String(data.month.key) : date.slice(0, 7)
      const listed = data !== null && data !== undefined && Array.isArray(data.days) ? data.days : []
      const days =
        listed.length > 0
          ? listed.map((entry) => String(entry.key))
          : Array.from({ length: daysInMonth(month) }, (_unused, index) => `${month}-${pad2(index + 1)}`)
      return { date, days }
    }

    /** 24 hourly points for one model (or the total block). */
    function hourPoints(rows, date, model) {
      const list = Array.isArray(rows) ? rows : []
      const byHour = new Map()
      for (const row of list) {
        if (row !== null && row !== undefined) byHour.set(num(row.h), row)
      }
      const points = []
      for (let hour = 0; hour < 24; hour += 1) {
        const row = byHour.get(hour) || {}
        const cost = num(row.cost)
        points.push({
          key: String(hour),
          label: `${pad2(hour)}:00`,
          tip: `${date} ${pad2(hour)}:00`,
          cost,
          tokens: num(row.tokens),
          calls: num(row.calls),
          share: bucketShare(cost, model),
        })
      }
      return points
    }

    /** One point per day of the month, padded with zeros by the host. */
    function dayPoints(rows, days, model) {
      const list = Array.isArray(rows) ? rows : []
      const byKey = new Map()
      for (const row of list) {
        if (row !== null && row !== undefined) byKey.set(String(row.key), row)
      }
      return days.map((key) => {
        const row = byKey.get(key) || {}
        const cost = num(row.cost)
        return {
          key,
          label: String(key).slice(5),
          tip: String(key).slice(5),
          cost,
          tokens: num(row.tokens),
          calls: num(row.calls),
          share: bucketShare(cost, model),
        }
      })
    }

    /** One bar per session, cost descending. */
    function sessionPoints(rows, model) {
      const list = Array.isArray(rows) ? rows.slice() : []
      list.sort((left, right) => num(right.cost) - num(left.cost))
      return list.map((row) => {
        const cost = num(row.cost)
        const title = typeof row.title === 'string' && row.title !== '' ? row.title : String(row.sessionId || '会话')
        return {
          key: String(row.sessionId || title),
          label: title,
          tip: title,
          cost,
          tokens: num(row.tokens),
          calls: num(row.calls),
          share: bucketShare(cost, model),
        }
      })
    }

    /**
     * Build all three chart series for one aggregation block.
     * @param {object} source - model row or `data.total`.
     * @param {{ date: string, days: string[] }} keys - axis keys.
     * @returns {{ hour: object[], day: object[], session: object[] }} series.
     */
    function buildSeries(source, keys) {
      const entry = source || {}
      return {
        hour: hourPoints(entry.hour, keys.date, entry),
        day: dayPoints(entry.day, keys.days, entry),
        session: sessionPoints(entry.session, entry),
      }
    }

    /** Merge one numeric field across a list of series arrays, index-aligned. */
    function mergeAligned(lists) {
      const base = lists.length > 0 ? lists[0] : []
      return base.map((point, index) => {
        let cost = 0
        let tokens = 0
        let calls = 0
        let share = null
        for (const list of lists) {
          const other = list[index]
          if (other === undefined) continue
          cost += other.cost
          tokens += other.tokens
          calls += other.calls
          if (other.share !== null) share = (share === null ? 0 : share) + other.share
        }
        return { ...point, cost, tokens, calls, share }
      })
    }

    /** Merge per-model session arrays by session id, cost descending. */
    function mergeSessions(lists) {
      const byId = new Map()
      for (const list of lists) {
        for (const point of list) {
          const existing = byId.get(point.key)
          if (existing === undefined) {
            byId.set(point.key, { ...point })
            continue
          }
          existing.cost += point.cost
          existing.tokens += point.tokens
          existing.calls += point.calls
          if (point.share !== null) existing.share = (existing.share === null ? 0 : existing.share) + point.share
        }
      }
      return [...byId.values()].sort((left, right) => right.cost - left.cost)
    }

    /**
     * The total block's series. It is derived from the per-model rows so each
     * bucket's percentage is the exact `Σ(cost/limit)` (SPEC §1) rather than a
     * proportional guess; when the host sent no models the raw total arrays are
     * used and the month share is split proportionally.
     * @param {object} data - timeline payload.
     * @returns {{ hour: object[], day: object[], session: object[] }} series.
     */
    function totalSeries(data) {
      const keys = seriesKeys(data)
      const models = data !== null && data !== undefined && Array.isArray(data.models) ? data.models : []
      if (models.length > 0) {
        const lists = models.map((model) => buildSeries(model, keys))
        return {
          hour: mergeAligned(lists.map((entry) => entry.hour)),
          day: mergeAligned(lists.map((entry) => entry.day)),
          session: mergeSessions(lists.map((entry) => entry.session)),
        }
      }
      const total = (data && data.total) || {}
      const series = buildSeries(total, keys)
      const spend = num(total.cost)
      const monthShare = Number.isFinite(total.share) ? total.share : null
      const scale = (points) =>
        points.map((point) => ({
          ...point,
          share: monthShare === null ? null : spend > 0 ? monthShare * (point.cost / spend) : 0,
        }))
      return { hour: scale(series.hour), day: scale(series.day), session: scale(series.session) }
    }

    // ------------------------------------------------------------------
    // Charts: hand-written SVG, no library (SPEC §5.4).
    // ------------------------------------------------------------------

    /** Round to 2 decimals so SVG attributes stay short. */
    function round2(value) {
      return Math.round(value * 100) / 100
    }

    /** Left gutter that holds the y-axis labels, shared by both charts. */
    const AXIS_WIDTH = 46

    /** Trim float noise off a tick value (0.30000000000000004 → 0.3). */
    function roundTick(value) {
      return Number(Number(value).toPrecision(12))
    }

    /**
     * The smallest readable step at or above `raw`: 1/2/5 × 10^k.
     * @param {number} raw - unrounded step.
     * @returns {number} the step.
     */
    function niceStep(raw) {
      if (!(raw > 0)) return 1
      const magnitude = 10 ** Math.floor(Math.log10(raw))
      const normalized = raw / magnitude
      const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
      return factor * magnitude
    }

    /**
     * Build 3–4 evenly spaced y-axis ticks whose top is a readable number, so
     * the labels read `$0 / $0.02 / $0.04` instead of `$0.0371 / $0.0742`.
     *
     * An empty series collapses to a single `0` tick: one baseline, not a
     * column of zeroes.
     * @param {number} maxValue - largest value the chart must fit.
     * @param {number} [targetTicks] - wanted tick count, 4 by default.
     * @returns {{ max: number, ticks: number[] }} axis top and tick values.
     */
    function niceScale(maxValue, targetTicks = 4) {
      const value = num(maxValue)
      if (value <= 0) return { max: 0, ticks: [0] }
      const intervals = Math.max(2, Math.round(num(targetTicks)) - 1)
      const step = niceStep(value / intervals)
      const top = roundTick(Math.ceil(value / step) * step)
      const count = Math.max(1, Math.round(top / step))
      const ticks = []
      for (let index = 0; index <= count; index += 1) ticks.push(roundTick(index * step))
      return { max: top, ticks }
    }

    // ------------------------------------------------------------------
    // Chart animation: one 100ms timeline for everything that changes the
    // picture — mode switches and month/day flips alike. Pure state machine
    // plus a single rAF driver; no CSS transitions on SVG geometry (they are
    // unreliable) and no animation library.
    // ------------------------------------------------------------------

    /** Duration of the whole transition, in milliseconds (SPEC: 0.1s). */
    const TRANSITION_MS = 100

    /** Clamp a value into `[0, 1]`. */
    function clamp01(value) {
      const number = num(value)
      if (number <= 0) return 0
      if (number >= 1) return 1
      return number
    }

    /** Cubic ease-in: slow start, fast end. */
    function easeInCubic(t) {
      const x = clamp01(t)
      return x * x * x
    }

    /** Cubic ease-out: fast start, slow end. */
    function easeOutCubic(t) {
      const x = clamp01(t)
      return 1 - (1 - x) ** 3
    }

    /** Cubic ease-in-out — the default for anything that just moves. */
    function easeInOutCubic(t) {
      const x = clamp01(t)
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
    }

    /**
     * Normalise a fraction of a sub-window: 0 before `start`, 1 after `end`.
     * @param {number} progress - whole-timeline progress.
     * @param {number} start - window start.
     * @param {number} end - window end.
     * @returns {number} the eased window position, unclamped easing applied later.
     */
    function windowOf(progress, start, end) {
      if (!(end > start)) return progress >= end ? 1 : 0
      return clamp01((num(progress) - start) / (end - start))
    }

    /** A chart point list as `[{ x, value }]` with x spread evenly over 0..1. */
    function shapeOf(points) {
      const list = Array.isArray(points) ? points : []
      const last = Math.max(1, list.length - 1)
      return list.map((point, index) => ({ x: list.length > 1 ? index / last : 0.5, value: num(point.cost) }))
    }

    /**
     * Resample a shape to a fixed number of evenly spaced x steps, interpolating
     * `value` linearly. This is what makes a 24-point day and a 31-point month
     * morph into each other without the two different lengths showing.
     * @param {Array<{ x: number, value: number }>} shape - source shape.
     * @param {number} [count] - sample count.
     * @returns {Array<{ x: number, value: number }>} resampled shape.
     */
    function resampleShape(shape, count = 96) {
      const source = Array.isArray(shape) ? shape : []
      const total = Math.max(2, Math.round(num(count)))
      if (source.length === 0) return []
      if (source.length === 1) {
        return Array.from({ length: total }, (_unused, index) => ({
          x: total > 1 ? index / (total - 1) : 0,
          value: source[0].value,
        }))
      }
      const out = []
      for (let index = 0; index < total; index += 1) {
        const x = total > 1 ? index / (total - 1) : 0
        const position = x * (source.length - 1)
        const lower = Math.floor(position)
        const upper = Math.min(source.length - 1, lower + 1)
        const fraction = position - lower
        out.push({ x, value: source[lower].value * (1 - fraction) + source[upper].value * fraction })
      }
      return out
    }

    /**
     * Resample raw chart points (the ones the host's series produce) to `count`
     * evenly spaced samples.
     * @param {object[]} points - chart points with `cost`.
     * @param {number} [count] - sample count, 96 by default.
     * @returns {Array<{ x: number, value: number }>} resampled shape.
     */
    function resamplePoints(points, count = 96) {
      return resampleShape(shapeOf(points), count)
    }

    /**
     * Point-wise interpolation between two shapes. The ends are exact, so
     * `lerpPoints(a, b, 0)` is `a` and `lerpPoints(a, b, 1)` is `b`.
     * @param {Array<{ x: number, value: number }>} a - start shape.
     * @param {Array<{ x: number, value: number }>} b - end shape.
     * @param {number} t - eased position.
     * @returns {Array<{ x: number, value: number }>} the blended shape.
     */
    function lerpPoints(a, b, t) {
      const start = Array.isArray(a) ? a : []
      const end = Array.isArray(b) ? b : []
      if (t <= 0) return start.map((point) => ({ x: point.x, value: point.value }))
      if (t >= 1) return end.map((point) => ({ x: point.x, value: point.value }))
      const total = Math.min(start.length, end.length)
      const out = []
      for (let index = 0; index < total; index += 1) {
        out.push({
          x: start[index].x + (end[index].x - start[index].x) * t,
          value: start[index].value + (end[index].value - start[index].value) * t,
        })
      }
      return out
    }

    /**
     * The three sub-windows of a line morph: dots fade out (0–30%), the line
     * deforms (15–85%), the new dots fade in (70–100%).
     * @param {number} progress - whole-timeline progress.
     * @returns {{ line: number, dotFrom: number, dotTo: number }} eased windows.
     */
    function morphTiming(progress) {
      return {
        line: easeInOutCubic(windowOf(progress, 0.15, 0.85)),
        dotFrom: 1 - easeInOutCubic(windowOf(progress, 0, 0.3)),
        dotTo: easeInOutCubic(windowOf(progress, 0.7, 1)),
      }
    }

    /**
     * The line a morph draws at one instant, plus how visible each end's dots
     * are. Equal-length inputs skip resampling and simply lerp node for node;
     * different lengths go through the 96-sample morph so the two shapes never
     * disagree about how many points the line has.
     * @param {object[]} fromPoints - the outgoing series.
     * @param {object[]} toPoints - the incoming series.
     * @param {number} progress - 0..1.
     * @param {Array<{ x: number, value: number }>} [fromShape] - a captured
     *   mid-animation shape, used when interrupting a running transition.
     * @returns {object} the frame.
     */
    function morphFrame(fromPoints, toPoints, progress, fromShape) {
      const from = Array.isArray(fromShape) && fromShape.length > 0 ? fromShape : shapeOf(fromPoints)
      const to = shapeOf(toPoints)
      if (from.length === to.length && from.length > 0) {
        return {
          kind: 'lerp',
          linePoints: lerpPoints(from, to, easeInOutCubic(progress)),
          dotOpacityFrom: 1,
          dotOpacityTo: 0,
        }
      }
      const timing = morphTiming(progress)
      return {
        kind: 'morph',
        linePoints: lerpPoints(resampleShape(from, 96), resampleShape(to, 96), timing.line),
        dotOpacityFrom: timing.dotFrom,
        dotOpacityTo: timing.dotTo,
      }
    }

    /** Bars falling toward the baseline over the first half of the timeline. */
    function collapseScale(progress) {
      return 1 - easeInCubic(clamp01(num(progress) * 2))
    }

    /** Bars growing out of the baseline over the second half. */
    function riseScale(progress) {
      return easeOutCubic(clamp01((num(progress) - 0.5) * 2))
    }

    /**
     * What kind of animation connects two selections.
     *
     * Line ↔ line morphs (one shape deforming into the other); line ↔ bars
     * collapses then rises, because a line and a bar cannot share a coordinate
     * system. Every plan lasts `TRANSITION_MS`; the two halves live inside that
     * one timeline, not after it.
     * @param {string} fromMode - previous chart mode.
     * @param {string} toMode - next chart mode.
     * @returns {{ kind: 'none'|'morph'|'collapse', phases: string[], duration: number }} plan.
     */
    function transitionPlan(fromMode, toMode) {
      if (fromMode === toMode) return { kind: 'none', phases: [], duration: 0 }
      const fromBars = fromMode === 'session'
      const toBars = toMode === 'session'
      if (fromBars !== toBars) {
        return { kind: 'collapse', phases: ['collapse', 'rise'], duration: TRANSITION_MS }
      }
      return { kind: 'morph', phases: ['morph'], duration: TRANSITION_MS }
    }

    /** A stable fingerprint of one chart selection, for change detection. */
    function seriesSignature(mode, points) {
      const list = Array.isArray(points) ? points : []
      let total = 0
      for (const point of list) total += num(point.cost)
      const head = list.length > 0 ? String(list[0].tip || '') : ''
      const tail = list.length > 0 ? String(list[list.length - 1].tip || '') : ''
      return `${mode}|${list.length}|${total.toFixed(6)}|${head}|${tail}`
    }

    /** A selection: which mode, which points, and its fingerprint. */
    function selectionOf(mode, points) {
      return { mode, points: Array.isArray(points) ? points : [], signature: seriesSignature(mode, points) }
    }

    /** The resting state: nothing is animating, `to` is what is on screen. */
    function idleFrame(selection) {
      return { phase: 'idle', progress: 1, from: null, to: selection, seq: 0, shape: null }
    }

    /**
     * The animation state machine, kept pure so data changes, mode changes and
     * interruptions are testable without a DOM.
     *
     * One event starts an animation: `{ type: 'data', to, animate }`. `from` is
     * whatever was on screen, and `shape` captures the line at the moment of an
     * interruption so the next animation continues from the current shape
     * instead of jumping back.
     * @param {object} state - current state.
     * @param {{ type: 'data'|'tick', to?: object, animate?: boolean, progress?: number }} event - what happened.
     * @returns {object} the next state.
     */
    function chartFrame(state, event) {
      if (event !== null && event !== undefined && event.type === 'data') {
        const to = event.to
        if (state.phase === 'idle' && to.signature === state.to.signature) return state
        const seq = state.seq + 1
        if (event.animate === false) return { phase: 'idle', progress: 1, from: null, to, seq, shape: null }
        // Interrupting: keep the line where it is and animate from that shape.
        const shape = state.phase === 'idle' ? null : frameOf(state).linePoints || null
        return { phase: 'morph', progress: 0, from: state.to, to, seq, shape }
      }
      if (event !== null && event !== undefined && event.type === 'tick') {
        if (state.phase === 'idle') return state
        const progress = clamp01(event.progress)
        if (progress < 1) return { ...state, progress }
        return { phase: 'idle', progress: 1, from: null, to: state.to, seq: state.seq, shape: null }
      }
      return state
    }

    /** The y-axis top a point list needs. */
    function axisMaxOf(points) {
      const list = Array.isArray(points) ? points : []
      return niceScale(list.reduce((max, point) => Math.max(max, num(point.cost)), 0)).max
    }

    /**
     * Translate a state into the single frame the charts must draw.
     *
     * There is only ever **one** chart on screen: a line either lerps node for
     * node (same point count) or morphs through the 96-sample shape (different
     * counts), and a chart-type change collapses then rises inside the same
     * 100ms. `axisMax` is the larger of the two axes so ticks never jump mid-way.
     * @param {object} state - animation state.
     * @returns {object} the frame.
     */
    function frameOf(state) {
      const to = state.to
      if (state.phase === 'idle' || state.from === null) {
        return { kind: 'idle', mode: to.mode, points: to.points, axisMax: axisMaxOf(to.points) }
      }
      const from = state.from
      const progress = clamp01(state.progress)
      const axisMax = Math.max(axisMaxOf(from.points), axisMaxOf(to.points))
      const fromBars = from.mode === 'session'
      const toBars = to.mode === 'session'

      if (fromBars !== toBars) {
        if (progress < 0.5) {
          return { kind: 'collapse', mode: from.mode, points: from.points, scale: collapseScale(progress), axisMax }
        }
        return { kind: 'rise', mode: to.mode, points: to.points, scale: riseScale(progress), axisMax }
      }

      if (toBars) {
        // Bars keep their geometry; equal counts lerp bar by bar.
        if (from.points.length === to.points.length && from.points.length > 0) {
          const eased = easeInOutCubic(progress)
          const points = to.points.map((point, index) => ({
            ...point,
            cost: num(from.points[index].cost) + (num(point.cost) - num(from.points[index].cost)) * eased,
          }))
          return { kind: 'bars-lerp', mode: to.mode, points, axisMax }
        }
        if (progress < 0.5) {
          return { kind: 'collapse', mode: from.mode, points: from.points, scale: collapseScale(progress), axisMax }
        }
        return { kind: 'rise', mode: to.mode, points: to.points, scale: riseScale(progress), axisMax }
      }

      const morph = morphFrame(from.points, to.points, progress, state.shape)
      return {
        kind: morph.kind === 'lerp' ? 'line-lerp' : 'line-morph',
        mode: to.mode,
        fromPoints: from.points,
        toPoints: to.points,
        linePoints: morph.linePoints,
        dotOpacityFrom: morph.dotOpacityFrom,
        dotOpacityTo: morph.dotOpacityTo,
        axisMax,
        progress,
      }
    }

    /**
     * Whether the browser asks for reduced motion. A missing or odd
     * `matchMedia` must never throw; unknown browsers get the animation.
     * @returns {boolean} true when animation is allowed.
     */
    function canAnimate() {
      if (typeof window === 'undefined') return false
      const matchMedia = window.matchMedia
      if (typeof matchMedia !== 'function') return true
      try {
        const query = matchMedia.call(window, '(prefers-reduced-motion: reduce)')
        return !(query && query.matches === true)
      } catch {
        return true
      }
    }

    /**
     * Drive the frame animation with `requestAnimationFrame`.
     *
     * Any change to the selection (mode, month, day, payload) starts one 100ms
     * timeline. SSR and reduced-motion environments rest in `idle` and never
     * start a frame. The change is applied during render (React's
     * derive-state-from-props pattern) so the first painted frame is already at
     * progress 0 — the old shape, never a flash of the new one. The effect owns
     * exactly one rAF loop; interruptions bump `seq` and restart it, and cleanup
     * covers unmount.
     * @param {string} mode - chart mode to show.
     * @param {object[]} points - the series for that mode.
     * @returns {{ frame: object, busy: boolean }} the frame to draw and whether it is animating.
     */
    function useChartFrame(mode, points) {
      const selection = selectionOf(mode, points)
      const [state, setState] = React.useState(() => idleFrame(selection))
      if (selection.signature !== state.to.signature) {
        setState((previous) => chartFrame(previous, { type: 'data', to: selection, animate: canAnimate() }))
      }
      React.useEffect(() => {
        if (state.phase === 'idle') return undefined
        if (typeof requestAnimationFrame !== 'function') {
          setState((previous) => chartFrame(previous, { type: 'tick', progress: 1 }))
          return undefined
        }
        let frame = 0
        let started = 0
        const step = (now) => {
          if (started === 0) started = now
          const progress = Math.min(1, (now - started) / TRANSITION_MS)
          setState((previous) => chartFrame(previous, { type: 'tick', progress }))
          if (progress < 1) frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
        }
      }, [state.phase, state.to.signature, state.seq])
      return { frame: frameOf(state), busy: state.phase !== 'idle' }
    }

    /**
     * Track a container's pixel width so the `viewBox` always equals the real
     * width — that keeps stroke widths and dot radii round instead of stretched
     * by `preserveAspectRatio`. SSR renders with the fallback; the observer only
     * exists in the browser.
     * @param {number} fallback - width used before the first measurement.
     * @returns {[number, object]} width and the ref to attach.
     */
    function useMeasuredWidth(fallback) {
      const [width, setWidth] = React.useState(fallback)
      const ref = React.useRef(null)
      React.useEffect(() => {
        const node = ref.current
        if (node === null || node === undefined) return undefined
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0]
          if (entry === undefined || entry.contentRect === undefined) return
          const next = Math.round(entry.contentRect.width)
          if (next > 0) setWidth(next)
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [])
      return [width, ref]
    }

    /** Up to five evenly spread x-axis tick indexes (first and last included). */
    function tickIndices(total) {
      if (total <= 1) return [0]
      if (total <= 6) return Array.from({ length: total }, (_unused, index) => index)
      // A 24-hour axis deserves round labels (00/06/12/18/23), not 00/06/12/17/23.
      if (total === 24) return [0, 6, 12, 18, 23]
      const wanted = 5
      const out = []
      for (let index = 0; index < wanted; index += 1) {
        out.push(Math.round((index * (total - 1)) / (wanted - 1)))
      }
      return [...new Set(out)]
    }

    /** Text anchor so edge labels do not overflow the plot. */
    function anchorFor(index, total) {
      if (index === 0) return 'start'
      if (index === total - 1) return 'end'
      return 'middle'
    }

    /** `2026-11-01 09:00 · $0.031 / 0.03%` for one hovered point. */
    function tooltipText(point) {
      return `${point.tip} · ${amountLine(point.cost, point.share === null ? null : formatPercent(point.share))}`
    }

    /**
     * Hour / day line chart: 140px tall, one dot per bucket, hover shows the
     * bucket's cost and quota share. A flat line at the baseline is what an
     * all-zero series looks like — the axis stays because the month has usage.
     *
     * Two ways to animate it, both inside this one component (there is never a
     * second chart on screen):
     *  - `scale` multiplies the *values* before they are mapped through the
     *    axis, so 0 lands exactly on the baseline (bars collapsing / rising);
     *  - `morph` draws a line computed by {@link morphFrame}: a single path
     *    whose y values are interpolated (and, for different point counts, whose
     *    two dot sets cross-fade by opacity).
     * `axisMax` pins the y range mid-transition so the ticks do not jump.
     * @param {{ points: object[], mode: string, scale?: number, axisMax?: number,
     *   morph?: object, forceHover?: number, hoverable?: boolean }} props - chart props.
     * @returns {object} React element.
     */
    function LineChart({ points, mode, scale, axisMax, morph, forceHover, hoverable }) {
      const [width, measureRef] = useMeasuredWidth(760)
      const [hoverState, setHoverState] = React.useState(-1)
      const factor = Number.isFinite(scale) ? Math.min(1, Math.max(0, scale)) : 1
      const interactive = hoverable !== false
      const animated = morph !== undefined && morph !== null
      const forced = interactive && typeof forceHover === 'number' ? forceHover : -1
      const hover = forced >= 0 ? forced : interactive ? hoverState : -1
      const setHover = (index) => {
        if (forced >= 0 || !interactive) return
        setHoverState(index)
      }

      const padTop = 14
      const padBottom = 20
      const padLeft = AXIS_WIDTH
      const padRight = 10
      const plotWidth = Math.max(60, width - padLeft - padRight)
      const plotHeight = Math.max(20, CHART_HEIGHT - padTop - padBottom)
      const baseline = padTop + plotHeight
      const maxCost = points.reduce((max, point) => Math.max(max, point.cost), 0)
      const axis = niceScale(Number.isFinite(axisMax) ? axisMax : maxCost)
      const last = Math.max(1, points.length - 1)
      const xOf = (index) => (points.length > 1 ? padLeft + (index / last) * plotWidth : padLeft + plotWidth / 2)
      // The axis never scales: only the data does.
      const axisY = (value) => (axis.max > 0 ? baseline - (value / axis.max) * plotHeight : baseline)
      const yOf = (cost) => (axis.max > 0 ? baseline - ((cost * factor) / axis.max) * plotHeight : baseline)
      const line = animated
        ? morph.linePoints
            .map((point, index) => `${index === 0 ? 'M' : 'L'}${round2(padLeft + point.x * plotWidth)} ${round2(axisY(point.value))}`)
            .join(' ')
        : points
            .map((point, index) => `${index === 0 ? 'M' : 'L'}${round2(xOf(index))} ${round2(yOf(point.cost))}`)
            .join(' ')
      const area =
        animated || points.length > 0
          ? `${line} L${round2(animated ? padLeft + plotWidth : xOf(points.length - 1))} ${round2(baseline)} L${round2(animated ? padLeft : xOf(0))} ${round2(baseline)} Z`
          : ''
      const slot = points.length > 1 ? plotWidth / last : plotWidth
      const hot = hover >= 0 && hover < points.length ? points[hover] : null
      // Keep the bubble inside the chart: never above the plot, never over the
      // y-axis labels, and never wide enough to run off either edge.
      const tooltipLeft =
        hot === null
          ? 0
          : Math.min(Math.max(xOf(hover), AXIS_WIDTH + 32), Math.max(AXIS_WIDTH + 32, width - 78))
      const tooltipTop = hot === null ? 0 : Math.min(Math.max(yOf(hover) - 26, 2), CHART_HEIGHT - 24)
      const dotAt = (x, y, opacity, key, radius) =>
        h('circle', {
          key,
          className: 'dts-dot',
          cx: round2(x),
          cy: round2(y),
          r: radius,
          opacity: opacity === 1 ? undefined : round2(opacity),
        })

      return h(
        'div',
        { className: 'dts-chart-wrap', ref: measureRef },
        h(
          'svg',
          {
            className: 'dts-chart-svg',
            viewBox: `0 0 ${width} ${CHART_HEIGHT}`,
            width,
            height: CHART_HEIGHT,
            role: 'img',
            'aria-label': mode === 'day' ? '每小时花费' : '每日花费',
          },
          // Y grid + labels: one line per tick, the 0 tick doubles as the baseline.
          axis.ticks.map((tick) =>
            h('line', {
              key: `ygrid-${tick}`,
              className: tick === 0 ? 'dts-grid is-base' : 'dts-grid',
              x1: padLeft,
              y1: round2(axisY(tick)),
              x2: round2(padLeft + plotWidth),
              y2: round2(axisY(tick)),
              vectorEffect: 'non-scaling-stroke',
            }),
          ),
          axis.ticks.map((tick) =>
            h(
              'text',
              {
                key: `ytick-${tick}`,
                className: 'dts-axis-label dts-axis-y',
                x: AXIS_WIDTH - 6,
                y: round2(axisY(tick) + 3.5),
                textAnchor: 'end',
              },
              formatUsd(tick),
            ),
          ),
          h('path', { className: 'dts-area', d: area }),
          h('path', { className: 'dts-line', d: line, vectorEffect: 'non-scaling-stroke' }),
          animated
            ? morph.kind === 'line-lerp'
              ? // Same point count: the dots ride the morphing line, no fading.
                morph.linePoints.map((point, index) =>
                  dotAt(padLeft + point.x * plotWidth, axisY(point.value), 1, `dot-${index}`, 2.5),
                )
              : // Different counts: each dot set fades on its own window.
                [
                  ...morph.fromPoints.map((point, index) =>
                    dotAt(xOf(index), axisY(num(point.cost)), morph.dotOpacityFrom, `dot-from-${index}`, 2.5),
                  ),
                  ...morph.toPoints.map((point, index) =>
                    dotAt(
                      padLeft +
                        (morph.toPoints.length > 1 ? index / (morph.toPoints.length - 1) : 0.5) * plotWidth,
                      axisY(num(point.cost)),
                      morph.dotOpacityTo,
                      `dot-to-${index}`,
                      2.5,
                    ),
                  ),
                ]
            : points.map((point, index) =>
                dotAt(xOf(index), yOf(point.cost), 1, `dot-${index}`, hover === index ? 4 : 2.5),
              ),
          interactive && !animated
            ? points.map((point, index) =>
                h('rect', {
                  key: `hit-${index}`,
                  className: 'dts-hit',
                  x: round2(Math.max(0, xOf(index) - slot / 2)),
                  y: 0,
                  width: round2(slot),
                  height: CHART_HEIGHT,
                  onMouseEnter: () => setHover(index),
                  onMouseLeave: () => setHover(-1),
                  onFocus: () => setHover(index),
                  onBlur: () => setHover(-1),
                }),
              )
            : null,
          tickIndices(points.length).map((index) =>
            h(
              'text',
              {
                key: `tick-${index}`,
                className: 'dts-axis-label',
                x: round2(xOf(index)),
                y: CHART_HEIGHT - 6,
                textAnchor: anchorFor(index, points.length),
              },
              points[index] === undefined ? '' : points[index].label,
            ),
          ),
        ),
        hot === null
          ? null
          : h(
              'div',
              {
                className: 'dts-tooltip',
                'data-side': yOf(hover) - 26 < 2 ? 'below' : 'above',
                style: { left: `${round2(tooltipLeft)}px`, top: `${round2(tooltipTop)}px` },
              },
              tooltipText(hot),
            ),
      )
    }

    /**
     * Session bar chart: fixed 28px bars, 12px gaps, horizontally scrollable.
     * The inner width never drops below ten slots, so a short list keeps its
     * bars at their real size and leaves blank space on the right instead of
     * stretching them across the dialog.
     *
     * The tooltip is a sibling of the scroll container, not a child: an
     * `overflow:auto` box clips on both axes, so a bubble inside it would be
     * cut off vertically. Its `left` compensates for `scrollLeft` and is
     * clamped to the visible width.
     * @param {{ points: object[], scale?: number, axisMax?: number, forceHover?: number,
     *   hoverable?: boolean }} props - chart props (`forceHover` pins one bar's
     *   tooltip for a server render; `scale` shrinks the bar values toward 0 for
     *   the collapse/rise half of a chart-type change).
     * @returns {object} React element.
     */
    function BarChart({ points, scale, axisMax, forceHover, hoverable }) {
      const [hoverState, setHoverState] = React.useState(-1)
      const [scrollLeft, setScrollLeft] = React.useState(0)
      const [width, measureRef] = useMeasuredWidth(760)
      const factor = Number.isFinite(scale) ? Math.min(1, Math.max(0, scale)) : 1
      const interactive = hoverable !== false
      const forced = interactive && typeof forceHover === 'number' ? forceHover : -1
      const hover = forced >= 0 ? forced : interactive ? hoverState : -1
      const setHover = (index) => {
        if (forced >= 0 || !interactive) return
        setHoverState(index)
      }

      // The axis column is fixed; only the plot scrolls, so its visible width is
      // the container minus the gutter.
      const plotWidth = Math.max(120, Math.max(60, width) - AXIS_WIDTH)
      const innerWidth = Math.max(BAR_STEP * BAR_MIN_SLOTS, points.length * BAR_STEP)
      const padTop = 14
      const padBottom = 14
      const plotHeight = CHART_HEIGHT - padTop - padBottom
      const baseline = CHART_HEIGHT - padBottom
      const maxCost = points.reduce((max, point) => Math.max(max, point.cost), 0)
      const axis = niceScale(Number.isFinite(axisMax) ? axisMax : maxCost)
      // The axis never scales; only the bar values do, so scale 0 sits exactly
      // on the baseline.
      const axisY = (value) => (axis.max > 0 ? baseline - (value / axis.max) * plotHeight : baseline)
      const barHeight = (cost) => {
        if (axis.max <= 0 || cost <= 0 || factor <= 0) return 0
        return Math.max(2, ((cost * factor) / axis.max) * plotHeight)
      }
      const hot = hover >= 0 && hover < points.length ? points[hover] : null
      const leftLimit = AXIS_WIDTH + 18
      const tooltipLeft =
        hot === null
          ? 0
          : Math.min(
              Math.max(hover * BAR_STEP + BAR_WIDTH / 2 - scrollLeft, leftLimit),
              Math.max(leftLimit, Math.max(60, width) - 64),
            )
      const hotTop = hot === null ? 0 : baseline - barHeight(hot.cost)
      // Flip below the bar top when there is no room above it, then clamp so the
      // bubble never covers the nav row or the axis.
      const tooltipTop =
        hot === null ? 0 : Math.min(Math.max(hotTop < 34 ? hotTop + 8 : hotTop - 26, 2), CHART_HEIGHT - 24)

      return h(
        'div',
        { className: 'dts-bars-wrap', ref: measureRef },
        // Fixed y-axis column: its labels and the grid lines below never scroll.
        h(
          'div',
          { className: 'dts-bars-axis', style: { width: `${AXIS_WIDTH}px` } },
          h(
            'svg',
            {
              className: 'dts-bars-axis-svg',
              width: AXIS_WIDTH,
              height: CHART_HEIGHT,
              viewBox: `0 0 ${AXIS_WIDTH} ${CHART_HEIGHT}`,
              'aria-hidden': 'true',
            },
            axis.ticks.map((tick) =>
              h(
                'text',
                {
                  key: `ytick-${tick}`,
                  className: 'dts-axis-label dts-axis-y',
                  x: AXIS_WIDTH - 6,
                  y: round2(axisY(tick) + 3.5),
                  textAnchor: 'end',
                },
                formatUsd(tick),
              ),
            ),
          ),
        ),
        h(
          'div',
          {
            className: 'dts-bars-grid',
            style: { left: `${AXIS_WIDTH}px`, width: `${plotWidth}px`, height: `${CHART_HEIGHT}px` },
            'aria-hidden': 'true',
          },
          axis.ticks.map((tick) =>
            h('div', {
              key: `grid-${tick}`,
              className: tick === 0 ? 'dts-grid-line is-base' : 'dts-grid-line',
              style: { top: `${round2(axisY(tick))}px` },
            }),
          ),
        ),
        h(
          'div',
          {
            className: 'dts-bars-scroll',
            style: { width: `${plotWidth}px` },
            onScroll: (event) => setScrollLeft(num(event.currentTarget.scrollLeft)),
          },
          h(
            'div',
            { className: 'dts-bars-inner', style: { width: `${innerWidth}px` } },
            h(
              'svg',
              {
                className: 'dts-bars-svg',
                width: innerWidth,
                height: CHART_HEIGHT,
                viewBox: `0 0 ${innerWidth} ${CHART_HEIGHT}`,
                role: 'img',
                'aria-label': '每个会话的花费',
              },
              points.map((point, index) => {
                const visible = barHeight(point.cost)
                return h('rect', {
                  key: `bar-${index}`,
                  className: hover === index ? 'dts-session-bar is-hot' : 'dts-session-bar',
                  x: index * BAR_STEP,
                  y: round2(baseline - visible),
                  width: BAR_WIDTH,
                  height: round2(visible),
                  rx: 3,
                })
              }),
              points.map((point, index) =>
                h('rect', {
                  key: `hit-${index}`,
                  className: 'dts-hit',
                  x: index * BAR_STEP,
                  y: 0,
                  width: BAR_STEP,
                  height: CHART_HEIGHT,
                  onMouseEnter: () => setHover(index),
                  onMouseLeave: () => setHover(-1),
                  onFocus: () => setHover(index),
                  onBlur: () => setHover(-1),
                }),
              ),
            ),
          ),
        ),
        hot === null
          ? null
          : h(
              'div',
              {
                className: 'dts-tooltip',
                'data-side': hotTop < 34 ? 'below' : 'above',
                style: { left: `${round2(tooltipLeft)}px`, top: `${round2(tooltipTop)}px` },
              },
              tooltipText(hot),
            ),
      )
    }

    /**
     * The points a given chart mode should draw.
     * @param {object|undefined} series - `{hour, day, session}` series.
     * @param {object[]|undefined} points - bare fallback list (single mode).
     * @param {string} mode - mode the caller asked for.
     * @param {string} target - mode to resolve.
     * @returns {object[]} points.
     */
    function seriesFor(series, points, mode, target) {
      const key = SERIES_OF_MODE[target]
      if (series !== undefined && series !== null && Array.isArray(series[key])) return series[key]
      return target === mode && Array.isArray(points) ? points : []
    }

    /**
     * Draw exactly one frame. There is deliberately no stacking here: a frame is
     * a single chart, whether it is the resting chart, a lerping line, a morphing
     * line, or a bar chart collapsing/rising.
     * @param {{ frame: object, forceHover?: number }} props - frame props.
     * @returns {object} React element.
     */
    function ChartFrameView({ frame, forceHover }) {
      const kind = frame.kind
      if (kind === 'line-lerp' || kind === 'line-morph') {
        return h(LineChart, {
          points: frame.toPoints,
          mode: frame.mode,
          axisMax: frame.axisMax,
          morph: frame,
          hoverable: false,
          forceHover,
        })
      }
      if (kind === 'collapse' || kind === 'rise') {
        return frame.mode === 'session'
          ? h(BarChart, {
              points: frame.points,
              scale: frame.scale,
              axisMax: frame.axisMax,
              hoverable: false,
              forceHover,
            })
          : h(LineChart, {
              points: frame.points,
              mode: frame.mode,
              scale: frame.scale,
              axisMax: frame.axisMax,
              hoverable: false,
              forceHover,
            })
      }
      // idle and bars-lerp both draw a plain chart of `frame.points`.
      return frame.mode === 'session'
        ? h(BarChart, { points: frame.points, axisMax: frame.axisMax, forceHover })
        : h(LineChart, { points: frame.points, mode: frame.mode, axisMax: frame.axisMax, forceHover })
    }

    /**
     * Draw the chart for one mode, animating every change of the picture —
     * mode switches, month/day flips and new payloads all go through the same
     * 100ms frame.
     *
     * While a block is loading a new selection it keeps its previous payload, so
     * the chart on screen does not move until the data actually changes; the
     * animation then starts from that shown shape.
     * @param {{ mode: string, series?: object, points?: object[], empty?: boolean,
     *   forceHover?: number }} props - mode, the `{hour, day, session}` series
     *   (preferred), a bare point list, whether the month has no usage at all,
     *   and the test-only hover pin.
     * @returns {object} React element.
     */
    function UsageChart({ mode, series, points, empty, forceHover }) {
      const current = seriesFor(series, points, mode, mode)
      const { frame, busy } = useChartFrame(mode, current)
      if (busy) return h(ChartFrameView, { frame, forceHover })
      if (empty === true) {
        return h('div', { className: 'dts-empty' }, mode === 'session' ? '本月暂无会话用量' : '本月暂无用量')
      }
      return h(ChartFrameView, { frame, forceHover })
    }

    /**
     * The `‹ label ›` stepper shared by every chart mode: the day chart steers
     * a date, the month and session charts steer a month. Both use the same
     * element and styling so the three modes read as one control.
     * @param {{ label: string, onPrev: Function, onNext: Function,
     *   prevDisabled: boolean, nextDisabled: boolean, prevTitle: string,
     *   nextTitle: string }} props - nav props.
     * @returns {object} React element.
     */
    function NavBar({ label, onPrev, onNext, prevDisabled, nextDisabled, prevTitle, nextTitle }) {
      const previous = typeof onPrev === 'function' ? onPrev : () => {}
      const next = typeof onNext === 'function' ? onNext : () => {}
      return h(
        'div',
        { className: 'dts-date-nav' },
        h(
          'button',
          {
            type: 'button',
            className: 'dts-date-btn',
            title: prevTitle,
            disabled: prevDisabled === true,
            onClick: () => previous(),
          },
          '‹',
        ),
        h('span', { className: 'dts-date-label' }, String(label || '')),
        h(
          'button',
          {
            type: 'button',
            className: 'dts-date-btn',
            title: nextTitle,
            disabled: nextDisabled === true,
            onClick: () => next(),
          },
          '›',
        ),
      )
    }

    /** The `日 | 月 | 会话` segmented control (per chart, default `日`). */
    function ModeSwitch({ mode, onChange }) {
      return h(
        'div',
        { className: 'dts-seg', role: 'group', 'aria-label': '图表模式' },
        MODES.map((entry) =>
          h(
            'button',
            {
              key: entry.id,
              type: 'button',
              className: 'dts-seg-btn',
              'aria-pressed': mode === entry.id ? 'true' : 'false',
              onClick: () => onChange(entry.id),
            },
            entry.label,
          ),
        ),
      )
    }

    /**
     * The stepper row for the current mode: a date in `日`, a month in `月` and
     * `会话`. It stays visible even when the month has no usage, otherwise a
     * user who lands on an empty month would have no way back.
     * @param {{ mode: string, nav: object }} props - mode and nav descriptor.
     * @returns {object|null} React element.
     */
    function BlockNav({ mode, nav }) {
      if (nav === null || nav === undefined) return null
      if (mode === 'day') {
        return h(NavBar, {
          label: nav.date,
          prevTitle: '前一天',
          nextTitle: '后一天',
          prevDisabled: false,
          nextDisabled: nav.dateNext !== true,
          onPrev: () => nav.shiftDate(-1),
          onNext: () => nav.shiftDate(1),
        })
      }
      return h(NavBar, {
        label: monthLabel(nav.month),
        prevTitle: '上个月',
        nextTitle: '下个月',
        prevDisabled: false,
        nextDisabled: nav.monthNext !== true,
        onPrev: () => nav.shiftMonth(-1),
        onNext: () => nav.shiftMonth(1),
      })
    }

    /**
     * One dialog block: heading + amount, the gray meta line, then a chart with
     * its own mode switch (and its own date/month stepper).
     * The mode lives in local state, but a `mode` prop makes the block
     * controlled — that is how a server render can exercise all three charts
     * without a browser to click in.
     * @param {object} props - block props (optionally `mode`, `onModeChange`).
     * @returns {object} React element.
     */
    /**
     * The selection a block starts on: this machine's current month and today,
     * clamped into it. Blocks never share this state — each one owns a cursor,
     * so flipping one chart's month leaves the others where they were.
     * @param {{ currentMonth: string, today: string }} limits - month bounds.
     * @param {string} [month] - explicit starting month (tests/embedding).
     * @param {string} [date] - explicit starting date (tests/embedding).
     * @returns {{ month: string, date: string }} the starting selection.
     */
    function startCursor(limits, month, date) {
      const target = typeof month === 'string' && month !== '' ? month : limits.currentMonth
      const days = daysInMonth(target)
      const day = typeof date === 'string' && date !== '' ? date : limits.today
      return { month: target, date: clampDateInMonth(day, target, days) }
    }

    /**
     * The nav descriptor for one block's own cursor: both steppers, their
     * enabled state (never into the future) and the shift callbacks.
     * @param {{ month: string, date: string }} cursor - block selection.
     * @param {{ currentMonth: string, today: string }} limits - month bounds.
     * @param {Function} setCursor - state setter for that block.
     * @returns {object} nav descriptor.
     */
    function blockNav(cursor, limits, setCursor) {
      const date = clampDateInMonth(cursor.date, cursor.month, daysInMonth(cursor.month))
      return {
        month: cursor.month,
        date,
        dateNext: addDays(date, 1) <= limits.today,
        monthNext: canShiftMonth(cursor.month, 1, limits.currentMonth),
        shiftDate: (delta) => setCursor((previous) => shiftCursor(previous, { kind: 'date', delta }, limits)),
        shiftMonth: (delta) => setCursor((previous) => shiftCursor(previous, { kind: 'month', delta }, limits)),
      }
    }

    /** An all-zero series for the block's month — used when a model is absent. */
    function emptySeries(month, date) {
      const days = Array.from({ length: daysInMonth(month) }, (_unused, index) => `${month}-${pad2(index + 1)}`)
      return { hour: hourPoints([], date, null), day: dayPoints([], days, null), session: [] }
    }

    /**
     * Locate this block's slice of a timeline payload.
     * @param {string} kind - `total` or `model`.
     * @param {object|null} data - timeline payload.
     * @param {string} modelKey - provider-qualified model key.
     * @returns {object|null} the total block or the model row.
     */
    function blockEntry(kind, data, modelKey) {
      if (data === null || data === undefined) return null
      if (kind === 'total') return data.total || null
      const models = Array.isArray(data.models) ? data.models : []
      return models.find((row) => row.key === modelKey) || models.find((row) => row.model === modelKey) || null
    }

    /**
     * Unused models sort by what they cost the last time they ran — their cost
     * this month is zero by definition, so ordering by it would be meaningless.
     * @param {object} a - known-model entry.
     * @param {object} b - known-model entry.
     * @returns {number} comparator.
     */
    function compareUnused(a, b) {
      const cost = num(b.lastMonthCost) - num(a.lastMonthCost)
      if (cost !== 0) return cost
      return num(b.lastAt) - num(a.lastAt)
    }

    /**
     * Split a timeline payload's models into the ones used this month and the
     * ones the host knows about but that never ran in it.
     *
     * `knownModels` is optional (older hosts do not send it), in which case the
     * unused list is simply empty and the dialog behaves as before.
     * @param {object|null} data - timeline payload.
     * @returns {{ used: object[], unused: object[] }} sorted groups.
     */
    function splitModels(data) {
      const models = data !== null && data !== undefined && Array.isArray(data.models) ? data.models : []
      const known = data !== null && data !== undefined && Array.isArray(data.knownModels) ? data.knownModels : []
      const used = models
        .slice()
        .sort((a, b) => num(b.month && b.month.cost) - num(a.month && a.month.cost))
      const usedKeys = new Set()
      for (const model of models) {
        usedKeys.add(model.key || model.model)
        usedKeys.add(model.model)
      }
      const unused = known
        .filter((entry) => !usedKeys.has(entry.key) && !usedKeys.has(entry.model))
        .sort(compareUnused)
      return { used, unused }
    }

    /**
     * How many known models did not run this month (the panel's footnote).
     * @param {object|null} data - summary payload.
     * @returns {number} unused model count.
     */
    function unusedCountOf(data) {
      if (data === null || data === undefined) return 0
      if (Number.isFinite(data.unusedCount)) return num(data.unusedCount)
      const models = Array.isArray(data.byModel) ? data.byModel : Array.isArray(data.models) ? data.models : []
      const known = Array.isArray(data.knownModels) ? data.knownModels : []
      const usedKeys = new Set()
      for (const model of models) {
        usedKeys.add(model.key || model.model)
        usedKeys.add(model.model)
      }
      return known.filter((entry) => !usedKeys.has(entry.key) && !usedKeys.has(entry.model)).length
    }

    /** `2026-10` for an entry's `lastMonthKey`, or null when it is unusable. */
    function usableMonthKey(value) {
      return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) ? value : null
    }

    /**
     * One dialog block: heading + amount, the gray meta line, then a chart with
     * its own mode switch and its own date/month stepper.
     *
     * The block is self-contained on purpose: it owns its (month, date) and its
     * request, so a slow or empty month only affects this block. Optional props
     * make it controllable for a server render — `mode` (the `日|月|会话` switch)
     * and `initialMonth`/`initialDate` (the starting selection); `forceHover`
     * pins a tooltip so its markup can be asserted.
     *
     * A model that did not run this month passes `headline` (a fixed `$0 / 0.00%`
     * for the current month), `tag` (`上次使用 2026年10月`) and `initialMonth` set
     * to that last-used month, so opening it immediately shows real data.
     * @param {object} props - block props.
     * @returns {object} React element.
     */
    function UsageBlock(props) {
      const { kind, modelKey, title, emphasis, headline, tag } = props
      const limits = props.limits || { currentMonth: monthKey(new Date()), today: dateKey(new Date()) }
      const [ownMode, setOwnMode] = React.useState('day')
      const mode = props.mode === undefined ? ownMode : props.mode
      const setMode = (next) => {
        setOwnMode(next)
        if (typeof props.onModeChange === 'function') props.onModeChange(next)
      }
      const [cursor, setCursor] = React.useState(() => startCursor(limits, props.initialMonth, props.initialDate))
      const timeline = useTimeline(true, cursor.month, cursor.date)
      const nav = blockNav(cursor, limits, setCursor)
      const amountClass = emphasis ? 'dts-block-total' : 'dts-block-cost'
      const data = timeline.state.data
      const failed = timeline.state.status === 'error'
      const loading = timeline.state.status === 'loading'
      // A background revalidation keeps the old chart on screen; only the
      // `aria-busy` flag betrays that the numbers are being refreshed.
      const busy = loading || timeline.busy === true
      const headlineAmount = headline === undefined || headline === null ? null : amountLine(headline.cost, headline.shareText)
      const titleNode = (amount) =>
        h(
          'div',
          { className: 'dts-block-head' },
          title === null || title === undefined ? null : h('span', { className: 'dts-block-title', title }, title),
          tag === null || tag === undefined ? null : h('span', { className: 'dts-tag' }, tag),
          h('span', { className: amountClass }, amount),
        )

      if (data === null) {
        // Only the very first load shows a skeleton; a block that already has a
        // payload keeps drawing it while the next one is fetched (or fails).
        return h(
          'div',
          { className: 'dts-block', 'aria-busy': 'true' },
          titleNode(
            failed
              ? h('span', { title: timeline.state.error }, '读取失败')
              : headlineAmount === null
                ? '—'
                : headlineAmount,
          ),
          h('div', { className: 'dts-block-meta' }, failed ? timeline.state.error || '暂时读不到该时间范围' : '正在读取…'),
          h(BlockNav, { mode, nav }),
          failed
            ? h('button', { type: 'button', className: 'dts-retry', onClick: timeline.reload }, '重试')
            : h('div', { className: 'dts-skeleton', style: { width: '100%', height: '140px' } }),
          h(ModeSwitch, { mode, onChange: setMode }),
        )
      }

      const entry = blockEntry(kind, data, modelKey)
      const block = kind === 'total' ? entry : entry && entry.month
      const keys = seriesKeys(data)
      const series =
        entry === null
          ? emptySeries(cursor.month, keys.date)
          : kind === 'total'
            ? totalSeries(data)
            : buildSeries(entry, keys)
      const shareText =
        entry === null
          ? '0.00%'
          : kind === 'total'
            ? entry.limitKnown === false || !Number.isFinite(entry.share)
              ? '0.00%'
              : formatPercent(entry.share)
            : shareTextOf({ ...entry, share: block && block.share !== undefined ? block.share : entry.share })

      return h(
        'div',
        { className: 'dts-block', 'aria-busy': busy ? 'true' : undefined },
        titleNode(
          headlineAmount === null ? amountLine(num(block && block.cost), shareText) : headlineAmount,
        ),
        h('div', { className: 'dts-block-meta' }, block === null ? '0 tokens · 0 次调用 · 0 个会话' : metaLine(block)),
        h(BlockNav, { mode, nav }),
        h(UsageChart, {
          mode,
          series,
          empty: hasUsage(block) === false,
          forceHover: props.forceHover,
        }),
        failed
          ? h(
              'div',
              { className: 'dts-note dts-block-error' },
              '读取失败，显示的是上一份数据 · ',
              h('button', { type: 'button', className: 'dts-retry', onClick: timeline.reload }, '重试'),
            )
          : null,
        h(ModeSwitch, { mode, onChange: setMode }),
      )
    }

    /**
     * The collapsed group of models that did not run this month.
     *
     * There can be a lot of them and they rarely matter, so they start folded
     * behind a single header. Expanding renders one normal block each — every one
     * of them opens on *its own* last-used month, so it has a real chart instead
     * of an empty axis.
     * @param {{ entries: object[], limits: object, expanded: boolean, onToggle: Function }} props - group props.
     * @returns {object} React element.
     */
    function UnusedGroup({ entries, limits, expanded, onToggle }) {
      return h(
        'div',
        { className: 'dts-unused' },
        h(
          'button',
          {
            type: 'button',
            className: 'dts-unused-head',
            'aria-expanded': expanded === true ? 'true' : 'false',
            onClick: onToggle,
          },
          h('span', { className: expanded === true ? 'dts-unused-caret is-open' : 'dts-unused-caret' }, '▸'),
          h('span', null, `本月未使用（${entries.length}）`),
        ),
        expanded === true
          ? entries.map((entry) =>
              h(UsageBlock, {
                key: entry.key || entry.model,
                kind: 'model',
                modelKey: entry.key || entry.model,
                title: entry.label || entry.model,
                limits,
                // Open on the month it last ran, not on this empty one.
                initialMonth: usableMonthKey(entry.lastMonthKey) || undefined,
                unused: true,
                tag: usableMonthKey(entry.lastMonthKey)
                  ? `上次使用 ${monthLabel(usableMonthKey(entry.lastMonthKey))}`
                  : '本月未使用',
                headline: { cost: 0, shareText: '0.00%' },
              }),
            )
          : null,
      )
    }

    /**
     * The centered "详细用量" dialog: one total block plus one block per model.
     *
     * The dialog itself only needs a base payload — the current month, which
     * tells it *which* models exist. Every block below fetches and navigates on
     * its own, so the month shown in one chart says nothing about the month
     * shown in another.
     * @param {object} props - dialog props (`base` = `{ state, month, date }` for
     *   the model list, `limits` = `{ currentMonth, today }` for the blocks).
     * @returns {object|null} React element, or null while closed.
     */
    function UsageModal(props) {
      const { open, base, limits, summary, onClose, onRetry } = props
      // Hooks first: `open` flips between renders, so nothing may sit above them.
      const [expanded, setExpanded] = React.useState(false)
      // The dialog stays mounted while closed (it renders `null`), so the group
      // has to fold itself again for the next opening.
      React.useEffect(() => {
        if (open !== true) setExpanded(false)
      }, [open])
      if (open !== true) return null

      const bounds = limits || { currentMonth: monthKey(new Date()), today: dateKey(new Date()) }
      const baseState = base && base.state ? base.state : { status: 'idle', data: null, error: null }
      const data = baseState.data === null || baseState.data === undefined ? null : baseState.data
      const status = baseState.status
      const summaryData = summary && summary.data ? summary.data : null
      const providers =
        summaryData && Array.isArray(summaryData.providers) && summaryData.providers.length > 0
          ? summaryData.providers
          : ['opencode-go']
      const close = typeof onClose === 'function' ? onClose : () => {}

      let body = null
      if (data === null) {
        body =
          status === 'error'
            ? h(
                'div',
                { className: 'dts-block' },
                h('div', { className: 'dts-error' }, (baseState.error) || '暂时读不到详细用量'),
                h(
                  'button',
                  { type: 'button', className: 'dts-retry', onClick: onRetry },
                  '重试',
                ),
              )
            : h(
                'div',
                { className: 'dts-block' },
                h('div', { className: 'dts-skeleton', style: { width: '40%' } }),
                h('div', { className: 'dts-skeleton', style: { width: '70%', height: '48px' } }),
                h('div', { className: 'dts-skeleton', style: { width: '100%', height: '140px' } }),
              )
      } else {
        const { used, unused } = splitModels(data)
        const unpricedCalls = num(data.unpriced && data.unpriced.calls)
        body = h(
          React.Fragment,
          null,
          h(UsageBlock, { kind: 'total', title: '总用量', emphasis: true, limits: bounds }),
          used.map((model) =>
            h(UsageBlock, {
              key: model.key || model.model,
              kind: 'model',
              modelKey: model.key || model.model,
              title: model.label || model.model,
              limits: bounds,
            }),
          ),
          unused.length > 0
            ? h(UnusedGroup, {
                entries: unused,
                limits: bounds,
                expanded,
                onToggle: () => setExpanded((previous) => !previous),
              })
            : null,
          unpricedCalls > 0
            ? h('div', { className: 'dts-note' }, `${count(unpricedCalls)} 次调用未匹配价目表，未计入金额。`)
            : null,
          h('div', { className: 'dts-note' }, data.note || `本机口径 · 仅 ${providers.join(', ')}`),
        )
      }

      return h(
        'div',
        {
          className: 'dts-modal',
          role: 'presentation',
          onClick: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          {
            className: 'dts-modal-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '详细用量',
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'dts-modal-head' },
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { className: 'dts-modal-title' }, '详细用量'),
              // No month here: each block can be showing a different one.
              h('div', { className: 'dts-modal-sub' }, `本机口径 · 仅 ${providers.join(', ')}`),
              h('div', { className: 'dts-modal-hint' }, '各图可独立切换时间范围'),
            ),
            h('button', { type: 'button', className: 'dts-close', title: '关闭', onClick: close }, '✕'),
          ),
          body,
        ),
      )
    }

    // ------------------------------------------------------------------
    // Panel.
    // ------------------------------------------------------------------

    /**
     * The popover body: month cost with its quota share, the per-model
     * breakdown with each model's share, and the 5h/weekly footnote.
     * @param {object} props - panel props.
     * @returns {object} React element tree.
     */
    function PanelBody({ summary, onRefresh, refreshing, onOpenDetails }) {
      const data = summary ? summary.data : null

      if (summary && summary.status === 'loading' && data === null) {
        return h(
          'div',
          null,
          h('div', { className: 'dts-skeleton', style: { width: '60%' } }),
          h('div', { className: 'dts-skeleton', style: { width: '35%', height: '24px' } }),
          h('div', { className: 'dts-skeleton', style: { width: '90%' } }),
          h('div', { className: 'dts-skeleton', style: { width: '80%' } }),
        )
      }
      if (data === null) {
        return h(
          'div',
          null,
          h('div', { className: 'dts-error' }, (summary && summary.error) || '暂时读不到用量'),
          h(
            'button',
            { type: 'button', className: 'dts-trigger', onClick: onRefresh, style: { marginTop: '8px' } },
            '重试',
          ),
        )
      }

      const totals = data.totals || {}
      const models = Array.isArray(data.byModel) ? data.byModel : Array.isArray(data.models) ? data.models : []
      const providers = Array.isArray(data.providers) && data.providers.length > 0 ? data.providers : ['opencode-go']
      const totalShare =
        totals.limitKnown === false || !Number.isFinite(totals.share) ? null : formatPercent(totals.share)
      const unpricedCalls = num(data.unpriced && data.unpriced.calls) || num(totals.unpricedCalls)
      const allowance = allowanceText(data.allowances)
      const unusedCount = unusedCountOf(data)
      const details = typeof onOpenDetails === 'function' ? onOpenDetails : () => {}

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dts-head' },
          h('span', { className: 'dts-title' }, `${(data.window && data.window.label) || ''} · ${data.user || ''}`),
          h(
            'div',
            { className: 'dts-head-actions' },
            h(
              'button',
              { type: 'button', className: 'dts-close', title: '刷新', onClick: onRefresh, disabled: refreshing },
              refreshing ? '…' : '⟳',
            ),
            h('button', { type: 'button', className: 'dts-close dts-more', title: '详细用量', onClick: details }, '⋯'),
          ),
        ),
        h(
          'div',
          { className: 'dts-big-row' },
          h('span', { className: 'dts-big' }, formatUsd(totals.cost)),
          totalShare === null ? null : h('span', { className: 'dts-pct' }, totalShare),
        ),
        h('div', { className: 'dts-sub' }, metaLine(totals)),
        data.last7 === null || data.last7 === undefined
          ? null
          : h(
              'div',
              { className: 'dts-sub' },
              `近 7 天 ${formatUsd(data.last7.cost)} · ${count(data.last7.calls)} 次`,
            ),
        num(data.fxRate) > 0
          ? h('div', { className: 'dts-sub' }, `≈ ¥${(num(totals.cost) * num(data.fxRate)).toFixed(2)}`)
          : null,
        models.length > 0
          ? h(
              'div',
              { className: 'dts-section' },
              h('div', { className: 'dts-section-title' }, '按模型'),
              models.map((row) => {
                const muted = row.priced === false || row.free === true
                return h(
                  'div',
                  { key: row.key || row.model },
                  h(
                    'div',
                    { className: 'dts-row' },
                    h('span', { className: 'dts-row-name', title: row.model || row.label }, row.label || row.model),
                    h('span', { className: 'dts-row-cost' }, amountLine(row.cost, shareTextOf(row))),
                  ),
                  h(
                    'div',
                    { className: 'dts-bar' },
                    h('div', {
                      className: muted ? 'dts-bar-fill is-muted' : 'dts-bar-fill',
                      style: { width: `${Math.max(1, Math.round(num(row.costShare) * 100))}%` },
                    }),
                  ),
                )
              }),
              unpricedCalls > 0
                ? h('div', { className: 'dts-note' }, `${count(unpricedCalls)} 次调用未匹配价目表，未计入金额。`)
                : null,
            )
          : null,
        h(
          'div',
          { className: 'dts-note' },
          h('div', null, data.note || `本机口径 · 仅 ${providers.join(', ')} · 本自然月`),
          allowance === null ? null : h('div', { className: 'dts-note-line' }, allowance),
          unusedCount > 0
            ? h('div', { className: 'dts-note-line dts-note-unused' }, `另有 ${unusedCount} 个模型本月未使用`)
            : null,
        ),
      )
    }

    /**
     * Sidebar footer action: a compact cost chip that opens the panel, which in
     * turn opens the centered usage dialog from its `⋯` button.
     * @param {object} props - slot props (`wide` from the sidebar shell;
     *   `detailsOpen` lets a server render start with the dialog open).
     * @returns {object} React element.
     */
    function TokenSplitAction(props) {
      const settings = props === undefined || props === null ? {} : props
      const wide = settings.wide !== false
      const [open, setOpen] = React.useState(false)
      const [details, setDetails] = React.useState(settings.detailsOpen === true)
      const [anchor, setAnchor] = React.useState(null)
      const triggerRef = React.useRef(null)
      const summary = useSummary(open)

      const today = React.useMemo(() => dateKey(new Date()), [])
      /** The month the summary is about; the dialog's base request follows it. */
      const summaryMonth = React.useMemo(() => {
        const data = summary.state.data
        const start = data && data.window && Number.isFinite(data.window.start) ? data.window.start : null
        return start === null ? today.slice(0, 7) : monthKey(new Date(start))
      }, [summary.state.data, today])
      const limits = React.useMemo(() => ({ currentMonth: summaryMonth, today }), [summaryMonth, today])
      // The dialog needs one "base" request to know which models exist this
      // month; the blocks below then fetch their own selections.
      const baseDate = clampDateInMonth(today, summaryMonth, daysInMonth(summaryMonth))
      const base = useTimeline(details, summaryMonth, baseDate)

      const close = React.useCallback(() => setOpen(false), [])
      const toggle = React.useCallback(() => {
        const node = triggerRef.current
        if (node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function') {
          setAnchor(node.getBoundingClientRect())
        }
        setOpen((previous) => !previous)
      }, [])
      const openDetails = React.useCallback(() => setDetails(true), [])
      const closeDetails = React.useCallback(() => setDetails(false), [])

      React.useEffect(() => {
        if (!open && !details) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (details) {
            setDetails(false)
            return
          }
          setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, details])

      const cost = summary.state.data === null ? null : num(summary.state.data.totals && summary.state.data.totals.cost)
      const label = cost === null ? '用量' : formatUsd(cost)

      const panelStyle =
        anchor === null || typeof window === 'undefined'
          ? undefined
          : {
              left: `${Math.max(12, Math.min(anchor.left, window.innerWidth - 344))}px`,
              bottom: `${Math.max(12, window.innerHeight - anchor.top + 8)}px`,
            }

      return h(
        'div',
        { className: 'dts-root' },
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className: 'dts-trigger',
            'aria-expanded': open,
            title: cost === null ? '本机 Go 用量（本月）' : `本月 ${formatUsd(cost)}`,
            onClick: toggle,
          },
          h('span', { className: 'dts-trigger-dot', style: { opacity: cost === null ? 0.3 : 1 } }),
          h('span', { className: 'dts-trigger-label' }, wide ? label : ''),
        ),
        open
          ? h(
              React.Fragment,
              null,
              h('div', { className: 'dts-backdrop', onClick: close }),
              h(
                'div',
                { className: 'dts-panel', style: panelStyle, role: 'dialog', 'aria-label': 'Go 用量' },
                h(PanelBody, {
                  summary: summary.state,
                  onRefresh: summary.reload,
                  refreshing: summary.state.status === 'refreshing',
                  onOpenDetails: openDetails,
                }),
              ),
            )
          : null,
        h(UsageModal, {
          open: details,
          base: { state: base.state, month: summaryMonth, date: baseDate },
          limits,
          summary: summary.state,
          onClose: closeDetails,
          onRetry: base.reload,
        }),
      )
    }

    /** Services this browser plugin needs. */
    const inject = ['slots']

    /**
     * Register the footer action.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'token-split', order: 5 }, TokenSplitAction),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.TokenSplitAction = TokenSplitAction
    exports.PanelBody = PanelBody
    exports.UsageModal = UsageModal
    exports.UsageBlock = UsageBlock
    exports.UsageChart = UsageChart
    exports.formatUsd = formatUsd
    exports.formatPercent = formatPercent
    exports.buildSeries = buildSeries
    exports.buildTotalSeries = totalSeries
    exports.seriesKeys = seriesKeys
    // Selection helpers, exported so the month/day navigation can be verified
    // without a DOM to click in.
    exports.addMonths = addMonths
    exports.addDays = addDays
    exports.shiftCursor = shiftCursor
    exports.startCursor = startCursor
    exports.canShiftMonth = canShiftMonth
    exports.monthLabel = monthLabel
    exports.timelinePath = timelinePath
    // Model grouping (used / unused this month), exported for direct assertions.
    exports.splitModels = splitModels
    exports.unusedCountOf = unusedCountOf
    exports.usableMonthKey = usableMonthKey
    // Timeline cache, exported so the sharing/eviction rules are testable.
    exports.loadTimeline = loadTimeline
    exports.clearTimelineCache = clearTimelineCache
    exports.REVALIDATE_MS = REVALIDATE_MS
    exports.seedTimelineState = (month, date, state) => {
      timelineCache.set(timelineKey(month, date), state)
      trimTimelineCache()
      return state
    }
    exports.mergeTimelineState = mergeTimelineState
    // Axis maths, exported so the tick rounding can be asserted directly.
    exports.niceScale = niceScale
    exports.niceStep = niceStep
    // Animation: easing, resampling, the state machine and the frame builder,
    // all exported so they can be asserted without a browser to animate in.
    exports.TRANSITION_MS = TRANSITION_MS
    exports.easeInCubic = easeInCubic
    exports.easeOutCubic = easeOutCubic
    exports.easeInOutCubic = easeInOutCubic
    exports.resamplePoints = resamplePoints
    exports.lerpPoints = lerpPoints
    exports.morphFrame = morphFrame
    exports.collapseScale = collapseScale
    exports.riseScale = riseScale
    exports.transitionPlan = transitionPlan
    exports.seriesSignature = seriesSignature
    exports.idleFrame = idleFrame
    exports.chartFrame = chartFrame
    exports.frameOf = frameOf
    exports.LineChart = LineChart
    exports.BarChart = BarChart
    exports.ChartFrameView = ChartFrameView
    exports.UsageChart = UsageChart
    exports.UnusedGroup = UnusedGroup
    return module.exports
  },
})
