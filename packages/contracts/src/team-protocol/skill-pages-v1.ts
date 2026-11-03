// Optional skill-pages-v1 contract. A collection has no record quota; one response is a bounded page.
// Per-record fields retain the released skills-admin-v1 validation.
import type { OptionalRouteCodec } from "./admin-wire";
import { adminRoute, fields, identifier, list, nullable } from "./admin-wire";
import { SKILLS_ADMIN_CODECS, SKILLS_ADMIN_ROUTES } from "./skills-admin-v1";
import type { TeamProtocolV2Json } from "./v2";

export const SKILL_PAGES_CAPABILITY = "skill-pages-v1";
export const SKILL_PAGE_SIZE = 256;
export const SKILL_PAGE_ROUTES = {
  admin: "/v1/admin/skills/page",
  chat: "/v1/agent-skills/page",
} as const;

function cursor(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256)
    throw new Error("Invalid installed-skill cursor.");
  return value;
}

function installedSkill(value: unknown): TeamProtocolV2Json {
  const codec = SKILLS_ADMIN_CODECS.get(SKILLS_ADMIN_ROUTES.install);
  if (!codec) throw new Error("The installed-skill codec is missing.");
  return codec.response(200, value);
}

const page = adminRoute(
  fields({ agentId: identifier, after: nullable(cursor) }),
  fields({ skills: list(installedSkill, SKILL_PAGE_SIZE), nextCursor: nullable(cursor) }),
);

export const SKILL_PAGES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [SKILL_PAGE_ROUTES.admin, page],
  [SKILL_PAGE_ROUTES.chat, page],
]);
