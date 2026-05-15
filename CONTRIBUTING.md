# Contributing to Orchestrail

Thank you for your interest in contributing to Orchestrail. This document
explains how to contribute and what to expect.

---

## Before You Contribute

All contributions to Orchestrail are governed by the
[Orchestrail Contributor License Agreement (CLA)](CLA.md).

**By submitting a pull request you confirm that you have read the CLA and
agree to its terms.** No separate signature is required -- your PR submission
constitutes your agreement.

Please read the CLA before submitting anything. Key points:

- You retain copyright of your own contribution
- You grant Scott Williams a perpetual license to use, modify, and relicense
  your contribution, including under commercial terms in the future
- You warrant that you own the code you are submitting

If you are not comfortable with these terms, please do not submit a
contribution.

---

## What to Contribute

Good candidates for contribution:

- Bug fixes with a clear description of the problem and solution
- Performance improvements to agent execution or DAG scheduling with
  before/after context
- New built-in agent roles or synthesizer strategies
- Improvements to the workbench, tool system, or pipeline stage model
- Documentation improvements and usage examples
- Home automation integration enhancements (MQTT, Home Assistant, WebUI)

Please open an issue before starting work on a significant new feature so we
can discuss whether it fits the project's direction before you invest time in
it.

---

## What Not to Contribute

- Code that hardcodes personal data, credentials, IP addresses, or entity IDs
- Cloud-dependent features -- Orchestrail is local-first and must remain
  runnable with no internet access
- Dependencies with licenses incompatible with PolyForm Noncommercial
- Agent implementations that call external APIs without explicit user
  configuration
- Code copied from other projects without clear license compatibility

---

## Pull Request Guidelines

1. Fork the repository and create a branch from `main`
2. Keep PRs focused -- one fix or feature per PR
3. All TypeScript files must:
   - Pass `npm run build` with zero errors
   - Follow the existing async/await patterns
   - Include JSDoc comments on exported functions and interfaces
4. Do not commit `node_modules/`, `dist/`, or `.env` files
5. Update `package.json` version if your change warrants it, following
   semver (patch for fixes, minor for new features, major for breaking changes)
6. Write a clear PR description explaining what changed and why

---

## Code Style

- Follow existing patterns in the file you are modifying
- Use structured logging -- no `console.log()` in production paths beyond
  startup messages
- No hardcoded IPs, hostnames, entity IDs, or personal data of any kind
- Keep strings ASCII-only where possible
- Agent role names, task descriptions, and synthesizer prompts should be
  configurable, not hardcoded

---

## Development Setup

```bash
git clone https://github.com/williasj/orchestrail
cd orchestrail
npm install
cp .env.example .env   # configure your Ollama endpoint
npm run dev
```

Or via Docker:

```bash
docker build -t orchestrail:latest .
docker compose up
```

The admin UI is available at `http://localhost:8089` once running.

---

## Reporting Issues

Open a GitHub issue with:

- Your Node.js version (`node --version`) or Docker version
- Your Orchestrail version (from `package.json`)
- Your Ollama model and endpoint (no credentials)
- Relevant log output with timestamps
- Steps to reproduce

---

## Questions

Open a GitHub Discussion or reach out via
[Scott.J.Williams14@gmail.com](mailto:Scott.J.Williams14@gmail.com).

---

*All contributions are subject to the [Orchestrail CLA](CLA.md) and the
[PolyForm Noncommercial License](LICENSE).*
