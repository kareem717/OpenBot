import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { DESKTOP_RELEASE_FEED_URL, desktopReleaseAssetUrl } from "../src/main/desktop-release-source";
import { HostReleaseService } from "../src/main/host-release-service";
import { checkDesktopFeedPromotion } from "./check-desktop-feed-promotion";
import { prepareDesktopUpdateManifest } from "./prepare-desktop-update-manifest";

const logger = createOpenBotLogger("desktop-feed-e2e");
const directory = await mkdtemp(join(tmpdir(), "openbot-desktop-feed-"));
const artifact = "OpenBot-0.60.1-x86_64.AppImage";
const bytes = Buffer.from("A release artifact used only by the desktop feed E2E.\n");
const sha512 = createHash("sha512").update(bytes).digest("base64");
const manifestPath = join(directory, "latest-linux.yml");
const original = stringify({
  version: "0.60.1",
  files: [{ url: artifact, sha512, size: bytes.byteLength, blockMapSize: 8 }],
  path: artifact,
  sha512,
});
let servedManifest = "";
const artifactPath = new URL(desktopReleaseAssetUrl("0.60.1", artifact)).pathname;
const server = createServer((request, response) => {
  if (request.url === "/latest-linux.yml") response.writeHead(200, { "Content-Type": "text/yaml" }).end(servedManifest);
  else if (request.url === artifactPath)
    response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(bytes);
  else response.writeHead(404).end();
});

try {
  await writeFile(join(directory, artifact), bytes);
  await writeFile(manifestPath, original);
  await prepareDesktopUpdateManifest(manifestPath);
  const prepared = await readFile(manifestPath, "utf8");
  const manifest = z
    .object({ path: z.string(), files: z.array(z.object({ url: z.string(), sha512: z.string() })) })
    .parse(parse(prepared));
  assert.equal(manifest.path, desktopReleaseAssetUrl("0.60.1", artifact));
  assert.equal(manifest.files[0]?.url, manifest.path);
  assert.equal(manifest.files[0]?.sha512, sha512);
  checkDesktopFeedPromotion(prepared, null);
  checkDesktopFeedPromotion(prepared, prepared);
  assert.throws(() => checkDesktopFeedPromotion(original, prepared));
  const newer = prepared.replaceAll("0.60.1", "0.60.2");
  checkDesktopFeedPromotion(newer, prepared);
  assert.throws(() => checkDesktopFeedPromotion(prepared, newer));
  assert.throws(() => checkDesktopFeedPromotion(`${prepared}\n`, prepared));

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const service = new HostReleaseService({
    currentVersion: "0.60.0",
    packaged: true,
    platform: "linux",
    arch: "x64",
    environment: {},
    updateStatus: () => ({ phase: "idle", managedByHost: false }),
    installationMode: "self",
    fetch: (input, init) => {
      assert.equal(input, `${DESKTOP_RELEASE_FEED_URL}latest-linux.yml`);
      return fetch(`${origin}/latest-linux.yml`, init);
    },
  });
  servedManifest = prepared;
  const state = await Effect.runPromise(service.check());
  assert.equal(state.phase, "available");
  assert.equal(state.latestVersion, "0.60.1");
  const response = await fetch(origin + new URL(manifest.path).pathname);
  assert.equal(response.status, 200);
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha512").update(downloaded).digest("base64"), sha512);
  servedManifest = original;
  assert.equal((await Effect.runPromise(service.check())).phase, "error");
  await writeFile(manifestPath, original.replace(sha512, `${"A".repeat(86)}==`));
  await assert.rejects(prepareDesktopUpdateManifest(manifestPath));
  const macFiles = [
    { name: "OpenBot-0.60.1-arm64.zip", bytes: Buffer.from("A Mac ZIP download.\n") },
    { name: "OpenBot-0.60.1-arm64.dmg", bytes: Buffer.from("A Mac DMG download.\n") },
  ];
  const macEntries = [];
  for (const file of macFiles) {
    await writeFile(join(directory, file.name), file.bytes);
    macEntries.push({
      url: file.name,
      sha512: createHash("sha512").update(file.bytes).digest("base64"),
      size: file.bytes.byteLength,
    });
  }
  const macManifestPath = join(directory, "latest-mac.yml");
  const macZip = macEntries[0];
  assert(macZip);
  await writeFile(
    macManifestPath,
    stringify({ version: "0.60.1", files: macEntries, path: macZip.url, sha512: macZip.sha512 }),
  );
  await prepareDesktopUpdateManifest(macManifestPath);
  const preparedMac = z
    .object({ path: z.string(), files: z.array(z.object({ url: z.string(), sha512: z.string() })) })
    .parse(parse(await readFile(macManifestPath, "utf8")));
  assert.equal(preparedMac.path, desktopReleaseAssetUrl("0.60.1", macZip.url));
  assert.deepEqual(
    preparedMac.files,
    macEntries.map((entry) => ({ url: desktopReleaseAssetUrl("0.60.1", entry.url), sha512: entry.sha512 })),
  );
  await writeFile(join(directory, "OpenBot-0.60.1-arm64.dmg"), "A changed DMG download.");
  await assert.rejects(prepareDesktopUpdateManifest(macManifestPath));
  await mkdir(resolve(".openbot-build"), { recursive: true });
  await writeFile(
    resolve(".openbot-build/desktop-feed-e2e.json"),
    JSON.stringify(
      {
        passed: true,
        macZipAndDmgManifestVerified: true,
        corruptMacDmgRejected: true,
        immutableArtifactDownloadVerified: true,
        sha512Preserved: true,
        upstreamRelativeManifestRejected: true,
        downgradeRejected: true,
        sameVersionMutationRejected: true,
        corruptArtifactManifestRejected: true,
      },
      null,
      2,
    ),
  );
  logger.info("Verified desktop feed discovery, immutable downloads, checksums, and monotonic promotion.");
} finally {
  if (server.listening) await new Promise<void>((complete) => server.close(() => complete()));
  await rm(directory, { recursive: true, force: true });
}
