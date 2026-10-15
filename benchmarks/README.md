# Benchmarks

Fixed prompts and independent graders for scoring the agent team end to end.
Each grader exercises the delivered artifact directly (it never trusts the
team's own test report).

| Prompt | Grader | What it checks |
|---|---|---|
| `fibonacci.txt` | `grade_fib.py impl.py` | values, external memo reuse, validation (bool/float/str/None/negative), recursion-limit warning and large n, docstrings, `__main__` |
| `lru-cache.txt` | `grade_lru.py impl.py` | get/put, LRU eviction, update recency, capacity bounds, O(1) structure, per-step state helper, demo coverage |
| `rate-limiter.txt` | `grade_rl.py impl.py Limiter TokenBucket SlidingWindow` | algorithm semantics (injected clock or real time), exact limits under 40-thread contention, strategy pattern, config validation, simulation log |
| `vaultwarden-caddy-compose.txt` | `grade_compose.py docker-compose.yml [Caddyfile]` | ports and networks, named volumes, env-only secrets, Vaultwarden DOMAIN URL, image-native healthcheck, Caddy `{$VAR}` syntax, WebSocket path |
| `sales-report-xlsx.txt` | `grade_sales.py sales_report.py` | sample generator, revenue by region/month and top 3 against an independent pandas calculation, bar chart, exit 1 on missing/empty/header-only CSV |

Graders need Python 3.10+; `grade_compose.py` needs PyYAML and `grade_sales.py`
needs pandas and openpyxl.

## Results, 2026-10-15 (qwen3.8:27b-orchestrail)

| Benchmark | Score | Time | Tokens | Escalations |
|---|---|---|---|---|
| Fibonacci | 23/23 | 502 s (GPU shared) | 223k | 0 |
| Rate limiter | 13/13 | 594 s (GPU shared) | 427k | 0 |
| LRU cache | 13/13 | 324 s | 451k | 0 |
| Sales report (pandas + xlsx) | 10/10 | 318 s | 342k | 0 |
| Vaultwarden + Caddy compose | 12/12 with the AIWiki compose playbook, 9/12 without | 184 s | 219k | 0 |

Earlier runs of the same prompts on the previous configuration: Fibonacci
unverified after 4 escalations (559k tokens); rate limiter 9-13/13; LRU 8/13.
