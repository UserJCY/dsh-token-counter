# Contributing

Thanks for looking. This is a small plugin with a deliberately small surface:
one host half (`lib/index.js` and its helpers), one pre-built browser half
(`lib/client.js`), and a test suite that runs in a single Node process.

## Requirements

- Node **24** (matches CI; the host half and the tests avoid newer syntax).
- No network at runtime: the plugin has **zero runtime dependencies** and never
  calls out.

## Setup

```powershell
npm install         # react / react-dom, dev only — the browser-half test needs them
npm test            # 157 cases, one process
```

`npm install` is all the setup there is. The tests resolve `@deepseek-ai/*` and
React through `test/resolve-hook.mjs`, which looks for a module root in this
order:

1. `$DSH_PROFILE_MODULES` — an explicit `node_modules` directory;
2. `./node_modules` — what `npm install` just gave you;
3. `$DSH_HOME/profiles/node_modules`;
4. `~/.dsh/profiles/node_modules`.

If none of them provides React it stops with a message naming the variable to
set. To test against an installed DSH instead of a fresh install:

```powershell
$env:DSH_PROFILE_MODULES='<path to a node_modules holding @deepseek-ai/dsh-client-runtime>/'
node --import ./test/register.mjs test/run.mjs
```

`node --test test/` is not used: it spawns a child process per file, which some
confined hosts refuse. `test/run.mjs` imports the files into one process.

## Ground rules

- **`lib/client.js` is a pre-built bundle** in the harness's lazy-CJS form: it
  registers a factory through `window.__ModuleLoader__.load` and does all its
  work inside `factory`. There is no build step; edit it directly, and keep it
  dependency-free apart from `require('react')`.
- **Money over tokens.** Cost is the primary unit because a Go allowance is
  denominated in dollars per model. A percentage is `cost / limit`; the
  plan-level one is the shared-pool sum `Σ(cost / limit)`, never
  `totalCost / Σlimit`.
- **Both halves format alike.** `lib/report.js` and `lib/client.js` each carry
  `formatUsd` / `formatPercent`. They are asserted to agree; change them
  together.
- **Sub-session money belongs to the root session**, and a sub-session never
  increments a session count. Use `createSessionResolver` from
  `lib/timeline.js` rather than walking `parent` links by hand.
- **No absolute paths, no keys, no machine names** in code, tests or docs. Test
  fixtures use placeholders (`alice`, `D:/work`).
- **Read-only routes.** Anything the browser talks to aggregates and returns; it
  never writes the ledger or the config, and it must stay loopback-only.
- **Add a test with the change.** The suite is the specification; a behaviour
  change without a case is a regression waiting to happen.

## Before opening a pull request

```powershell
npm test
for file in lib/*.js; do node --check "$file"; done
```

Both should be clean (157 pass / 0 fail). CI runs exactly the same two steps on
Node 24.

## Releases

Cut by hand, from a clean tree:

```powershell
npm pack --pack-destination dist          # npm artifact
git tag v0.3.0 && git push --tags         # git tag for the GitHub release
```

See `GITHUB.md` in the release bundle for the publishing steps and the
`dist/SHA256SUMS.txt` convention.
