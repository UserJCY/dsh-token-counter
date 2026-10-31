/**
 * Test-only module resolution.
 *
 * The plugin is installed into a DSH profile, where `@deepseek-ai/*` packages
 * are hoisted beside it and resolve normally. In this checkout they are not,
 * so the test run redirects those bare specifiers at the profile's module root
 * instead of duplicating the packages (or their transitive dependencies) here.
 *
 * Override the root with `DSH_PROFILE_MODULES` when testing against another
 * installation.
 */
import { pathToFileURL } from 'node:url'

const MODULES_ROOT = process.env.DSH_PROFILE_MODULES
  ?? 'C:/Users/Jerry/.dsh/profiles/node_modules/'

/** A parent URL inside the module root: Node resolves bare specifiers by walking up from it. */
const PARENT_URL = pathToFileURL(`${MODULES_ROOT.replace(/\/?$/, '/')}__dsh_test_parent__.js`).href

/**
 * Redirect `@deepseek-ai/*` imports to the profile's hoisted modules, plus the
 * React packages the browser-half test renders with.
 * @param {string} specifier - requested specifier.
 * @param {object} context - Node resolve context.
 * @param {(specifier: string, context: object) => Promise<object>} next - default resolver.
 * @returns {Promise<object>} the resolution.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') || specifier === 'react' || specifier === 'react-dom' || specifier.startsWith('react-dom/') || specifier.startsWith('react/')) {
    return next(specifier, { ...context, parentURL: PARENT_URL })
  }
  return next(specifier, context)
}
