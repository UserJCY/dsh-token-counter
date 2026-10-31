/**
 * Browser half of dsh-token-split.
 *
 * One sidebar footer action: the current cycle's Go cost, and a panel that
 * breaks it down per model and splits the monthly fee against the other
 * person's number. Data comes from the host's read-only
 * `GET /token-split/summary` route, so the browser never touches the ledger
 * file and never recomputes pricing.
 *
 * This file is a pre-built client bundle in the harness's lazy-CJS form:
 * executing it only registers a factory; the body runs on materialization.
 * `require` resolves the shared `react` module from the module table.
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
    // forwards JSON posts — the handler is read-only either way.
    const ATTEMPTS = [
      { path: '/token-split/summary', method: 'GET' },
      { path: '/api/token-split/summary', method: 'GET' },
      { path: '/api/token-split/summary', method: 'POST' },
    ]
    const STYLE_ID = 'dsh-token-split/panel.css'
    const REFRESH_MS = 60_000

    /**
     * Resolve one endpoint against the directory the host serves the UI from,
     * exactly as the market's own client does: root deployments resolve to `/`,
     * a sub-path deployment keeps its mount prefix.
     * @param {string} path - route path.
     * @returns {string} the fetchable pathname.
     */
    function endpoint(path) {
      const relative = path.replace(/^\/+/, '')
      if (typeof document === 'undefined' || typeof document.baseURI !== 'string') return `/${relative}`
      try {
        return new URL(relative, document.baseURI).pathname
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
.dts-panel{position:fixed;z-index:901;box-sizing:border-box;width:330px;max-width:calc(100vw - 24px);max-height:min(560px,calc(100vh - 32px));overflow:auto;padding:14px;border:1px solid #e4e4ea;border-radius:12px;background-color:#ffffff;background-image:none;color:#17171a;box-shadow:0 16px 40px rgba(0,0,0,.18);font-size:13px;line-height:1.45;isolation:isolate}
@media (prefers-color-scheme:dark){.dts-panel{background-color:#1c1c1f;color:#ececf0;border-color:#3a3a42;box-shadow:0 16px 40px rgba(0,0,0,.55)}}
@supports (color:light-dark(#fff,#000)){.dts-panel{background-color:light-dark(#ffffff,#1c1c1f);color:light-dark(#17171a,#ececf0);border-color:light-dark(#e4e4ea,#3a3a42);box-shadow:0 16px 40px light-dark(rgba(0,0,0,.18),rgba(0,0,0,.55))}}
.dts-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:10px}
.dts-title{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dts-close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;border-radius:6px}
.dts-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dts-big{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
.dts-sub{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.dts-section{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dts-section-title{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}
.dts-row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:5px 0;align-items:baseline}
.dts-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dts-row-cost{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dts-bar{grid-column:1 / -1;height:3px;border-radius:2px;background:var(--dsw-alias-fill-l2);overflow:hidden}
.dts-bar-fill{height:100%;border-radius:2px;background:var(--dsw-alias-label-secondary)}
.dts-note{margin-top:10px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.dts-error{margin-top:10px;color:#d33;font-size:12px}
.dts-skeleton{height:12px;border-radius:6px;background:rgba(127,127,127,.18);margin:6px 0}
/* The panel carries its own opaque surface, so every inner tone is derived
   from its own color instead of the host theme's translucent tokens. */
.dts-panel .dts-title,.dts-panel .dts-sub,.dts-panel .dts-section-title{color:inherit;opacity:.6}
.dts-panel .dts-note{color:inherit;opacity:.62}
.dts-panel .dts-close{color:inherit;opacity:.72}
.dts-panel .dts-row-cost{color:inherit;opacity:.8}
.dts-panel .dts-bar{background:rgba(127,127,127,.22)}
.dts-panel .dts-bar-fill{background:currentColor;opacity:.55}
.dts-panel .dts-close:hover{outline:none;background:rgba(127,127,127,.16)}
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

    /** `$0.0234`-style money, mirroring the host's formatUsd. */
    function money(value) {
      const usd = Number.isFinite(value) ? value : 0
      if (usd === 0) return '$0'
      if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`
      if (Math.abs(usd) < 1) return `$${usd.toFixed(3)}`
      return `$${usd.toFixed(2)}`
    }

    /** Group digits without locale surprises. */
    function count(value) {
      const rounded = Math.round(Number.isFinite(value) ? value : 0)
      return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** Compact token counts for the trigger line. */
    function compact(value) {
      const n = Number.isFinite(value) ? value : 0
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
      return String(Math.round(n))
    }

    /**
     * Read one summary endpoint as JSON, or throw a diagnostic that names the
     * exact HTTP status and body head — an empty body is the failure mode this
     * panel hit first, and "Unexpected end of JSON input" alone cannot tell a
     * 404 from a 403.
     * @param {{ path: string, method: string }} attempt - endpoint and verb.
     * @returns {Promise<object>} parsed summary.
     */
    async function fetchSummary({ path, method }) {
      const url = endpoint(path)
      const response = await fetch(url, { method, headers: { accept: 'application/json' }, cache: 'no-store' })
      const text = await response.text()
      if (!response.ok) throw new Error(`${method} ${path} → HTTP ${response.status} ${text.slice(0, 80)}`)
      if (text.trim() === '') throw new Error(`${method} ${path} → HTTP ${response.status} 空响应`)
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`${method} ${path} → 非 JSON（${text.slice(0, 80)}）`)
      }
      if (!json || json.ok !== true) throw new Error(`${method} ${path} → ${(json && json.error) || '统计服务未就绪'}`)
      return json
    }

    /**
     * Fetch the host summary for the current cycle, trying every registered
     * route spelling before giving up.
     * @param {boolean} open - whether the panel is visible.
     * @returns {{ state: object, reload: () => void }} data state plus a manual refresh.
     */
    function useSummary(open) {
      const [state, setState] = React.useState({ status: 'idle', data: null, error: null })
      const load = React.useCallback(() => {
        if (typeof fetch !== 'function') {
          setState({ status: 'error', data: null, error: '当前环境没有 fetch' })
          return
        }
        setState((previous) => ({ ...previous, status: previous.data === null ? 'loading' : 'refreshing' }))
        const problems = []
        const attempt = (index) => {
          if (index >= ATTEMPTS.length) {
            setState((previous) => ({ status: 'error', data: previous.data, error: problems.join(' · ') }))
            return Promise.resolve()
          }
          return fetchSummary(ATTEMPTS[index]).then(
            (json) => {
              setState({ status: 'ready', data: json, error: null })
            },
            (error) => {
              problems.push(error instanceof Error ? error.message : String(error))
              return attempt(index + 1)
            },
          )
        }
        void attempt(0)
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
     * The popover body: cycle cost and the per-model breakdown.
     * @param {object} props - panel props.
     * @returns {object} React element tree.
     */
    function PanelBody({ summary, onRefresh, refreshing }) {
      const data = summary.data

      if (summary.status === 'loading' && data === null) {
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
          h('div', { className: 'dts-error' }, summary.error || '暂时读不到用量'),
          h(
            'button',
            { type: 'button', className: 'dts-trigger', onClick: onRefresh, style: { marginTop: '8px' } },
            '重试',
          ),
        )
      }

      const totals = data.totals
      const models = (data.models || []).slice(0, 5)

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dts-head' },
          h('span', { className: 'dts-title' }, `${data.window.label} · ${data.user}`),
          h('button', { type: 'button', className: 'dts-close', title: '刷新', onClick: onRefresh, disabled: refreshing }, refreshing ? '…' : '⟳'),
        ),
        h('div', { className: 'dts-big' }, money(totals.cost)),
        h(
          'div',
          { className: 'dts-sub' },
          `${count(totals.tokens)} tokens · ${count(totals.calls)} 次调用 · ${count(totals.sessions)} 个会话`,
        ),
        data.fxRate > 0 ? h('div', { className: 'dts-sub' }, `≈ ¥${(totals.cost * data.fxRate).toFixed(2)}`) : null,
        models.length > 0
          ? h(
              'div',
              { className: 'dts-section' },
              h('div', { className: 'dts-section-title' }, '按模型'),
              models.map((row) =>
                h(
                  'div',
                  { key: row.model },
                  h(
                    'div',
                    { className: 'dts-row' },
                    h('span', { className: 'dts-row-name', title: row.model }, row.label),
                    h('span', { className: 'dts-row-cost' }, money(row.cost)),
                  ),
                  h(
                    'div',
                    { className: 'dts-bar' },
                    h('div', {
                      className: 'dts-bar-fill',
                      style: { width: `${Math.max(1, Math.round((row.costShare || 0) * 100))}%`, opacity: row.priced ? 1 : 0.35 },
                    }),
                  ),
                ),
              ),
              totals.unpricedCalls > 0
                ? h('div', { className: 'dts-note' }, `${count(totals.unpricedCalls)} 次调用未匹配价目表，未计入金额。`)
                : null,
            )
          : null,
        h(
          'div',
          { className: 'dts-note' },
          `只统计本机 · ${(data.providers || []).join(', ') || '全部来源'} · 定价来自 Go 官方价目表`,
        ),
      )
    }

    /**
     * Sidebar footer action: a compact cost chip that opens the panel.
     * @param {object} props - slot props (`wide` from the sidebar shell).
     * @returns {object} React element.
     */
    function TokenSplitAction(props) {
      const wide = props === undefined || props.wide !== false
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const triggerRef = React.useRef(null)
      const summary = useSummary(open)

      const close = React.useCallback(() => setOpen(false), [])
      const toggle = React.useCallback(() => {
        const node = triggerRef.current
        if (node !== null && typeof node.getBoundingClientRect === 'function') setAnchor(node.getBoundingClientRect())
        setOpen((previous) => !previous)
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const cost = summary.state.data === null ? null : summary.state.data.totals.cost
      const label = cost === null ? '用量' : money(cost)

      const panelStyle =
        anchor === null
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
            title: cost === null ? '本机 Go 用量' : `本周期 ${money(cost)}`,
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
                }),
              ),
            )
          : null,
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
    return module.exports
  },
})
