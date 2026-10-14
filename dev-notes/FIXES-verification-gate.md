# Verification-Integrity Hard Gate (Option A) -- Fixes

Resolves the conv-cb46f3a9 gap: a requiresVerifiedExecution stage that never
reached a passing run could advance and be rubber-stamped into a clean SUCCESS.

## Root cause (confirmed from source, no container logs needed)
finalizeBypass DID run and DID escalate (selfContract) -- it was not overridden.
The run still shipped because the selfContract ESCALATE is a SOFT re-run: after
maxRetries the pipeline's give-up path advances (pipeline.ts ~168), the terminal
reviewer (no exec tools) read an EMPTY test_report and returned DONE, and
Terminal-DONE-is-final (pipeline.ts ~188) closed the run without coordinator
review. test_report was empty because attemptDeterministicVerification early-returns
when executionAttempted is already true (agent.ts ~349) -- which it was, because the
test-engineer self-executed via use_skill.

## Changes
1. agent.ts -- test_report floor (Fix #1). When a stage with test_report in its
   requiredOutputSlots self-executes use_skill and the result carries real test
   counts, the orchestrator renders the authoritative counts into test_report
   immediately. Closes the empty-slot path that let the reviewer pass an un-run
   verification. (resultHasTestCounts gate; formatTestReport render.)

2. types/index.ts + agent.ts -- capability-based verification signal. AgentResult
   gains `verification {required, passed, detail}`, populated at every terminal
   return via mkVerification(). `passed` is the deterministic ground truth from the
   real execution result (executionPassed), independent of any prose the model wrote.

3. synthesize.ts -- deterministic hard gate (Option A core). Computes
   hardVerificationFailure from verification.passed (primary) and nonzero
   failed/errored counts in test_report (secondary). When true, a MACHINE-AUTHORED
   "VERIFICATION FAILED -- UNVERIFIED RESULT" banner is prepended to the final
   output, in code -- so a rubber-stamped review or a non-compliant synthesizer
   cannot present the run as complete. Also ORs the signal into the existing
   model-facing unresolved-stage notice.

4. orchestrail-agents.json (prompts):
   - test-engineer (Fix #3, pressure-relief valve): if verification ERRORS due to a
     bug in the test's OWN harness (e.g. IndexError from a short expected[] vs the
     loop range), fix the test and re-run; only ESCALATE for genuine implementation
     defects. Read the traceback: if the failing frame is in your test, fix the test.
   - adversarial-reviewer (Fix #2): an empty/missing test_report, or any nonzero
     failed/errored count, is a BLOCKING defect -- ESCALATE, never pass. DONE only on
     a real executed clean pass (ran>0, 0 failed, 0 errored).

## Interaction
Fix #1 keeps test_report non-empty (model-facing); the verification capability flag
is the deterministic ground truth (gate-facing). A model that LIES in test_report
("all passed") cannot launder a failure: executionPassed is captured from the real
skill result, so the banner still fires. Fix #3 keeps a self-buggy harness from
tripping the gate against a correct implementation by getting the test fixed first.

## Deploy (Scott's box -- per prior handoff)
- src changed -> REBUILD orchestrail:latest (container runs compiled dist/):
    sudo docker build -t orchestrail:latest .
- orchestrail-exec is UNCHANGED -- do NOT rebuild it.
- orchestrail-agents.json -> copy to /data, then restart the stack:
    (drop file on /data, it contains real secrets -- keep out of the public repo)
    sudo docker compose restart   # or restart the local-agentic-team service
- No exec/skill changes; python-run-tests skill untouched.

## Verify after deploy
Re-run the Fibonacci grading task. Expected: test-engineer that errors on its OWN
test fixes and re-runs (no false ESCALATE); a genuinely failing/empty verification
yields the UNVERIFIED banner and an unresolved synthesis rather than a clean SUCCESS.
Grep:
  sudo docker logs local-agentic-team 2>&1 | grep -E '\[verify\]|\[finalize\]|\[complete_stage\]|VERIFICATION FAILED' | tail -50

---

# Round 2 -- findings from conv-a03cd91f + stage-scramble fix

## Two things this run proved
1. DEPLOY GAP: the orchestrail image was NOT rebuilt -- only agents.json (read from
   /data) was live. Evidence: the reviewer used the NEW prompt language verbatim
   ("ran>0, 0 failed, 0 errored") AND hard-escalated 3x on the empty test_report
   (Fix #2 working), but NO "VERIFICATION FAILED" banner appeared even though a
   required verification never passed -- so synthesize.ts / agent.ts / types (banner,
   Fix #1, verification field) were the OLD compiled dist. src changes require
   rebuilding orchestrail:latest; agents.json alone does not pick them up.
   Confirm on the box:
     sudo docker exec local-agentic-team grep -rl "hardVerificationFailure" /app/dist 2>/dev/null \
       || echo "STALE IMAGE -- banner code not in running dist, rebuild needed"

2. GOOD: Fix #2 demonstrably changed reviewer behavior. In the prior failure the
   reviewer rubber-stamped an empty test_report ("All checks passed"); now it treats
   it as BLOCKING and escalates. That half works even on the un-rebuilt image.

## New root cause this run exposed (upstream of the gate): STAGE-NAME SCRAMBLE
The decompose model emitted stages named Design / Implementation / Review / Testing
and assigned them in pipeline order -- so "Review" landed on the test-engineer and
"Testing" landed on the adversarial-reviewer. Canonicalization (decompose.ts) only
corrected ASSIGNEE order, not stage NAMES. pipeline.ts then keyed isTestStage partly
on the literal name "Testing", so the adversarial-reviewer (no exec tools) was handed
"run python-run-tests" instructions it could not satisfy -> 4 escalations, ~286k
tokens, test_report never written by anyone, and the implementation slot ended up
carrying the unittest harness (the "Implementation Code" in the synthesis is the test
file). The verification gate is downstream: had the image been rebuilt it would have
correctly stamped this UNVERIFIED, but it cannot stop the upstream thrash.

## Fix (this round)
3. pipeline.ts -- role detection is now ASSIGNEE-ONLY (dropped the stage.name ===
   'Testing'/'Review' checks). A mislabeled stage name can no longer hand
   test-execution instructions to an agent without exec tools.
4. types/index.ts + decompose.ts + agents.json -- added TeamAgent.stageName
   (Design/Implementation/Testing/Review) and decompose now canonicalizes stage.name
   to the role's stageName at the same point it fixes assignee. Verified on the exact
   conv-a03cd91f decompose output: "Review"->"Testing" (test-engineer),
   "Testing"->"Review" (adversarial-reviewer).

## Residual (needs the rebuilt-image rerun to judge)
The test-engineer made ZERO use_skill calls this run and just read+stopped -- under
the OLD dist and a "Review"-framed task. With the name canonicalized, Fix #1 live,
and the assignee-based test enrichment it already receives, the expectation is it
executes and test_report populates. If it still write-and-stops after a clean rebuild,
that is a genuine test-engineer non-execution problem to chase separately (the task
description text, still LLM-authored, is the remaining lever). Re-run after rebuild
and grep:
  sudo docker logs local-agentic-team 2>&1 | grep -E 'name "(Review|Testing)" ->|\[verify\]|VERIFICATION FAILED' | tail -40

---

# Round 3 -- conv-4ec7b768 (rebuilt image): gate works, but a FALSE POSITIVE

## What the rebuild proved (all good)
- Banner is LIVE and fired. synthesize.ts/agent.ts/types are now in dist.
- assignee-only role keying worked: the adversarial-reviewer ("Testing") no longer
  got test-execution instructions; reviewer cost dropped ~129k->50k tokens, 4->2 attempts.
- test-engineer EXECUTED for real: use_skill python-run-tests -> ran:7 passed:7
  failed:0 errored:0, wrote a real test_report, complete_stage DONE. The happy path
  works. The implementation in the synthesis is REAL fib_memo code, not a test harness.
- Total tokens 286k -> 140k.

## The false positive
The banner fired on the SENIOR-ENGINEER, not the test stage. senior-engineer never
executed its own code (wrote the implementation slot 3x, zero use_skill/bash), so its
requiresVerifiedExecution gate -> executionPassed=false -> verification.passed=false
-> verificationNeverPassed=true -> banner. But the test-engineer cleanly verified the
SAME final implementation (7/7). So the run was actually verified; the banner is wrong.

senior-engineer's requiresVerifiedExecution was ALSO the sole cause of its 4-retry
spiral: it wrote its required slot every time but self-contract-escalated purely on
"finished without executing anything."

## Fix (this round, agents.json only -- no code change)
Removed requiresVerifiedExecution from senior-engineer. The test-engineer is the
verification authority; the implementer builds, the test stage verifies the final
artifact. Effects:
- senior-engineer now completes Implementation in ONE pass (no exec gate to fail).
- the hard-gate now keys only on the test-engineer's outcome: banner fires iff the
  test stage did not reach a clean executed pass -- which is exactly what we want.
- no loss of safety: broken code still fails the test stage and trips the banner.

Expected next run: Design DONE -> Implementation DONE (1 pass) -> Testing 7/7 DONE ->
Review DONE -> synthesis with NO banner. A genuinely failing impl still gets the banner
via the test stage.

## POLICY NOTE (your call)
This makes test-engineer the single verification gate. If you instead want the
engineer to self-verify on principle, the alternative is to KEEP the flag and fix
senior-engineer's BEHAVIOR so it actually runs its code (prompt enforcement) -- but it
has not executed in 2 runs and the flag currently only produces spirals + false
banners. Reverting is one line (re-add "requiresVerifiedExecution": true to
senior-engineer). I recommend the removal.

## Still outstanding (minor)
- stageName canonicalization did NOT relabel the stages this run (decompose still shows
  Review/Testing on the wrong agents). The loader passes stageName through fine, so the
  round-2 agents.json (with stageName) likely is not on /data yet -- re-copy it. Harm is
  already neutralized by assignee-only keying; this is display + rewind-targeting polish.
