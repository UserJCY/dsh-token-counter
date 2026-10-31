/**
 * Preloaded by `node --import ./test/register.mjs` so every test file resolves
 * `@deepseek-ai/*` against the installed DSH profile.
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./resolve-hook.mjs', pathToFileURL(`${import.meta.dirname}/`))
