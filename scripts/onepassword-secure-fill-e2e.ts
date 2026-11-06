// Drives the real 1Password connector, encrypted store and vault router through an injected SDK.
// Run: bun scripts/onepassword-secure-fill-e2e.ts
// Report: .openbot-build/onepassword-secure-fill-e2e/report.json
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Result } from "effect";
import { passwordVaultRouter } from "../src/backend/password-vault-router";
import { type OnePasswordClient, OnePasswordConnectorService } from "../src/main/onepassword-connector-service";
import { OnePasswordConnectorStore } from "../src/main/onepassword-connector-store";

const output = resolve(import.meta.dirname, "../.openbot-build/onepassword-secure-fill-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-onepassword-fill-"));
const stored = join(root, "onepassword.json");
const token = "fixture-service-account-token-for-secure-fill";
const password = "fixture-password-never-in-report-948175";
const code = "954172";
const origin = "https://accounts.fixture.example.test";
let now = 1_000_000;
let denyIndex = false;
let denyItem = false;
let websites = [{ url: "https://fixture.example.test", autofillBehavior: "AnywhereOnWebsite" }];
let itemReads = 0;
let indexReads = 0;
let heldRead: {
  entered: ReturnType<typeof Promise.withResolvers<void>>;
  released: ReturnType<typeof Promise.withResolvers<void>>;
} | null = null;
const sdk: OnePasswordClient = {
  vaults: {
    async list() {
      indexReads++;
      if (denyIndex) throw new Error("Fixture authentication error: missing read permission.");
      return [{ id: "fixture-vault", title: "Shared fixture" }];
    },
  },
  items: {
    async list() {
      return [{ id: "fixture-login", title: "Fixture sign-in", category: "Login", websites }];
    },
    async get() {
      itemReads++;
      if (denyItem) throw new Error("Fixture item read permission refused.");
      const held = heldRead;
      if (held) {
        held.entered.resolve();
        await held.released.promise;
      }
      return {
        fields: [
          { id: "username", fieldType: "Text", value: "fixture-user" },
          { id: "password", fieldType: "Concealed", value: password },
          { id: "totp", fieldType: "Totp", value: "fixture-otp-seed", details: { type: "Otp", content: { code } } },
        ],
        websites,
      };
    },
  },
};
const cipher = {
  encrypt: (value: string) => Buffer.from(value, "utf8").reverse(),
  decrypt: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
};
const store = new OnePasswordConnectorStore(stored, cipher);
const connector = new OnePasswordConnectorService({
  store,
  hostName: "Synthetic fixture",
  appVersion: "0.0.0-e2e",
  cliInstall: null,
  openExternal: async () => {
    throw new Error("The fixture must not open an external page.");
  },
  findCli: () => Effect.succeed([]),
  runCli: async () => {
    throw new Error("The fixture must not run the real CLI.");
  },
  createClient: async (candidate) => {
    assert.equal(candidate, token);
    return sdk;
  },
  now: () => now,
});
const report: { passed: boolean; checks: string[]; indexReads: number; itemReads: number; error?: string } = {
  passed: false,
  checks: [],
  indexReads: 0,
  itemReads: 0,
};
try {
  const connected = await Effect.runPromise(connector.connectWithToken(token));
  assert.equal(connected.state, "connected");
  assert.ok(!(await readFile(stored, "utf8")).includes(token), "The stored envelope exposed the token.");
  report.checks.push("The connector persists the token only through its cipher.");

  const router = passwordVaultRouter([{ prefix: "", vault: connector }]);
  const list = await Effect.runPromise(router.loginsFor(origin));
  assert.deepEqual(list, [
    { id: "fixture-login", title: "Fixture sign-in", username: "fixture-user", hasOneTimePassword: true },
  ]);
  assert.ok(!JSON.stringify(list).includes(password) && !JSON.stringify(list).includes(code));
  assert.equal(await Effect.runPromise(router.secretFor("fixture-login", origin, "password")), password);
  assert.equal(await Effect.runPromise(router.secretFor("fixture-login", origin, "totp")), code);
  report.checks.push("Login metadata omits values; password and computed TOTP reach the browser port.");

  assert.equal(await Effect.runPromise(router.secretFor("fixture-login", "https://unrelated.test", "password")), null);
  assert.equal(
    await Effect.runPromise(router.secretFor("fixture-login", "http://accounts.fixture.example.test", "totp")),
    null,
  );
  websites = [{ url: "https://unrelated.test", autofillBehavior: "AnywhereOnWebsite" }];
  assert.equal(await Effect.runPromise(router.secretFor("fixture-login", origin, "password")), null);
  report.checks.push("Every secret read rechecks the current HTTPS website binding.");
  websites = [{ url: origin, autofillBehavior: "Never" }];
  assert.equal(await Effect.runPromise(router.secretFor("fixture-login", origin, "totp")), null);
  websites = [{ url: origin, autofillBehavior: "ExactDomain" }];
  assert.equal(
    await Effect.runPromise(router.secretFor("fixture-login", "https://other.fixture.example.test", "password")),
    null,
  );
  report.checks.push("Never-fill and exact-domain rules remain enforced.");
  websites = [{ url: "https://fixture.example.test", autofillBehavior: "AnywhereOnWebsite" }];

  now += 5 * 60_000;
  denyIndex = true;
  const beforeFailure = indexReads;
  const denied = await Effect.runPromise(Effect.result(router.loginsFor(origin)));
  assert.ok(Result.isFailure(denied));
  assert.equal(indexReads, beforeFailure + 1, "A permission failure caused an automatic retry.");
  denyIndex = false;
  assert.equal((await Effect.runPromise(router.loginsFor(origin)))?.length, 1);
  report.checks.push("A failed vault index read stays a failure and the next allowed read recovers.");

  denyItem = true;
  assert.ok(
    Result.isFailure(await Effect.runPromise(Effect.result(router.secretFor("fixture-login", origin, "totp")))),
  );
  denyItem = false;
  assert.equal(await Effect.runPromise(router.secretFor("fixture-login", origin, "totp")), code);
  report.checks.push("A failed item read does not end the connection or cache a failed code.");

  heldRead = { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
  const pending = Effect.runPromise(router.secretFor("fixture-login", origin, "password"));
  await heldRead.entered.promise;
  await Effect.runPromise(connector.disconnect());
  heldRead.released.resolve();
  assert.equal(await pending, null);
  assert.equal(router.connected(), false);
  assert.equal(await Effect.runPromise(router.loginsFor(origin)), null);
  report.checks.push("Disconnect drops an in-flight secret and prevents later reads.");
  report.passed = true;
} catch (cause) {
  // Assertions must not put a synthetic secret into the retained report either.
  const text = cause instanceof Error ? cause.message : "The connector fixture failed.";
  report.error = [token, password, code].reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
  process.exitCode = 1;
} finally {
  heldRead?.released.resolve();
  await Effect.runPromise(connector.dispose());
  report.indexReads = indexReads;
  report.itemReads = itemReads;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  // Machine-readable: fixture counts and fixed check labels only.
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
