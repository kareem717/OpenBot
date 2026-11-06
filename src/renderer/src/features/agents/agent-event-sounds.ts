import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import {
  attentionNotificationIdentity,
  notificationRequestKey,
  pendingAttentionNotificationEvents,
} from "@openbot/team-client/agent-notifications";
import { playActionSound } from "../../action-sounds";

/**
 * Plays one cue for an agent event that the user must know about: `attention` when the agent waits
 * for an answer, and `error` when a run fails. A finished reply has its own completion sound, so it
 * plays nothing here. Desktop and the web client give the returned function each event of the
 * selected server. `notifies` gives the mute of each agent, so a muted agent stays silent, as with the
 * completion sound.
 */
export function createAgentEventSounds(
  notifies: (agentId: string) => boolean,
  play: typeof playActionSound = playActionSound,
): (event: AgentEvent | TeamRealtimeEvent) => void {
  // Requests in different threads must not replace each other's repeat markers.
  const askedRequests = new Set<string>();
  const ask = (event: AgentEvent, agentId: string) => {
    const key = notificationRequestKey("", event);
    const identity = attentionNotificationIdentity(event);
    if (key === null || identity === null) return;
    const seenKey = JSON.stringify([key, identity]);
    if (askedRequests.has(seenKey)) return;
    askedRequests.add(seenKey);
    for (const oldest of askedRequests.keys()) {
      if (askedRequests.size <= 512) break;
      askedRequests.delete(oldest);
    }
    if (notifies(agentId)) play("attention");
  };
  const handle = (event: AgentEvent | TeamRealtimeEvent) => {
    switch (event.type) {
      case "runtime-snapshot":
        for (const pending of pendingAttentionNotificationEvents(event.snapshot)) handle(pending);
        return;
      case "approval":
        ask(event, event.approval.agentId);
        return;
      case "prompt":
        ask(event, event.agentId);
        return;
      case "browser-takeover-requested":
        ask(event, event.request.agentId);
        return;
      case "turn-completed":
        // A routine or a teammate starts a run without the user, so its failure stays silent. A
        // provider retry reports an error more than once in a run, so the cue follows the run end.
        if (
          event.status === "failed" &&
          event.origin !== "routine" &&
          event.origin !== "agent" &&
          notifies(event.agentId)
        ) {
          play("error");
        }
        return;
    }
  };
  return handle;
}
