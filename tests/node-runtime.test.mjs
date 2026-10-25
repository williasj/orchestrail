// Orchestrail must build and run on a supported Node.js line (22 LTS or newer).
// Node 20 reached end of life on 2026-04-30 and gets no security fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the build runs on Node 22 or newer', () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'running ' + process.version);
});

test('the main image is based on node:22', () => {
  const from = read('Dockerfile').split('\n').find((l) => /^FROM\s/i.test(l));
  assert.match(from, /^FROM\s+node:22(-|\.|\s|$)/i);
});

test('the main image installs exactly what the lockfile pins', () => {
  const d = read('Dockerfile');
  assert.match(d, /COPY[^\n]*package-lock\.json/);
  assert.match(d, /RUN\s+npm\s+ci\b/);
  assert.doesNotMatch(d, /RUN\s+npm\s+install\b/);
});

test('orchestrail-exec installs Node 22', () => {
  const d = read('add_ons/orchestrail-exec/Dockerfile');
  assert.match(d, /setup_22\.x/);
  assert.doesNotMatch(d, /setup_20\.x/);
});

test('package.json requires Node 22 and its types match', () => {
  const p = JSON.parse(read('package.json'));
  assert.equal(p.engines && p.engines.node, '>=22');
  assert.match(p.devDependencies['@types/node'], /^\^22\./);
});
