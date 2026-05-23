#!/usr/bin/env node
// Manual e2e verification of #2 (filter imports) + #3 (group overloads)
// against the live W:\ codegraph index. Run after `npm run build`.
//
// This is an integration smoke test for environments where the synthetic-fixture
// tests in search-filter-imports.test.ts can't run (Windows node:sqlite lacks
// FTS5 in the npm built-in; better-sqlite3 native binding required for those).
//
// Usage:
//   node __tests__/verify-against-live-index.mjs
// Exit code 0 = all assertions pass.

import { CodeGraph } from '../dist/index.js';
import { ToolHandler } from '../dist/mcp/tools.js';

const PROJECT = 'W:\\';
let failed = 0;
let tests = 0;

function assert(name, cond, detail) {
  tests++;
  if (cond) {
    console.log(`[${tests}] OK   ${name}`);
  } else {
    console.log(`[${tests}] FAIL ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function run() {
  const cg = CodeGraph.openSync(PROJECT);
  const h = new ToolHandler(cg);

  // ---- #2: import filtering ----
  // ErrorInformado: module + many import nodes in the live index.
  let r = await h.handleSearch({ query: 'ErrorInformado', limit: 5 });
  let text = r.content?.[0]?.text ?? '';
  assert(
    'default search for ErrorInformado does NOT include (import) nodes',
    !text.includes('(import)'),
    'output contained (import) — filtering broken'
  );
  assert(
    'default search for ErrorInformado returns at least the module/class',
    text.includes('ErrorInformado'),
  );

  r = await h.handleSearch({ query: 'ErrorInformado', limit: 5, includeImports: true });
  text = r.content?.[0]?.text ?? '';
  assert(
    'includeImports:true brings (import) nodes back',
    text.includes('(import)'),
    'output had no (import) nodes — opt-in flag not working'
  );

  // ---- #3: overload grouping ----
  // CrearQuery has 4 overloads in VCL/DBdata/TableMax.Query.pas.
  r = await h.handleSearch({ query: 'CrearQuery', limit: 10 });
  text = r.content?.[0]?.text ?? '';
  assert(
    'CrearQuery overloads collapse into a "— N overloads" group',
    /CrearQuery \(function\) — \d+ overloads/.test(text),
    'no grouped overload header found'
  );

  r = await h.handleSearch({ query: 'CrearQuery', limit: 10, groupOverloads: false });
  text = r.content?.[0]?.text ?? '';
  assert(
    'groupOverloads:false returns flat per-signature entries',
    !/— \d+ overloads/.test(text),
    'flat mode still showed grouping header'
  );
  const flat = (text.match(/### CrearQuery \(function\)/g) ?? []).length;
  assert(
    'flat mode shows multiple separate CrearQuery entries',
    flat >= 2,
    `only ${flat} flat entries`
  );

  // ---- Sanity: limit applies to groups, not raw rows ----
  r = await h.handleSearch({ query: 'CrearQuery', limit: 2 });
  text = r.content?.[0]?.text ?? '';
  const groupCount = (text.match(/^### /gm) ?? []).length;
  assert(
    'limit:2 returns at most 2 groups (not 2 of N overloads)',
    groupCount <= 2,
    `got ${groupCount} groups`
  );

  console.log('');
  console.log('=============================================================');
  if (failed === 0) {
    console.log(`ALL ${tests} ASSERTIONS PASSED`);
    process.exit(0);
  } else {
    console.log(`${failed} of ${tests} FAILED`);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
