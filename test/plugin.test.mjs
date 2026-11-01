import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply, resolveConfig, SUMMARY_ROUTE, TIMELINE_ROUTE } from '../lib/index.js'
import { chunkEvent, contextEvent, createFakeContext, messageEvent, sessionStub, settle, tempDir, titleEvent, usage } from './helpers.mjs'

/** A throwaway DSH home so the plugin never touches the real ledger. */
function tempHome() {
  return tempDir('home-')
}

/** Build the services the plugin needs for a live-only run. */
function services() {
  return {}
}

/** A fake `ctx.webServer` that records the routes the plugin registers. */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
}

/** A fake `http.ServerResponse` capturing status, headers and body. */
function fakeResponse() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text ?? ''
    },
  }
}

test('apply registers the token_usage tool with the documented schema', () => {
  process.env.DSH_HOME = tempHome()
  const ctx = createFakeContext({ services: services() })
  apply(ctx, resolveConfig({ backfill: false }))
  assert.equal(ctx.registered.length, 1)
  const tool = ctx.registered[0]
  assert.equal(tool.name, 'token_usage')
  assert.deepEqual(tool.parameters.properties.period.enum, ['today', 'cycle', 'month', 'last7', 'last30', 'all'])
  assert.deepEqual(tool.parameters.properties.basis.enum, ['cost', 'tokens'])
  assert.ok(tool.parameters.properties.otherCost)
  assert.equal(tool.parameters.required, undefined)
  assert.equal(tool.output.schema.type, 'object')
  ctx.disposeAll()
})

test('the default config counts only opencode-go at the Go plan price', () => {
  process.env.DSH_HOME = tempHome()
  const config = resolveConfig({})
  assert.deepEqual(config.providers, ['opencode-go'])
  assert.equal(config.monthlyFee, 10)
  assert.equal(config.plan, 'go')
  assert.equal(config.cycleStartDay, 1)
})

test('live events are folded, priced, persisted, and reported', async () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  const ctx = createFakeContext({ services: services() })
  const config = resolveConfig({ user: 'alice', monthlyFee: 10, backfill: false, cycleStartDay: 1 })
  apply(ctx, config)

  const session = sessionStub({ id: 'session-live', createdAt: 1_700_000_000_000 })
  ctx.emit('session/event', session, contextEvent())
  ctx.emit('session/event', session, titleEvent('重构账单'))
  ctx.emit('session/event', session, chunkEvent({ usage: usage({ input: 900, output: 1 }) }))
  ctx.emit('session/event', session, messageEvent({ usage: usage({ input: 1_000_000, output: 100_000, cacheRead: 500_000 }) }))
  ctx.emit('session/event', session, { type: 'turn/end', seq: 9, time: 1_700_000_003_000, data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(200)

  const file = path.join(home, 'token-split', 'ledger.json')
  assert.equal(fs.existsSync(file), true)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  const records = Object.values(stored.records)
  assert.equal(records.length, 1)
  assert.equal(records[0].input, 1_000_000)
  assert.equal(records[0].cacheRead, 500_000)
  assert.equal(records[0].provider, 'opencode-go')
  assert.equal(stored.sessions['session-live'].title, '重构账单')

  const tool = ctx.registered[0]
  const { report } = await tool.execute({ period: 'all' }, {})
  assert.match(report, /1,600,000/)
  assert.match(report, /按 Go 定价的金额/)

  const split = await tool.execute({ period: 'all', otherCost: 0.25, monthlyFee: 10 }, {})
  assert.match(split.report, /你应付/)
  ctx.disposeAll()
})

test('usage from another provider never enters the bill', async () => {
  process.env.DSH_HOME = tempHome()
  const ctx = createFakeContext({ services: services() })
  apply(ctx, resolveConfig({ user: 'alice', backfill: false, providers: ['opencode-go'] }))

  const go = sessionStub({ id: 'go-session' })
  const other = sessionStub({ id: 'other-session' })
  ctx.emit('session/event', go, messageEvent({ provider: 'opencode-go', usage: usage({ input: 1_000 }) }))
  ctx.emit('session/event', other, messageEvent({ provider: 'qianfan', usage: usage({ input: 9_999 }) }))

  const tool = ctx.registered[0]
  const { report } = await tool.execute({ period: 'all' }, {})
  assert.match(report, /1,000/)
  assert.doesNotMatch(report, /9,999/)
  ctx.disposeAll()
})

test('a usage chunk alone still bills a failed request', async () => {
  process.env.DSH_HOME = tempHome()
  const ctx = createFakeContext({ services: services() })
  apply(ctx, resolveConfig({ user: 'alice', backfill: false }))
  const session = sessionStub({ id: 'session-failed' })
  ctx.emit('session/event', session, contextEvent())
  ctx.emit('session/event', session, chunkEvent({ usage: usage({ input: 4_000, output: 0 }) }))
  const tool = ctx.registered[0]
  const { report } = await tool.execute({ period: 'all' }, {})
  assert.match(report, /4,000/)
  ctx.disposeAll()
})

test('subagent sessions are excluded when configured', async () => {
  process.env.DSH_HOME = tempHome()
  const ctx = createFakeContext({ services: services() })
  apply(ctx, resolveConfig({ user: 'alice', backfill: false, includeSubagents: false }))
  ctx.emit('session/event', sessionStub({ id: 'sub', depth: 1 }), messageEvent({ usage: usage({ input: 7_777 }) }))
  ctx.emit('session/event', sessionStub({ id: 'main', depth: 0 }), messageEvent({ usage: usage({ input: 1_111 }) }))
  const tool = ctx.registered[0]
  const { report } = await tool.execute({ period: 'all' }, {})
  assert.match(report, /1,111/)
  assert.doesNotMatch(report, /7,777/)
  ctx.disposeAll()
})

test('save writes a Markdown report and a CSV next to the session workspace', async () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  const ctx = createFakeContext({ services: services() })
  apply(ctx, resolveConfig({ user: 'alice', backfill: false }))
  const workspace = tempDir('ws-')
  ctx.emit('session/event', sessionStub({ id: 's1', cwd: workspace }), messageEvent({ usage: usage({ input: 1_000, output: 200 }) }))
  const tool = ctx.registered[0]
  const result = await tool.execute({ period: 'all', save: true }, { agent: { session: { header: { cwd: workspace } } } })
  assert.match(result.report, /已保存/)
  const files = fs.readdirSync(workspace)
  assert.equal(files.filter((name) => name.endsWith('.md')).length, 1)
  assert.equal(files.filter((name) => name.endsWith('.csv')).length, 1)
  const csv = fs.readFileSync(path.join(workspace, files.find((name) => name.endsWith('.csv'))), 'utf8')
  assert.match(csv, /^date,time,session/)
  ctx.disposeAll()
})

test('the browser route serves the current calendar month by default', async () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  const webServer = fakeWebServer()
  const ctx = createFakeContext({ services: { webServer } })
  apply(ctx, resolveConfig({ user: 'alice', backfill: false }))

  assert.equal(webServer.routes.length, 4)
  assert.deepEqual(webServer.routes.map((entry) => entry.path).sort(), [
    '/api/token-split/summary',
    '/api/token-split/timeline',
    '/token-split/summary',
    '/token-split/timeline',
  ])
  const route = webServer.routes.find((entry) => entry.path === SUMMARY_ROUTE)
  assert.equal(route.kind, 'exact')

  ctx.emit('session/event', sessionStub({ id: 's1' }), messageEvent({ usage: usage({ input: 1_000_000, output: 1_000_000 }) }))

  // No query means the calendar month, not a rolling window.
  const defaulted = fakeResponse()
  route.handler({ method: 'GET', url: SUMMARY_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, defaulted)
  const defaultBody = JSON.parse(defaulted.captured.body)
  assert.equal(defaultBody.window.period, 'month')
  assert.equal(defaultBody.window.start, new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime())
  assert.equal(defaultBody.window.label.includes(' ~ '), true)
  assert.equal(defaultBody.note, '本机口径 · 仅 opencode-go · 本自然月')

  const res = fakeResponse()
  route.handler({ method: 'GET', url: `${SUMMARY_ROUTE}?period=all`, socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.captured.status, 200)
  const body = JSON.parse(res.captured.body)
  assert.equal(body.ok, true)
  assert.equal(body.user, 'alice')
  assert.deepEqual(body.providers, ['opencode-go'])
  assert.equal(body.totals.calls, 1)
  assert.equal(body.totals.cost, 0.75)
  assert.equal(body.totals.share, 0.0075)
  assert.equal(body.totals.limitKnown, true)
  assert.deepEqual(body.unpriced, { calls: 0, tokens: 0 })
  assert.equal(body.allowances.fiveHour.cap, 0.2)
  assert.equal(body.allowances.weekly.cap, 0.5)
  assert.equal(body.models[0].key, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(body.models[0].provider, 'opencode-go')
  assert.equal(body.models[0].model, 'deepseek-v4.1-flash')
  assert.equal(body.models[0].label, 'DeepSeek V4.1 Flash')
  assert.equal(body.models[0].limit, 100)
  assert.equal(body.models[0].share, 0.0075)
  assert.equal(body.models[0].priced, true)
  assert.equal(body.models[0].free, false)
  assert.equal(body.models[0].sessions, 1)
  assert.equal(body.window.label, '全部历史')
  ctx.disposeAll()
})

test('the timeline route serves one month of total, per-model and session series', () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  const webServer = fakeWebServer()
  const ctx = createFakeContext({ services: { webServer } })
  apply(ctx, resolveConfig({ user: 'alice', backfill: false }))

  const route = webServer.routes.find((entry) => entry.path === TIMELINE_ROUTE)
  assert.ok(route)
  assert.equal(route.kind, 'exact')

  const at = Date.now()
  ctx.emit('session/event', sessionStub({ id: 'session-root' }), messageEvent({ time: at, usage: usage({ input: 1_000_000, output: 0 }) }))

  const res = fakeResponse()
  route.handler({ method: 'GET', url: TIMELINE_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.captured.status, 200)
  const body = JSON.parse(res.captured.body)
  const today = new Date(at)
  const monthDays = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  assert.equal(body.ok, true)
  assert.equal(body.hours.length, 24)
  assert.equal(body.days.length, monthDays)
  assert.equal(body.total.hour.length, 24)
  assert.equal(body.total.day.length, monthDays)
  assert.deepEqual(body.total.session, [])
  assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(body.note, /本机口径 · 仅 opencode-go/)
  assert.equal(body.total.calls, 1)
  assert.equal(body.total.sessions, 1)
  assert.equal(body.total.day.find((point) => point.key === body.date).calls, 1)
  assert.equal(body.total.hour[today.getHours()].calls, 1)
  assert.equal(body.models.length, 1)
  assert.equal(body.models[0].key, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(body.models[0].hour.length, 24)
  assert.equal(body.models[0].day.length, monthDays)
  assert.equal(body.models[0].session.length, 1)
  assert.equal(body.models[0].session[0].sessionId, 'session-root')
  // The all-history model list rides along on the same response.
  assert.deepEqual(body.knownModels.map((row) => row.key), ['opencode-go/deepseek-v4.1-flash'])
  assert.equal(body.knownModels[0].totalCalls, 1)
  assert.equal(body.knownModels[0].lastAt, at)

  // An explicit month is honoured; a date outside it falls back to the 1st.
  const former = fakeResponse()
  route.handler({ method: 'GET', url: `${TIMELINE_ROUTE}?month=2026-09&date=2026-12-05`, socket: { remoteAddress: '127.0.0.1' } }, former)
  const formerBody = JSON.parse(former.captured.body)
  assert.equal(formerBody.month.key, '2026-09')
  assert.equal(formerBody.month.days, 30)
  assert.equal(formerBody.date, '2026-09-01')
  assert.equal(formerBody.total.calls, 0)
  assert.deepEqual(formerBody.models, [])
  // Known models ignore the selected month.
  assert.deepEqual(formerBody.knownModels, body.knownModels)

  // Same guards as the summary route.
  const remote = fakeResponse()
  route.handler({ method: 'GET', url: TIMELINE_ROUTE, socket: { remoteAddress: '192.168.1.5' } }, remote)
  assert.equal(remote.captured.status, 403)
  const put = fakeResponse()
  route.handler({ method: 'PUT', url: TIMELINE_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, put)
  assert.equal(put.captured.status, 405)
  ctx.disposeAll()
})

test('the summary and the timeline agree on the session count', () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  const webServer = fakeWebServer()
  const ctx = createFakeContext({ services: { webServer } })
  apply(ctx, resolveConfig({ user: 'alice', backfill: false }))

  const at = Date.now()
  ctx.emit('session/event', sessionStub({ id: 'root-main' }), messageEvent({ time: at, usage: usage({ input: 1_000_000, output: 0 }) }))
  // A delegated turn: same session of work, different session id on disk.
  ctx.emit(
    'session/event',
    sessionStub({ id: 'sub-1', depth: 1, parent: 'root-main' }),
    messageEvent({ time: at + 1000, usage: usage({ input: 2_000_000, output: 0 }) }),
  )

  const summaryRoute = webServer.routes.find((entry) => entry.path === SUMMARY_ROUTE)
  const summaryRes = fakeResponse()
  summaryRoute.handler({ method: 'GET', url: SUMMARY_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, summaryRes)
  const summary = JSON.parse(summaryRes.captured.body)

  const timelineRoute = webServer.routes.find((entry) => entry.path === TIMELINE_ROUTE)
  const timelineRes = fakeResponse()
  timelineRoute.handler({ method: 'GET', url: TIMELINE_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, timelineRes)
  const timeline = JSON.parse(timelineRes.captured.body)

  assert.equal(summary.totals.calls, 2)
  assert.equal(summary.totals.sessions, 1)
  assert.equal(timeline.total.calls, 2)
  assert.equal(timeline.total.sessions, 1)
  assert.equal(summary.totals.sessions, timeline.total.sessions)
  assert.equal(summary.totals.cost, timeline.total.cost)
  // The subagent's money shows up in the root session's bar.
  assert.equal(timeline.models[0].session.length, 1)
  assert.equal(timeline.models[0].session[0].sessionId, 'root-main')
  assert.equal(timeline.models[0].month.sessions, 1)
  ctx.disposeAll()
})

test('the summary counts models the ledger knows but this month never used', () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  const webServer = fakeWebServer()
  const ctx = createFakeContext({ services: { webServer } })
  apply(ctx, resolveConfig({ user: 'alice', backfill: false }))

  const now = new Date()
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12).getTime()
  // A: used this month. B: only used last month, so it is outside the window.
  ctx.emit('session/event', sessionStub({ id: 's-now' }), messageEvent({ time: Date.now(), usage: usage({ input: 1_000_000 }) }))
  ctx.emit(
    'session/event',
    sessionStub({ id: 's-old' }),
    messageEvent({ time: lastMonth, model: 'claude-haiku-5-5', usage: usage({ input: 2_000_000 }) }),
  )

  const summaryRoute = webServer.routes.find((entry) => entry.path === SUMMARY_ROUTE)
  const summaryRes = fakeResponse()
  summaryRoute.handler({ method: 'GET', url: SUMMARY_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, summaryRes)
  const summary = JSON.parse(summaryRes.captured.body)
  assert.equal(summary.totals.calls, 1)
  assert.equal(summary.unusedCount, 1)

  // The dialog's all-history list carries the same model, so the two views agree.
  const timelineRoute = webServer.routes.find((entry) => entry.path === TIMELINE_ROUTE)
  const timelineRes = fakeResponse()
  timelineRoute.handler({ method: 'GET', url: TIMELINE_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, timelineRes)
  const timeline = JSON.parse(timelineRes.captured.body)
  assert.equal(timeline.knownModels.some((row) => row.key === 'opencode-go/claude-haiku-5-5'), true)
  ctx.disposeAll()
})

test('unusedCount ignores models used this month and other providers', () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  const webServer = fakeWebServer()
  const ctx = createFakeContext({ services: { webServer } })
  apply(ctx, resolveConfig({ user: 'alice', backfill: false }))

  const now = new Date()
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12).getTime()
  // Both known models are used this month.
  ctx.emit('session/event', sessionStub({ id: 's-now' }), messageEvent({ time: Date.now(), usage: usage({ input: 1_000_000 }) }))
  ctx.emit(
    'session/event',
    sessionStub({ id: 's-now-2' }),
    messageEvent({ time: Date.now(), model: 'claude-haiku-5-5', usage: usage({ input: 1_000 }) }),
  )
  // A provider outside the whitelist must not contribute a model.
  ctx.emit(
    'session/event',
    sessionStub({ id: 's-other' }),
    messageEvent({ time: lastMonth, provider: 'qianfan', model: 'remote-model', usage: usage({ input: 1_000 }) }),
  )

  const summaryRoute = webServer.routes.find((entry) => entry.path === SUMMARY_ROUTE)
  const summaryRes = fakeResponse()
  summaryRoute.handler({ method: 'GET', url: SUMMARY_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, summaryRes)
  const summary = JSON.parse(summaryRes.captured.body)
  assert.equal(summary.models.length, 2)
  assert.equal(summary.unusedCount, 0)
  ctx.disposeAll()
})

test('the browser route refuses non-loopback callers and writes', () => {
  process.env.DSH_HOME = tempHome()
  const webServer = fakeWebServer()
  const ctx = createFakeContext({ services: { webServer } })
  apply(ctx, resolveConfig({ backfill: false }))
  const route = webServer.routes[0]

  const remote = fakeResponse()
  route.handler({ method: 'GET', url: SUMMARY_ROUTE, socket: { remoteAddress: '192.168.1.5' } }, remote)
  assert.equal(remote.captured.status, 403)

  const write = fakeResponse()
  route.handler({ method: 'PUT', url: SUMMARY_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, write)
  assert.equal(write.captured.status, 405)

  // POST is accepted: the renderer bridge may only forward posts to /api.
  const post = fakeResponse()
  route.handler({ method: 'POST', url: SUMMARY_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, post)
  assert.equal(post.captured.status, 200)
  ctx.disposeAll()
})

/** Write one plain-JSONL session log under `<home>/sessions`. */
function writeSessionLog(home, sessionId, { createdAt = 1_650_000_000_000, cwd = 'D:/old', delegationDepth = 0 } = {}, events = []) {
  const dir = path.join(home, 'sessions', 'workspace-slug', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [{ type: 'session', version: 4, id: sessionId, createdAt, cwd, delegationDepth }, ...events]
  const file = path.join(dir, 'session.v4.jsonl')
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return file
}

test('backfill folds historical logs from disk and remembers the lifecycle', async () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  writeSessionLog(home, 'session-old', {}, [
    contextEvent(),
    titleEvent('历史会话'),
    messageEvent({ turn: 3, step: 2, usage: usage({ input: 2_000, output: 300 }) }),
  ])

  const ctx = createFakeContext({ services: services() })
  apply(ctx, resolveConfig({ user: 'alice', backfill: true }))
  await settle(300)

  const file = path.join(home, 'token-split', 'ledger.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(Object.keys(stored.records).length, 1)
  assert.equal(stored.meta.backfilled['session-old'], 1_650_000_000_000)
  assert.equal(stored.sessions['session-old'].title, '历史会话')
  assert.ok(stored.meta.lastBackfillAt > 0)

  // A later log write must not be re-folded: the lifecycle is already marked.
  writeSessionLog(home, 'session-old', {}, [
    contextEvent(),
    titleEvent('历史会话'),
    messageEvent({ turn: 3, step: 2, usage: usage({ input: 2_000, output: 300 }) }),
    messageEvent({ turn: 4, step: 1, usage: usage({ input: 9_999 }) }),
  ])
  const again = createFakeContext({ services: services() })
  apply(again, resolveConfig({ user: 'alice', backfill: true }))
  await settle(300)
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).records).length, 1)
  ctx.disposeAll()
  again.disposeAll()
})

test('a backfill failure is logged and does not stop the plugin', async () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  // A file that starts with the zstd magic but is not a valid frame.
  const dir = path.join(home, 'sessions', 'workspace-slug', 'broken')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('garbage')]))

  const ctx = createFakeContext({ services: services() })
  apply(ctx, resolveConfig({ user: 'alice', backfill: true }))
  await settle(300)
  assert.equal(ctx.warnings.some((line) => line.includes('cannot read session log')), true)
  assert.equal(ctx.registered.length, 1)
  ctx.disposeAll()
})

