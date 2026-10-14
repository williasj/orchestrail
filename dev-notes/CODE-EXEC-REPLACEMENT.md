# Orchestrail -- Code Execution Replacement

Replaces the Piston `run_code` wrapper with **orchestrail-exec**: a stateful,
filesystem-aware sandbox exposing four tools (`bash`, `write_file`, `read_file`,
`list_files`), all scoped to `/workbench/{runId}/`. There is no `run_code`
primitive anywhere -- skills run through the same path agents do (write a file,
run it with bash).

Decisions applied: auto-prepend dropped (agents read the impl via
read_file/workbench_read); per-call execution caps removed (MAX_TOOL_ROUNDS is
the backstop); `injectCodeFromSlot` field kept as the impl-pointer for the
orchestrator's deterministic python-run-tests verification.

Status: `tsc` builds clean; the python-run-tests skill path is verified
end-to-end through the new exec server (pass + fail cases, temp-file cleanup,
exit-code preservation). The four seeded skills are unchanged.

---

## What's in this package

```
orchestrail-code-exec-replacement/
  README.md                         <- you are here
  docker-compose.yml                <- your combined stack (local-agentic-team + orchestrail-exec)
  add_ons/
    orchestrail-exec/               <- NEW exec sidecar (build this image)
      server.mjs                    dependency-free Node server (node: builtins only)
      Dockerfile                    ubuntu:24.04 + python3 + node20 + pip/npm
      entrypoint.sh                 iptables egress lockdown, then `node server.mjs`
  src/                              <- REPLACE these in /path/to/orchestrail/src/
    server.ts                       (comment only)
    core/
      tools.ts                      runCodeViaTool rewrite, EXEC_TOOLS interceptor,
                                    resolveCodeExecUrl + canExecuteCode -> `bash`,
                                    list_runtimes -> exec /runtimes, de-Piston'd
      agent.ts                      removed rate-limit / lang-autoinject / prepend
                                    blocks; outcome capture run_code -> bash; messages
      pipeline.ts                   write_file extraction fallback + fix-task instruction
      skillexec.ts                  wire-contract comment (no behavior change)
    utils/
      text.ts                       extractCodeFromToolCalls scans write_file content
      config.ts                     CODE_EXEC_URL comment (no behavior change)
    types/
      index.ts                      injectCodeFromSlot / requiresVerifiedExecution comments
```

Each path under `src/` mirrors exactly where it goes in your repo.

---

## Deploy (TrueNAS Scale -- your layout)

Your container runs compiled `dist/` baked into the image; the `/app/src` bind is
only the self-improvement read view + build context. So you copy the patched
`.ts` into your src tree, then rebuild so the new `dist/` is baked in.

```bash
# 1) copy the patched source over your live src / build context
cp -r src/* /path/to/orchestrail/src/

# 2) put the exec add-on under the orchestrail build context
mkdir -p /path/to/orchestrail/add_ons
cp -r add_ons/orchestrail-exec /path/to/orchestrail/add_ons/

# 3) one-time exec bind dirs
sudo mkdir -p /mnt/tempapp/APPS/orchestrail-exec/{workbench,pip-cache,npm-cache}

# 4) build both images
cd /path/to/orchestrail
sudo docker build -t orchestrail:latest .
cd /path/to/orchestrail/add_ons/orchestrail-exec
sudo docker build -t orchestrail-exec:latest .
```

Then redeploy the `local-agentic-team` app with `docker-compose.yml` from this
package (adds the `orchestrail-exec` service + the `CODE_EXEC_URL` env). Delete
the old `code-exec-tools` + `piston` app.

### Required data step -- register the exec tool in tools.json

The code resolves the exec URL from `CODE_EXEC_URL`, but agents only get the four
tool *definitions* in their prompt if the exec server is registered as an
`openai_tools` tool and assigned to them:

1. Add one `openai_tools` tool with `config.url = http://orchestrail-exec:8766/`
   (its GET / advertises all four tools). Id it e.g. `orchestrail-exec`.
2. Assign it to exactly the agents that previously had the Piston `run_code` tool
   (senior-engineer, adversarial-reviewer, test-engineer -- NOT the architect).
   The `canExecuteCode` gate now keys on `bash`, so this assignment is also what
   unlocks `use_skill` for those agents.
3. Remove the old Piston `run_code` tool registration.

### Verify

```bash
# lockdown applied? want "egress lockdown applied", NOT the FATAL line
sudo docker logs orchestrail-exec | head

# liveness over service DNS (no host port)
sudo docker exec local-agentic-team wget -qO- http://orchestrail-exec:8766/runtimes
# -> {"result":[{"language":"python","version":"3.12..."},{"language":"node",...}]}
```

> Your compose carries real ADMIN_PASSWORD / PIPELINES_API_KEY / admin email.
> Keep `docker-compose.yml` OUT of the public williasj/orchestrail repo.

---

## Notes

- **runtimes slot still load-bearing.** It remains the "this is a code task"
  signal for the requiresVerifiedExecution gate and an architect deliverable.
  `list_runtimes` now reports what the exec container actually has installed.
- **Authoritative verification unchanged.** The gate still requires a real
  execution that passed; the deterministic python-run-tests run is authoritative.
  The bash outcome capture (last bash exit code) is the secondary signal.
- **The egress lockdown blocks your LAN.** Agent code in the sandbox cannot reach
  your LAN hosts (Ollama), Qdrant, or any other box -- only DNS + public pip/npm.
- **Deferred (separate TODO):** post-SYNTHESIZE TTL cleanup of old workbench run
  dirs. Skill temp files self-clean, but per-run agent artifacts accumulate under
  the workbench bind until that job is wired (can run inside the exec container
  against /workbench).
