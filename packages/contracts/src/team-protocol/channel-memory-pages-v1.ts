// Optional channel-memory-pages-v1 contract. A page has bounded size; a channel has no record quota.
// Cursors use ascending memory ids, so an edit or delete cannot shift the next page.
import type { OptionalRouteCodec } from "./admin-wire";
import { adminRoute, fields, identifier, list, nullable, oneOf, string } from "./admin-wire";

export const CHANNEL_MEMORY_PAGES_CAPABILITY = "channel-memory-pages-v1";
export const CHANNEL_MEMORY_PAGE_ROUTE = "/v1/channel-memories/page";
export const CHANNEL_MEMORY_PAGE_SIZE = 256;

export const CHANNEL_MEMORY_PAGES_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    CHANNEL_MEMORY_PAGE_ROUTE,
    adminRoute(
      fields({ channelId: identifier, after: nullable(identifier) }),
      fields({
        memories: list(
          fields({
            id: identifier,
            channelId: identifier,
            text: string(500),
            origin: oneOf("automatic", "manual"),
            sourceTurnId: nullable(identifier),
            createdAt: string(64),
            updatedAt: string(64),
          }),
          CHANNEL_MEMORY_PAGE_SIZE,
        ),
        nextCursor: nullable(identifier),
      }),
    ),
  ],
]);
