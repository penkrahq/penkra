// FILE: turnRecoveryPrompts.ts
// Purpose: The recovery prompts the legacy provider command reactor still sends
// for a restarted turn. The automatic restart-recovery machinery was removed in
// 0.14.4; these strings remain only until step 11 removes the legacy reactor.
// Layer: Server orchestration
// Exports: RESTART_TURN_RECOVERY_PROMPT, PLAY_TURN_RECOVERY_PROMPT

export const RESTART_TURN_RECOVERY_PROMPT =
  "The previous turn was interrupted because Penkra stopped. Continue the existing task from the current state. Verify the current state before repeating any action whose outcome may be uncertain.";
export const PLAY_TURN_RECOVERY_PROMPT =
  "The previous turn did not finish. Continue the existing task from the current state. Verify the current state before repeating any action whose outcome may be uncertain.";
