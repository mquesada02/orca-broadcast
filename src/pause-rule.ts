import type { AgentRecord } from './types.js';

/** An agent whose pane went away during the run. */
export function isGone(agent: AgentRecord): boolean {
  return agent.resumeStatus === 'gone';
}

/** An agent that `pause` no longer waits for: gone, confirmed, or one whose pause send failed. */
export function isSettled(agent: AgentRecord): boolean {
  return isGone(agent) || agent.pauseStatus === 'confirmed' || agent.pauseReason === 'send-failed';
}
