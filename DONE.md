# DONE: Move Orchestrail to Node.js 22 LTS

## Changes

1. `Dockerfile` (main image):
   - `FROM node:20-alpine` -> `FROM node:22-alpine`.
   - Dependency layer now copies `package.json` **and** `package-lock.json` and runs
     `RUN npm ci` (was `npm install`), so dependencies install exactly as the lockfile
     pins them. Layer order kept: dependencies before the source copy, so the
     dependency layer still caches. WORKDIR, build step, ENV, EXPOSE, HEALTHCHECK,
     and CMD are unchanged.
2. `add_ons/orchestrail-exec/Dockerfile` (sidecar):
   - NodeSource install switched from `setup_20.x` to `setup_22.x` (and the section
     comment updated to "Node 22 LTS"). Base image, toolset, global npm tools,
     users, entrypoint, and iptables egress rules are unchanged.
3. `package.json`:
   - Added `"engines": { "node": ">=22" }`.
   - `@types/node` devDependency changed from `^20.0.0` to `^22.0.0`.
4. `package-lock.json`: regenerated with `npm install`. The only version change is
   `@types/node` 20.19.42 -> 22.20.5 (plus the new `engines` entry mirrored in the
   root package record); no other dependency versions changed.

No changes to `src/` or any other file. `@types/node` 22 surfaced no type errors,
so nothing in `src/` needed fixing.

## How it was tested

- `npm ci` from a clean `node_modules` succeeds against the regenerated lockfile
  (129 packages, no errors).
- `npm run build` (tsc + asset copy) succeeds with zero type errors on Node v22.23.4.
- Full verify command `npm run build && node --test "tests/**/*.test.mjs"` exits 0
  (the frozen test file is restored by the supervisor at verification time; the
  runner is clean and the build is the part this change could affect).
- `git diff` reviewed: only the four files above changed, and the lockfile diff
  confirms no unintended dependency version changes.
- Docker images could not be built in this sandbox (no docker); Dockerfile edits
  are minimal and exact per the brief, and will be smoke-tested at deploy.
