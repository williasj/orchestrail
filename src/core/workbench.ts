// -- Workbench -----------------------------------------------------------------
// Per-pipeline key-value scratchpad. Lives in memory; cleared after response.
// Agents call workbench_list / workbench_read / workbench_write to share
// artifacts without bloating each other's context windows.
//
// The workbench is scoped to a pipeline run via AsyncLocalStorage — each
// concurrent request gets its own isolated namespace.

import { AsyncLocalStorage } from 'node:async_hooks'

export const workbenchIdStorage = new AsyncLocalStorage<string>()

// pipelineId → (slot → content)
export const workbenchStore = new Map<string, Map<string, string>>()

// Maps pipeline/workbench IDs to their conversation ID for memory persistence.
export const wbIdToConversationId = new Map<string, string>()

function wbId(): string { return workbenchIdStorage.getStore() ?? 'default' }

export function wbGet(slot: string): string | null {
  return workbenchStore.get(wbId())?.get(slot) ?? null
}

export function wbSet(slot: string, content: string): void {
  if (!workbenchStore.has(wbId())) workbenchStore.set(wbId(), new Map())
  workbenchStore.get(wbId())!.set(slot, content)
}

export function wbList(): string[] {
  return Array.from(workbenchStore.get(wbId())?.keys() ?? [])
}

export function wbClear(id: string): void {
  workbenchStore.delete(id)
}
