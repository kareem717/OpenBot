import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { parse } from "yaml";
import { z } from "zod";
import { DESKTOP_RELEASE_FEED_URL, desktopReleaseAssetUrl } from "../src/main/desktop-release-source";
import { newerRelease } from "../src/main/host-release-service";

const logger = createOpenBotLogger("desktop-feed-promotion");
const schema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  path: z.string(),
  files: z.array(z.object({ url: z.string() })).min(1),
});

/** Stop an older build, or a changed build of the same version, from moving the update feed back. */
export function checkDesktopFeedPromotion(candidateSource: string, previousSource: string | null): void {
  const candidate = schema.parse(parse(candidateSource));
  const artifact = `OpenBot-${candidate.version}-x86_64.AppImage`;
  const expected = desktopReleaseAssetUrl(candidate.version, artifact);
  if (candidate.path !== expected || !candidate.files.some((file) => file.url === expected))
    throw new Error("The candidate feed does not name its immutable Linux desktop artifact.");
  if (previousSource === null) return;
  const previous = schema.parse(parse(previousSource));
  if (candidate.version === previous.version) {
    if (candidateSource !== previousSource) throw new Error("A published desktop version cannot change.");
    return;
  }
  if (!newerRelease(candidate.version, previous.version))
    throw new Error("The desktop feed cannot move to an older version.");
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun scripts/check-desktop-feed-promotion.ts <latest-linux.yml>");
  const response = await fetch(`${DESKTOP_RELEASE_FEED_URL}latest-linux.yml`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok && response.status !== 404) throw new Error("The current desktop feed could not be checked.");
  const previous = response.status === 404 ? null : await response.text();
  if (previous !== null && Buffer.byteLength(previous, "utf8") > 65_536)
    throw new Error("The current desktop feed is too large.");
  checkDesktopFeedPromotion(await readFile(path, "utf8"), previous);
  logger.info(`Verified promotion of ${basename(path)}.`);
}
