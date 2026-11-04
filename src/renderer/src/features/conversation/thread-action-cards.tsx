import type { AgentMessage, ChatActionMarkerModel } from "@openbot/ui/data";
import { ChatActionMarker } from "@openbot/ui/features/conversation/ChatActionMarker";
import { Show } from "solid-js";
import { createConversationRoutineCards } from "./conversation-routine-cards";
import { useConversationViewScope } from "./conversation-scope";
import { agentSkillsMode } from "./installed-skills-source";
import { MarketplaceSuggestionChatCard, marketplaceSuggestionKnown } from "./MarketplaceSuggestionChatCard";
import { McpSignInChatCard } from "./McpSignInChatCard";
import { RoutineChatCard } from "./RoutineChatCard";
import { RoutineWebhookChatCard } from "./RoutineWebhookChatCard";

/** Cards use this thread's history and send Continue to this thread without changing its draft. */
export function createThreadActionCards(
  messages: () => readonly AgentMessage[],
  onContinue: (body: string) => Promise<boolean>,
  historyId: () => string | undefined,
) {
  const { props, mcpServers, openSkillSettings, openRoutineSettings, openExternalMessageUrl } =
    useConversationViewScope();
  const { routineCard, webhookRoutineCard, webhookRoutines, availableRoutineIds } = createConversationRoutineCards(
    props,
    messages,
    historyId,
  );
  const signInConfig = (marker: ChatActionMarkerModel) =>
    marker.kind === "mcp-sign-in"
      ? mcpServers().find((config) => config.id === marker.mcpServerId && config.transport === "http")
      : undefined;
  const suggestion = (marker: ChatActionMarkerModel) =>
    marker.kind === "marketplace-suggestion" && marketplaceSuggestionKnown(marker.appId) ? marker : undefined;

  const routineAvailable = (marker: ChatActionMarkerModel) => {
    if (!("routineId" in marker)) return true;
    if (marker.kind === "routine-lifecycle" && marker.action === "deleted") return false;
    return availableRoutineIds()?.includes(marker.routineId) === true;
  };

  return function ThreadActionCard(card: { message: AgentMessage }) {
    return (
      <Show when={card.message.actionMarker}>
        {(marker) => (
          <Show
            when={routineCard(card.message, marker())}
            fallback={
              <Show
                when={webhookRoutineCard(card.message, marker())}
                fallback={
                  <Show
                    when={signInConfig(marker())}
                    fallback={
                      <Show
                        when={suggestion(marker())}
                        fallback={
                          <ChatActionMarker
                            marker={marker()}
                            agents={props.agents}
                            onSelectAgent={props.onSelectAgent}
                            onOpenSkill={
                              agentSkillsMode(props.server, props.runtime) === "hidden" ? undefined : openSkillSettings
                            }
                            onOpenRoutine={openRoutineSettings}
                            routineAvailable={routineAvailable(marker())}
                            onOpenHostedSite={(url) => void openExternalMessageUrl(url)}
                          />
                        }
                      >
                        {(app) => (
                          <MarketplaceSuggestionChatCard
                            messageId={card.message.id}
                            appId={app().appId}
                            connectors={props.connectors}
                            mcpServers={mcpServers()}
                            onOpenMarketplaceApp={props.onOpenMarketplaceApp}
                          />
                        )}
                      </Show>
                    }
                  >
                    {(config) => (
                      <McpSignInChatCard
                        config={config()}
                        signedIn={props.mcpSignedIn?.(config().id) ?? false}
                        onSignIn={
                          props.onOpenMcpSignIn ? (trigger) => props.onOpenMcpSignIn?.(config().id, trigger) : undefined
                        }
                        onContinue={onContinue}
                      />
                    )}
                  </Show>
                }
              >
                {(webhook) => (
                  <RoutineWebhookChatCard
                    api={webhook().api}
                    action={webhook().action}
                    routine={webhook().routine}
                    connected={webhookRoutines.state.connected}
                    secret={webhookRoutines.state.secrets[webhook().routine.id] ?? null}
                    onSecret={(secret) => webhookRoutines.setSecret(webhook().routine.id, secret)}
                    onOpenRoutine={openRoutineSettings}
                  />
                )}
              </Show>
            }
          >
            {(routine) => (
              <RoutineChatCard
                action={routine().action}
                routine={routine().routine}
                agentId={routine().agentId}
                onOpenRoutine={openRoutineSettings}
              />
            )}
          </Show>
        )}
      </Show>
    );
  };
}
