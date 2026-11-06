import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { BrowserJsonValue } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { redactText, registerSecretValue, registerSecretValues } from "@openbot/logging";
import { Deferred, Effect, Result } from "effect";
import type { WebContents } from "electron";
import * as webSockets from "ws";
import { z } from "zod";
import type { SendCommand } from "./browser-cdp-values";
import { type BrowserOperationError, browserCall, browserFailure, browserSync } from "./browser-effects";
import {
  type BrowserNativeInput,
  type BrowserNativeInputResult,
  browserNativeInputSchema,
} from "./browser-native-control";
import { isAllowedMainUrl } from "./browser-policy";
import { runCauseEffect } from "./effect-boundary";

const commandSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  method: z.string().min(1).max(128),
  params: z.record(z.string(), z.json()).default({}),
  sessionId: z.string().min(1).max(128).optional(),
});
const PAGE_SESSION = "openbot-page";
const sourceSchema = z.strictObject({ values: z.array(z.string().min(1).max(16_384)).min(1).max(32) });
const nativeInputSchema = z.strictObject({ snapshotId: z.string().min(1).max(128), input: browserNativeInputSchema });
const SOURCE_CAPTURE_METHODS = new Set([
  "Page.captureScreenshot",
  "Page.printToPDF",
  "Page.startScreencast",
  "Page.captureSnapshot",
]);
const SECRET_FIELDS =
  /^(?:cookie|cookies|cookieLine|associatedCookies|blockedCookies|password|passwd|token|accessToken|refreshToken|authorization|proxyAuthorization|postData|postDataEntries)$/i;
const PAGE_DOMAINS = new Set([
  "Accessibility",
  "DOM",
  "DOMSnapshot",
  "CSS",
  "Input",
  "Page",
  "Runtime",
  "Emulation",
  "Network",
  "Performance",
  "Overlay",
  "Log",
]);
const BLOCKED_METHODS = new Set([
  "Page.crash",
  "Page.close",
  "Page.setDownloadBehavior",
  "Page.handleJavaScriptDialog",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Emulation.setScriptExecutionDisabled",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
]);
// Exact methods only. Other commands require an exact audited helper hash below, or mark the origin.
const NON_SCRIPTING_METHODS = new Set([
  "Accessibility.enable",
  "Accessibility.disable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Accessibility.getRootAXNode",
  "Accessibility.getAXNodeAndAncestors",
  "Accessibility.getChildAXNodes",
  "Accessibility.queryAXTree",
  "DOM.enable",
  "DOM.disable",
  "DOM.getDocument",
  "DOM.getFlattenedDocument",
  "DOM.describeNode",
  "DOM.requestNode",
  "DOM.resolveNode",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getAttributes",
  "DOM.getOuterHTML",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "DOM.getFrameOwner",
  "DOM.requestChildNodes",
  "DOM.pushNodesByBackendIdsToFrontend",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.focus",
  "DOMSnapshot.enable",
  "DOMSnapshot.disable",
  "DOMSnapshot.captureSnapshot",
  "CSS.enable",
  "CSS.disable",
  "CSS.getComputedStyleForNode",
  "CSS.getMatchedStylesForNode",
  "CSS.getInlineStylesForNode",
  "Page.enable",
  "Page.disable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.captureScreenshot",
  "Page.stopScreencast",
  "Page.setLifecycleEventsEnabled",
  "Page.bringToFront",
  "Runtime.enable",
  "Runtime.disable",
  "Runtime.runIfWaitingForDebugger",
  "Input.insertText",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.dispatchTouchEvent",
  "Emulation.setFocusEmulationEnabled",
  "Network.enable",
  "Network.disable",
  "Network.getResponseBody",
  "Performance.enable",
  "Performance.disable",
  "Performance.getMetrics",
  "Log.enable",
  "Log.disable",
]);
// agent-browser v0.27.0 (c830d1b67dc18b754e305859f0ae587f858a1447) and v0.41.2
// (d52a5e90c372ec4710c69adc3837ac14bbd852aa), cli/src/native/{snapshot,browser,interaction}.rs.
// These exact helpers read the page and add/remove only temporary data-__ab-ci markers. They do not
// install handlers, write storage, change prototypes, or use the network. See docs/architecture/browser.md.
// Hash the full UTF-8 expression without normalization. A modified helper is untrusted script.
const SNAPSHOT_EVALUATION_HASHES = new Set([
  "74725063d5035488751fc064797673b3392e301698adf66d7d7cb68f42d95c41", // Cursor inspection.
  "e0a0131bd17e00339a6f265db007db8636023645b0b71cd8bd539f138a87a969", // Marker cleanup.
  "305d076223e0260b539f371026511ea91d1537f4b73bd1dce5252dc8fdf5b5a0", // location.href.
  "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b", // Liveness probe: 1.
]);
// The fixed fill-by-ref helpers focus the selected element and clear it with an input event. They
// accept no source or handler argument. Arbitrary callFunctionOn functions remain untrusted.
const INPUT_FUNCTION_HASHES = new Set([
  "f986c03bf1f36d338f70ac7927e015d6e99d2557eaf186a88c698cae3557a5af", // Focus.
  "02337bef426345581f9363175ae42b52f972adb815482762436b8d13b0e1971b", // Clear.
]);

function isAuditedAgentBrowserCommand(method: string, params: DynamicRecord): boolean {
  const source = method === "Runtime.evaluate" ? params.expression : params.functionDeclaration;
  const hashes = method === "Runtime.evaluate" ? SNAPSHOT_EVALUATION_HASHES : INPUT_FUNCTION_HASHES;
  return (
    (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") &&
    isString(source) &&
    hashes.has(createHash("sha256").update(source).digest("hex"))
  );
}

interface BrowserCdpBridgeOptions {
  /** Native mode keeps local secret registration but accepts no CDP socket. */
  nativeOnly?: boolean;
  nativeInput?: (
    snapshotId: string,
    input: BrowserNativeInput,
  ) => Effect.Effect<BrowserNativeInputResult, BrowserOperationError>;
  contents: WebContents;
  targetId: string;
  checkAccess(): void;
  captureAllowed(): boolean;
  send: SendCommand;
  protectSourceSecrets(): Effect.Effect<void, BrowserOperationError>;
  release(): void;
}

/** Owns one local CDP endpoint for one existing tab. It cannot discover the application renderer. */
export class BrowserCdpBridge {
  readonly #options: BrowserCdpBridgeOptions;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #server = createServer((request, response) => {
    void runCauseEffect(this.#handleHttp(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  readonly #sockets = new webSockets.WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  readonly #closed = Deferred.makeUnsafe<void>();
  readonly #frameSessions = new Set<string>();
  #socket: webSockets.WebSocket | undefined;
  #port = 0;
  #revoked = false;
  #pending = 0;
  #sourceRegistered = false;
  #hasRunScript = false;

  constructor(options: BrowserCdpBridgeOptions) {
    this.#options = options;
  }

  get endpoint(): string {
    return `ws://127.0.0.1:${this.#port}/devtools/browser/${this.#token}`;
  }

  get nativeInputUrl(): string {
    return `http://127.0.0.1:${this.#port}/devtools/browser/${this.#token}/native`;
  }

  get revoked(): boolean {
    return this.#revoked;
  }

  get hasRunScript(): boolean {
    return this.#hasRunScript;
  }

  get secretRegistrationUrl(): string {
    return `http://127.0.0.1:${this.#port}/devtools/browser/${this.#token}/secrets`;
  }

  /** Reuse the live connection's credential scope only while its original access checks pass. */
  assertAccess(): void {
    this.#checkAccess();
  }

  readonly start = Effect.fn("BrowserCdpBridge.start")(function* (this: BrowserCdpBridge) {
    registerSecretValue(this.#token);
    this.#server.on("upgrade", (request, socket, head) => {
      try {
        this.#checkAccess();
        if (
          this.#options.nativeOnly ||
          request.url !== `/devtools/browser/${this.#token}` ||
          request.headers.origin !== undefined ||
          request.headers.host !== `127.0.0.1:${this.#port}` ||
          this.#socket
        ) {
          socket.destroy();
          return;
        }
        this.#sockets.handleUpgrade(request, socket, head, (client) => {
          this.#socket = client;
          client.on("error", () => client.terminate());
          client.on("close", () => {
            if (this.#socket === client) this.#socket = undefined;
          });
          client.on("message", (data, binary) => {
            if (binary || this.#pending >= 64) {
              client.terminate();
              return;
            }
            this.#pending += 1;
            void runCauseEffect(this.#handle(data.toString(), client))
              .catch(() => this.revoke())
              .finally(() => {
                this.#pending -= 1;
              });
          });
        });
      } catch {
        socket.destroy();
      }
    });
    yield* browserCall(
      () =>
        new Promise<void>((resolve, reject) => {
          this.#server.once("error", reject);
          this.#server.listen(0, "127.0.0.1", () => {
            this.#server.off("error", reject);
            resolve();
          });
        }),
    ).pipe(Effect.onError(() => this.close()));
    const address = this.#server.address();
    if (!address || isString(address)) return yield* browserFailure(new Error("Unable to bind the tab CDP endpoint."));
    this.#port = address.port;
    this.#options.contents.debugger.on("message", this.#onMessage);
    this.#options.contents.debugger.on("detach", this.revoke);
    this.#options.contents.once("destroyed", this.revoke);
    return this.endpoint;
  });

  /** Revoke access before a protected operation starts; cleanup can finish in the tab's scope. */
  readonly revoke = (): void => {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#options.contents.debugger.off("message", this.#onMessage);
    this.#options.contents.debugger.off("detach", this.revoke);
    this.#options.contents.off("destroyed", this.revoke);
    for (const client of this.#sockets.clients) client.terminate();
    this.#socket = undefined;
    this.#frameSessions.clear();
    this.#options.release();
    this.#sockets.close();
    this.#server.close(() => Deferred.doneUnsafe(this.#closed, Effect.void));
  };

  readonly close = Effect.fn("BrowserCdpBridge.close")(function* (this: BrowserCdpBridge) {
    this.revoke();
    yield* Deferred.await(this.#closed);
  });

  #checkAccess(): void {
    if (this.#revoked) throw new Error("The tab CDP connection ended. Call connect_cdp again.");
    this.#options.checkAccess();
  }

  #targetInfo(): DynamicRecord {
    return {
      targetId: this.#options.targetId,
      type: "page",
      title: this.#options.contents.getTitle(),
      url: this.#options.contents.getURL(),
      attached: true,
      canAccessOpener: false,
    };
  }

  readonly #handleHttp = Effect.fn("BrowserCdpBridge.registerSourceSecrets")(function* (
    this: BrowserCdpBridge,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    const isNativeInput = request.url === `/devtools/browser/${this.#token}/native` && this.#options.nativeInput;
    if (
      request.method !== "POST" ||
      (!isNativeInput && request.url !== `/devtools/browser/${this.#token}/secrets`) ||
      request.headers.origin !== undefined ||
      request.headers.host !== `127.0.0.1:${this.#port}`
    ) {
      response.writeHead(404).end();
      return;
    }
    yield* browserSync(() => this.#checkAccess());
    const body = yield* browserCall(async () => {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error("Invalid local credential input.");
        length += chunk.length;
        if (length > 65_536) throw new Error("Local credential input is too large.");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    });
    if (isNativeInput) {
      const call = yield* browserSync(() => nativeInputSchema.parse(JSON.parse(body)));
      if (call.input.kind === "type" && !this.#sourceRegistered)
        return yield* browserFailure(new Error("Register local source text before native input."));
      if (call.input.kind === "type") registerSecretValue(call.input.text, { allowShort: true });
      const result = yield* isNativeInput(call.snapshotId, call.input);
      response
        .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ dispatched: true, verification: result.verification }));
      return;
    }
    const source = yield* browserSync(() => sourceSchema.parse(JSON.parse(body)));
    registerSecretValues(source.values, { allowShort: true });
    yield* this.#options.protectSourceSecrets();
    this.#sourceRegistered = true;
    yield* this.#options.send("Page.stopScreencast").pipe(Effect.ignore);
    response
      .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end('{"registered":true}');
  });

  readonly #handle = Effect.fn("BrowserCdpBridge.handle")(function* (
    this: BrowserCdpBridge,
    text: string,
    client: webSockets.WebSocket,
  ) {
    if (this.#socket !== client) return;
    const decoded = yield* browserSync(() => commandSchema.parse(JSON.parse(text))).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      this.#socket?.terminate();
      return;
    }
    const command = decoded.success;
    const result = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* browserSync(() => this.#checkAccess());
        const { method, params, sessionId } = command;
        if (!this.#options.captureAllowed() && SOURCE_CAPTURE_METHODS.has(method))
          return yield* browserFailure(new Error("Images are protected while the page holds supplied credentials."));
        if (method === "Page.navigate" && (!isString(params.url) || !isAllowedMainUrl(params.url)))
          return yield* browserFailure(new Error("This navigation URL is unavailable for an OpenBot tab."));
        if (sessionId && sessionId !== PAGE_SESSION && !this.#frameSessions.has(sessionId))
          return yield* browserFailure(new Error("Unknown tab CDP session."));
        if (method === "Browser.getVersion")
          return {
            protocolVersion: "1.3",
            product: `Chrome/${process.versions.chrome}`,
            revision: "OpenBot",
            userAgent: this.#options.contents.getUserAgent(),
            jsVersion: process.versions.v8,
          };
        if (method === "Target.getTargets") return { targetInfos: [this.#targetInfo()] };
        if (method === "Target.setDiscoverTargets") return {};
        if (
          method === "Target.getTargetInfo" ||
          method === "Target.attachToTarget" ||
          method === "Target.activateTarget"
        ) {
          if (params.targetId !== undefined && params.targetId !== this.#options.targetId)
            return yield* browserFailure(new Error("This CDP endpoint controls only its selected OpenBot tab."));
          if (method === "Target.getTargetInfo") return { targetInfo: this.#targetInfo() };
          if (method === "Target.activateTarget") return {};
          return { sessionId: PAGE_SESSION };
        }
        if (method === "Target.detachFromTarget") return {};
        if (method === "Target.setAutoAttach")
          return yield* this.#options.send(
            method,
            {
              autoAttach: params.autoAttach === true,
              waitForDebuggerOnStart: false,
              flatten: true,
              filter: [{ type: "iframe", exclude: false }],
            },
            sessionId === PAGE_SESSION ? undefined : sessionId,
          );
        if (!PAGE_DOMAINS.has(method.split(".")[0] ?? "") || BLOCKED_METHODS.has(method))
          return yield* browserFailure(new Error("This CDP command is unavailable for an OpenBot tab."));
        if (!NON_SCRIPTING_METHODS.has(method) && !isAuditedAgentBrowserCommand(method, params))
          this.#hasRunScript = true;
        return yield* this.#options.send(method, params, sessionId === PAGE_SESSION ? undefined : sessionId);
      }),
    );
    const envelope = { id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}) };
    this.#write(
      Result.isSuccess(result)
        ? { ...envelope, result: result.success }
        : {
            ...envelope,
            error: {
              code: -32000,
              message: "The OpenBot tab refused the CDP command. Check tab ownership, secure input, and user control.",
            },
          },
      client,
    );
  });

  readonly #onMessage = (_event: Electron.Event, method: string, params: DynamicRecord, sessionId?: string): void => {
    if (["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"].includes(method)) return;
    if (!this.#options.captureAllowed() && method === "Page.screencastFrame") return;
    // Child sessions can only be created by the iframe-only auto-attach above.
    if (
      method === "Target.attachedToTarget" &&
      isDynamicRecord(params.targetInfo) &&
      params.targetInfo.type === "iframe" &&
      isString(params.sessionId)
    )
      this.#frameSessions.add(params.sessionId);
    if (method === "Target.detachedFromTarget" && isString(params.sessionId))
      this.#frameSessions.delete(params.sessionId);
    if (sessionId && !this.#frameSessions.has(sessionId)) return;
    if (!PAGE_DOMAINS.has(method.split(".")[0] ?? "") && !method.startsWith("Target.")) return;
    this.#write({ method, params, sessionId: sessionId ?? PAGE_SESSION });
  };

  #write(value: DynamicRecord, client = this.#socket): void {
    try {
      this.#checkAccess();
      if (!client || client !== this.#socket || client.readyState !== webSockets.WebSocket.OPEN) return;
      if (this.#socket.bufferedAmount > 8 * 1024 * 1024) {
        this.#socket.terminate();
        return;
      }
      const safe = scrubCdp(value);
      if (isDynamicRecord(safe)) {
        if (typeof value.id === "number") safe.id = value.id;
        if (isString(value.sessionId)) safe.sessionId = value.sessionId;
      }
      this.#socket.send(JSON.stringify(safe));
    } catch {
      this.revoke();
    }
  }
}

/** Preserve protocol objects and long snapshot strings while redacting registered secret values. */
function scrubCdp(value: unknown, redactNumbers = false): BrowserJsonValue {
  if (isString(value)) return redactText(value);
  if (typeof value === "number") {
    const scrubbed = redactText(String(value));
    return !redactNumbers || scrubbed === String(value) ? value : scrubbed;
  }
  if (value === null || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => scrubCdp(entry, redactNumbers));
  if (!isDynamicRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [
        key,
        SECRET_FIELDS.test(key)
          ? "[redacted]"
          : key.toLowerCase() === "headers" && isDynamicRecord(entry)
            ? Object.fromEntries(Object.keys(entry).map((name) => [name, "[redacted]"]))
            : scrubCdp(entry, redactNumbers || key === "value"),
      ]),
  );
}
