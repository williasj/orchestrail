// deliver.check.mjs - verifies the deliver tool's store helpers and MIME mapping.
// Follows the check.mjs pattern: standalone assertion script, no test framework.
// Run after a build:  npm run build && node deliver.check.mjs
//
// Tests: (1) convToken sanitization, (2) store dir construction,
// (3) MIME mapping, (4) extension allowlist.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const TOOLS  = process.env.TOOLS_MODULE  || path.join(here, 'dist', 'core', 'tools.js')
const CONFIG = process.env.CONFIG_MODULE || path.join(here, 'dist', 'utils', 'config.js')

const { deliverableConvToken, deliverableStoreDir, DELIVER_MIME, DELIVER_EXTENSIONS } =
  await import(pathToFileURL(TOOLS).href)
const { DATA_DIR } = await import(pathToFileURL(CONFIG).href)

let fail = 0
function ok(cond, label, extra) {
  if (cond) { console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')) }
}

// -- convToken sanitization ------------------------------------------------------

console.log('deliverableConvToken:')
ok(deliverableConvToken('conv-abc123') === 'conv-abc123', 'normal id unchanged')
ok(deliverableConvToken('direct-a1b2c3d4') === 'direct-a1b2c3d4', 'direct-chat id unchanged')
ok(deliverableConvToken('conv/abc:123') === 'conv_abc_123', 'special chars replaced with underscore')
ok(deliverableConvToken('a'.repeat(100)).length === 64, 'over-long id truncated to 64')
ok(deliverableConvToken('') === '', 'empty string stays empty')
ok(deliverableConvToken('hello world') === 'hello_world', 'space replaced with underscore')
ok(deliverableConvToken('test@domain.com') === 'test_domain_com', 'dots and @ replaced')

// -- store dir construction ------------------------------------------------------

console.log('\ndeliverableStoreDir:')
const expected = path.join(DATA_DIR, 'deliverables', 'conv123')
ok(deliverableStoreDir('conv123') === expected, 'maps convToken under DATA_DIR/deliverables/', deliverableStoreDir('conv123'))
ok(deliverableStoreDir('direct-abc').includes('direct-abc'), 'direct-chat token preserved in path')

// -- MIME mapping ----------------------------------------------------------------

console.log('\nDELIVER_MIME:')
ok(DELIVER_MIME['.xlsx'] === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx MIME correct')
ok(DELIVER_MIME['.zip']  === 'application/zip', '.zip MIME correct')
ok(DELIVER_MIME['.pdf']  === 'application/pdf', '.pdf MIME correct')
ok(DELIVER_MIME['.png']  === 'image/png', '.png MIME correct')

// -- extension allowlist ---------------------------------------------------------

console.log('\nDELIVER_EXTENSIONS:')
ok(DELIVER_EXTENSIONS.has('.xlsx'), '.xlsx allowed')
ok(DELIVER_EXTENSIONS.has('.zip'),  '.zip allowed')
ok(DELIVER_EXTENSIONS.has('.pdf'),  '.pdf allowed')
ok(DELIVER_EXTENSIONS.has('.png'),  '.png allowed')
ok(!DELIVER_EXTENSIONS.has('.txt'), '.txt not allowed')
ok(!DELIVER_EXTENSIONS.has('.exe'), '.exe not allowed')
ok(!DELIVER_EXTENSIONS.has('.sh'),  '.sh not allowed')
ok(!DELIVER_EXTENSIONS.has(''),     'empty ext not allowed')

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exit(fail === 0 ? 0 : 1)
