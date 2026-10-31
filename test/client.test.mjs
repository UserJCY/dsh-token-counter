import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** The bundle the module loader received. */
let bundle

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      bundle = definition
    },
  },
}

await import('../lib/client.js')

/** Materialize the browser half the way the module loader does. */
function materialize() {
  const required = []
  const exports = bundle.factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  })
  return { exports, required }
}

/** A fake client `slots` service. */
function fakeSlots() {
  const registrations = []
  return {
    registrations,
    inject(name, callback) {
      registrations.push({ injected: name })
      callback()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  }
}

/** A summary payload shaped like the host route's response. */
function summaryData() {
  return {
    ok: true,
    user: 'jerry',
    providers: ['opencode-go'],
    plan: 'go',
    monthlyFee: 10,
    cycleStartDay: 1,
    fxRate: 0,
    window: { label: '2026-10-01 ~ 2026-10-31', start: 0, end: 1, period: 'cycle' },
    totals: { calls: 24, tokens: 6_766_146, cost: 1.2345, sessions: 2, unpricedCalls: 0 },
    models: [
      { model: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', calls: 24, tokens: 6_766_146, cost: 1.2345, share: 1, costShare: 1, limit: 100, priced: true },
    ],
    days: [],
  }
}

test('the bundle registers a lazy-CJS factory under its package id', () => {
  assert.equal(bundle.id, 'dsh-token-split')
  assert.equal(typeof bundle.factory, 'function')
})

test('the factory requires only react and exports apply/inject', () => {
  const { exports, required } = materialize()
  assert.deepEqual(required, ['react'])
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('apply registers one sidebar footer action', () => {
  const { exports } = materialize()
  const slots = fakeSlots()
  exports.apply({ slots })
  const injected = slots.registrations.find((entry) => entry.injected !== undefined)
  assert.equal(injected.injected, 'sidebar.footer.action')
  const registration = slots.registrations.find((entry) => entry.options !== undefined)
  assert.equal(registration.options.name, 'sidebar.footer.action')
  assert.equal(registration.options.id, 'token-split')
  assert.equal(typeof registration.Component, 'function')
})

test('the closed trigger renders a compact chip without fetching', () => {
  const { exports } = materialize()
  const html = renderToStaticMarkup(React.createElement(exports.TokenSplitAction, { wide: true }))
  assert.match(html, /dts-trigger/)
  assert.match(html, /用量/)
  assert.doesNotMatch(html, /dts-panel/)
})

test('the collapsed trigger drops the label', () => {
  const { exports } = materialize()
  const html = renderToStaticMarkup(React.createElement(exports.TokenSplitAction, { wide: false }))
  assert.match(html, /dts-trigger-dot/)
  assert.doesNotMatch(html, />用量</)
})

test('the panel renders the cycle cost and the model rows, without a split form', () => {
  const { exports } = materialize()
  const html = renderToStaticMarkup(
    React.createElement(exports.PanelBody, {
      summary: { status: 'ready', data: summaryData(), error: null },
      onRefresh: () => {},
      refreshing: false,
    }),
  )
  assert.match(html, /\$1\.23/)
  assert.match(html, /DeepSeek V4\.1 Flash/)
  assert.match(html, /6,766,146 tokens/)
  assert.match(html, /opencode-go/)
  assert.doesNotMatch(html, /分摊/)
  assert.doesNotMatch(html, /朋友用量/)
})

test('the panel shows an error state with a retry action', () => {
  const { exports } = materialize()
  const html = renderToStaticMarkup(
    React.createElement(exports.PanelBody, {
      summary: { status: 'error', data: null, error: '统计服务未就绪' },
      onRefresh: () => {},
      refreshing: false,
    }),
  )
  assert.match(html, /统计服务未就绪/)
  assert.match(html, /重试/)
})

test('the panel reports unpriced calls instead of hiding them', () => {
  const { exports } = materialize()
  const data = summaryData()
  data.totals.unpricedCalls = 3
  data.models[0].priced = false
  const html = renderToStaticMarkup(
    React.createElement(exports.PanelBody, {
      summary: { status: 'ready', data, error: null },
      onRefresh: () => {},
      refreshing: false,
    }),
  )
  assert.match(html, /未匹配价目表/)
})

