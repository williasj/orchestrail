# Handoff: deterministic verification, synthesis anti-fabrication, pipeline convergence

**Date:** 2026-06-07
**Scope:** 7 source files. Closes the two primary failures from conv-af768074
(test stage that would not re-execute; synthesis that fabricated a fix), plus the
review-stage non-convergence that drove the 55,735-token run, and three supporting
hardening items. Build is clean (`npm run build` / `tsc --noEmit` both exit 0).

---

## DO THIS FIRST

Rebuild and confirm the running image actually changed (do not trust a restart):

```
npm run build           # tsc, exits 0
docker build -t orchestrail:latest .
docker compose -f deploy.yaml up -d
```

Baseline `tsc --noEmit` was clean before edits and remains clean after. No
pre-existing warnings were touched.

---

## What changed and why

### 1. test-engineer now executes deterministically (root fix for the stall)

The verification gate was purely reactive: it caught "no execution" after the
model finished and re-ran the stage hoping the model would call `use_skill` next
time. On the IQ3 model it did not converge -- attempts 2 and 3 finished with zero
executions, so the boolean fix was never re-tested.

`agent.ts` now captures the test harness the model emits (the `test_code`
argument of any `use_skill` call, including an envelope-malformed one) and
persists it across stage retries in an internal `__test_harness__` workbench slot
(hidden from the model). At every finalization point, for a
`requiresVerifiedExecution` code stage where the model did NOT execute this
attempt, the orchestrator runs `python-run-tests` itself against the current
`implementation` slot plus the captured harness, writes the real
`{ran,passed,failed,errored}` to `test_report`, and sets the execution flags the
gate reads. Execution is now an orchestrator guarantee whenever a harness was ever
produced, not a model-behavior gamble.

This fires only when the model did not execute this attempt; if the model ran
(pass or fail), its own result stays authoritative and is not re-run or clobbered.

### 2. Legacy run_code-only test-engineer guards removed

`agent.ts` had three `lastRunCodeExitCode`-based guards that force-ESCALATED a
test-engineer which had "not called run_code". The designated path is
`use_skill(python-run-tests)`, which never sets `lastRunCodeExitCode` -- so a
test-engineer that verified correctly via the skill and reported DONE would be
force-escalated, and the happy path could never close. These were the guards
`AGENT-TS-GUARD-REMOVAL.md` flagged; "redundant but harmless" was wrong. They are
removed. The capability-agnostic gate (`requiresVerifiedExecution && runtimes`,
fed by run_code OR use_skill OR the deterministic verify above) is the single
verification authority now.

### 3. Synthesis can no longer fabricate a fix

The synthesis prompt previously presumed a found->fixed->confirmed arc ("confirm
the fix", "note what was corrected") and the FIDELITY rule only barred invented
counts. When a run ended unresolved, the model invented a fix. Also, the
authoritative failure cause (the test-engineer's `escalation_reason`) was never
given to synthesis, so it borrowed the reviewer's speculation as fact.

`synthesize.ts` now passes a `## Stage Outcomes` block (each stage's terminal
DONE/ESCALATE status + escalation reason) into the prompt, and injects an
unresolved-stage directive when the testing stage escalated. `prompts.ts`
rewrites the Review/Test sections to be evidence-bound and adds a NO INVENTED
RESOLUTION rule: no claim of a fix, correction, or passing re-run unless the Test
Report slot or Stage Outcomes record it; the reviewer's hypothesis about a cause
is explicitly not evidence.

### 4. Pipeline convergence

`pipeline.ts`:
- **Terminal-DONE-is-final.** When the last stage (the acceptance gate) returns
  DONE, the pipeline synthesizes instead of handing that DONE to the coordinator,
  which previously second-guessed it and manufactured a discretionary ESCALATE on
  a subjective spec reading (the observed DONE->ESCALATE oscillation). A genuine
  reviewer ESCALATE is unaffected; only an acceptance is made final. The in-agent
  `complete_stage` gate already enforced required slots before that DONE.
- **Global escalation budget** (`MAX_PIPELINE_ESCALATIONS = 6`, config.ts). A
  hard cap on total fix dispatches across all stages, so one non-converging stage
  cannot run up unbounded cost regardless of per-stage `maxRetries`.

### 5. Supporting hardening

- **PEP 563 shim** (`utils/text.ts` `ensurePyFutureAnnotations`, applied in
  `tools.ts` `runCodeViaTool` and the `use_skill` python path). Prepends
  `from __future__ import annotations` to python at execution time only (never to
  stored slots or the deliverable), so PEP 604 unions (`dict | None`) stop raising
  on the sub-3.10 Piston runtime. This removes the architect-vs-runtime annotation
  mismatch that fed the reviewer's "signature" churn at its source.
- **use_skill name auto-repair** (`tools.ts`). When the model omits the top-level
  `name` but `input` carries a `{code, test_code}` shape, default to
  `python-run-tests` instead of returning "name is required".
- **Failure-store hygiene** (`agent.ts` `skillHardErrored`). A `use_skill` run
  that executed and reported failing tests (`ran>0`) is a valid outcome and is no
  longer recorded as a failure; only a hard error (transport/skill error, or
  `ran==0`) is. Stops the honest "7 passed, 2 failed" run from polluting the
  failure store.

---

## File inventory

| File | Change |
|------|--------|
| `src/core/agent.ts` | Harness capture; `attemptDeterministicVerification` wired at all 3 finalization points; legacy run_code-only guards removed; `skillHardErrored`/`formatTestReport` helpers; failure flag uses `skillHardErrored`. |
| `src/core/tools.ts` | `runCodeViaTool` PEP 563 shim for python; `use_skill` name auto-repair + python code normalization. |
| `src/core/synthesize.ts` | `## Stage Outcomes` block + unresolved-stage directive into the synthesis prompt. |
| `src/core/prompts.ts` | Evidence-bound Review/Test sections; NO INVENTED RESOLUTION FIDELITY rule. |
| `src/core/pipeline.ts` | Terminal-DONE-is-final; global escalation budget; internal `__`-slots hidden from the workbench notice. |
| `src/utils/text.ts` | `ensurePyFutureAnnotations` helper. |
| `src/utils/config.ts` | `MAX_PIPELINE_ESCALATIONS = 6`. |

---

## Verify procedure

- `npm run build` passes clean (confirmed: exit 0).
- `grep -n "attemptDeterministicVerification" src/core/agent.ts` -> 1 def + 3 call sites.
- `grep -n "Test report written without calling run_code\|fabrication phrases detected" src/core/agent.ts` -> empty (guards removed).
- `grep -n "remainingNames.length === 0\|MAX_PIPELINE_ESCALATIONS" src/core/pipeline.ts` -> terminal-DONE + budget wired.
- Re-run the standard Fibonacci prompt. Success now looks like:
  - test-engineer (or the orchestrator on its behalf) executes; `test_report` holds
    real numbers; after the boolean fix the re-run PASSES and the stage closes DONE;
  - reviewer DONE ends the pipeline (no DONE->ESCALATE oscillation);
  - footer leads with `coordinator (...)`; total back near ~10k, not ~54k;
  - synthesis Test Report matches the slot; no "a correction was applied" unless a
    passing re-run is actually recorded.

---

## Validation state

| Item | Status |
|------|--------|
| Build clean (`tsc --noEmit` / `npm run build`) | DONE (verified, exit 0) |
| PEP 563 shim makes `dict | None` safe + idempotent | Unit-verified (shimmed source compiles; idempotent) |
| `skillHardErrored` / `formatTestReport` on real log shapes | Unit-verified (7p/2f not a failure; name-missing + ran=0 are) |
| test-engineer executes reliably (orchestrator-guaranteed) | Logic complete; NOT yet validated on a live run |
| Token cost back near ~10k | NOT validated live |
| Synthesis no longer fabricates a fix | Logic + prompt complete; NOT validated live |
| Terminal-DONE ends pipeline (no oscillation) | Logic complete; NOT validated live |
| Global escalation budget caps cost | Logic complete; NOT validated live |

## Next run

1. Rebuild, confirm the image changed.
2. Re-run the Fibonacci prompt; send both logs (tool-log JSON + container log).
   Expect a clean close with real `test_report` numbers and a ~10k footer.
3. Then drive the two deliberate ESCALATE-gate scenarios (a task whose tests FAIL;
   a tester/reviewer that skips execution) to confirm the gate + budget behave.
