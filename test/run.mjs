/**
 * One-process test entry point.
 *
 * `node --test test/` spawns a child per file, which a confined host may
 * refuse (`spawn EPERM`). Importing the files here runs the same suite in the
 * current process, with `test/register.mjs` supplying the module resolution.
 *
 *   node --import ./test/register.mjs test/run.mjs
 */
import './fold.test.mjs'
import './ledger.test.mjs'
import './pricing.test.mjs'
import './report.test.mjs'
import './plugin.test.mjs'
import './client.test.mjs'
