import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply, resolveConfig, SUMMARY_ROUTE } from '../lib/index.js'
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
  const config = resolveConfig({ user: 'jerry', monthlyFee: 10, backfill: false, cycleStartDay: 1 })
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
  apply(ctx, resolveConfig({ user: 'jerry', backfill: false, providers: ['opencode-go'] }))

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
  apply(ctx, resolveConfig({ user: 'jerry', backfill: false }))
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
  apply(ctx, resolveConfig({ user: 'jerry', backfill: false, includeSubagents: false }))
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
  apply(ctx, resolveConfig({ user: 'jerry', backfill: false }))
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

test('the browser route serves the current cycle as JSON', async () => {
  const home = tempHome()
  process.env.DSH_HOME = home
  const webServer = fakeWebServer()
  const ctx = createFakeContext({ services: { webServer } })
  apply(ctx, resolveConfig({ user: 'jerry', backfill: false }))

  assert.equal(webServer.routes.length, 2)
  assert.deepEqual(webServer.routes.map((entry) => entry.path).sort(), ['/api/token-split/summary', '/token-split/summary'])
  const route = webServer.routes.find((entry) => entry.path === SUMMARY_ROUTE)
  assert.equal(route.kind, 'exact')

  ctx.emit('session/event', sessionStub({ id: 's1' }), messageEvent({ usage: usage({ input: 1_000_000, output: 1_000_000 }) }))

  // No query means the rolling window, not the calendar cycle.
  const defaulted = fakeResponse()
  route.handler({ method: 'GET', url: SUMMARY_ROUTE, socket: { remoteAddress: '127.0.0.1' } }, defaulted)
  const defaultBody = JSON.parse(defaulted.captured.body)
  assert.equal(defaultBody.window.period, 'last30')
  assert.equal(defaultBody.window.label.includes(' ~ '), true)

  const res = fakeResponse()
  route.handler({ method: 'GET', url: `${SUMMARY_ROUTE}?period=all`, socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.captured.status, 200)
  const body = JSON.parse(res.captured.body)
  assert.equal(body.ok, true)
  assert.equal(body.user, 'jerry')
  assert.deepEqual(body.providers, ['opencode-go'])
  assert.equal(body.totals.calls, 1)
  assert.equal(body.totals.cost, 0.75)
  assert.equal(body.models[0].label, 'DeepSeek V4.1 Flash')
  assert.equal(body.models[0].limit, 100)
  assert.equal(body.window.label, '全部历史')
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
  apply(ctx, resolveConfig({ user: 'jerry', backfill: true }))
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
  apply(again, resolveConfig({ user: 'jerry', backfill: true }))
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
  apply(ctx, resolveConfig({ user: 'jerry', backfill: true }))
  await settle(300)
  assert.equal(ctx.warnings.some((line) => line.includes('cannot read session log')), true)
  assert.equal(ctx.registered.length, 1)
  ctx.disposeAll()
})

