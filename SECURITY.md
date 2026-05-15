# Security Policy

## Project Status

Orchestrail is a personal hobby project maintained by a single developer in
spare time. There is no dedicated security team, no SLA, and no guarantee of
response time or remediation for any reported issue.

## Reporting

If you discover what you believe is a security vulnerability, you may report it
privately via email: Scott.J.Williams14@gmail.com

There is no guarantee of response, timeline, or fix. Reports will be reviewed
when time permits.

## No Warranties

Orchestrail is provided as-is under the PolyForm Noncommercial License with no
warranties of any kind. See the LICENSE file.

Users deploy Orchestrail in their own environments at their own risk. The
maintainer accepts no liability for any security incidents arising from the use
of this software.

## Threat Model

Orchestrail runs entirely on your local network and communicates only with
locally-hosted services (Ollama, Qdrant, and any other tools you configure).
It does not make outbound internet connections except where explicitly
configured by the user.

The primary attack surface is:

- The HTTP API and admin UI (unauthenticated by default -- bind to localhost
  or secure at the network level)
- Agent prompts which may influence LLM behavior if injected via task input
- The Ollama model itself and its behavior under adversarial prompts
- The workbench data directory if exposed beyond the container

## Upstream Dependencies

Most attack surface in an Orchestrail deployment comes from upstream software:
Ollama, Node.js, Express, and any tool services you have configured. Report
vulnerabilities in those projects to their respective maintainers.
