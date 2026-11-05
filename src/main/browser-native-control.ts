import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrowserJsonValue } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Semaphore } from "effect";
import { app, type BrowserWindow, nativeImage, type Rectangle, type WebContentsView } from "electron";
import { z } from "zod";
import { type BrowserOperationError, browserCall, browserFailure, browserSync } from "../backend/browser-effects";
import type {
  BrowserNativeControl,
  BrowserNativeInput,
  BrowserNativeInputResult,
  BrowserNativeSnapshot,
} from "../backend/browser-native-control";
import type { CuaDriverRuntime } from "./cua-driver-runtime";

const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
const windowSchema = z.object({
  window_id: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  title: z.string(),
  bounds: boundsSchema,
});
const windowsSchema = z.object({ windows: z.array(windowSchema) });
const captureSchema = z.object({
  capture_id: z.string().min(1),
  screenshot_width: z.number().int().positive(),
  screenshot_height: z.number().int().positive(),
  screenshot_frame_valid: z.literal(true),
});
const keyNames: Readonly<Record<string, string>> = {
  enter: "return",
  return: "return",
  tab: "tab",
  escape: "escape",
  esc: "escape",
  backspace: "backspace",
  delete: "delete",
  arrowleft: "left",
  left: "left",
  arrowright: "right",
  right: "right",
  arrowup: "up",
  up: "up",
  arrowdown: "down",
  down: "down",
  home: "home",
  end: "end",
  pageup: "pageup",
  pagedown: "pagedown",
  space: "space",
  f5: "f5",
};

interface NativeWindow {
  tabId: string;
  view: WebContentsView;
  window: BrowserWindow;
  title: string;
  removeDocumentListeners(): void;
  generation: number;
  driverId?: number;
  proof?:
    | {
        id: string;
        captureId: string;
        width: number;
        height: number;
        bounds: Rectangle;
        driverBounds: Rectangle;
        generation: number;
      }
    | undefined;
}

interface NativeBrowserControlOptions {
  driver: CuaDriverRuntime;
  ownsDriver: boolean;
  primaryReady(): boolean;
  createWindow(title: string): BrowserWindow;
  environment: Readonly<Record<string, string>>;
  platform: NodeJS.Platform;
  windowTitle: string;
}

/** Owns an OS-driver connection and one window containing the browser host's existing page. */
export class NativeBrowserControl implements BrowserNativeControl {
  readonly #options: NativeBrowserControlOptions;
  readonly #lock = Semaphore.makeUnsafe(1);
  #session = `openbot-browser-${randomUUID()}`;
  #window: { window: BrowserWindow; title: string } | undefined;
  #active: NativeWindow | undefined;
  #client: Client | undefined;
  #transport: StdioClientTransport | undefined;

  constructor(options: NativeBrowserControlOptions) {
    this.#options = options;
  }

  ready(): boolean {
    return ["darwin", "linux"].includes(this.#options.platform) && this.#options.primaryReady();
  }

  readonly open = Effect.fn("NativeBrowserControl.open")(function* (
    this: NativeBrowserControl,
    tabId: string,
    view: WebContentsView,
  ) {
    yield* this.#lock.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* browserSync(() => this.#requireReady());
        if (this.#active && this.#active.tabId !== tabId)
          return yield* browserFailure(new Error(sourceText("error.backend.browserNativeChanged")));
        yield* this.#connect();
        if (this.#active && !this.#active.window.isDestroyed()) {
          yield* browserSync(() => {
            this.#active?.window.show();
            if (this.#options.platform === "darwin") app.focus({ steal: true });
            this.#active?.window.focus();
            view.webContents.focus();
          });
          return;
        }
        yield* browserSync(() => {
          const { window, title } = this.#getWindow();
          const invalidateDocument = () => {
            active.proof = undefined;
            active.generation += 1;
          };
          const removeDocumentListeners = () => {
            if (view.webContents.isDestroyed()) return;
            view.webContents.off("did-navigate", invalidateDocument);
            view.webContents.off("dom-ready", invalidateDocument);
            view.webContents.off("did-start-navigation", invalidateDocument);
            view.webContents.off("did-navigate-in-page", invalidateDocument);
          };
          const active: NativeWindow = { tabId, view, window, title, removeDocumentListeners, generation: 0 };
          view.webContents.on("did-navigate", invalidateDocument);
          view.webContents.on("dom-ready", invalidateDocument);
          view.webContents.on("did-start-navigation", invalidateDocument);
          view.webContents.on("did-navigate-in-page", invalidateDocument);
          this.#active = active;
          window.contentView.addChildView(view);
          const { width, height } = window.getContentBounds();
          view.setBounds({ x: 0, y: 0, width, height });
          view.setVisible(true);
          window.show();
          if (this.#options.platform === "darwin") app.focus({ steal: true });
          window.focus();
          view.webContents.focus();
          view.webContents.invalidate();
        });
        const active = this.#active;
        if (!active) return yield* browserFailure(new Error(sourceText("error.backend.browserNativeChanged")));
        yield* this.#focusWindow(active);
        yield* browserCall(() => view.webContents.capturePage()).pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(() => browserFailure(new Error(sourceText("error.backend.browserNativeFailed")))),
        );
      }),
    );
  });

  readonly close = Effect.fn("NativeBrowserControl.close")(function* (this: NativeBrowserControl, tabId: string) {
    yield* this.#lock.withPermit(
      Effect.gen({ self: this }, function* () {
        const active = this.#active;
        if (active && active.tabId !== tabId) return;
        if (active)
          yield* browserSync(() => {
            this.#detachWindow(active.window);
            if (!active.window.isDestroyed()) active.window.hide();
          });
        yield* this.#disconnect();
      }),
    );
  });

  readonly snapshot = Effect.fn("NativeBrowserControl.snapshot")(function* (
    this: NativeBrowserControl,
    tabId: string,
    checkAccess: () => void,
  ): Effect.fn.Return<BrowserNativeSnapshot, BrowserOperationError> {
    return yield* this.#lock.withPermit(
      Effect.gen({ self: this }, function* () {
        const active = yield* browserSync(() => this.#requireActive(tabId));
        yield* browserSync(checkAccess);
        yield* this.#focusWindow(active);
        const generation = active.generation;
        const captureAccess = () => {
          checkAccess();
          this.#requireActive(tabId);
          if (active.generation !== generation || !active.window.isFocused() || !active.view.webContents.isFocused())
            throw new Error(sourceText("error.backend.browserNativeChanged"));
        };
        const chosen = yield* this.#findWindow(active);
        const result = yield* this.#call(
          "get_window_state",
          {
            pid: process.pid,
            window_id: chosen.window_id,
            include_accessibility_tree: false,
            include_screenshot: true,
            max_image_dimension: 1600,
          },
          captureAccess,
        );
        const capture = yield* safeDecode(() => captureSchema.parse(result.structuredContent));
        const content = result.content;
        const screenshot = Array.isArray(content)
          ? content.find((item) => isDynamicRecord(item) && item.type === "image" && item.mimeType === "image/png")
          : undefined;
        if (
          !isDynamicRecord(screenshot) ||
          typeof screenshot.data !== "string" ||
          screenshot.data.length > 32 * 1024 * 1024
        )
          return yield* browserFailure(new Error(sourceText("error.backend.browserNativeFailed")));
        const image = `data:image/png;base64,${screenshot.data}`;
        const size = yield* browserSync(() => nativeImage.createFromDataURL(image).getSize());
        if (size.width !== capture.screenshot_width || size.height !== capture.screenshot_height)
          return yield* browserFailure(new Error(sourceText("error.backend.browserNativeChanged")));
        yield* browserSync(() => {
          checkAccess();
          this.#requireActive(tabId);
          if (active.generation !== generation || !active.window.isFocused() || !active.view.webContents.isFocused())
            throw new Error(sourceText("error.backend.browserNativeChanged"));
          active.driverId = chosen.window_id;
          active.proof = {
            id: randomUUID(),
            captureId: capture.capture_id,
            width: size.width,
            height: size.height,
            bounds: active.window.getBounds(),
            driverBounds: chosen.bounds,
            generation,
          };
        });
        const proof = active.proof;
        if (!proof) return yield* browserFailure(new Error(sourceText("error.backend.browserNativeChanged")));
        return { snapshotId: proof.id, image, width: proof.width, height: proof.height };
      }),
    );
  });

  readonly input = Effect.fn("NativeBrowserControl.input")(function* (
    this: NativeBrowserControl,
    tabId: string,
    snapshotId: string,
    input: BrowserNativeInput,
    checkAccess: () => void,
  ): Effect.fn.Return<BrowserNativeInputResult, BrowserOperationError> {
    return yield* this.#lock.withPermit(
      Effect.gen({ self: this }, function* () {
        const active = yield* browserSync(() => this.#requireActive(tabId));
        yield* browserSync(checkAccess);
        const proof = active.proof;
        const chosen = yield* this.#findWindow(active);
        if (
          !proof ||
          active.proof !== proof ||
          active.generation !== proof.generation ||
          proof.id !== snapshotId ||
          active.driverId !== chosen.window_id ||
          !sameBounds(proof.bounds, active.window.getBounds()) ||
          !sameBounds(proof.driverBounds, chosen.bounds) ||
          !active.window.isFocused() ||
          !active.view.webContents.isFocused()
        )
          return yield* browserFailure(new Error(sourceText("error.backend.browserNativeChanged")));
        if ((input.kind === "click" || input.kind === "scroll") && (input.x >= proof.width || input.y >= proof.height))
          return yield* browserFailure(new Error(sourceText("error.backend.browserNativeChanged")));
        const inputAccess = () => {
          checkAccess();
          this.#requireActive(tabId);
          if (
            active.proof !== proof ||
            active.generation !== proof.generation ||
            !sameBounds(proof.bounds, active.window.getBounds()) ||
            !active.window.isFocused() ||
            !active.view.webContents.isFocused()
          )
            throw new Error(sourceText("error.backend.browserNativeChanged"));
        };
        const target = {
          target: { kind: "window", pid: process.pid, window_id: chosen.window_id },
          delivery_mode: "foreground",
        };
        const result = yield* Effect.gen({ self: this }, function* () {
          switch (input.kind) {
            case "click":
              return yield* this.#call(
                "click",
                { ...target, x: input.x, y: input.y, capture_id: proof.captureId },
                inputAccess,
              );
            case "type":
              registerSecretValue(input.text);
              return yield* this.#call("type_text", { ...target, text: input.text, delay_ms: 0 }, inputAccess);
            case "press": {
              const keys = yield* browserSync(() => nativeKey(input.key));
              return yield* this.#call("press_key", { ...target, ...keys }, inputAccess);
            }
            case "scroll":
              return yield* this.#call(
                "scroll",
                {
                  ...target,
                  x: input.x,
                  y: input.y,
                  direction: input.direction,
                  amount: input.amount,
                  by: "line",
                },
                inputAccess,
              );
          }
        });
        const structured = result.structuredContent;
        const verification: BrowserNativeInputResult["verification"] =
          isDynamicRecord(structured) && structured.effect === "confirmed" ? "confirmed" : "unverifiable";
        return { verification };
      }),
    );
  });

  readonly destroy = Effect.fn("NativeBrowserControl.destroy")(function* (this: NativeBrowserControl) {
    const active = this.#active;
    if (active) yield* this.close(active.tabId);
    yield* browserSync(() => {
      const cached = this.#window;
      this.#window = undefined;
      if (cached && !cached.window.isDestroyed()) cached.window.destroy();
    });
    yield* this.#lock.withPermit(this.#disconnect());
    if (this.#options.ownsDriver) yield* this.#options.driver.stop().pipe(Effect.mapError(browserFailure));
  });

  readonly #disconnect = Effect.fn("NativeBrowserControl.disconnect")(function* (this: NativeBrowserControl) {
    const client = this.#client;
    const transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;
    if (client) yield* browserCall(() => client.close()).pipe(Effect.ignore);
    if (transport) yield* browserCall(() => transport.close()).pipe(Effect.ignore);
  });

  #getWindow(): { window: BrowserWindow; title: string } {
    if (this.#window && !this.#window.window.isDestroyed()) return this.#window;
    const title = `${this.#options.windowTitle} ${randomUUID()}`;
    const window = this.#options.createWindow(title);
    const cached = { window, title };
    this.#window = cached;
    const invalidate = () => {
      const active = this.#active;
      if (active?.window !== window) return;
      active.proof = undefined;
      active.generation += 1;
    };
    window.on("resize", () => {
      const active = this.#active;
      if (active?.window !== window || window.isDestroyed() || active.view.webContents.isDestroyed()) return;
      const { width, height } = window.getContentBounds();
      active.view.setBounds({ x: 0, y: 0, width, height });
      invalidate();
    });
    window.on("move", invalidate);
    window.on("blur", invalidate);
    window.on("close", () => {
      this.#detachWindow(window);
      if (this.#window === cached) this.#window = undefined;
    });
    window.once("closed", () => {
      this.#detachWindow(window);
      if (this.#window === cached) this.#window = undefined;
    });
    return cached;
  }

  #detachWindow(window: BrowserWindow): void {
    const active = this.#active;
    if (active?.window !== window) return;
    active.proof = undefined;
    active.generation += 1;
    active.removeDocumentListeners();
    this.#active = undefined;
    if (!active.view.webContents.isDestroyed()) {
      active.view.setVisible(false);
      if (!window.isDestroyed()) window.contentView.removeChildView(active.view);
    }
  }

  #requireReady(): void {
    if (!this.ready()) throw new Error(sourceText("error.backend.browserNativeUnavailable"));
  }

  #requireActive(tabId: string): NativeWindow {
    this.#requireReady();
    const active = this.#active;
    if (!active || active.tabId !== tabId || active.window.isDestroyed() || active.view.webContents.isDestroyed())
      throw new Error(sourceText("error.backend.browserNativeChanged"));
    return active;
  }

  readonly #connect = Effect.fn("NativeBrowserControl.connect")(function* (this: NativeBrowserControl) {
    if (this.#client) return;
    for (const directory of new Set([
      this.#options.environment.XDG_STATE_HOME,
      this.#options.environment.XDG_CONFIG_HOME,
    ])) {
      if (directory)
        yield* browserCall(() => mkdir(directory, { recursive: true, mode: 0o700 })).pipe(
          Effect.mapError(() => browserFailure(new Error(sourceText("error.backend.browserNativeUnavailable")))),
        );
    }
    const state = yield* this.#options.driver
      .state()
      .pipe(Effect.mapError(() => browserFailure(new Error(sourceText("error.backend.browserNativeUnavailable")))));
    const config = this.#options.driver.mcpServerConfig();
    if (state.status !== "ready" || !config)
      return yield* browserFailure(new Error(sourceText("error.backend.browserNativeUnavailable")));
    const client = new Client({ name: "openbot-native-browser", version: "1" }, { capabilities: {} });
    this.#session = `openbot-browser-${randomUUID()}`;
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...getDefaultEnvironment(),
        ...this.#options.environment,
        ...Object.fromEntries(config.env.map((entry) => [entry.key, entry.value])),
      },
      stderr: "ignore",
    });
    yield* browserCall((signal) => client.connect(transport, { signal })).pipe(
      Effect.mapError(() => browserFailure(new Error(sourceText("error.backend.browserNativeUnavailable")))),
      Effect.onError(() => browserCall(() => transport.close()).pipe(Effect.ignore)),
    );
    this.#client = client;
    this.#transport = transport;
  });

  readonly #call = Effect.fn("NativeBrowserControl.call")(function* (
    this: NativeBrowserControl,
    name: string,
    args: Record<string, BrowserJsonValue>,
    checkAccess?: () => void,
  ) {
    const client = this.#client;
    if (!client) return yield* browserFailure(new Error(sourceText("error.backend.browserNativeUnavailable")));
    const result = yield* browserCall((signal) => {
      checkAccess?.();
      return client
        .callTool({ name, arguments: { ...args, session: this.#session } }, undefined, {
          signal,
          timeout: 30_000,
        })
        .catch(() => {
          throw new Error(sourceText("error.backend.browserNativeFailed"));
        });
    });
    const structured = result.structuredContent;
    if (
      result.isError ||
      (isDynamicRecord(structured) && ["refused", "suspected_noop", "partial"].includes(String(structured.effect)))
    )
      return yield* browserFailure(new Error(sourceText("error.backend.browserNativeFailed")));
    return result;
  });

  readonly #focusWindow = Effect.fn("NativeBrowserControl.focusWindow")(function* (
    this: NativeBrowserControl,
    active: NativeWindow,
  ) {
    yield* Effect.callback<void, BrowserOperationError>((resume) => {
      const contents = active.view.webContents;
      let completed = false;
      const cleanup = () => {
        active.window.off("focus", focused);
        active.window.off("closed", changed);
        contents.off("focus", focused);
        contents.off("destroyed", changed);
      };
      const finish = (result: Effect.Effect<void, BrowserOperationError>) => {
        if (completed) return;
        completed = true;
        cleanup();
        resume(result);
      };
      const changed = () =>
        finish(Effect.fail(browserFailure(new Error(sourceText("error.backend.browserNativeChanged")))));
      const focused = () => {
        if (active.window.isDestroyed() || contents.isDestroyed()) return changed();
        if (active.window.isFocused() && contents.isFocused()) finish(Effect.void);
      };
      active.window.on("focus", focused);
      contents.on("focus", focused);
      active.window.once("closed", changed);
      contents.once("destroyed", changed);
      try {
        if (this.#options.platform === "darwin") app.focus({ steal: true });
        active.window.focus();
        contents.focus();
        focused();
      } catch {
        changed();
      }
      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeout("3 seconds"),
      Effect.mapError(() => browserFailure(new Error(sourceText("error.backend.browserNativeChanged")))),
    );
  });

  readonly #findWindow = Effect.fn("NativeBrowserControl.findWindow")(function* (
    this: NativeBrowserControl,
    active: NativeWindow,
  ) {
    const result = yield* this.#call("list_windows", { pid: process.pid, on_screen_only: true });
    const rows = yield* safeDecode(() => windowsSchema.parse(result.structuredContent));
    const candidates = rows.windows.filter((window) => window.pid === process.pid && window.title === active.title);
    if (candidates.length !== 1)
      return yield* browserFailure(new Error(sourceText("error.backend.browserNativeChanged")));
    const chosen = candidates[0];
    if (!chosen) return yield* browserFailure(new Error(sourceText("error.backend.browserNativeChanged")));
    return chosen;
  });
}

function safeDecode<A>(decode: () => A): Effect.Effect<A, BrowserOperationError> {
  return browserSync(decode).pipe(
    Effect.mapError(() => browserFailure(new Error(sourceText("error.backend.browserNativeFailed")))),
  );
}

function sameBounds(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function nativeKey(input: string): { key: string; modifiers?: string[] } {
  if (input === "Shift+Tab") return { key: "tab", modifiers: ["shift"] };
  if (input === "Control+A") return { key: "a", modifiers: ["ctrl"] };
  if (input === "Meta+A") return { key: "a", modifiers: ["cmd"] };
  const parts = input.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  if (parts.length === 0 && keyNames[key]) return { key: keyNames[key] };
  throw new Error(sourceText("error.backend.browserNativeChanged"));
}
