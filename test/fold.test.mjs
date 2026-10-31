import assert from 'node:assert/strict'
import test from 'node:test'
import { foldSessionEvents, sampleFromEvent, shouldReplace, billableTokens, usageKey } from '../lib/fold.js'
import { chunkEvent, contextEvent, messageEvent, titleEvent, usage } from './helpers.mjs'

test('sampleFromEvent reads a finalized assistant message', () => {
  const sample = sampleFromEvent('s1', messageEvent({ turn: 2, step: 3, usage: usage({ input: 10, output: 5, cacheRead: 7, cacheWrite: 2, reasoning: 1 }) }))
  assert.equal(sample.key, usageKey('s1', 2, 3))
  assert.equal(sample.final, true)
  assert.equal(sample.provider, 'opencode-go')
  assert.equal(sample.model, 'deepseek-v4.1-flash')
  assert.deepEqual(
    { input: sample.input, output: sample.output, cacheRead: sample.cacheRead, cacheWrite: sample.cacheWrite, reasoning: sample.reasoning },
    { input: 10, output: 5, cacheRead: 7, cacheWrite: 2, reasoning: 1 },
  )
})

test('sampleFromEvent ignores a message without provider usage', () => {
  const event = messageEvent()
  delete event.data.usage
  assert.equal(sampleFromEvent('s1', event), undefined)
})

test('sampleFromEvent labels a usage chunk from the latest route', () => {
  const sample = sampleFromEvent('s1', chunkEvent({ turn: 1, step: 1 }), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.equal(sample.final, false)
  assert.equal(sample.model, 'deepseek-v4.1-flash')
})

test('sampleFromEvent treats non-usage chunks and other events as unbilled', () => {
  assert.equal(sampleFromEvent('s1', { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text', text: 'hi' } } }), undefined)
  assert.equal(sampleFromEvent('s1', { type: 'turn/start', data: { turn: 1 } }), undefined)
  assert.equal(sampleFromEvent('s1', undefined), undefined)
})

test('billableTokens sums disjoint buckets and excludes reasoning', () => {
  assert.equal(billableTokens({ input: 100, output: 20, cacheRead: 300, cacheWrite: 4, reasoning: 15 }), 424)
})

test('shouldReplace keeps a finalized sample and lets a later observation win otherwise', () => {
  assert.equal(shouldReplace(undefined, { final: false }), true)
  assert.equal(shouldReplace({ final: false }, { final: false }), true)
  assert.equal(shouldReplace({ final: false }, { final: true }), true)
  assert.equal(shouldReplace({ final: true }, { final: false }), false)
  assert.equal(shouldReplace({ final: true }, { final: true }), false)
})

test('foldSessionEvents lets the finalized message replace an earlier usage chunk', () => {
  const result = foldSessionEvents({
    sessionId: 's1',
    user: 'jerry',
    events: [
      contextEvent(),
      chunkEvent({ usage: usage({ input: 500, output: 10 }) }),
      messageEvent({ usage: usage({ input: 100, output: 20, cacheRead: 40 }) }),
    ],
  })
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].final, true)
  assert.equal(result.records[0].input, 100)
  assert.equal(result.records[0].cacheRead, 40)
  assert.equal(result.records[0].user, 'jerry')
})

test('foldSessionEvents keeps the last of several usage chunks when no message follows', () => {
  const result = foldSessionEvents({
    sessionId: 's1',
    user: 'jerry',
    events: [chunkEvent({ usage: usage({ input: 100 }) }), chunkEvent({ usage: usage({ input: 400, output: 50 }) })],
  })
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].final, false)
  assert.equal(result.records[0].input, 400)
})

test('foldSessionEvents never lets a late chunk overwrite a finalized step', () => {
  const result = foldSessionEvents({
    sessionId: 's1',
    user: 'jerry',
    events: [messageEvent({ usage: usage({ input: 100 }) }), chunkEvent({ usage: usage({ input: 999 }) })],
  })
  assert.equal(result.records[0].input, 100)
})

test('foldSessionEvents bills each turn and step once', () => {
  const result = foldSessionEvents({
    sessionId: 's1',
    user: 'jerry',
    events: [
      messageEvent({ turn: 1, step: 1 }),
      messageEvent({ turn: 1, step: 2 }),
      messageEvent({ turn: 2, step: 1 }),
    ],
  })
  assert.equal(result.records.length, 3)
  assert.deepEqual(result.records.map((record) => record.key).sort(), ['s1#1#1', 's1#1#2', 's1#2#1'])
})

test('foldSessionEvents drops a delegation session when subagents are excluded', () => {
  const events = [messageEvent()]
  const included = foldSessionEvents({ sessionId: 's1', user: 'jerry', events, delegationDepth: 1, includeSubagents: true })
  const excluded = foldSessionEvents({ sessionId: 's1', user: 'jerry', events, delegationDepth: 1, includeSubagents: false })
  assert.equal(included.records.length, 1)
  assert.equal(excluded.records.length, 0)
})

test('foldSessionEvents reports the title and the event time span', () => {
  const result = foldSessionEvents({
    sessionId: 's1',
    user: 'jerry',
    events: [contextEvent({ time: 1000 }), titleEvent('重构账单', 2000), messageEvent({ time: 3000 })],
  })
  assert.equal(result.title, '重构账单')
  assert.equal(result.firstAt, 1000)
  assert.equal(result.lastAt, 3000)
})
