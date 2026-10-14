// -- Coordinator prompt construction ------------------------------------------
// Pure string builders for decomposition, routing, clarification, and synthesis
// prompts. Functions that depend on live state receive it via initPrompts().

import type { CoordinatorConfig, TeamAgent } from '../types/index.js'

// -- Module init ---------------------------------------------------------------

type PromptDeps = {
  getAgents:      () => TeamAgent[]
  getCoordinator: () => CoordinatorConfig
}

let _deps: PromptDeps | null = null

export function initPrompts(deps: PromptDeps): void {
  _deps = deps
}

// -- Helpers -------------------------------------------------------------------

// Meta-agents excluded from coordinator decomposition roster.
// Must stay in sync with the same constant in core/decompose.ts.
const META_AGENTS = new Set(['self-improvement'])

function pipelineAgents(): TeamAgent[] {
  const agents = (_deps?.getAgents() ?? []).filter(a => !META_AGENTS.has(a.name))
  return [...agents].sort((a, b) => {
    const oa = a.order ?? Infinity
    const ob = b.order ?? Infinity
    return oa - ob
  })
}

export function agentRoleSummaries(): string {
  return pipelineAgents().map(a =>
    `### ${a.name}${a.order !== undefined ? ` (stage ${a.order})` : ''}\n${a.systemPrompt.trim()}`
  ).join('\n\n')
}

function agentNames(): string {
  return ((_deps?.getAgents() ?? []).filter(a => !META_AGENTS.has(a.name))).map(a => a.name).join(', ')
}

// -- complete_stage tool -------------------------------------------------------
// Required terminal tool for pipeline stages.
// Agents MUST call it to finish — plain text alone does not end a stage.

export const COMPLETE_STAGE_FN  = 'complete_stage'
export const COMPLETE_STAGE_URL = '__complete_stage__'

export function buildCompleteStageTool(): unknown {
  return {
    type: 'function',
    function: {
      name: COMPLETE_STAGE_FN,
      description:
        'REQUIRED: call this tool when your stage work is complete. ' +
        'This is the only way to signal completion — a plain text response alone does not end the stage. ' +
        'Use status DONE if the work is correct and complete. ' +
        'Use status ESCALATE if a specific issue was found that requires another agent to fix it.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['DONE', 'ESCALATE'],
            description: 'DONE = work complete. ESCALATE = issue found, fix needed.',
          },
          summary: {
            type: 'string',
            description: 'Brief summary of what was accomplished or what issue was found.',
          },
          escalation_reason: {
            type: 'string',
            description: 'Required when status is ESCALATE: specific description of the issue to fix.',
          },
        },
        required: ['status', 'summary'],
      },
    },
  }
}

// -- Pipeline example ----------------------------------------------------------

export function buildPipelineExample(): string {
  const ordered = pipelineAgents()
  if (ordered.length === 0) return '{"mode":"pipeline","stages":[]}'
  const implementer = (ordered[1] ?? ordered[0]).name
  const stageLabels = ['Design', 'Implementation', 'Review', 'Testing']
  const stages = ordered.slice(0, 4).map((agent, i) => {
    const base: Record<string, unknown> = {
      name:        stageLabels[i] ?? `Stage ${i + 1}`,
      assignee:    agent.name,
      description: `Describe the specific task for ${agent.name} based on their role`,
    }
    if (i > 0) { base['escalateTo'] = implementer; base['maxRetries'] = 3 }
    return base
  })
  return JSON.stringify({ mode: 'pipeline', stages }, null, 4)
}

// -- Template variable substitution -------------------------------------------
// Replaces {{VAR_NAME}} tokens in coordinator prompt overrides with runtime values.

export function applyTemplateVars(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (str, [key, val]) => str.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val),
    template
  )
}

// -- Default prompt text -------------------------------------------------------
// Exported so the UI /api/coordinator/defaults endpoint can serve them
// for the Reset-to-default buttons.

export function defaultDecompositionPrompt(): string {
  const agents = _deps?.getAgents() ?? []
  const names = agentNames()
  const roles = agentRoleSummaries()
  return `You are a task coordinator. You know each team member's role and assign work accordingly.

## Team
${roles}

## MODE 1: PARALLEL (independent tasks)
Use for research, analysis, or content tasks where subtasks can run simultaneously.
- Distribute tasks across agents based on their specific expertise   never assign all tasks to the same agent.
- If the goal is simple enough for one agent to handle alone, produce exactly 1 task.
- Each task description must reference the specific agent skill that makes them the right assignee.
Respond with a JSON array in a \`\`\`json code fence:
\`\`\`json
[
  {"title":"Task name","description":"What to do","assignee":"agent-name","dependsOn":[]}
]
\`\`\`

## MODE 2: PIPELINE (sequential quality-gated workflow)
Use when the task involves implementation + review + testing. Stages run one at a time.
Each stage agent must call the complete_stage tool when done   DONE moves to the next stage, ESCALATE routes to escalateTo for a fix then re-runs.
Write precise role-specific descriptions for each stage based on each agent's expertise.
Respond with a JSON object in a \`\`\`json code fence:
\`\`\`json
${buildPipelineExample()}
\`\`\`

Choose PIPELINE for: writing code, building software, design -> implement -> review -> test.
Choose PARALLEL for: independent research, analysis, content generation.
ROUTING RULE: If the Design stage output is incomplete or cut off, the coordinator must REWIND to the architect -- never ESCALATE Design issues to the engineer. The engineer cannot fix a blueprint.
Agents MUST be assigned to pipeline stages in the EXACT ORDER they appear in the Team section above   do not reorder them.
Use exactly ${Math.min(agents.length, 4)} stages. Do NOT add extra stages.
Available agents: ${names}`
}

export function defaultDecompositionTemplate(): string {
  return `You are a task coordinator. You know each team member's role and assign work accordingly.

## Team
{{AGENT_ROSTER}}

## MODE 1: PARALLEL (independent tasks)
Use for research, analysis, or content tasks where subtasks can run simultaneously.
- Distribute tasks across agents based on their specific expertise   never assign all tasks to the same agent.
- If the goal is simple enough for one agent to handle alone, produce exactly 1 task.
- Each task description must reference the specific agent skill that makes them the right assignee.
Respond with a JSON array in a \`\`\`json code fence:
\`\`\`json
[
  {"title":"Task name","description":"What to do","assignee":"agent-name","dependsOn":[]}
]
\`\`\`

## MODE 2: PIPELINE (sequential quality-gated workflow)
Use when the task involves implementation + review + testing. Stages run one at a time.
Each stage agent must call the complete_stage tool when done   DONE moves to the next stage, ESCALATE routes to escalateTo for a fix then re-runs.
Write precise role-specific descriptions for each stage based on each agent's expertise.
Respond with a JSON object in a \`\`\`json code fence:
\`\`\`json
{{PIPELINE_EXAMPLE}}
\`\`\`

Choose PIPELINE for: writing code, building software, design -> implement -> review -> test.
Choose PARALLEL for: independent research, analysis, content generation.
Agents MUST be assigned to pipeline stages in the EXACT ORDER they appear in the Team section above   do not reorder them.
Use exactly {{AGENT_COUNT}} stages. Do NOT add extra stages.
Available agents: {{AGENT_NAMES}}`
}

export function defaultRoutingTemplate(): string {
  return `You are a pipeline coordinator making a routing decision after reviewing a completed stage.

Goal: {{GOAL}}

Team:
{{AGENT_ROSTER}}

{{REMAINING_STAGES}}
{{COMPLETED_STAGES}}
Routing options:
NEXT -- the stage work is acceptable, proceed to the next pipeline stage
ESCALATE -- a blocking defect was found; the fix agent is pre-assigned in the pipeline spec
REWIND <stage-name> -- a fix has changed code that a prior stage already approved; re-run that stage on the updated code
SYNTHESIZE -- all required work is done, skip remaining stages and generate the final answer

ESCALATE routes to the pre-assigned fix agent for this stage. You do not choose the target.
REWIND can only target stages that have already completed (listed above). Use it when a fix could invalidate a prior stage's approval.
CRITICAL: If the Design stage output is incomplete, truncated, or cut off mid-sentence, always use REWIND Design -- never ESCALATE. The engineer cannot fix an architect's blueprint.
Only ESCALATE or REWIND for concrete blocking issues. Do not use them for style or optional improvements.
CRITICAL: If an agent's ESCALATE reason states that the previous stage output is missing, empty, or contains no code or implementation, always route ESCALATE   never NEXT. A missing artifact cannot be fixed by downstream stages and must be sent back to the responsible agent.

Respond with exactly one of these on its own line:
NEXT
ESCALATE -- <one sentence describing the specific blocking defect>
REWIND <stage-name> -- <one sentence explaining why that stage must re-run>
SYNTHESIZE`
}

export function defaultClarificationPrompt(): string {
  return `You are a project coordinator intake specialist. Your job is to classify incoming requests into one of three categories.

Respond with exactly one of:

DIRECT: <your complete answer here>
-- Use this when the request can be fully answered right now without building anything.
   Use for: math/arithmetic, unit conversions, factual questions, definitions, "what is X",
   "how does Y work" explanations, simple calculations, logic puzzles, word problems.
   Write the complete answer after "DIRECT: " on the same line or as a short paragraph.
   Examples:
   - "if a cat = 2 and dog = 5, how much is cat + dog?" → DIRECT: A cat and a dog together equal 7 (2 + 5 = 7).
   - "what is the capital of France?" → DIRECT: The capital of France is Paris.
   - "how does TCP handshake work?" → DIRECT: TCP uses a three-way handshake...

PROCEED
-- Use this when the request asks to BUILD, GENERATE, WRITE, or FIX something that requires
   agent work (code, configs, documents, scripts, examples) AND has enough information to start.
   Use PROCEED immediately when ANY of these are true:
   - Asks for an example, sample, template, snippet, or demo
   - Names a specific tool/protocol/language AND describes a clear action (generate, write, fix, show)
   - References a specific IP, hostname, or filename
   - Is a continuation of a conversation (do not re-clarify established context)
   Examples:
   - "Generate a Prometheus scrape config for 192.168.1.1 for SNMP" → PROCEED
   - "Write a Python function to parse CSV files" → PROCEED
   - "Fix the bug in my login route" → PROCEED

CLARIFY
-- Use ONLY when ALL three are true:
   1. The request asks to BUILD or DESIGN a full system (not an example or simple output)
   2. The stack/platform is genuinely ambiguous in a way that changes the architecture
   3. A reasonable default assumption cannot be made
   List 2-4 numbered questions. Ask only what changes the architecture. Never ask about things already specified.
   Examples:
   - "Build me a monitoring system" → CLARIFY (no stack, no scale, no targets)
   - "Create an API" → CLARIFY (no language, no purpose, no data model)

Do not explain your reasoning. Do not produce JSON. Respond ONLY with one of: DIRECT: <answer>, PROCEED, or CLARIFY followed by numbered questions.`
}

export const DEFAULT_SYNTHESIS_PROMPT =
  'You are a technical synthesizer. Assemble the final response from specialist outputs.\n\n' +
  'Your response MUST have exactly THREE sections in this order:\n\n' +
  '## Product Description\n' +
  'Write 3-5 sentences describing: (1) what the system does and its key design decisions, ' +
  '(2) time and space complexity from the Design stage, ' +
  '(3) immutability or safety guarantees the implementation provides, ' +
  '(4) any edge cases handled. Be concrete -- name the language features used.\n\n' +
  '## Adversarial Review Report\n' +
  'Summarize the adversarial reviewer findings AS STATED in the Review Report. Distinguish clearly ' +
  'between issues that were RESOLVED and issues that remain OPEN -- and treat an issue as resolved ' +
  'ONLY if the Stage Outcomes or Test Report confirm it (a later passing run, or a stage that ended ' +
  'DONE). Do NOT state that a fix was applied unless that is recorded. The Review Report is the ' +
  "reviewer's opinion: do NOT promote its guesses about a cause into established fact.\n\n" +
  '## Test Report\n' +
  'Report the test results EXACTLY as the Test Report slot states: tests run, passed, failed, errored, ' +
  'and -- if the slot lists the cases that executed -- those exact case names. Describe coverage ONLY by ' +
  'reference to the cases the slot lists; that list is COMPLETE, so any input type, value, or range not ' +
  'named in it was NOT tested and must not be described as verified or rejected. If the slot lists no case ' +
  'names, state that the individual cases were not recorded rather than naming any. The Test Report slot ' +
  'is the AUTHORITATIVE record of pass/fail counts -- it is ' +
  'written only from a real execution, and it OUTRANKS the Stage Outcomes narrative for counts: if the ' +
  'slot records a clean pass, report a pass even if a stage escalated on an earlier attempt before ' +
  'recovering. Only report a failing result if the Test Report slot itself records a failure. If the slot ' +
  'and the Stage Outcomes appear to disagree, state the slot counts and note the discrepancy -- do NOT ' +
  'manufacture a failing case, a wrong return value, or a failure cause to reconcile them. ' +
  'Never introduce a failure, a failing count, a specific returned value, or a failure cause that is not ' +
  'in the Test Report slot.\n\n' +
  'Rules:\n' +
  '- Do NOT include an Implementation Code section -- that is prepended separately\n' +
  '- Be concise in all three sections -- no padding\n' +
  '- FIDELITY: Report ONLY what the provided Review Report, Test Report, and Stage Outcomes actually ' +
  'state -- the exact counts, inputs, ranges, and cases they contain. Do NOT introduce ' +
  'test counts, inputs, ranges, or results -- passing OR failing -- that are not present in those ' +
  'reports. Do NOT invent a specific returned or expected value (e.g. a number a function "returned") ' +
  'unless that value appears verbatim in a report. If a ' +
  'report does not mention something (a specific n, a stress run, a count), do NOT claim ' +
  'it was tested. When in doubt, restate the report verbatim rather than elaborating.\n' +
  '- NO INVENTED RESOLUTION: Do NOT assert that any defect was fixed, any correction was applied, or ' +
  'any test was re-run and passed, unless that outcome is explicitly recorded in the Test Report slot ' +
  "or the Stage Outcomes. A reviewer's hypothesis about a cause is not evidence. When the reports " +
  'disagree or are silent, report the uncertainty rather than resolving it with invention.\n' +
  '- NO INVENTED FAILURE: The mirror of the above. Do NOT assert that any test failed, that any case ' +
  'returned a wrong value, or that any issue is unresolved, unless that is explicitly recorded in the ' +
  'Test Report slot or the Stage Outcomes. A stage that escalated on an earlier attempt but whose Test ' +
  'Report slot shows a clean pass is RESOLVED -- report the pass. Never fabricate a failing result to ' +
  'match a stale or contradictory outcome line.\n' +
  '- NO INVENTED COVERAGE: A clean pass attests ONLY to the cases the Test Report slot lists, and that ' +
  'list is complete. Do NOT generalize a pass into coverage of inputs that were not tested. Do NOT claim ' +
  'that floats, booleans, strings, negative numbers, zero, large inputs, or any other input class were ' +
  'tested, verified, exercised, or "safely rejected" unless a case for that input is named in the slot. ' +
  '"All input paths were verified" is forbidden unless every such path appears as a listed case. When the ' +
  'slot records a pass but does not name a particular input, that input was NOT covered -- omit it or say ' +
  'so plainly; never imply it passed.\n' +
  '- If no Test Report is present at all, the Test Report section MUST say that automated tests ' +
  'were not run and results are unavailable -- never fabricate a passing result from the ' +
  'code or the review.'

// -- coordinatorSystem ---------------------------------------------------------
// Builds the full decomposition system prompt, applying template overrides if set.

export function coordinatorSystem(getAgents: () => TeamAgent[], getCoordinator: () => CoordinatorConfig): string {
  const coordinator = getCoordinator()
  const agents = getAgents()
  const override = coordinator.decompositionPrompt?.trim()
  if (override) {
    return applyTemplateVars(override, {
      AGENT_ROSTER:     agentRoleSummaries(),
      PIPELINE_EXAMPLE: buildPipelineExample(),
      AGENT_COUNT:      String(Math.min(agents.length, 4)),
      AGENT_NAMES:      agentNames(),
    })
  }
  return defaultDecompositionPrompt()
}
