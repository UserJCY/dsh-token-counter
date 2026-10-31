# dsh-token-split

OpenCode **Go** accounting for DSH: counts only the `opencode-go` provider route, prices it with the official Go rate card (DeepSeek peak/off-peak included), shows the number in the sidebar, and splits the monthly subscription by spend.

> Built for one situation: two people share a Go subscription (same key), each running DSH on their own machine. The plugin counts **this machine** and **this provider** only; the other side runs the same plugin and reports their figure.

## What it does

1. **Go only** — every record carries its provider; reports and the panel count `providers: ['opencode-go']` by default, so your own DeepSeek key, qianfan, or anything else never enters the bill.
2. **Live + backfill** — folds each `assistant/message.usage` from `session/event`, and folds the persisted session logs on disk once at startup. Idempotent across restarts.
3. **Priced with the Go table** — `lib/pricing.js` carries all 30 Go models in USD per 1M tokens, applies DeepSeek V4.1 Flash / V4 Pro peak and off-peak rates by timestamp, and shows each model's monthly allowance (e.g. `$100` for V4.1 Flash).
4. **Sidebar panel** — a cost chip in the sidebar footer opens the rolling **last 30 days**: total cost, tokens, calls, and a per-model breakdown, fed by the read-only host route `GET /token-split/summary`.
5. **Tool + export** — the `token_usage` tool renders a Markdown report; `save: true` also writes `.md` and a per-step `.csv`.

## Install

**From GitHub (recommended — this is the command to share):**

```powershell
dsh plugin --profile desktop add github:UserJCY/dsh-token-counter
```

**From a local checkout (for development):**

```powershell
dsh plugin --profile desktop add file:D:\Programs\dsh-token-counter
```

`dsh plugin add` appends any dependency declaring `dsh.bundle` to `dsh.profile.bundles`. Then **restart DSH**: the ledger appears, backfill runs, and the sidebar chip shows up.

### Update / uninstall

```powershell
# git dependencies pin a commit and file: ones are copies — reinstall to pick changes up
dsh plugin --profile desktop remove dsh-token-split
dsh plugin --profile desktop add github:UserJCY/dsh-token-counter

# uninstall (the ledger stays for reconciliation)
dsh plugin --profile desktop remove dsh-token-split
```

## Configuration

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: token-split
  config:
    user: jerry
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
| `cycleStartDay` | `1` | cycle restart day (1–28). |
| `fxRate` | `0` | USD→CNY rate; when > 0 the report adds a CNY line. |
| `pricingFile` | `''` | extra price-override file; empty reads `pricing.json` in the data directory. |
| `includeSubagents` | `true` | count delegation sessions. |
| `backfill` | `true` | fold history on startup. |
| `reportDir` | `''` | where `save` writes; empty = session cwd. |

## The panel

A chip in the sidebar footer shows the **rolling last 30 days** cost. Opened, it shows the window's total (cost, tokens, calls, sessions) and the per-model split with share bars. It refreshes every 60 s while open and fetches only then.

> The window rolls, so the number does not reset on the 1st. For a calendar month or the subscription cycle, use the tool with `period: 'cycle'` (the cycle start is `cycleStartDay`).

## Pricing

Rates come from the public Go docs (`https://opencode.ai/docs/go/` → Usage limits), USD per 1M tokens:

- **DeepSeek V4.1 Flash** — off-peak `$0.15 / $0.60 / $0.003` (input / output / cached read); peak doubles them. Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; every other hour, including the whole weekend, is off-peak.
- **DeepSeek V4 Pro** — off-peak `$0.66 / $1.98 / $0.022`; peak `$1.32 / $3.96 / $0.044`.
- Everything else (Kimi K3, GLM-5.3, Qwen3.8, Claude Haiku 5.5, Gemini 4 Argon, …) is flat-rate; see `lib/pricing.js`.
- Each model's **monthly allowance** is included, so the report and panel show "used / limit" per model.

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

Resolution order: exact id → alias → strip a build suffix such as `-1017` → longest prefix. An unmatched model is reported as unpriced (cost 0) and called out, never silently dropped.

### Reconciling with the console

The console (`opencode.ai/console`) reports **the whole key**: this machine's DSH + the other person's machine + any other client. The plugin counts **this machine** and **`opencode-go`** only, so:

```
console total ≈ this machine + the other person (+ other local clients)
```

Measured once: the console showed `deepseek-v4.1-flash` 561 requests / $0.99 while this machine showed 336 / $0.724 — the 225-request, ~$0.27 gap was the other person's usage. The console also listed `claude-haiku-5-5`, a model absent from the local ledger, confirming other clients use the key.

- **Pricing agrees**: feeding the console's token counts through this repo's table yields $0.987 ≈ the displayed $0.99, peak/off-peak included. A difference can only come from scope, never from the rate.
- **The gap covers every non-local source**, so splitting on "console total − this machine" is safer than trusting a number the other person reports.
- With the plugin on both machines, local + theirs should ≈ the console; a larger gap means a third client uses the key.

## The tool

- "How much did I use this cycle?" → `token_usage({ period: 'cycle' })`
- "Break it down by day" → `token_usage({ detail: 'daily' })`
- "My friend used $0.80, the plan is $10 — what do I owe?" → `token_usage({ otherCost: 0.8, monthlyFee: 10 })`
- "Save the details" → `save: true`

```
**本机用量** · 2026-10-01 ~ 2026-10-31 · 用户 `Jerry` · 来源 `opencode-go`

| 调用次数 | 189 |
| 输入（未缓存） | 829,430 |
| 缓存读取 | 36,226,816 |
| 输出 | 238,305 |
| 合计 tokens | 37,294,551 |
| **按 Go 定价的金额** | **$0.376** |
```

## Data

| path | content |
| --- | --- |
| `~/.dsh/token-split/ledger.json` | the ledger (`0o600`, atomic replace) |
| `~/.dsh/token-split/pricing.json` | your price overrides (optional) |
| `<workspace>/token-usage-<from>.md` / `.csv` | `save: true` output |

The panel reads `GET /token-split/summary`: read-only, loopback-only, aggregates rather than records, `no-store`. The ledger file never reaches the browser.

## Verification

```powershell
npm test          # 79 cases
```

Covers fold precedence, ledger corruption recovery, peak/off-peak, price matching and overrides, aggregation with the provider filter, split arithmetic, the HTTP route (200/403/405), and the client bundle (factory, registration, panel markup rendered through `react-dom/server`).

Offline cross-check against this machine's logs (zstd frame decoding, same `lib/fold.js` and price table):

```powershell
node --import ./test/register.mjs scripts/verify-history.mjs
```

On this machine the history splits `deepseek-official=7367 / deepseek-account=620 / qianfan=154 / opencode-go=189`; filtered to Go, the 189 steps cost **$0.376**.

## Known limitations

- DSH traffic only: usage the same key spends through another client (opencode CLI, …) is invisible.
- Context-tiered prices (Grok 4.7 > 200K, Qwen3.7 Plus > 256K, GPT Luna > 272K, Claude Haiku > 100K, MiniMax M3 > 512K) use the base tier: a usage sample carries buckets, not the context size that produced them.
- Peak is decided from the request's event time, so a request spanning a boundary takes its start's rate.
- One ledger per machine: two DSH processes writing it is last-write-wins.
- The panel needs `ctx.webServer` (present in Web and desktop, absent in headless); the tool works either way.

## Layout

```
lib/index.js    host plugin: config, event subscriptions, backfill, HTTP route, token_usage tool
lib/fold.js     pure: event -> usage sample, step precedence
lib/ledger.js   ledger: in-memory state plus debounced atomic writes
lib/pricing.js  Go rate card, peak/off-peak, model matching, override file
lib/report.js   pure: windows, aggregation, split, Markdown/CSV
lib/client.js   browser half: sidebar chip + panel (lazy-CJS bundle)
scripts/        offline verification helpers
test/           79 cases
```
