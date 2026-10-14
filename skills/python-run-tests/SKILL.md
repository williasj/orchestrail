---
name: python-run-tests
version: 1.1.2
status: stable
description: >
  Verify a Python implementation by executing it: run unittest test cases against the code, confirm it produces the expected output across normal and edge cases, and return deterministic pass and fail counts. Use after writing or implementing a function to demonstrate it works and validate correctness against the spec, instead of judging the code by eye.
language: python
entrypoint: skill.py
input_mode: entrypoint
input_contract: object with code and test_code strings; test_code defines a unittest.TestCase
output_contract: >
  {"ok": bool, "ran": int, "passed": int, "failed": int, "errored": int, "error": str or null}
tags: [validator, python, testing, unittest]
author: human
author_type: human
confidence: 0.9
invocation_count: 14
success_count: 14
self_test_passed: true
created_at: 2026-06-04T20:18:53.560Z
last_updated: 2026-06-12T06:00:00.000Z
content_hash: 
---

# python-run-tests

Executes implementation source, then loads and runs any `unittest.TestCase` defined in
`test_code` against it in the same namespace. Returns counts only (deterministic);
failure detail is intentionally omitted so results are stable across runs.
Counts are per test METHOD (a self.subTest loop is one test), so passed is always coherent.

## Input
```
{ "code": "def add(a,b):\n    return a+b\n",
  "test_code": "import unittest\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2,3),5)\n" }
```

## Output
`{ "ok": true, "ran": 2, "passed": 2, "failed": 0, "errored": 0, "error": null }`.
`ok` is true only when at least one test ran and none failed or errored. If the impl or
test_code itself raises on load, `ok` is false and `error` names the cause.

## When to use
This is the deterministic verification path: prefer it over asserting "the code looks
correct." A reviewer should run the spec's tests through this rather than eyeballing.
