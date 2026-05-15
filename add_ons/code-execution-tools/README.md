# code-execution-tools

An Orchestrail add-on that provides sandboxed multi-language code execution
to agents via the `run_code` and `list_runtimes` tools.

Built on [Piston](https://github.com/engineer-man/piston) with a thin FastAPI
wrapper that exposes Piston as a tool endpoint compatible with Orchestrail's
tool registry.

---

## Architecture

```
Agent (Orchestrail)
    |
    | POST http://code-exec-tools:8765/
    v
code-exec-tools  (FastAPI wrapper, port 8765)
    |
    | POST http://piston:2000/api/v2/execute
    v
piston           (sandboxed execution engine, internal only)
```

The Piston container is not exposed to the host network. All sandboxing
(namespace isolation, cgroup limits, timeouts) is handled by Piston.

---

## Tools Provided

### `run_code`
Execute source code in any installed language runtime.

| Parameter  | Type   | Required | Description                              |
|------------|--------|----------|------------------------------------------|
| `language` | string | yes      | Language name (e.g. `python`, `rust`)    |
| `code`     | string | yes      | Source code to execute                   |
| `version`  | string | no       | Runtime version. Use `*` for latest.     |
| `stdin`    | string | no       | Optional stdin input                     |

Returns: `language`, `version`, `status`, `exit_code`, `output`, `stderr`

### `list_runtimes`
List all language runtimes currently installed in the Piston sandbox.
Call this before `run_code` to confirm a language is available.

Returns: array of `{ language, version, aliases }`

---

## Quickstart

```bash
cd add_ons/code-execution-tools
docker compose up -d

# First time only: install language runtimes (takes a few minutes)
bash install_packages.sh
```

The tool server is available at `http://localhost:8765`.

---

## Registering in Orchestrail

In the Orchestrail admin UI, go to **Tools** and add:

- **Name:** `code-execution-tools`
- **URL:** `http://code-exec-tools:8765` (if co-located) or `http://<host>:8765`

Then assign the tool to any agent that should be able to execute code.

---

## Configuration

All configuration is via environment variables in `docker-compose.yml`:

| Variable             | Default                    | Description                        |
|----------------------|----------------------------|------------------------------------|
| `PISTON_URL`         | `http://piston:2000`       | Internal Piston API URL            |
| `RUN_TIMEOUT_MS`     | `30000`                    | Max execution time per run (ms)    |
| `COMPILE_TIMEOUT_MS` | `10000`                    | Max compile time (ms)              |

---

## Adding / Removing Language Runtimes

`install_packages.sh` installs a default set of languages. To add more,
edit the `PACKAGES` map in the script and re-run it against a running
Piston instance:

```bash
bash install_packages.sh
```

To see all packages available in Piston's registry:

```bash
curl -s http://localhost:2000/api/v2/packages | \
  python3 -c "import json,sys; pkgs=json.load(sys.stdin); print('\n'.join(sorted(set(p['language'] for p in pkgs))))"
```

---

## Air-gapped / Offline Deployment

To deploy without internet access on the target host, use `build.sh` on a
machine with Docker and internet access:

```bash
bash build.sh
```

This builds the wrapper image, pulls Piston, and bundles both into
`code-exec-tools-bundle.tar`. Transfer the tar plus `docker-compose.yml`
and `install_packages.sh` to the target host and follow the instructions
printed by the script.

---

## Default Installed Languages

bash, C, C++, Go, Java, JavaScript (Node.js), Lua, Perl, PHP, Python,
R, Ruby, Rust, Swift, TypeScript, Deno, Kotlin, Dart, Haskell, Julia, Zig

---

## License

[PolyForm Noncommercial License 1.0.0](../../LICENSE)

Copyright Scott Williams
