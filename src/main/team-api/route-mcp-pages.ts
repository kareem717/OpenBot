import {
  MCP_PAGES_ROUTES,
  MCP_SERVER_PAGE_SIZE,
  MCP_SERVER_PAGES_CAPABILITY,
} from "@openbot/contracts/team-protocol/mcp-pages-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import { parseRemoveMcpServer, parseSaveMcpServer, parseSetMcpServerEnabled } from "../ipc/mcp-inputs";
import type { McpToolRuntimePreparation } from "../ipc/mcp-server-handlers";
import type { TeamApiMcpServerOwners, TeamApiMcpServers, TeamApiMcpSignIns } from "./dependencies";
import { HttpError } from "./http-error";
import { requireMcpAccess, requireOwnMcpServer, requireOwnMcpSignIn } from "./mcp-member-access";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, stringField } from "./request-helpers";

const routes: ReadonlySet<string> = new Set(Object.values(MCP_PAGES_ROUTES));
const PAGE_BYTES = 1024 * 1024;

/** Pages use stable identifiers so deleting an earlier row does not skip a later row. */
function page<T>(items: readonly T[], cursor: string | null, id: (item: T) => string) {
  const remaining = items
    .filter((item) => cursor === null || id(item) > cursor)
    .sort((a, b) => {
      const left = id(a);
      const right = id(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const kept: T[] = [];
  for (const item of remaining.slice(0, MCP_SERVER_PAGE_SIZE)) {
    if (Buffer.byteLength(JSON.stringify([...kept, item]), "utf8") > PAGE_BYTES) break;
    kept.push(item);
  }
  if (remaining.length > 0 && kept.length === 0) throw new HttpError(413, "The MCP configuration exceeds one page.");
  const last = kept.at(-1);
  return { items: kept, nextCursor: last !== undefined && kept.length < remaining.length ? id(last) : null };
}

/**
 * Writes return no collection; clients read the complete result through pages. The access is that of
 * the `mcp-v1` routes: an administrator, or with `mcp-member-access-v1` a member, who changes or removes
 * only a server that the member added.
 */
export async function routeMcpServerPages(
  context: TeamApiRequestContext,
  mcpServers: TeamApiMcpServers | undefined,
  signIns: TeamApiMcpSignIns | undefined,
  toolRuntimes?: McpToolRuntimePreparation,
  owners?: TeamApiMcpServerOwners,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !routes.has(url.pathname)) return "unmatched";
  if (!mcpServers || !capabilities.has(MCP_SERVER_PAGES_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.mcpUnsupported"));
  const access = requireMcpAccess(member, capabilities, owners);
  const body = await readJson(request);
  if (url.pathname === MCP_PAGES_ROUTES.list || url.pathname === MCP_PAGES_ROUTES.signIns) {
    const cursor = body.cursor === null ? null : stringField(body, "cursor", false, 128);
    return url.pathname === MCP_PAGES_ROUTES.list
      ? json(
          200,
          page(mcpServers.listMcpServers(), cursor, (item) => item.id),
        )
      : json(
          200,
          page(signIns?.list() ?? [], cursor, (item) => item.mcpServerId),
        );
  }
  if (url.pathname === MCP_PAGES_ROUTES.save) {
    const input = parseSaveMcpServer(body);
    const before = new Set(mcpServers.listMcpServers().map((server) => server.id));
    if (before.has(input.config.id)) requireOwnMcpServer(access, input.config.id);
    toolRuntimes?.startToolRuntimes();
    const saved = await runCauseEffect(mcpServers.saveMcpServer(input));
    // The new row is the one the list did not have, by its name, as in the `mcp-v1` save.
    const name = input.config.name.trim();
    const added = saved.find((server) => !before.has(server.id) && server.name === name);
    if (added && owners) await runCauseEffect(owners.add(added.id, member.id));
  } else if (url.pathname === MCP_PAGES_ROUTES.remove) {
    const input = parseRemoveMcpServer(body);
    requireOwnMcpServer(access, input.mcpServerId);
    await runCauseEffect(mcpServers.removeMcpServer(input));
    if (owners) await runCauseEffect(owners.remove(input.mcpServerId));
  } else if (url.pathname === MCP_PAGES_ROUTES.toggle) {
    const parsed = parseSetMcpServerEnabled(body);
    requireOwnMcpServer(access, parsed.mcpServerId);
    if (parsed.enabled) toolRuntimes?.startToolRuntimes();
    await runCauseEffect(mcpServers.setMcpServerEnabled(parsed));
  } else {
    if (!signIns) throw new HttpError(400, sourceText("error.team.mcpUnsupported"));
    const input = parseRemoveMcpServer(body);
    requireOwnMcpSignIn(access, mcpServers.listMcpServers(), input.mcpServerId);
    await runCauseEffect(signIns.signOut(input));
  }
  return json(200, {});
}
