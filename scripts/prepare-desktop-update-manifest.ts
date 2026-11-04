import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { desktopReleaseAssetUrl } from "../src/main/desktop-release-source";

const logger = createOpenBotLogger("desktop-update-manifest");
const manifestSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    files: z
      .array(
        z
          .object({
            url: z.string().min(1),
            sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
            size: z.number().int().positive(),
          })
          .loose(),
      )
      .min(1),
    path: z.string().min(1),
    sha512: z.string(),
  })
  .loose();

/**
 * Keep the builder's digests and block-map data. Only the download addresses change: the moving
 * feed names a fixed desktop release, so a feed change cannot change a download already in progress.
 */
export async function prepareDesktopUpdateManifest(path: string): Promise<void> {
  const manifest = manifestSchema.parse(parse(await readFile(path, "utf8")));
  const originalPath = manifest.path;
  const files = [];
  for (const file of manifest.files) {
    const name = basename(file.url);
    const url = desktopReleaseAssetUrl(manifest.version, name);
    if (
      !name.startsWith(`OpenBot-${manifest.version}-`) ||
      (file.url !== name && file.url !== url) ||
      !/\.(?:AppImage|zip|exe|dmg)$/u.test(name)
    )
      throw new Error("The update manifest names an unexpected artifact.");
    const artifact = join(resolve(path, ".."), name);
    if ((await stat(artifact)).size !== file.size)
      throw new Error("The update artifact size is not the manifest size.");
    const hash = createHash("sha512");
    for await (const chunk of createReadStream(artifact)) hash.update(chunk);
    if (hash.digest("base64") !== file.sha512) throw new Error("The update artifact SHA-512 does not match.");
    files.push({ ...file, url });
  }
  const selected = files.find((file) => basename(file.url) === basename(originalPath));
  if (!selected || selected.sha512 !== manifest.sha512)
    throw new Error("The legacy update path has no matching digest.");
  await writeFile(path, stringify({ ...manifest, path: selected.url, files }, { version: "1.1" }));
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error("Usage: bun scripts/prepare-desktop-update-manifest.ts <manifest.yml> [...]");
  for (const path of paths) {
    await prepareDesktopUpdateManifest(resolve(path));
    logger.info(`Verified and prepared ${basename(path)} for the isolated desktop feed.`);
  }
}
