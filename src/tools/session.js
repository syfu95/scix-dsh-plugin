/**
 * Session-key derivation for the working-set store. Dependency-free.
 *
 * VERIFIED against installed sources (2026-11-25, read-only):
 * - dsh-tools/src/contracts.ts: ToolExecutionInput has `agent?: Agent`.
 * - dsh-agent/src/types.ts: `interface Agent { readonly id: SessionId }`.
 * - dsh-session/src/types.ts: `SessionId = Branded<'SessionId'>` — a branded
 *   string, stable per conversation.
 *
 * So the exec context DOES expose a session id: `exec.agent.id`. Tools pass
 * that string as the working-set sessionKey. When a call carries no agent
 * (e.g. a transport dispatch without one), we fall back to a single
 * plugin-instance-wide key; the store itself lives for the plugin instance
 * and is cleared on dispose(), so the fallback never outlives the plugin.
 * @module tools/session
 */

/** Fallback sessionKey when exec carries no agent identity (documented above). */
export const FALLBACK_SESSION_KEY = 'plugin-instance'

/**
 * Derive the working-set sessionKey from a tool execution context.
 * @param {{ agent?: { id?: unknown } } | undefined | null} exec
 * @returns {string}
 */
export function sessionKeyFromExec(exec) {
  const id = exec?.agent?.id
  return typeof id === 'string' && id.length > 0 ? id : FALLBACK_SESSION_KEY
}
