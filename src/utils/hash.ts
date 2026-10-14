// -- Hashing utilities ---------------------------------------------------------

/**
 * DJB2 hash shortened to a hex string. Used for conversation ID derivation
 * and Qdrant point ID generation. Caps input at 512 chars for performance.
 */
export function djb2Short(s: string): string {
  let h = 5381
  for (let i = 0; i < Math.min(s.length, 512); i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(16)
}
