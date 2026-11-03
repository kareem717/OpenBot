import type { InstalledSkill } from "@openbot/contracts/ipc";
import {
  SKILL_PAGE_ROUTES,
  SKILL_PAGE_SIZE,
  SKILL_PAGES_CAPABILITY,
} from "@openbot/contracts/team-protocol/skill-pages-v1";
import { SKILLS_ADMIN_CAPABILITY } from "@openbot/contracts/team-protocol/skills-admin-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAdmin, TeamApiAgents, TeamApiOptions } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import {
  readJson,
  requireAdmin,
  requireVisibleBodyAgent,
  stringField,
  WEBRTC_FRAME_BODY_BUDGET,
} from "./request-helpers";

export interface SkillPagesRouteDependencies {
  agents: Pick<TeamApiAgents, "listAgents">;
  admin: TeamApiAdmin | undefined;
  skills: TeamApiOptions["skills"];
}

/** The admin list and member-readable chat-tag list keep their existing authorization boundaries. */
export async function routeSkillPages(
  context: TeamApiRequestContext,
  { agents, admin, skills }: SkillPagesRouteDependencies,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  const adminPage = url.pathname === SKILL_PAGE_ROUTES.admin;
  const chatPage = url.pathname === SKILL_PAGE_ROUTES.chat;
  if (method !== "POST" || (!adminPage && !chatPage) || !capabilities.has(SKILL_PAGES_CAPABILITY)) return "unmatched";
  const managedSkills = admin?.skills;
  const read = adminPage
    ? managedSkills && ((agentId: string) => managedSkills.listInstalled(agentId))
    : skills && ((agentId: string) => skills.listInstalledForChatTags(agentId));
  if (adminPage) {
    if (!managedSkills || !capabilities.has(SKILLS_ADMIN_CAPABILITY))
      throw new HttpError(400, sourceText("error.team.skillsUnsupported"));
    requireAdmin(member);
  }
  if (!read) {
    throw new HttpError(400, sourceText("error.team.skillsUnsupported"));
  }
  const body = await readJson(request);
  requireVisibleBodyAgent(body, hiddenAgentIds);
  const agentId = stringField(body, "agentId");
  if (context.agentLevel(agentId) === "none" || !agents.listAgents().some((agent) => agent.id === agentId))
    throw new HttpError(404, sourceText("error.team.agentNotFound"));
  const after = body.after === null ? null : stringField(body, "after", false, 256);
  try {
    const installed = await runCauseEffect(read(agentId));
    const remaining = installed
      .filter((skill) => after === null || skill.skillId > after)
      .sort((left, right) => (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0));
    const page: InstalledSkill[] = [];
    for (const skill of remaining.slice(0, SKILL_PAGE_SIZE)) {
      page.push(skill);
      if (
        Buffer.byteLength(JSON.stringify({ skills: page, nextCursor: skill.skillId }), "utf8") >
        WEBRTC_FRAME_BODY_BUDGET
      ) {
        page.pop();
        break;
      }
    }
    if (remaining.length && !page.length)
      throw new HttpError(413, "The installed skill exceeds the response size limit.");
    return json(200, {
      skills: page,
      nextCursor: remaining.length > page.length ? (page.at(-1)?.skillId ?? null) : null,
    });
  } catch (error) {
    if (error instanceof Error && !(error instanceof HttpError)) throw new HttpError(409, error.message);
    throw error;
  }
}
