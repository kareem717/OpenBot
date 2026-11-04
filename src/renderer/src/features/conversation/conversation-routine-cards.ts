import type { AgentMessage, ChatActionMarkerModel } from "@openbot/ui/data";
import { createMemo } from "solid-js";
import { remoteRoutineRecovery } from "../servers/server-capabilities";
import type { ConversationProps } from "./conversation-types";
import { createChatWebhookRoutines } from "./RoutineWebhookChatCard";
import { desktopChatEventRoutinesApi } from "./routine-webhooks-api";

/** The routine cards of one history, with the same permissions in the chat and its side threads. */
export function createConversationRoutineCards(
  props: ConversationProps,
  messages: () => readonly AgentMessage[],
  historyId: () => string | undefined = () => undefined,
) {
  /**
   * An agent's record of a routine it created or changed is a card whose schedule the person can
   * change. Only a record from an agent turn has a `turnId`. A change the person made in the app
   * keeps the plain marker, so an edit on a card does not add a second card that replaces it. A
   * deleted routine also keeps the plain marker, because its schedule is not known. Only the newest
   * record of a routine is a card: each card shows the routine as it is now, so an older card would
   * repeat it. An older record keeps the plain marker.
   */
  const routineCardMarker = (message: AgentMessage | undefined, marker: ChatActionMarkerModel | undefined) =>
    message?.turnId && marker?.kind === "routine-lifecycle" ? marker : undefined;
  // The newest agent record of each routine is its one card.
  const latestRoutineMessageIds = createMemo(() => {
    const latest = new Map<string, string>();
    for (const message of messages()) {
      const marker = routineCardMarker(message, message.actionMarker);
      if (marker) latest.set(marker.routineId, message.id);
    }
    return latest;
  });
  const routineCard = (message: AgentMessage | undefined, marker: ChatActionMarkerModel) => {
    const agentId = props.agent?.id;
    const cardMarker = routineCardMarker(message, marker);
    if (!message || !cardMarker || cardMarker.action === "deleted" || !agentId) return undefined;
    if (latestRoutineMessageIds().get(cardMarker.routineId) !== message.id) return undefined;
    const routine = props.routines?.find((candidate) => candidate.id === cardMarker.routineId);
    return routine && { action: cardMarker.action, routine, agentId };
  };
  // Webhook routines load only for a person who can manage them, and only for a chat with an agent
  // record of a routine that is not a schedule routine.
  const webhookRoutinesNeeded = createMemo(() => {
    // Before the schedule routines load, every record looks like one that is not a schedule routine.
    if (!props.routines) return false;
    const scheduled = new Set(props.routines.map((routine) => routine.id));
    return messages().some((message) => {
      const marker = routineCardMarker(message, message.actionMarker);
      return marker !== undefined && marker.action !== "deleted" && !scheduled.has(marker.routineId);
    });
  });
  const webhookRoutineSource = createMemo(
    () => {
      const agentId = props.agent?.id;
      const api = webhookRoutinesNeeded() ? desktopChatEventRoutinesApi(props.server, props.runtime) : undefined;
      return agentId && api
        ? {
            api,
            agentId,
            serverId: props.server?.id,
            recovery: remoteRoutineRecovery(props.server),
            historyId: historyId(),
          }
        : undefined;
    },
    // A new adapter for the same host, agent and routes is the same source: no reload.
    {
      equals: (left, right) =>
        left?.agentId === right?.agentId &&
        left?.serverId === right?.serverId &&
        left?.recovery === right?.recovery &&
        left?.historyId === right?.historyId,
    },
  );
  const webhookRoutines = createChatWebhookRoutines(webhookRoutineSource);
  // The plain marker of a webhook routine opens it too: the host lists those routines on their own.
  const availableRoutineIds = createMemo(() =>
    props.availableRoutineIds
      ? [...props.availableRoutineIds, ...webhookRoutines.state.routines.map((routine) => routine.id)]
      : undefined,
  );
  /**
   * An agent's newest record of a webhook routine it created or changed is a card with its URL, its
   * signing secret and its events. An older record keeps the plain marker.
   */
  const webhookRoutineCard = (message: AgentMessage | undefined, marker: ChatActionMarkerModel) => {
    const source = webhookRoutineSource();
    const cardMarker = routineCardMarker(message, marker);
    if (!source || !message || !cardMarker || cardMarker.action === "deleted") return undefined;
    if (latestRoutineMessageIds().get(cardMarker.routineId) !== message.id) return undefined;
    const routine = webhookRoutines.state.routines.find((candidate) => candidate.id === cardMarker.routineId);
    return routine && { api: source.api, action: cardMarker.action, routine };
  };
  return { routineCard, webhookRoutineCard, webhookRoutines, availableRoutineIds };
}
