import type { AgentApproval, AgentTask } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import type { SidebarApproval, SidebarAttention } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import { attentionAgentId, attentionKey, type PendingAttentionPrompts } from "./agent-runtime-snapshot";

export interface AgentThreadAttentionInput {
  agents: readonly Pick<AgentProfile, "id" | "threadId">[];
  /** By `attentionKey`. */
  pendingPrompts: PendingAttentionPrompts;
  approvals: readonly AgentApproval[];
  /** Only a listed, open side thread can become an agent-row destination. Channels stay separate. */
  sideThreads?: readonly Pick<AgentTask, "id" | "agentId" | "threadId" | "state">[];
}

/**
 * One routable wait per agent. Its own chat comes first; a caller that can open a side thread may
 * include those threads too. A channel or unknown thread stays out of the agent's row.
 */
export function agentThreadAttention(input: AgentThreadAttentionInput): {
  pendingPrompts: Record<string, SidebarAttention | undefined>;
  pendingApprovals: Record<string, SidebarApproval | undefined>;
  targets: Record<string, { threadId: string; taskId: string | null } | undefined>;
} {
  const prompts = new Map(
    Object.values(input.pendingPrompts).flatMap((event) =>
      event
        ? [
            [
              attentionKey(attentionAgentId(event), event.type === "prompt" ? event.threadId : event.request.threadId),
              event,
            ] as const,
          ]
        : [],
    ),
  );
  const approvals = new Map(
    input.approvals.map((approval) => [attentionKey(approval.agentId, approval.threadId ?? null), approval]),
  );
  const pendingPrompts: Record<string, SidebarAttention | undefined> = {};
  const pendingApprovals: Record<string, SidebarApproval | undefined> = {};
  const targets: Record<string, { threadId: string; taskId: string | null } | undefined> = {};
  for (const agent of input.agents) {
    const ownKey = attentionKey(agent.id, agent.threadId);
    const own = agent.threadId && (prompts.has(ownKey) || approvals.has(ownKey));
    const sides = (input.sideThreads ?? []).filter((task) => task.agentId === agent.id && task.state !== "closed");
    const side = own
      ? undefined
      : (sides.find((task) => prompts.has(attentionKey(agent.id, task.threadId))) ??
        sides.find((task) => approvals.has(attentionKey(agent.id, task.threadId))));
    const threadId = own ? agent.threadId : side?.threadId;
    if (!threadId) continue;
    const key = attentionKey(agent.id, threadId);
    pendingPrompts[agent.id] = prompts.get(key);
    pendingApprovals[agent.id] = approvals.get(key);
    targets[agent.id] = { threadId, taskId: side?.id ?? null };
  }
  return { pendingPrompts, pendingApprovals, targets };
}
