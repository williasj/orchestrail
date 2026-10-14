// -- BulletTrain exec client ------------------------------------------------------
// Talks to orchestrail-exec over HTTP as a peer, posting its own
// { name, runId, arguments } envelope. Deliberately NOT routed through
// core/tools.ts -- this is the one seam that needs zero changes if BulletTrain
// ever gets its own container. The wire format matches what orchestrail-exec
// already speaks (see add_ons/orchestrail-exec/server.mjs); nothing on the
// exec sidecar changes for BulletTrain to work.

import { BT_EXEC_URL } from './config.js'

export type BTExecTool = 'bash' | 'write_file' | 'read_file' | 'list_files'

export interface BTExecResult {
  stdout?: string
  stderr?: string
  exit_code?: number
  ok?: boolean
  path?: string
  bytes?: number
  content?: string
  entries?: Array<{ name: string; type: 'dir' | 'file' | 'link' }>
  error?: string
}

export function btWorkbenchRunId(slug: string): string {
  return 'bt-' + slug
}

export async function btExecPost(
  name: BTExecTool,
  runId: string,
  args: Record<string, unknown>,
  timeoutMs = 90_000,
): Promise<BTExecResult> {
  if (!BT_EXEC_URL) throw new Error('no exec endpoint registered (set CODE_EXEC_URL or BT_EXEC_URL)')
  const res = await fetch(BT_EXEC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, runId, arguments: args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    throw new Error(`exec ${name} HTTP ${res.status}: ${body}`)
  }
  const data = await res.json() as Record<string, unknown>
  return (data['result'] ?? data) as BTExecResult
}

export async function btBash(runId: string, command: string, stdin?: string, timeoutMs?: number): Promise<BTExecResult> {
  return btExecPost('bash', runId, { command, stdin: stdin ?? '' }, timeoutMs)
}

export async function btWriteFile(runId: string, path: string, content: string): Promise<BTExecResult> {
  return btExecPost('write_file', runId, { path, content })
}

export async function btReadFile(runId: string, path: string): Promise<BTExecResult> {
  return btExecPost('read_file', runId, { path })
}

export async function btListFiles(runId: string, subpath?: string): Promise<BTExecResult> {
  return btExecPost('list_files', runId, subpath !== undefined ? { path: subpath } : {})
}

/** Health check -- used to distinguish exec_unreachable from a bad command. */
export async function btExecHealthy(): Promise<boolean> {
  if (!BT_EXEC_URL) return false
  try {
    const base = BT_EXEC_URL.replace(/\/$/, '')
    const res = await fetch(base + '/health', { signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}
