# -*- coding: utf-8 -*-
"""
Idempotent, secret-safe editor for orchestrail agents.json.

Adds the senior-engineer "author a deterministic test harness" change:
  1) requiredOutputSlots gains 'test_harness'
  2) the CODE WORKFLOW prompt gains a step instructing it to write the
     unittest.TestCase into the test_harness slot.

Run on the box that holds the live file:
    python3 apply-senior-harness-agents.py /data/agents.json

- Makes a timestamped backup next to the file before writing.
- Preserves all existing (non-ASCII) prompt formatting; only ASCII is injected.
- Re-running is a no-op (detects the change is already present).
- Never prints file contents (your apiKey/admin creds stay off-screen).
"""
import json
import os
import shutil
import sys
import time

ANCHOR = "Your response text and the slot content must be the identical code block."

HARNESS_STEP = (
    "\n3b. workbench_write(slot='test_harness', content=YOUR_TESTS) -- REQUIRED for code "
    "tasks. Author a complete unittest.TestCase that imports the code under test as "
    "`from implementation import <name>` and exercises the blueprint's required edge cases. "
    "Write this slot even if you also run the tests yourself: the orchestrator re-runs this "
    "exact harness deterministically against the implementation, so test_harness is the "
    "verification of record. Put test code ONLY in this slot, never in the implementation slot."
)


def main():
    if len(sys.argv) != 2:
        print("usage: python3 apply-senior-harness-agents.py /path/to/agents.json")
        sys.exit(2)
    path = sys.argv[1]
    if not os.path.isfile(path):
        print("ERROR: not a file: %s" % path)
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    if not isinstance(data, list):
        print("ERROR: expected a top-level JSON array of agents")
        sys.exit(1)

    se = next((a for a in data if a.get("name") == "senior-engineer"), None)
    if se is None:
        print("ERROR: no senior-engineer agent found")
        sys.exit(1)

    changed = False

    # 1) requiredOutputSlots
    slots = list(se.get("requiredOutputSlots") or [])
    if "test_harness" not in slots:
        slots.append("test_harness")
        se["requiredOutputSlots"] = slots
        changed = True
        print("requiredOutputSlots -> %s" % slots)
    else:
        print("requiredOutputSlots already has test_harness (skip)")

    # 2) prompt step
    key = "systemPrompt" if "systemPrompt" in se else "prompt"
    prompt = se.get(key) or ""
    if "test_harness" in prompt:
        print("prompt already mentions test_harness (skip)")
    elif ANCHOR not in prompt:
        print("WARNING: anchor text not found in prompt; prompt NOT modified.")
        print("         Add a step manually instructing a workbench_write to slot "
              "'test_harness'.")
    else:
        se[key] = prompt.replace(ANCHOR, ANCHOR + HARNESS_STEP, 1)
        changed = True
        print("prompt: inserted test_harness authoring step")

    if not changed:
        print("No changes needed; file already up to date.")
        return

    backup = "%s.bak-%d" % (path, int(time.time()))
    shutil.copy2(path, backup)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print("backup written: %s" % backup)
    print("updated: %s" % path)
    print("Done. No rebuild needed for agents.json -- copy on /data + restart the container.")


if __name__ == "__main__":
    main()
