import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { parse } from "yaml";
import { DESKTOP_RELEASE_FEED_URL } from "../src/main/desktop-release-source";

/** A fork package must not return to the upstream or the other application's update feed. */
export function verifyDesktopUpdateSource(source: string): void {
  const metadata = parse(source);
  if (!isDynamicRecord(metadata) || metadata.provider !== "generic" || metadata.url !== DESKTOP_RELEASE_FEED_URL)
    throw new Error("The packaged update source is not the isolated desktop feed.");
}
