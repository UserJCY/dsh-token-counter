# dsh-token-split

OpenCode **Go** accounting for DSH: counts only the `opencode-go` provider route, prices it with the official Go rate card (DeepSeek peak/off-peak included), shows the cost and its **allowance percentage** in the sidebar, and splits the monthly subscription by spend.

> Built for one situation: two people share a Go subscription (same key), each running DSH on their own machine. The plugin counts **this machine** and **this provider** only; the other side runs the same plugin and reports their figure.

Version **0.3.0** · 2026-11-01 · MIT

## What it does

1. **Go only** — every record carries its provider; reports and the panel count `providers: ['opencode-go']` by default, so your own DeepSeek key, qianfan, or anything else never enters the bill.
2. **Live + backfill** — folds each `assistant/message.usage` from `session/event`, and scans the persisted session logs on disk once at startup. Idempotent across restarts.
3. **Priced with the Go table** — `lib/pricing.js` carries 30 Go models in USD per 1M tokens (2 of them free-tier), and applies DeepSeek V4.1 Flash / V4 Pro peak and off-peak rates by timestamp.
4. **Allowance percentages** — each model row reads "cost / share of its allowance" (`$0.446 / 0.45%`); the panel's headline amount carries the **total percentage**, computed as the shared-pool sum `Σ(cost / limit)`.
5. **Sidebar panel** — a cost chip in the sidebar footer (current calendar month) opens "month cost / per model / rolling-window footnote", fed by the read-only host route `GET /token-split/summary`.
6. **Detailed-usage dialog** — opened from the panel's `⋯`; one block for the total plus one block per model, each with its **own** `day / month / session` mode and its own time navigation, drawn with hand-written SVG.
7. **Tool + export** — the `token_usage` tool renders a Markdown report; `save: true` also writes `.md` and a per-step `.csv`.

## Install

**From GitHub (recommended — this is the command to share):**

```powershell
dsh plugin --profile desktop add github:<your-user>/dsh-token-counter
```

> `package.json` ships with `repository` pointing at `github.com/UserJCY/dsh-token-counter`. If you push to your own fork, change that URL here and in `package.json` together.

**From a local checkout or an unpacked release (development, offline installs):**

```powershell
dsh plugin --profile desktop add file:<absolute path to this checkout or unpacked folder>
```

`dsh plugin add` appends any dependency declaring `dsh.bundle` to `dsh.profile.bundles`. Then **restart DSH**: the ledger appears, backfill runs, and the sidebar chip shows up.

### Update / uninstall

```powershell
# git dependencies pin a commit and file: ones are copies — reinstall to pick changes up
dsh plugin --profile desktop remove dsh-token-split
dsh plugin --profile desktop add github:<your-user>/dsh-token-counter

# uninstall (the ledger stays for reconciliation)
dsh plugin --profile desktop remove dsh-token-split
```

## Configuration

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: token-split
  config:
    user: alice
    monthlyFee: 10        # Go $10/mo, Go Plus $40, Go Teams $20 per member
    cycleStartDay: 1
    providers: [opencode-go]
```

| key | default | meaning |
| --- | --- | --- |
| `user` | OS account name | attribution label on every record. |
| `providers` | `['opencode-go']` | **the only provider routes counted**; an empty array disables the filter. |
| `plan` | `go` | `go` / `plus` / `teams`, copy only. |
| `monthlyFee` | `10` | subscription price per cycle, USD. |
| `cycleStartDay` | `1` | cycle restart day (1–28). Only affects `period: 'cycle'`; the panel always shows the **calendar month**. |
| `fxRate` | `0` | USD→CNY rate; when > 0 the report and panel add a CNY reference. |
| `pricingFile` | `''` | extra price-override file; empty reads `pricing.json` in the data directory. |
| `includeSubagents` | `true` | count delegation sessions (their spend rolls up into the root session; session counts are per root). |
| `backfill` | `true` | fold history on startup. |
| `reportDir` | `''` | where `save` writes; empty = session cwd. |

## The panel

A chip in the sidebar footer (`sidebar.footer.action`, order 5) shows the **current calendar month** cost. Opened:

```
┌──────────────────────────────────┐
│ 2026-11-01 ~ 2026-11-30 · alice  ⟳ ⋯│
│ $0.446                      0.45% │
│ 37,294,551 tokens · 189 calls · 3 sessions │
│                                  │
│ By model                         │
│ DeepSeek V4.1 Flash  $0.446 / 0.45%│
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁          │
│                                  │
│ this machine · opencode-go only · calendar month │
│ 5h 0.02%/20% · week 0.09%/50%     │
│ 4 more models did not run this month │
└──────────────────────────────────┘
```

- The headline is this month's cost; the number beside it is the **total percentage** (`Σ(cost/limit)`, shared-pool basis). If any paid model has no allowance data the total reads `—`, because that sum would be a lie.
- Each model row is "cost / share of that model's allowance", with a thin bar for its share of this month's spend beneath. Unpriced models are muted and flagged; free-tier models read `/ free`.
- The footnote is `5h x%/20% · week y%/50%`: the rolling 5-hour and rolling 7-day spend expressed as a share of the monthly allowance, plus each window's cap (20% / 50%). These are Go's own two-window limits, shown for reference.
- The line under it counts models that did **not** run this month (`summary.unusedCount`).
- It refreshes every 60 s while open, or immediately via `⟳`. Closed, it fetches nothing.
- `⋯` in the header opens the **detailed usage** dialog.

> The panel window is the **calendar month** (`period: 'month'`), so it resets on the 1st. For a billing cycle, use the tool with `period: 'cycle'` (start day = `cycleStartDay`).

## The detailed-usage dialog

Entered from `⋯`. A centered card, scrolling vertically:

- One **total** block, then one block per model that ran this month. Each block heads with its own "cost / allowance share" and `tokens · calls · sessions`.
- Every block has its **own** `day / month / session` switch:
  - `day` — a 24-hour line chart that can step **across months** day by day (never into the future);
  - `month` — that month's per-day bars, one month back or forward at a time (never past the current month);
  - `session` — one bar per root session in the month, sorted by cost.
- Blocks do not share a month: one can sit in September while another stays on this month. Identical `(month, date)` selections are fetched once and shared through a small LRU cache.
- Charts are hand-written SVG: `niceScale` Y-axis ticks, hover tooltips, and a 100 ms transition when the selection changes (line points are resampled and eased, bars scale their height). A loading month keeps the previous chart on screen; a failed refresh keeps it too and offers a retry inside the block.
- **Unused this month (N)** — models that exist in history but never ran this month sit in one collapsed group. Expanded, each block opens on **the month it last ran**, labelled "last used YYYY-MM".
- Opening the dialog is **stale-while-revalidate**: the previous payload paints immediately (no skeleton), a forced refresh runs in parallel, and while the dialog is open every visible selection is revalidated every 30 s. The cache is also what makes month switching not flash.

## Percentage semantics

Money is the primary unit; a percentage is just another way to say it:

- **Model percentage** = `this month's cost for that model / that model's monthly allowance`. Free-tier and unpriced models have no percentage.
- **Total percentage** = `Σ(model cost / model limit)`, **not** `total cost / Σ limits`. Go treats the allowances as one shared pool; the second formula is badly distorted when per-model prices differ.
- The panel and the report share one `formatPercent`: `<0.01%` below one basis point, two decimals under 1%, one decimal under 100%, whole numbers from 100% up.

## Pricing

Rates come from the public Go docs (`https://opencode.ai/docs/go/` → Usage limits), USD per 1M tokens:

- **DeepSeek V4.1 Flash** — off-peak `$0.15 / $0.60 / $0.003` (input / output / cached read); peak doubles them (`$0.30 / $1.20 / $0.006`). Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; every other hour, including the whole weekend, is off-peak. Allowance `$100`.
- **DeepSeek V4 Pro** — off-peak `$0.66 / $1.98 / $0.022`; peak `$1.32 / $3.96 / $0.044`. Allowance `$15`.
- Everything else (Kimi K3, GLM-5.3, Qwen3.8, Claude Haiku 5.5, Gemini 4 Argon, …) is flat-rate; see `lib/pricing.js`. The two free-tier rows (`beam-free`, `iceman-contributor-free`) cost nothing and stay out of the allowance pool.
- Each model's **monthly allowance** is built in, and the report, panel and dialog all derive their percentages from it.

**Why money, not tokens**: a Go allowance is denominated in dollars per model, and cached input costs two orders of magnitude less than output. Splitting by raw tokens would price cached tokens like output tokens and badly overcharge cache-heavy use. The default basis is therefore `cost`; `tokens` remains available.

### Correcting prices

Drop overrides into `~/.dsh/token-split/pricing.json` (hot-reloaded, no restart):

```json
{
  "models": {
    "my-new-model": { "label": "My New Model", "input": 0.2, "output": 0.8, "cacheRead": 0.02, "cacheWrite": 0, "monthlyLimit": 20 }
  },
  "aliases": { "deepseek-flash": "deepseek-v4.1-flash" }
}
```

Resolution order: exact id → alias → strip a build suffix such as `-1017` → longest prefix. An unmatched model is reported as unpriced (cost 0) and called out — in the report, the panel and the dialog — never silently dropped.

### Reconciling with the console

The console (`opencode.ai/console`) reports **the whole key**: this machine's DSH + the other person's machine + any other client. The plugin counts **this machine** and **`opencode-go`** only, so:

```
console total ≈ this machine + the other person (+ other local clients)
```

Measured once: the console showed `deepseek-v4.1-flash` 561 requests / $0.99 while this machine showed 336 / $0.724 — the 225-request, ~$0.27 gap was the other person's usage. The console also listed `claude-haiku-5-5`, a model absent from the local ledger, confirming other clients use the key.

- **Pricing agrees**: feeding the console's token counts through this repo's table yields $0.987 ≈ the displayed $0.99, peak/off-peak included. A difference can only come from scope, never from the rate.
- **The gap covers every non-local source**, so splitting on "console total − this machine" is safer than trusting a number the other person reports.
- With the plugin on both machines, local + theirs should ≈ the console; a larger gap means a third client uses the key.

## HTTP routes

The panel and the dialog read host routes only; the browser never touches the ledger file:

| route | purpose | query |
| --- | --- | --- |
| `GET /token-split/summary` | panel: window, totals, per-model rows, `unusedCount`, `allowances` (5 h / week) | `period`, `since`, `until` |
| `GET /token-split/timeline` | dialog: the whole month's day / hour / session series per model, plus `knownModels` | `month` (`YYYY-MM`), `date` (`YYYY-MM-DD`) |
| `/api/token-split/summary`, `/api/token-split/timeline` | the same two handlers under the `/api/` namespace (the desktop renderer's fetch bridge only guarantees `/api/*`) | same |

- **Read-only**: both routes aggregate and return; they never write the ledger or the config. `GET` / `HEAD` / `POST` are accepted (POST is a hedge for bridges that only forward JSON POSTs — the semantics stay read-only).
- **Loopback only**: anything that is not `127.0.0.1` / `::1` / `::ffff:127.0.0.1` gets `403 {"error":"loopback-only"}`; a wrong method gets `405`; responses carry `cache-control: no-store`.
- **Aggregates, not records**: `summary` returns totals and model rows, `timeline` returns month/day/hour series. Neither exposes per-step records.

## The tool

Defaults to the **current calendar month**:

- "How much did I use this month?" → `token_usage({})`
- "How much did I use this cycle?" → `token_usage({ period: 'cycle' })`
- "Last 30 days?" → `token_usage({ period: 'last30' })`
- "Break it down by day" → `token_usage({ detail: 'daily' })`
- "My friend used $0.80, the plan is $10 — what do I owe?" → `token_usage({ otherCost: 0.8, monthlyFee: 10 })`
- "Save the details" → `save: true`

```
**本机用量** · 2026-11-01 ~ 2026-11-30 · 用户 `alice` · 来源 `opencode-go`

| 项目 | 数值 |
| --- | ---: |
| 调用次数 | 189 |
| 输入（未缓存） | 829,430 |
| 缓存读取 | 36,226,816 |
| 输出 | 238,305 |
| 合计 tokens | 37,294,551 |
| **按 Go 定价的金额** | **$0.446** |
| **占 Go 月度额度** | **0.45%** |
| 会话数 | 3 |

> 额度窗口（占月额度）：5h 0.02%/20% · 周 0.09%/50%
```

## Data

| path | content |
| --- | --- |
| `~/.dsh/token-split/ledger.json` | the ledger (`0o600`, atomic replace) |
| `~/.dsh/token-split/pricing.json` | your price overrides (optional) |
| `<workspace>/token-usage-<from>.md` / `.csv` | `save: true` output |

## Verification

```powershell
npm test          # 157 cases
```

CI (`.github/workflows/ci.yml`) runs the same suite on Node 24. The tests need `react` / `react-dom` to render the browser half, so those are **devDependencies** — the plugin itself has zero runtime dependencies and does not need them inside DSH.

Locally, reusing an installed DSH profile:

```powershell
# point at a node_modules directory holding @deepseek-ai/dsh-client-runtime, react and react-dom
$env:DSH_PROFILE_MODULES='<absolute path to a node_modules directory>/'
node --import ./test/register.mjs test/run.mjs
```

`test/resolve-hook.mjs` looks for that module root in order: `DSH_PROFILE_MODULES` → `DSH_HOME/profiles/node_modules` → `~/.dsh/profiles/node_modules`. If none exists it stops with a readable error instead of skipping silently.

Covers fold precedence, ledger corruption recovery, peak/off-peak, price matching and overrides, aggregation with the provider filter, split arithmetic, allowance percentages (per model and shared pool), the rolling 5 h / weekly windows, the HTTP routes (200/403/405), the timeline's month/day/session series and `knownModels`, the unused-model group, the SWR cache with its 30 s revalidation, and the client bundle (factory, registration, panel and dialog markup rendered through `react-dom/server`).

Offline cross-check against this machine's logs (zstd frame decoding, same `lib/fold.js` and price table):

```powershell
node --import ./test/register.mjs scripts/verify-history.mjs
```

## Known limitations

- DSH traffic only: usage the same key spends through another client (opencode CLI, …) is invisible.
- The panel always shows the **calendar month**. To follow the billing cycle you currently have to use the tool with `period: 'cycle'`; `cycleStartDay` does not move the panel.
- Context-tiered prices (Grok 4.7 > 200K, Qwen3.7 Plus > 256K, GPT Luna > 272K, Claude Haiku > 100K, MiniMax M3 > 512K) use the base tier: a usage sample carries buckets, not the context size that produced them.
- Peak is decided from the request's event time, so a request spanning a boundary takes its start's rate.
- One ledger per machine: two DSH processes writing it is last-write-wins.
- The panel and the dialog both need `ctx.webServer` (present in Web and desktop, absent in headless); the tool works either way.
- The 5 h / weekly windows are a **local** approximation: they sum this machine's records over a rolling window, not the server's real rate-limit counters.

## Layout

```
lib/index.js    host plugin: config, event subscriptions, backfill, both HTTP routes, token_usage tool
lib/fold.js     pure: event -> usage sample, step precedence
lib/ledger.js   ledger: in-memory state plus debounced atomic writes
lib/pricing.js  Go rate card, peak/off-peak, model matching, allowances and shared-pool percentages
lib/report.js   pure: windows, aggregation, split, allowance footnote, Markdown/CSV
lib/timeline.js pure: month's hour/day/session series plus knownModels
lib/history.js  session-log enumeration and zstd frame reads
lib/fsutil.js   data directory and atomic writes
lib/client.js   browser half: sidebar chip + panel + detailed-usage dialog (lazy-CJS bundle)
scripts/        offline verification helpers
test/           157 cases
```

## Changelog

**0.3.0** (2026-11-01)

- Allowance percentage beside every amount in the panel (`$0.446 / 0.45%`), and a shared-pool total percentage beside the headline.
- Default window is now the **calendar month** instead of a rolling 30 days.
- New `5h …/20% · week …/50%` rolling-window footnote in the panel.
- New **detailed usage** dialog (`⋯`): total plus one block per model, each with its own `day / month / session` mode and navigation, hand-written SVG charts with tooltips and a 100 ms transition.
- New `GET /token-split/timeline` route, returning `knownModels` (all-history model list with `lastMonthKey` / `lastMonthCost`).
- Models unused this month collapse into an "unused this month (N)" group that opens on each model's last-used month.
- The client is now stale-while-revalidate: cached payload first, forced refresh in parallel, 30 s revalidation while the dialog is open.
- Sub-session spend rolls up into its root session; session counts are per root session.
- `summary` gains `unusedCount`.

Earlier history: [CHANGELOG.md](CHANGELOG.md).

## Screenshots

| Panel | Detailed-usage dialog |
| --- | --- |
| _(placeholder: sidebar chip + panel with cost / percentage / per-model rows / 5 h · week footnote)_ | _(placeholder: dialog with the total block and model blocks, day / month / session charts)_ |
