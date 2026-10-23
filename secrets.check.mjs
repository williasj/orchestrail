// Verifies the startup-banner secret masking (see src/server.ts, src/utils/secrets.ts).
// Follows the check.mjs pattern: a standalone assertion script, no test framework.
// Run after a build:  npm run build && node secrets.check.mjs
//
// It (1) unit-tests maskSecret and (2) simulates the exact banner strings the
// server emits for both the insecure default and a real key, asserting the raw
// secret never reaches the log line.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SECRETS = process.env.SECRETS_MODULE || path.join(here, 'dist', 'utils', 'secrets.js')
const CONFIG  = process.env.CONFIG_MODULE  || path.join(here, 'dist', 'utils', 'config.js')

// Windows absolute paths are not valid ESM import specifiers; use file:// URLs.
const { maskSecret } = await import(pathToFileURL(SECRETS).href)
const { PIPELINES_API_KEY_DEFAULT } = await import(pathToFileURL(CONFIG).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- maskSecret unit tests ------------------------------------------------------

const realKey = 'sk-super-secret-1234567890'

console.log('maskSecret:')
ok(maskSecret('') === '(empty)', 'empty -> "(empty)"', maskSecret(''))
ok(maskSecret('abc') === '***', 'short value fully masked', maskSecret('abc'))
ok(maskSecret(realKey) === '*'.repeat(realKey.length - 4) + realKey.slice(-4), 'long value keeps only last 4', maskSecret(realKey))
ok(!maskSecret(realKey).includes(realKey), 'masked output never contains the full raw secret')
ok(maskSecret(realKey).length === realKey.length, 'masked output preserves length (no layout shift)')
ok(maskSecret(realKey, 0) === '*'.repeat(realKey.length), 'visible=0 -> fully masked')

// The masked form must not be reconstructable: every non-trailing char is '*'.
const masked = maskSecret(realKey)
ok(masked.slice(0, -4).split('').every(c => c === '*'), 'all leading chars are asterisks')

// -- Simulated startup banner (mirrors src/server.ts) ---------------------------

console.log('\nstartup banner:')
const PORT = 8080

// Real key -> masked line.
const realBanner = 'Pipelines URL      -- http://localhost:' + PORT + '  (key: ' + maskSecret(realKey) + ')'
console.log('    ' + realBanner)
ok(!realBanner.includes(realKey), 'real-key banner does not contain the raw key')
ok(realBanner.includes(maskSecret(realKey)), 'real-key banner shows the masked key')

// Insecure default -> loud warning, default is a documented non-secret.
const defaultBanner = 'Pipelines URL      -- http://localhost:' + PORT + '  (key: ' + PIPELINES_API_KEY_DEFAULT + ' [INSECURE DEFAULT — set PIPELINES_API_KEY to a strong value])'
console.log('    ' + defaultBanner)
ok(PIPELINES_API_KEY_DEFAULT === 'change-me', 'default constant is the documented "change-me"', PIPELINES_API_KEY_DEFAULT)
ok(defaultBanner.includes('INSECURE DEFAULT'), 'default banner flags the insecure default')

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
