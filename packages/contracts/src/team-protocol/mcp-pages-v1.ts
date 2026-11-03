// Additive MCP administration for hosts whose stored server count is not bounded.
// Each page retains the released per-configuration bounds and the 32-record frame bound.
import type { McpServerConfig, McpSignInState } from "../ipc-mcp-servers";
import { decodeMcpServerConfigs, decodeMcpSignInStates } from "../ipc-mcp-servers";
import { isDynamicRecord, isString } from "../runtime-values";
import type { OptionalRouteCodec } from "./admin-wire";
import { adminRoute, boolean, empty, fields, identifier, list, nullable } from "./admin-wire";
import { MCP_ROUTES, mcpRequest, mcpResponse } from "./mcp-v1";

export const MCP_SERVER_PAGES_CAPABILITY = "mcp-server-pages-v1";
export const MCP_SERVER_PAGE_SIZE = 32;
export const MCP_PAGES_ROUTES = {
  list: "/v1/admin/mcp-servers/v2/list",
  save: "/v1/admin/mcp-servers/v2/save",
  remove: "/v1/admin/mcp-servers/v2/delete",
  toggle: "/v1/admin/mcp-servers/v2/toggle",
  signIns: "/v1/admin/mcp-servers/v2/sign-ins",
  signOut: "/v1/admin/mcp-servers/v2/sign-out",
} as const;

export interface McpServerPage {
  items: McpServerConfig[];
  nextCursor: string | null;
}
export interface McpSignInPage {
  items: McpSignInState[];
  nextCursor: string | null;
}

const pageRequest = fields({ cursor: nullable(identifier) });
const configs = (value: unknown) => mcpResponse(MCP_ROUTES.list, 200, value);
const signIns = list(fields({ mcpServerId: identifier, signedIn: boolean }), 32);

export const MCP_SERVER_PAGES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [MCP_PAGES_ROUTES.list, adminRoute(pageRequest, fields({ items: configs, nextCursor: nullable(identifier) }))],
  [MCP_PAGES_ROUTES.save, adminRoute((value) => mcpRequest(MCP_ROUTES.save, value), empty)],
  [MCP_PAGES_ROUTES.remove, adminRoute((value) => mcpRequest(MCP_ROUTES.remove, value), empty)],
  [MCP_PAGES_ROUTES.toggle, adminRoute((value) => mcpRequest(MCP_ROUTES.toggle, value), empty)],
  [MCP_PAGES_ROUTES.signIns, adminRoute(pageRequest, fields({ items: signIns, nextCursor: nullable(identifier) }))],
  [MCP_PAGES_ROUTES.signOut, adminRoute(fields({ mcpServerId: identifier }), empty)],
]);

function cursor(value: unknown): value is string | null {
  return value === null || (isString(value) && value.length > 0 && value.length <= 128);
}

export function decodeMcpServerPage(value: unknown): McpServerPage {
  if (!isDynamicRecord(value) || !Array.isArray(value.items) || value.items.length > 32 || !cursor(value.nextCursor))
    throw new Error("Invalid MCP server page.");
  return { items: decodeMcpServerConfigs(value.items), nextCursor: value.nextCursor };
}

export function decodeMcpSignInPage(value: unknown): McpSignInPage {
  if (!isDynamicRecord(value) || !Array.isArray(value.items) || value.items.length > 32 || !cursor(value.nextCursor))
    throw new Error("Invalid MCP sign-in page.");
  return { items: decodeMcpSignInStates(value.items), nextCursor: value.nextCursor };
}
