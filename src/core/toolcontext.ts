// -- Tool log request context --------------------------------------------------
// Extracted into its own module to break the circular dependency between
// tools.ts (which appends log entries) and conversation.ts (which persists them).

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ToolLogRequestContext {
  userId:         string   // pipelinesUser.email (or '' if unauthenticated)
  conversationId: string
  projectId?:     string   // AIWiki project the conversation is bound to (set by the server, never the model)
}

export const toolLogContextStorage = new AsyncLocalStorage<ToolLogRequestContext>()
