import type { EventRoutine, RoutineWebhookTrigger } from "@openbot/contracts/ipc-events";
import { createEffect, createStore } from "solid-js";
import type { EventRoutinesApi } from "./routine-webhooks-api";
import { agentRoutinesPort } from "./routines-port";

export type ChatWebhookRoutine = EventRoutine & { trigger: RoutineWebhookTrigger };

export function isWebhookRoutine(routine: EventRoutine): routine is ChatWebhookRoutine {
  return routine.trigger.kind === "webhook";
}

/**
 * The webhook routines of the chat's agent and the relay state of its host, for the cards of the
 * routines the agent created or changed. The list loads again on each routine change, because the
 * route sync stores the URL after the save. Undefined from `source` clears it.
 *
 * A new signing secret stays here, not in its card: the timeline removes a card that leaves the
 * view, and the old secret no longer works. It goes when the chat changes.
 */
export function createChatWebhookRoutines(source: () => { api: EventRoutinesApi; agentId: string } | undefined) {
  const [state, setState] = createStore<{
    routines: ChatWebhookRoutine[];
    connected: boolean | null;
    secrets: Record<string, string>;
  }>({ routines: [], connected: null, secrets: {} });
  let request = 0;
  createEffect(source, (current) => {
    request += 1;
    setState((draft) => {
      draft.routines = [];
      draft.connected = null;
      draft.secrets = {};
    });
    if (!current) return;
    const owner = { kind: "agent", id: current.agentId } as const;
    const load = () => {
      const loading = ++request;
      void Promise.all([current.api.listRoutines({ owner }), current.api.getStatus()])
        .then(([routines, status]) => {
          if (loading !== request) return;
          setState((draft) => {
            draft.routines = routines.filter(isWebhookRoutine);
            draft.connected = status.connected;
          });
        })
        // The plain marker stays when the host cannot list the routines.
        .catch(() => undefined);
    };
    load();
    return agentRoutinesPort(current.agentId).subscribe(load);
  });
  return {
    state,
    setSecret(routineId: string, secret: string | null): void {
      setState((draft) => {
        const others = Object.entries(draft.secrets).filter(([id]) => id !== routineId);
        draft.secrets = Object.fromEntries(secret === null ? others : [...others, [routineId, secret]]);
      });
    },
  };
}
