# FIXES -- verification regression round

Diagnosed from tool-log conv-9bccd8f3 (fib_memo run that thrashed to max retries
and synthesized a "failed" report for correct code). The exec swap itself was
fine; these fix the verification contract on top of it.

## Fix 1 -- implementation slot materialized as a file (root cause)

Dropping the auto-prepend (decision b) removed the only thing that guaranteed the
implementation was present in the test namespace, and nothing replaced it with a
filesystem convention. Agents guessed filenames (main.py / fibonacci.py),
invented paths (/testbed, /home/user), and wrote tests doing
`from implementation import X` against a module that never existed ->
ModuleNotFoundError, verification never produced a trustworthy signal.

`src/core/tools.ts`: `workbench_write('implementation', ...)` now also writes
`implementation.<ext>` into the run's exec dir (`materializeImplementation`,
`implementationExt`). Because the skill harness and bash both run with cwd = the
run dir, `from implementation import <name>` -- the agents' dominant instinct --
now resolves in BOTH paths. The orchestrator mirrors the canonical verified slot
to a canonical filename; it authors nothing.

`src/core/agent.ts`: code-capable agents get an "Execution environment" prompt
block stating the convention (implementation.py is in your working directory;
import it; do not invent paths). Gated on the agent actually having bash/use_skill.

Verified: the exact `from implementation import fib_memo` pattern that threw
ModuleNotFoundError now returns ok via the skill path AND bash.

## Fix 2 -- python-run-tests counting bug

`skills/python-run-tests/skill.py` (v1.1.2). `passed = ran - len(res.failures)`
went negative (passed:-10, failed:17, ran:7) because `self.subTest` in a loop
adds one failure entry per failed subtest while testsRun counts the method once.
Now counts distinct failing/erroring METHODS via a custom TestResult, so a
subTest loop is one test and the numbers are always coherent.

Verified: subtest-heavy failing case -> ran:2 passed:1 failed:1 (was the -10/17
corruption); correct fib_memo -> 2/2 pass (confirming the "memoization" failure
was a phantom test, not a real defect).

Re-seed/re-index this skill so the new code is loaded (content_hash blanked so the
loader recomputes).

## Fix 3 -- failure-learner mined a non-reproducible "known-good"

`src/core/memory.ts`. The auto-resolver took "the nearest later successful call
of the same tool by the same agent" as the fix, without excluding the
orchestrator's OWN verification calls (`orchestratorVerified: true`, `input:
null`) -- which succeed via slot injection the agent cannot reproduce. It thus
recorded "call python-run-tests with code:'' " as known-good (NameErrors as a
real agent invocation) and marked it resolved, feeding future agents a broken
pattern: a negative-learning loop.

Now the recovery search excludes orchestrator-internal successes and requires the
sibling to share the failed call's argument shape; the prevention text is marked
an UNVERIFIED single-run signal rather than "prefer it".

## Not addressed here (prompt-level, separate)

The review agents chased a contradictory requirement -- demanding the memo cache
persist across calls (the mutable-default-arg anti-pattern) and then flagging the
mutable default. That phantom drove the retry thrash. With verification now
producing a real signal most of it should subside, but the reviewer prompts may
still want an explicit note that idiomatic correctness (memo=None reset per call)
is acceptable and cross-call cache persistence is NOT a requirement unless the
spec asks for it.

## Files changed this round

```
src/core/tools.ts      materialization + ext helper
src/core/agent.ts      execution-environment convention block
src/core/memory.ts     failure-learner recovery gating
skills/python-run-tests/skill.py    subtest-safe counting (v1.1.2)
skills/python-run-tests/SKILL.md    version bump, content_hash blanked
```

Rebuild `orchestrail:latest` (src changed), re-seed the python-run-tests skill,
redeploy. The exec image is unchanged from the base package.

---

# Round 2 -- prompt fixes + skill-path backstop (from conv-a0d39258)

Run 2 confirmed the plumbing fixes worked (zero ModuleNotFoundError, coherent
counts, name mismatch auto-corrected, retries down from 9 to 2). It still didn't
cleanly pass because the AGENT PROMPTS were stale and contradictory. Root cause:
`orchestrail-agents.json` still instructed agents to call `run_code` -- a tool
that no longer exists -- so the test-engineer flailed (guessed module names,
imported `from fibonacci import`), and the reviewer prompt actively MANDATED the
memoization phantom.

## orchestrail-agents.json (the dominant fix this round)

- **test-engineer**: fully rewritten off `run_code`. Now: read implementation
  for exact names, verify via use_skill python-run-tests (test_code references
  symbols by name; implementation supplied automatically) OR write_file + bash
  with `from implementation import`, then write test_report immediately. Forbids
  importing the code under test from any module other than `implementation`.
- **senior-engineer**: `run_code` references replaced with use_skill / bash;
  added "implement the EXACT function names/signatures from the blueprint's
  Demonstration Contract -- do not rename" (the cause of the fibonacci vs
  fibonacci_memo escalation).
- **adversarial-reviewer**: dropped the `run_code` mention; added an explicit
  guard that per-call cache init via a recursive helper is CORRECT and O(n),
  cross-call persistence is NOT required, and "cache recreated per call" / O(2^n)
  must not be escalated unless the recursion re-inits the cache within a single
  computation. This kills the phantom that drove both runs' escalations.
- **self-improvement**: rubric #12 `run_code` -> `bash`.
- Net: zero `run_code` references remain in any prompt.

## src/core/tools.ts -- import-strip backstop (deterministic)

`stripRedundantImplImports`: in the single-namespace python-run-tests harness the
implementation is exec'd into the same namespace as test_code, so importing it by
module name is never needed. The use_skill handler now strips test_code import
lines that pull ONLY implementation-defined symbols (or the literal
`implementation` module). This makes the skill path import-proof regardless of
which module name the model guesses; stdlib/third-party imports are untouched.
Verified: `from fibonacci import fibonacci_memo` (run-2 failure) is dropped,
`import math` preserved, skill passes.

## src/core/agent.ts -- convention block hardened

The execution-environment prompt block is now prescriptive: one canonical
`implementation.py`, no parallel source files (main.py/fibonacci.py), tests import
ONLY `from implementation import`, use exact symbol names (read the slot if
unsure).

## Deploy

Rebuild `orchestrail:latest` (tools.ts + agent.ts changed) and **replace
orchestrail-agents.json** in your data dir (it is read from /data, not the image,
so update it on disk and restart). Skill + exec image unchanged from round 1.

## Files changed this round
```
orchestrail-agents.json             all four agent prompts de-run_code'd; phantom killed
src/core/tools.ts                   stripRedundantImplImports backstop
src/core/agent.ts                   hardened convention block
```
