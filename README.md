<h1 align="center">Orchestrail</h1>
<p align="center">
  Local multi-agent orchestration with DAG scheduling and OpenAI-compatible API
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version"/>
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-green" alt="Node.js"/>
  <img src="https://img.shields.io/badge/license-PolyForm%20NC-lightgrey" alt="License"/>
  <img src="https://img.shields.io/badge/runtime-local--only-orange" alt="Local Only"/>
  <img src="https://img.shields.io/badge/api-OpenAI%20compatible-blueviolet" alt="OpenAI Compatible"/>
</p>

---

Orchestrail is a local multi-agent orchestration service that runs a
DAG-scheduled team of specialized agents against a goal and returns a
synthesized result via an OpenAI-compatible API. Agents execute in parallel
where the dependency graph allows, with a numbered anomaly register ensuring
the synthesizer never silently drops minor findings.

It ships with a self-contained admin UI for managing agent rosters, tools,
coordinator prompts, and reviewing run history -- no external frontend required.

---

## How It Works

A request arrives at the OpenAI-compatible endpoint. The coordinator
decomposes the goal into a DAG of tasks, assigns each to a specialized agent,
and schedules execution respecting dependencies. Agents run in parallel where
possible. A synthesizer collects all findings via a numbered anomaly register
and produces the final response.

```
Request (OpenAI-compatible)
  |
  v
Coordinator --> DAG of tasks
                    |
         +----------+----------+
         v          v          v
      Agent A    Agent B    Agent C   (parallel where no dependency)
         |          |          |
         +----------+----------+
                    |
            Numbered Anomaly Register
                    |
               Synthesizer
                    |
         Response (OpenAI-compatible)
```

Key design decisions:

- **DAG-aware scheduling** -- tasks declare dependencies; execution order is
  enforced with maximum parallelism
- **Numbered anomaly register** -- findings are assigned IDs before synthesis,
  preventing silent editorial cuts of minor results
- **Root task injection** -- the coordinator injects the full goal into root
  task descriptions so agents always have complete context
- **Workbench** -- agents share a structured scratchpad for passing data
  between pipeline stages
- **OpenAI-compatible API** -- drop-in compatible with any client that speaks
  the OpenAI chat completions format; works with Open WebUI out of the box
- **Admin UI** -- built-in single-page interface for managing configuration
  without touching files

---

## Requirements

- Docker (recommended) or Node.js 20+
- An [Ollama](https://ollama.ai) instance on your network with at least one
  model pulled
- Optional: Qdrant for RAG tool support

No cloud services required. Orchestrail is designed to run fully air-gapped.

---

## Quick Start (Docker)

```bash
git clone https://github.com/williasj/orchestrail
cd orchestrail

# Edit docker-compose.yml to point OLLAMA_BASE_URL at your Ollama instance
docker build -t orchestrail:latest .
docker compose up -d
```

The admin UI is available at `http://localhost:8089`.

The OpenAI-compatible API endpoint is at `http://localhost:8089/v1`.

---

## Quick Start (Node.js)

```bash
git clone https://github.com/williasj/orchestrail
cd orchestrail
npm install
cp .env.example .env   # set OLLAMA_BASE_URL and OLLAMA_MODEL
npm run dev
```

---

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434/v1` | Ollama API base URL |
| `OLLAMA_MODEL` | `llama3.2` | Default model for agents |
| `OPENAI_API_KEY` | `ollama` | API key (set to `ollama` for local) |
| `DATA_DIR` | `/data` | Persistent data directory for agent/tool config |

Agent rosters, tool configurations, and coordinator prompts are managed
through the admin UI and persisted to `DATA_DIR` as JSON files.

---

## API

Orchestrail exposes an OpenAI-compatible API:

```
POST /v1/chat/completions   # Main inference endpoint
GET  /v1/models             # Lists available model (orchestrail)
GET  /health                # Health check
GET  /                      # Admin UI
```

Point any OpenAI-compatible client at `http://localhost:8089/v1` with model
`orchestrail` and API key `ollama`.

### Open WebUI

In Open WebUI, add a new connection:

- **Base URL:** `http://<your-host>:8089/v1`
- **API Key:** `ollama`
- **Model:** `orchestrail`

---

## Add-ons


=======
Optional add-ons live in the `add_ons/` directory. Each is self-contained
with its own `docker-compose.yml` and `README.md`.

| Add-on | Description | Port |
|--------|-------------|------|
| [code-execution-tools](add_ons/code-execution-tools/README.md) | Sandboxed multi-language code execution via [Piston](https://github.com/engineer-man/piston). Provides `run_code` and `list_runtimes` tools to agents. | 8765 |

To enable an add-on, start it separately and register its URL in the
Orchestrail admin UI under **Tools**:

```bash
cd add_ons/code-execution-tools
docker compose up -d
bash install_packages.sh   # first time only
```

---

## Home Automation Integration

Orchestrail agents can pull live sensor data from Home Assistant and publish
run events to MQTT. Configure Home Assistant credentials and MQTT broker
details in the admin UI under Tools.
>>>>>>> 43005a1 (Add code-execution-tools add-on; sanitize hardcoded IPs and model defaults)

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)

Copyright Scott Williams -- [Scott.J.Williams14@gmail.com](mailto:Scott.J.Williams14@gmail.com)

Free for personal, educational, and noncommercial use. Commercial use requires
a separate license from the maintainer.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions are subject to the
[Orchestrail CLA](CLA.md).
