// -- Baseline comparison harness (frontier items 9 + 12) -------------------------
// Live-run harness that compares the full multi-agent pipeline against
// single-agent and two-agent baselines on the existing benchmark tasks, using
// the independent Python graders in benchmarks/graders/ as the scoring authority.
//
// Repeat-run mode (frontier item 12): run each task N times per config and
// report mean +/- spread per config x task. Two uses:
//   - MoE model comparison: run the harness under each model (OLLAMA_MODEL env),
//     tag with --model-label, compare the two reports / JSON sidecars.
//   - Wiki-playbook A/B: run the compose task with --wiki on (seeded playbook
//     available) vs --wiki off (no playbook readable), compare mean scores.
//
// Requires (operational prerequisites — not unit-testable):
//   - A live Ollama model (see OLLAMA_BASE_URL / OLLAMA_MODEL in src/agents.ts)
//   - Python 3.10+ with: PyYAML (compose), pandas + openpyxl (sales)
//   - A built dist/  (run: npm run build)
//
// Run:
//   node benchmarks/baselines.mjs
//   node benchmarks/baselines.mjs --reps 3
//   node benchmarks/baselines.mjs --reps 3 --tasks compose --wiki off
//   node benchmarks/baselines.mjs --reps 3 --model-label qwen3.8-27b
//
// Flags:
//   --reps N         reps per config x task (default 1 = single-run baseline)
//   --tasks a,b      only run the named tasks (default: all)
//   --wiki on|off    off unsets AIWIKI_URL/AIWIKI_TOKEN before loading dist, so
//                    agents' aiwiki tool reports "not configured" — the
//                    controlled "no playbook" condition for the A/B (default on)
//   --model-label T  tag recorded in the report / JSON sidecar (default:
//                    OLLAMA_MODEL env, else 'unlabeled')
//
// The scoring / comparison / report logic is in src/utils/evaluation.ts (item 9)
// and src/utils/repeat.ts (item 12), unit-tested by evaluation.check.mjs and
// repeat.check.mjs. This harness is the live-run part: it drives the pipeline,
// extracts artifacts, runs the graders, and produces the comparison report.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

// -- CLI flags (parsed before the dist imports: --wiki off must unset env first) --

const argv = process.argv.slice(2)

function argValue(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}

const REPS = Math.max(1, Number.parseInt(argValue('--reps', '1'), 10) || 1)
const WIKI_MODE = (argValue('--wiki', 'on') || 'on').toLowerCase()
if (WIKI_MODE !== 'on' && WIKI_MODE !== 'off') {
  console.error(`--wiki must be 'on' or 'off', got: ${WIKI_MODE}`)
  process.exit(1)
}
const TASK_FILTER = (argValue('--tasks', '') || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const MODEL_LABEL = argValue('--model-label', '') || process.env.OLLAMA_MODEL || 'unlabeled'

// --wiki off: the aiwiki client reads AIWIKI_URL/AIWIKI_TOKEN at module load, so
// unset them before the dist imports below. Agents' aiwiki tool then reports
// "AIWiki is not configured" — the controlled "no playbook" condition for the
// wiki-playbook A/B (frontier item 12 / E1).
if (WIKI_MODE === 'off') {
  delete process.env.AIWIKI_URL
  delete process.env.AIWIKI_TOKEN
}

// -- Import compiled dist modules ------------------------------------------------

const dist = (p) => path.join(root, 'dist', p)

const { loadAgents, loadTools, loadCoordinator } =
  await import(pathToFileURL(dist('core/persistence.js')).href)
const { initLLM, callCoordinatorLLM, usageStorage } =
  await import(pathToFileURL(dist('core/llm.js')).href)
const { initPrompts } =
  await import(pathToFileURL(dist('core/prompts.js')).href)
const { initTools, appendToolLog, getToolLog } =
  await import(pathToFileURL(dist('core/tools.js')).href)
const { initAgent, runAgent, bumpGeneration, getGeneration } =
  await import(pathToFileURL(dist('core/agent.js')).href)
const { initIntake } =
  await import(pathToFileURL(dist('core/intake.js')).href)
const { initDecompose } =
  await import(pathToFileURL(dist('core/decompose.js')).href)
const { initSynthesize } =
  await import(pathToFileURL(dist('core/synthesize.js')).href)
const { initSkillExec } =
  await import(pathToFileURL(dist('core/skillexec.js')).href)
const { initRagKernel } =
  await import(pathToFileURL(dist('core/ragkernel.js')).href)
const { initMemory, rehydrateWorkbench } =
  await import(pathToFileURL(dist('core/memory.js')).href)
const { createCoordinatorRoute } =
  await import(pathToFileURL(dist('core/coordinator.js')).href)
const { executePipeline } =
  await import(pathToFileURL(dist('core/pipeline.js')).href)
const {
  EVAL_DEFAULTS,
  CONFIG_SINGLE_AGENT,
  CONFIG_TWO_AGENT,
  CONFIG_FULL_PIPELINE,
  parseGraderOutput,
  aggregateRuns,
  buildReport,
  renderReport,
} = await import(pathToFileURL(dist('utils/evaluation.js')).href)
const { renderRepTable } =
  await import(pathToFileURL(dist('utils/repeat.js')).href)

// -- Init wiring (mirrors src/server.ts) -----------------------------------------

const AGENTS      = loadAgents()
const TOOLS       = loadTools()
const COORDINATOR = loadCoordinator()

initMemory({ getCoordinator: () => COORDINATOR, getToolLog: () => getToolLog() })
initLLM({ getCoordinator: () => COORDINATOR })
initPrompts({ getAgents: () => AGENTS, getCoordinator: () => COORDINATOR })
initTools({ getAgents: () => AGENTS, getTools: () => TOOLS })
initAgent({ getAgents: () => AGENTS })
initIntake({ getCoordinator: () => COORDINATOR })
initDecompose({ getAgents: () => AGENTS, getCoordinator: () => COORDINATOR })
initSynthesize({ getCoordinator: () => COORDINATOR })
initSkillExec({ getCoordinator: () => COORDINATOR })
initRagKernel({ getCoordinator: () => COORDINATOR })

const coordinatorRoute = createCoordinatorRoute({
  getAgents:        () => AGENTS,
  getRoutingPrompt: () => COORDINATOR.routingPrompt,
  callLLM:          callCoordinatorLLM,
  appendToolLog,
})

// -- Benchmark task definitions --------------------------------------------------

const TASKS = [
  {
    task:    'fib',
    prompt:  fs.readFileSync(path.join(here, 'prompts', 'fibonacci.txt'), 'utf-8').trim(),
    grader:  path.join(here, 'graders', 'grade_fib.py'),
    graderArgs: (artifactPath) => [artifactPath],
    artifactExt: '.py',
    artifactName: 'impl.py',
  },
  {
    task:    'lru',
    prompt:  fs.readFileSync(path.join(here, 'prompts', 'lru-cache.txt'), 'utf-8').trim(),
    grader:  path.join(here, 'graders', 'grade_lru.py'),
    graderArgs: (artifactPath) => [artifactPath],
    artifactExt: '.py',
    artifactName: 'impl.py',
  },
  {
    task:    'rl',
    prompt:  fs.readFileSync(path.join(here, 'prompts', 'rate-limiter.txt'), 'utf-8').trim(),
    grader:  path.join(here, 'graders', 'grade_rl.py'),
    graderArgs: (artifactPath) => [artifactPath, 'Limiter', 'TokenBucket', 'SlidingWindow'],
    artifactExt: '.py',
    artifactName: 'impl.py',
  },
  {
    task:    'sales',
    prompt:  fs.readFileSync(path.join(here, 'prompts', 'sales-report-xlsx.txt'), 'utf-8').trim(),
    grader:  path.join(here, 'graders', 'grade_sales.py'),
    graderArgs: (artifactPath) => [artifactPath],
    artifactExt: '.py',
    artifactName: 'sales_report.py',
  },
  {
    task:    'compose',
    prompt:  fs.readFileSync(path.join(here, 'prompts', 'vaultwarden-caddy-compose.txt'), 'utf-8').trim(),
    grader:  path.join(here, 'graders', 'grade_compose.py'),
    graderArgs: (artifactPath) => [artifactPath],
    artifactExt: '.yml',
    artifactName: 'docker-compose.yml',
  },
]

// -- Config definitions -----------------------------------------------------------

/**
 * Build the pipeline stages for a given config.
 *
 * single-agent:    one stage (senior-engineer does everything)
 * two-agent:       two stages (senior-engineer + test-engineer)
 * full-pipeline:   four stages (architect + engineer + test + reviewer)
 */
function buildStages(config, prompt) {
  const implDesc = prompt

  switch (config) {
    case CONFIG_SINGLE_AGENT:
      return [
        { name: 'Implementation', description: implDesc, assignee: 'senior-engineer', dependsOn: [] },
      ]

    case CONFIG_TWO_AGENT:
      return [
        { name: 'Implementation', description: implDesc, assignee: 'senior-engineer', dependsOn: [] },
        { name: 'Testing',        description: 'Write and run comprehensive tests for the implementation. Verify all requirements are met.', assignee: 'test-engineer', dependsOn: [] },
      ]

    case CONFIG_FULL_PIPELINE:
      return [
        { name: 'Design',         description: 'Design the solution. Produce a blueprint covering architecture, data structures, and edge cases.', assignee: 'software-architect', dependsOn: [] },
        { name: 'Implementation', description: implDesc, assignee: 'senior-engineer', dependsOn: [] },
        { name: 'Testing',        description: 'Write and run comprehensive tests for the implementation. Verify all requirements are met.', assignee: 'test-engineer', dependsOn: [] },
        { name: 'Review',         description: 'Adversarially review the implementation for correctness, edge cases, performance, and security issues.', assignee: 'adversarial-reviewer', dependsOn: [] },
      ]

    default:
      throw new Error(`Unknown config: ${config}`)
  }
}

const CONFIGS = [CONFIG_SINGLE_AGENT, CONFIG_TWO_AGENT, CONFIG_FULL_PIPELINE]

// -- Grader runner -----------------------------------------------------------------

/**
 * Run a Python grader on an artifact file. Returns the parsed GraderResult.
 */
async function runGrader(graderPath, args, graderName) {
  try {
    const { stdout, stderr } = await execFileAsync('python3', [graderPath, ...args], {
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    const output = stdout + (stderr ? '\n' + stderr : '')
    return parseGraderOutput(output, graderName)
  } catch (err) {
    // Grader crashed (non-zero exit, timeout, etc.)
    const output = (err.stdout ?? '') + (err.stderr ? '\n' + err.stderr : '')
    return parseGraderOutput(output, graderName)
  }
}

// -- Pipeline runner -----------------------------------------------------------------

/**
 * Run the pipeline for a given config + task (one rep). Returns a RunRecord.
 * The run is wrapped in a fresh usageStorage store so the model's reported
 * token totals are captured per rep (frontier item 12 / H1).
 */
async function runConfig(config, taskDef, rep) {
  const stages = buildStages(config, taskDef.prompt)
  const generation = bumpGeneration(`baseline:${config}:${taskDef.task}:rep${rep}`)
  const t0 = Date.now()
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

  try {
    const callbacks = {
      onStageStart:       () => {},
      onStageDone:        () => {},
      onFixStart:         () => {},
      onFixDone:          () => {},
      onMaxRetries:       () => {},
      onCoordinatorRoute: () => {},
      onRewind:           () => {},
    }

    const deps = {
      runAgent,
      coordinatorRoute,
      rehydrateWorkbench,
      getGeneration,
    }

    const result = await usageStorage.run(usage, () =>
      executePipeline(stages, taskDef.prompt, generation, callbacks, deps),
    )

    const durationMs = Date.now() - t0
    const impl = result.wbSnapshot?.['implementation'] ?? ''

    if (!impl.trim()) {
      return {
        task: taskDef.task,
        config,
        grader: {
          grader: taskDef.task, passed: 0, failed: 0, total: 0,
          hasScore: false, scoreLine: null,
          failedChecks: [], passedChecks: [],
          diagnostics: ['no implementation in workbench snapshot'],
        },
        durationMs,
        completed: false,
        error: 'no implementation produced',
        tokens: usage.total_tokens,
        rep,
      }
    }

    // Write artifact to a temp file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `orch-eval-${taskDef.task}-`))
    const artifactPath = path.join(tmpDir, taskDef.artifactName)
    fs.writeFileSync(artifactPath, impl, 'utf-8')

    try {
      const graderResult = await runGrader(
        taskDef.grader,
        taskDef.graderArgs(artifactPath),
        taskDef.task,
      )
      return {
        task: taskDef.task,
        config,
        grader: graderResult,
        durationMs,
        completed: true,
        error: null,
        tokens: usage.total_tokens,
        rep,
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  } catch (err) {
    const durationMs = Date.now() - t0
    return {
      task: taskDef.task,
      config,
      grader: {
        grader: taskDef.task, passed: 0, failed: 0, total: 0,
        hasScore: false, scoreLine: null,
        failedChecks: [], passedChecks: [],
        diagnostics: [err instanceof Error ? err.message : String(err)],
      },
      durationMs,
      completed: false,
      error: err instanceof Error ? err.message : String(err),
      tokens: usage.total_tokens,
      rep,
    }
  }
}

// -- Main ----------------------------------------------------------------------------

async function main() {
  const activeTasks = TASKS.filter(t => TASK_FILTER.length === 0 || TASK_FILTER.includes(t.task))
  if (activeTasks.length === 0) {
    console.error(`--tasks matched no known tasks (known: ${TASKS.map(t => t.task).join(', ')})`)
    process.exit(1)
  }

  console.log('=== Orchestrail Baseline Comparison ===')
  console.log(`Model:   ${MODEL_LABEL}`)
  console.log(`Wiki:    ${WIKI_MODE}`)
  console.log(`Reps:    ${REPS}`)
  console.log(`Tasks:   ${activeTasks.map(t => t.task).join(', ')}`)
  console.log(`Configs: ${CONFIGS.join(', ')}`)
  console.log(`Threshold: ${(EVAL_DEFAULTS.qualityThreshold * 100).toFixed(0)}% score delta`)
  console.log('')

  const allRecords = []

  for (const config of CONFIGS) {
    console.log(`--- Config: ${config} ---`)
    for (const taskDef of activeTasks) {
      for (let rep = 1; rep <= REPS; rep++) {
        const label = REPS > 1
          ? `${config} / ${taskDef.task} (rep ${rep}/${REPS})`
          : `${config} / ${taskDef.task}`
        console.log(`  Running ${label}...`)
        const record = await runConfig(config, taskDef, rep)
        allRecords.push(record)
        const score = record.grader.hasScore
          ? `${record.grader.passed}/${record.grader.total}`
          : 'N/A'
        const status = record.completed ? 'OK' : `ERR: ${record.error}`
        const tok = typeof record.tokens === 'number' ? ` tokens=${record.tokens}` : ''
        console.log(`  ${label}: score=${score} time=${record.durationMs}ms${tok} ${status}`)
      }
    }
    console.log('')
  }

  // Aggregate per config
  const aggregates = CONFIGS.map(config =>
    aggregateRuns(allRecords.filter(r => r.config === config)),
  )

  // Build and render report (item 9 comparison + item 12 per-config-x-task spread)
  const report = buildReport(aggregates, CONFIG_FULL_PIPELINE)
  const rendered = renderReport(report) + '\n\n' + renderRepTable(allRecords)
  console.log(rendered)

  // Write report to file (repeat-report for repeat/A/B runs, baseline-report otherwise)
  const stem = REPS > 1 || WIKI_MODE === 'off' ? 'repeat-report' : 'baseline-report'
  const reportPath = path.join(here, `${stem}-${new Date().toISOString().slice(0, 10)}.txt`)
  fs.writeFileSync(reportPath, rendered + '\n', 'utf-8')
  console.log(`Report written to: ${reportPath}`)

  // Write the per-rep records as a JSON sidecar so two runs (different models
  // or wiki on/off) can be compared afterwards without re-running.
  const jsonPath = reportPath.replace(/\.txt$/, '.json')
  fs.writeFileSync(jsonPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    model: MODEL_LABEL,
    wiki: WIKI_MODE,
    reps: REPS,
    records: allRecords,
  }, null, 2), 'utf-8')
  console.log(`Records written to: ${jsonPath}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
