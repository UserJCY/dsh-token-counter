# Changelog

All notable changes to `dsh-token-split`. Dates are local build dates.

## 0.3.3 — 2026-11-01

The detailed-usage dialog now follows the console's layout.

- **Toolbar** — a model picker (`全部模型` / one model) and an `导出` button that
  downloads the loaded month as CSV (`date, cost_usd, calls, tokens`). The picker
  only narrows what is drawn; each block still owns its request.
- **Three KPI cards** — `消费金额`, `API 请求次数`, `Tokens`, over the dialog's base
  month.
- **Chart cards** — the total block draws one wide `消费金额` card; every model
  block draws the console's pair, `API 请求次数` and `Tokens`, side by side. The
  date stepper and the `日 | 月 | 会话` switch moved into a footer row under the
  charts, one set per block, so each chart keeps its own range as before.
- The chart engine gained a measure dimension: points are re-pointed at
  `calls` / `tokens` and a formatter prints the axis and the tooltip as plain
  grouped integers instead of dollars.

## 0.3.2 — 2026-11-01

- **The panel now actually asks for the rolling window.** The client had
  `period: 'month'` hard-coded in its summary request, so the 0.3.1 host-side
  default never reached it and the header kept reading `2026-11-01 ~ 2026-11-30`.
  It requests `last30` now. The allowance footnote is unaffected: `week` stays
  the trailing seven days and `month` the live calendar month, both aggregated
  host-side from their own windows.

## 0.3.1 — 2026-11-01

The window and the allowance are now decoupled: the panel rolls, the percentages
do not.

- **Default window is the rolling 30 days again** (`DEFAULT_PERIOD` = `last30`),
  so the panel no longer resets on the 1st. `month` and `cycle` stay available
  through the tool.
- **Last-7-days line under the headline**: `近 7 天 $0.132 · 41 次`, from a new
  `last7` block in the summary payload.
- **The allowance footnote gains the monthly share and English labels**:
  `5h 0.02%/20% · week 0.09%/50% · month 0.05%`. `week` is the trailing seven
  days (cap 50%), `month` is the live calendar month's plan-level `Σ(cost/limit)`
  (no cap — it is the whole allowance). Both are aggregated independently of the
  panel window, so a rolling window can never mix two billing months into them.
- The panel note now reads `近 30 天` instead of `本自然月`.

## 0.3.0 — 2026-11-01

The "how much of the plan is left" release: money is still the unit, but every
amount now carries its share of the Go allowance, and there is a page to look
at the history.

- **Allowance percentages in the panel.** Every model row reads
  `$0.446 / 0.45%` (`cost / that model's monthly allowance`); the headline
  amount carries the plan-level total, computed as the shared-pool sum
  `Σ(cost / limit)` rather than `totalCost / Σlimit`. The total is hidden when
  any paid model lacks allowance data, because that sum would be misleading.
- **Default window is the calendar month.** `DEFAULT_PERIOD` moved from the
  rolling 30 days to `month`, so the percentages always describe the live
  billed month instead of mixing two of them. `last30` is still available.
- **Rolling-window footnote.** The panel now ends with
  `5h 0.02%/20% · 周 0.09%/50%`: the last five hours and the last seven days
  as a share of the monthly allowance, with each window's cap (20% / 50%).
- **Detailed-usage dialog** (`⋯` in the panel header). One block for the total
  plus one block per model; every block owns its `日 / 月 / 会话` mode and its
  own cursor, so `日` steps day by day across months and `月` / `会话` step
  month by month. Charts are hand-written SVG: `niceScale` Y ticks, hover
  tooltips, and a 100 ms transition between selections (point resampling for
  lines, height scaling for bars). A loading month keeps the previous chart.
- **New `GET /token-split/timeline` route** (also under `/api/`), read-only and
  loopback-only like the summary. One request answers the whole dialog: the
  month's day series, the selected day's 24 hours, the month's per-session bars
  — for the total and for every model — plus `knownModels`, the all-history
  model list carrying `lastMonthKey` / `lastMonthCost`.
- **"Unused this month (N)" group.** Models present in history but absent from
  the current month collapse into one group; expanded, each opens on the month
  it last ran and is labelled with it.
- **Stale-while-revalidate on the client.** Opening the dialog paints the cached
  payload (no skeleton) while a forced refresh runs; while it stays open, every
  visible selection revalidates every 30 s. Identical selections share one
  in-flight request and a small LRU cache.
- **Sub-session spend rolls up into its root session**, and a sub-session never
  adds to the session count: one resolver serves the panel, the timeline and the
  report, so the three cannot disagree.
- **`summary` gains `unusedCount`** so the panel can footnote models that did
  not run this month.

## 0.2.7 — baseline before 0.3.0

- Sidebar chip and panel over a rolling **last 30 days**, per-model split with
  share bars, 60 s refresh.
- `GET /token-split/summary` (and `/api/token-split/summary`), read-only and
  loopback-only.
- `token_usage` tool with `period` / `detail` / `otherCost` / `monthlyFee` /
  `basis` / `save`, Markdown report and per-step CSV.
- Go rate card for 30 models, DeepSeek V4.1 Flash and V4 Pro peak/off-peak,
  per-model monthly allowances, `pricing.json` overrides with hot reload.
- Session-event folding, idempotent history backfill, atomic ledger.
