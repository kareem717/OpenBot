import {
  type EventFilterDraft,
  eventFilterDraft,
  eventFilterDraftsValid,
  eventFiltersFromDrafts,
} from "@openbot/contracts/event-filter-value";
import type { EventFilter, EventRoutine, EventRoutineOwner } from "@openbot/contracts/ipc-events";
import { RoutineWebhookCard, type RoutineWebhookCardState } from "@openbot/ui/features/conversation/RoutineWebhookCard";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createStore } from "solid-js";
import { type ChatWebhookRoutine, isWebhookRoutine } from "./chat-webhook-routines";
import type { EventRoutinesApi } from "./routine-webhooks-api";

export { type ChatWebhookRoutine, createChatWebhookRoutines } from "./chat-webhook-routines";

/** A routine read from a store is a proxy, which the desktop bridge cannot clone. */
function plainOwner(routine: EventRoutine): EventRoutineOwner {
  return { kind: routine.owner.kind, id: routine.owner.id };
}

/** One text for the events of a trigger, to compare a draft with the saved events. */
function eventsKey(events: { eventType: string | null; filters: readonly EventFilter[] }): string {
  return JSON.stringify({ eventType: events.eventType, filters: events.filters });
}

export interface RoutineWebhookChatCardProps {
  api: EventRoutinesApi;
  action: "created" | "updated";
  routine: ChatWebhookRoutine;
  connected: boolean | null;
  /** The secret that the person made in this chat, until they press Done. */
  secret: string | null;
  onSecret: (secret: string | null) => void;
  onOpenRoutine: (routine: { routineId: string; name: string }) => void;
}

type CardSave = { status: "idle" } | { status: "saving" } | { status: "saved" } | { status: "error"; message: string };

/**
 * The chat card of a webhook routine the agent created or changed. A change of the events saves
 * with Save, as the Save of the routine settings does.
 */
export function RoutineWebhookChatCard(props: RoutineWebhookChatCardProps) {
  const text = useText();
  const [card, setCard] = createStore<{
    eventType: string;
    filters: EventFilterDraft[];
    /** The saved events when the person started to edit; null with no edit. */
    base: string | null;
    save: CardSave;
    /** The save result is newer than the routine list until the list loads again. */
    saved: ChatWebhookRoutine | null;
  }>({ eventType: "", filters: [], base: null, save: { status: "idle" }, saved: null });
  const routine = createMemo(() => {
    const saved = card.saved;
    return saved && saved.updatedAt > props.routine.updatedAt ? saved : props.routine;
  });
  const draft = () => ({ eventType: card.eventType.trim() || null, filters: eventFiltersFromDrafts(card.filters) });
  // A newer save, such as the agent's, replaces the draft unless the person changed it: an edit
  // that they took back does not hold the old events.
  createEffect(
    () => (card.base !== null && eventsKey(draft()) !== card.base ? undefined : routine().trigger),
    (trigger) => {
      if (!trigger) return;
      setCard((next) => {
        next.eventType = trigger.eventType ?? "";
        next.filters = trigger.filters.map(eventFilterDraft);
        next.base = null;
      });
    },
  );
  const changed = () => eventsKey(draft()) !== eventsKey(routine().trigger);
  const valid = () => eventFilterDraftsValid(card.filters);
  // A failed save keeps Save, so the person can try again; the card shows the error with it.
  const retry = () => card.save.status === "error" && card.base !== null && valid() && changed();
  const state = (): RoutineWebhookCardState => {
    if (retry()) return "changed";
    if (card.save.status === "saving" || card.save.status === "error") return card.save.status;
    if (card.base !== null && (!valid() || changed())) return valid() ? "changed" : "error";
    return card.save.status === "saved" ? "saved" : "idle";
  };
  const errorText = () => {
    if (card.save.status === "error") return card.save.message;
    return valid() ? undefined : text.t("routine.card.webhookFiltersInvalid");
  };

  function edit(change: (next: { eventType: string; filters: EventFilterDraft[] }) => void): void {
    const base = card.base ?? eventsKey(routine().trigger);
    setCard((next) => {
      change(next);
      next.base = base;
      if (next.save.status !== "saving") next.save = { status: "idle" };
    });
  }

  async function save(): Promise<void> {
    if (card.save.status === "saving" || !valid()) return;
    const current = routine();
    setCard((next) => {
      next.save = { status: "saving" };
    });
    try {
      // The policies are left out, so the host keeps the saved ones.
      const result = await props.api.saveRoutine({
        id: current.id,
        owner: plainOwner(current),
        name: current.name,
        instruction: current.instruction,
        active: current.active,
        timezone: current.timezone,
        trigger: { kind: "webhook", ...draft() },
      });
      setCard((next) => {
        if (isWebhookRoutine(result.routine)) next.saved = result.routine;
        next.base = null;
        next.save = { status: "saved" };
      });
    } catch (caught) {
      setCard((next) => {
        next.save = { status: "error", message: text.errorMessage(caught, text.t("routine.card.webhookSaveFailed")) };
      });
    }
  }

  return (
    <RoutineWebhookCard
      action={props.action}
      routineName={routine().name}
      url={routine().trigger.url}
      connected={props.connected}
      secret={props.secret}
      onSecretDismiss={() => props.onSecret(null)}
      onRegenerateSecret={async () => {
        const result = await props.api.rotateSecret({ owner: plainOwner(routine()), id: routine().id });
        props.onSecret(result.secret);
      }}
      eventType={card.eventType}
      filters={card.filters}
      onEventTypeChange={(eventType) =>
        edit((next) => {
          next.eventType = eventType;
        })
      }
      onFiltersChange={(filters) =>
        edit((next) => {
          next.filters = filters;
        })
      }
      state={state()}
      errorText={errorText()}
      onSave={() => void save()}
      onOpenRoutine={() => props.onOpenRoutine({ routineId: routine().id, name: routine().name })}
    />
  );
}
