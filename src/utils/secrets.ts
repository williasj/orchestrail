// -- Secret masking -----------------------------------------------------------
// Pure helpers for displaying credentials in logs and banners without leaking
// the value. The goal is to let an operator confirm *which* credential is
// loaded (the trailing characters) while keeping the secret non-recoverable
// from the output.

/**
 * Masks a secret for safe display. Reveals only the last `visible` characters
 * and replaces the rest with `*`.
 *
 * - Empty input  -> "(empty)"
 * - Short input  (<= visible) -> fully masked, so a short value is never
 *   half-revealed.
 * - Longer input -> leading asterisks + the trailing `visible` characters.
 *
 * The masked result never contains the full raw secret, so it is safe to write
 * to a log line that may be shared or retained.
 */
export function maskSecret(secret: string, visible = 4): string {
  if (!secret) return '(empty)'
  // visible <= 0 means "reveal nothing". Guarded explicitly: `secret.slice(-0)`
  // is `slice(0)` and would return the whole secret.
  if (visible <= 0 || secret.length <= visible) return '*'.repeat(secret.length)
  return '*'.repeat(secret.length - visible) + secret.slice(-visible)
}
