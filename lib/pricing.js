/**
 * OpenCode Go pricing.
 *
 * Prices come from the public Go documentation
 * (`https://opencode.ai/docs/go/` → "Usage limits"), in USD per 1M tokens.
 * A Go plan's monthly allowance is denominated in dollars per model, and the
 * same table decides how a request consumes it, so the dollar figure is the
 * fair basis for splitting a subscription — not the raw token count.
 *
 * DeepSeek V4.1 Flash and V4 Pro are the two models with peak/off-peak
 * pricing: peak is 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; every
 * other hour, including the whole weekend, is off-peak.
 *
 * Models whose price depends on context length (Grok 4.7 > 200K, Qwen3.7
 * Plus > 256K, GPT Luna > 272K, Claude Haiku > 100K, MiniMax M3 > 512K) use
 * their base tier here, because a usage sample records buckets but not the
 * context size that produced them.
 *
 * Anything can be corrected without touching code: drop a `pricing.json`
 * into the plugin's data directory (or point `pricingFile` at one) and its
 * entries merge over the built-in table.
 *
 * @module dsh-token-split/pricing
 */
import fs from 'node:fs'
import path from 'node:path'

/** Monthly plan prices, USD. */
export const PLANS = { go: 10, plus: 40, teams: 20 }

/** The peak window, in UTC hours, Monday–Friday. */
export const PEAK_HOURS = [
  [1, 4],
  [6, 10],
]

/**
 * One model's price row.
 * @typedef {object} PriceRow
 * @property {string} id - provider model id.
 * @property {string} label - display name.
 * @property {number} input - USD per 1M uncached input tokens.
 * @property {number} output - USD per 1M output tokens.
 * @property {number} cacheRead - USD per 1M cached input tokens.
 * @property {number} cacheWrite - USD per 1M cache-write tokens (0 when the model has none).
 * @property {number} monthlyLimit - monthly allowance in USD for the Go plan (`Infinity` for free models).
 * @property {PriceRow | undefined} [peak] - the peak-hour variant, when the model has one.
 */

/** @type {PriceRow[]} */
export const MODEL_PRICING = [
  { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'glm-5.3', label: 'GLM-5.3', input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0, monthlyLimit: 15 },
  { id: 'glm-5.2', label: 'GLM-5.2', input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2, monthlyLimit: 15 },
  { id: 'kimi-k3', label: 'Kimi K3', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3, monthlyLimit: 15 },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'longcat-2.0', label: 'LongCat-2.0', input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'step-5-preview', label: 'Step 5 Preview', input: 1, output: 2.7, cacheRead: 0.1, cacheWrite: 0, monthlyLimit: 15 },
  { id: 'beam-free', label: 'Beam Free', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, monthlyLimit: Infinity },
  { id: 'iceman-contributor-free', label: 'Iceman Contributor Free', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, monthlyLimit: Infinity },
  { id: 'mimo-v2.6-flash', label: 'MiMo-V2.6-Flash', input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'mimo-v2.6-pro', label: 'MiMo-V2.6-Pro', input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0, monthlyLimit: 15 },
  { id: 'mimo-v2.5', label: 'MiMo-V2.5', input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'mimo-v2.5-pro', label: 'MiMo-V2.5-Pro', input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0, monthlyLimit: 15 },
  { id: 'minimax-m3.1-flash', label: 'MiniMax M3.1 Flash', input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0, monthlyLimit: 20 },
  { id: 'minimax-m3', label: 'MiniMax M3', input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3 Contributor', input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'muse-spark-1.2-contributor', label: 'Muse Spark 1.2 Contributor', input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max', input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5, monthlyLimit: 15 },
  { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2, monthlyLimit: 30 },
  { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5, monthlyLimit: 60 },
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    cacheWrite: 0,
    monthlyLimit: 100,
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022,
    cacheWrite: 0,
    monthlyLimit: 15,
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  },
  { id: 'hy4-preview', label: 'Hy4 preview', input: 0.834, output: 2.501, cacheRead: 0.042, cacheWrite: 0, monthlyLimit: 30 },
  { id: 'hy3', label: 'Hy3', input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0, monthlyLimit: 60 },
  { id: 'grok-4.7', label: 'Grok 4.7', input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, monthlyLimit: 15 },
  { id: 'gpt-6-luna', label: 'GPT 6 Luna', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, monthlyLimit: 15 },
  { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, monthlyLimit: 15 },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, monthlyLimit: 15 },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0, monthlyLimit: 30 },
]

/**
 * Model ids that are really another row: older route names, or ids carrying a
 * build suffix. Overridable in `pricing.json`.
 * @type {Record<string, string>}
 */
export const MODEL_ALIASES = {
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash',
  'deepseek-v4-flash': 'deepseek-v4.1-flash',
  'deepseek-v4-pro-1017': 'deepseek-v4-pro',
}

/**
 * Whether an instant falls inside the DeepSeek peak window.
 * @param {number} at - epoch milliseconds.
 * @returns {boolean} true for peak pricing.
 */
export function isPeak(at) {
  const date = new Date(at)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours()
  return PEAK_HOURS.some(([from, to]) => hour >= from && hour < to)
}

/**
 * Cost of one usage sample in USD.
 * @param {object} sample - usage sample with `input`, `output`, `cacheRead`, `cacheWrite`, `at`.
 * @param {PriceRow} row - the resolved price row (already the peak variant when applicable).
 * @returns {number} USD.
 */
export function costWithRow(sample, row) {
  return (
    (sample.input * row.input +
      sample.output * row.output +
      sample.cacheRead * row.cacheRead +
      sample.cacheWrite * row.cacheWrite) /
    1e6
  )
}

/**
 * A resolved price table: built-ins, aliases, and any user overrides merged in.
 */
export class PriceTable {
  /**
   * @param {object} [input] - table input.
   * @param {readonly PriceRow[]} [input.models] - rows; later rows win by id.
   * @param {Record<string, string>} [input.aliases] - model id → row id.
   */
  constructor({ models = MODEL_PRICING, aliases = MODEL_ALIASES } = {}) {
    /** @type {Map<string, PriceRow>} */
    this.rows = new Map()
    for (const row of models) this.rows.set(row.id, row)
    this.aliases = { ...aliases }
    this.ids = [...this.rows.keys()].sort((a, b) => b.length - a.length)
  }

  /**
   * Resolve a model id to its price row, following aliases, a build suffix,
   * and finally the longest row id that prefixes it.
   * @param {string} modelId - provider model id.
   * @returns {{ row: PriceRow, matchedId: string, viaAlias: boolean } | undefined} the match.
   */
  resolve(modelId) {
    const id = String(modelId ?? '').trim()
    if (id.length === 0) return undefined
    if (this.rows.has(id)) return { row: this.rows.get(id), matchedId: id, viaAlias: false }
    const alias = this.aliases[id]
    if (alias !== undefined && this.rows.has(alias)) return { row: this.rows.get(alias), matchedId: alias, viaAlias: true }
    const stripped = id.replace(/-\d{3,}$/, '')
    if (stripped !== id && this.rows.has(stripped)) return { row: this.rows.get(stripped), matchedId: stripped, viaAlias: true }
    for (const candidate of this.ids) {
      if (id.startsWith(candidate)) return { row: this.rows.get(candidate), matchedId: candidate, viaAlias: true }
    }
    return undefined
  }

  /**
   * Cost of one sample, applying the peak variant when the row has one.
   * @param {object} sample - usage sample.
   * @returns {{ usd: number, matchedId: string | undefined, row: PriceRow | undefined, peak: boolean }} priced sample.
   */
  price(sample) {
    const match = this.resolve(sample.model)
    if (match === undefined) return { usd: 0, matchedId: undefined, row: undefined, peak: false }
    const peak = match.row.peak !== undefined && isPeak(sample.at)
    const row = peak ? match.row.peak : match.row
    return { usd: costWithRow(sample, row), matchedId: match.matchedId, row: match.row, peak }
  }

  /** Display label for a model id, falling back to the raw id. */
  labelOf(modelId) {
    const match = this.resolve(modelId)
    return match === undefined ? String(modelId) : match.row.label
  }

  /** Monthly allowance in USD for a model id, when known. */
  limitOf(modelId) {
    const match = this.resolve(modelId)
    return match === undefined ? undefined : match.row.monthlyLimit
  }
}

/**
 * Read user overrides from a JSON file.
 * Shape: `{ "models": { "<id>": { ...PriceRow fields } }, "aliases": { "<id>": "<row id>" } }`.
 * @param {string} file - absolute path.
 * @returns {{ models: PriceRow[], aliases: Record<string, string> } | undefined} overrides, or undefined when absent/unreadable.
 */
export function readPriceOverrides(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return undefined
  }
  const parsed = JSON.parse(text)
  const models = []
  if (parsed && typeof parsed.models === 'object' && parsed.models !== null) {
    for (const [id, value] of Object.entries(parsed.models)) {
      if (!value || typeof value !== 'object') continue
      models.push({ id, label: value.label ?? id, ...value })
    }
  }
  const aliases = parsed && typeof parsed.aliases === 'object' && parsed.aliases !== null ? parsed.aliases : {}
  return { models, aliases }
}

/**
 * Build the effective table: built-ins, then the data-directory override file,
 * then the configured file.
 * @param {object} [options] - loading options.
 * @param {string} [options.dataDir] - plugin data directory.
 * @param {string} [options.file] - explicit override path.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 * @returns {PriceTable} the table.
 */
export function loadPriceTable({ dataDir, file, warn = () => {} } = {}) {
  const candidates = [dataDir === undefined ? undefined : path.join(dataDir, 'pricing.json'), file].filter(
    (candidate) => typeof candidate === 'string' && candidate.length > 0,
  )
  let models = [...MODEL_PRICING]
  let aliases = { ...MODEL_ALIASES }
  for (const candidate of candidates) {
    let overrides
    try {
      overrides = readPriceOverrides(candidate)
    } catch (error) {
      warn(`token-split: cannot read pricing overrides at ${candidate}: ${String(error)}`)
      continue
    }
    if (overrides === undefined) continue
    const byId = new Map(models.map((row) => [row.id, row]))
    for (const row of overrides.models) byId.set(row.id, { ...byId.get(row.id), ...row })
    models = [...byId.values()]
    aliases = { ...aliases, ...overrides.aliases }
  }
  return new PriceTable({ models, aliases })
}
