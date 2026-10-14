export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1'
export const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || 'llama3.2'

/**
 * Minimal agent descriptor used to seed the default agent roster on first
 * boot. Persisted configuration is managed by server.ts as TeamAgent[].
 */
export interface AgentConfig {
  name:          string
  model:         string
  systemPrompt?: string
}

export const DEFAULT_AGENTS: AgentConfig[] = [
  {
    name:         'software-architect',
    model:        OLLAMA_MODEL,
    systemPrompt: 'You are a senior software architect. Provide the conceptual and structural blueprint for any technical problem. Be concise — the engineer needs specs, not essays.',
  },
  {
    name:         'senior-engineer',
    model:        OLLAMA_MODEL,
    systemPrompt: 'You are a senior software engineer. Write production-ready, readable code. Be concise.',
  },
  {
    name:         'adversarial-reviewer',
    model:        OLLAMA_MODEL,
    systemPrompt: 'You are an adversarial code reviewer and test engineer. Hunt for failure. Be concise.',
  },
]
