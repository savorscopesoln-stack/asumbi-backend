/* =========================================================================
   TINY TEST HARNESS
   This project has no test framework installed and Phase 15 shouldn't be
   the phase that adds a heavyweight one just to print PASS/FAIL. This is
   ~40 lines wrapping node:assert.

   Usage per test file:
     const { suite, test, assert } = require("./helpers/tinytest");
     suite("myFile.test.js");
     test("does the thing", async () => { assert.strictEqual(1, 1); });
   Test files only REGISTER cases (test() collects the promise, it
   doesn't await it inline) — run-all.js awaits everything and prints one
   aggregated report, so ordering across files never matters and a slow
   test in one file can't block another's results from appearing.
========================================================================= */
const assert = require("assert");

let current = null;
const suites = [];

function suite(file) {
  current = { file, results: [] };
  suites.push(current);
}

function test(name, fn) {
  const entry = { name, pass: null, error: null };
  current.results.push(entry);
  // Not awaited here on purpose — see file header. summarize() awaits
  // every entry's promise before printing anything.
  entry.promise = Promise.resolve()
    .then(fn)
    .then(() => { entry.pass = true; })
    .catch((err) => { entry.pass = false; entry.error = err.message; });
}

async function summarize() {
  let total = 0, passed = 0;
  for (const s of suites) {
    console.log(`\n${s.file}`);
    for (const r of s.results) {
      await r.promise;
      total += 1;
      if (r.pass) { passed += 1; console.log(`  ✓ ${r.name}`); }
      else console.log(`  ✗ ${r.name}\n      ${r.error}`);
    }
  }
  console.log(`\n${passed}/${total} passed`);
  return passed === total;
}

module.exports = { assert, suite, test, summarize };
