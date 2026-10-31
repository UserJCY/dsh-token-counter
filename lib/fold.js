/**
 * Pure folding of session events into billable usage samples.
 *
 * One sample per `(sessionId, turn, step)`. The provider reports usage twice:
 * an early `assistant/chunk { type: 'usage' }` sample that survives a request
 * that later fails, and the authoritative `assistant/message.usage` of the
 * assembled step. Precedence therefore is:
 *
 *   - a finalized sample is never replaced;
 *   - a partial sample is replaced by any later sample of the same step
 *     (usage chunks are cumulative snapshots, so last wins).
 *
 * Nothing here touches the filesystem, the clock, or a Cordis context, which
 * is what lets the same fold serve live events and historical backfill.
 *
 * @module dsh-token-split/fold
 */

/** Usage bucket fields a sample always carries, all non-negative integers. */
const BUCKETS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']

/**
 * Stable identity of one billable step. Session ids never contain `#`.
 * @param {string} sessionId - owning session.
 * @param {number} turn - turn index inside that session.
 * @param {number} step - step index inside that turn.
 * @returns {string} the ledger key.
 */
export function usageKey(sessionId, turn, step) {
  return `${sessionId}#${turn}#${step}`
}

/** Coerce a provider number to a finite non-negative integer. */
function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * Read the five buckets off a provider `TokenUsage` value.
 * Reasoning is a subset of output, so it is recorded but never added to the
 * billable total.
 * @param {object | undefined} usage - provider usage payload.
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number }} buckets.
 */
export function bucketsOf(usage) {
  const source = usage && typeof usage === 'object' ? usage : {}
  return {
    input: count(source.inputTokens),
    output: count(source.outputTokens),
    cacheRead: count(source.cacheReadTokens),
    cacheWrite: count(source.cacheWriteTokens),
    reasoning: count(source.reasoningTokens),
  }
}

/**
 * The billable token total of one sample: disjoint provider buckets, with
 * reasoning excluded because it is already part of `output`.
 * @param {{ input: number, output: number, cacheRead: number, cacheWrite: number }} sample - buckets.
 * @returns {number} summed tokens.
 */
export function billableTokens(sample) {
  return sample.input + sample.output + sample.cacheRead + sample.cacheWrite
}

/**
 * Extract the usage sample an event carries, if any.
 * @param {string} sessionId - owning session.
 * @param {{ type: string, time?: number, data?: object }} event - one session event.
 * @param {{ provider?: string, model?: string }} route - most recent `request/context` route.
 * @returns {object | undefined} a sample, or undefined when the event bills nothing.
 */
export function sampleFromEvent(sessionId, event, route) {
  const data = event && event.data
  if (!data || typeof data !== 'object') return undefined
  if (event.type === 'assistant/message') {
    if (!data.usage) return undefined
    const source = data.message && data.message.source ? data.message.source : {}
    return {
      key: usageKey(sessionId, data.turn, data.step),
      sessionId,
      turn: data.turn,
      step: data.step,
      at: event.time ?? Date.now(),
      provider: source.provider ?? '',
      model: source.model ?? '',
      final: true,
      ...bucketsOf(data.usage),
    }
  }
  if (event.type === 'assistant/chunk' && data.chunk && data.chunk.type === 'usage') {
    return {
      key: usageKey(sessionId, data.turn, data.step),
      sessionId,
      turn: data.turn,
      step: data.step,
      at: event.time ?? Date.now(),
      provider: (route && route.provider) ?? '',
      model: (route && route.model) ?? '',
      final: false,
      ...bucketsOf(data.chunk.usage),
    }
  }
  return undefined
}

/**
 * Whether a new sample should replace the one already recorded for its step.
 * @param {object | undefined} previous - recorded sample.
 * @param {object} next - candidate sample.
 * @returns {boolean} true when `next` wins.
 */
export function shouldReplace(previous, next) {
  if (!previous) return true
  if (previous.final) return false
  // A partial sample is only a lower bound; any later observation of the same
  // step — another chunk or the assembled message — supersedes it.
  return next.final === true || next.final === false
}

/**
 * Fold one session log into its usage samples plus the metadata the ledger
 * keeps beside them.
 * @param {object} input - fold input.
 * @param {string} input.sessionId - owning session.
 * @param {readonly object[]} input.events - session events in log order.
 * @param {string} input.user - attribution label recorded on every sample.
 * @param {boolean} [input.includeSubagents] - keep delegation sessions (default true).
 * @param {number} [input.delegationDepth] - session depth; > 0 means a subagent.
 * @returns {{ records: object[], title: string | undefined, firstAt: number | undefined, lastAt: number | undefined }} folded log.
 */
export function foldSessionEvents({ sessionId, events, user, includeSubagents = true, delegationDepth = 0 }) {
  const records = new Map()
  const route = { provider: '', model: '' }
  let title
  let firstAt
  let lastAt

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (typeof event.time === 'number') {
      if (firstAt === undefined || event.time < firstAt) firstAt = event.time
      if (lastAt === undefined || event.time > lastAt) lastAt = event.time
    }
    if (event.type === 'request/context' && event.data) {
      route.provider = event.data.provider ?? ''
      route.model = event.data.model ?? ''
      continue
    }
    if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      title = event.data.title
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/chunk') continue
    const sample = sampleFromEvent(sessionId, event, route)
    if (!sample) continue
    const previous = records.get(sample.key)
    if (!shouldReplace(previous, sample)) continue
    records.set(sample.key, { ...sample, user })
  }

  const kept = includeSubagents || delegationDepth <= 0 ? [...records.values()] : []
  return { records: kept, title, firstAt, lastAt }
}

/**
 * The five bucket names, exported for report code that sums samples.
 * @type {readonly string[]}
 */
export const BUCKET_NAMES = BUCKETS
