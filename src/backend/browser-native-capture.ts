import { Effect, Scope } from "effect";
import type { NativeImage, WebContents } from "electron";
import type { BrowserScreencastFrame, BrowserScreencastOptions } from "./browser-cdp";
import { type BrowserOperationError, browserCall, browserFailure, browserSync } from "./browser-effects";
import { createFramePacer, type FramePacer } from "./browser-screencast-pacing";

interface NativeStream {
  pacer: FramePacer<NativeImage>;
  ended?: ((error: unknown) => void) | undefined;
}

/** Owns native page captures and the one frame subscription of a tab. It never uses the debugger. */
export class BrowserNativeCapture {
  readonly #contents: WebContents;
  readonly #viewport: () => { width: number; height: number } | undefined;
  readonly #checkActive: () => void;
  readonly #streams = new Set<NativeStream>();
  #subscribed = false;

  constructor(
    contents: WebContents,
    viewport: () => { width: number; height: number } | undefined,
    checkActive: () => void,
  ) {
    this.#contents = contents;
    this.#viewport = viewport;
    this.#checkActive = checkActive;
  }

  readonly screenshot = Effect.fn("BrowserNativeCapture.screenshot")(function* (
    this: BrowserNativeCapture,
  ): Effect.fn.Return<NativeImage, BrowserOperationError> {
    yield* browserSync(this.#checkActive);
    const image = yield* browserCall(() => this.#contents.capturePage());
    yield* browserSync(this.#checkActive);
    if (image.isEmpty()) return yield* browserFailure(new Error("The native browser capture has no frame."));
    return image;
  });

  readonly startScreencast = Effect.fn("BrowserNativeCapture.startScreencast")(function* (
    this: BrowserNativeCapture,
    scope: Scope.Scope,
    options: BrowserScreencastOptions,
    onFrame: (frame: BrowserScreencastFrame) => void,
    onEnded?: (error: unknown) => void,
  ): Effect.fn.Return<() => Effect.Effect<void>, BrowserOperationError> {
    yield* browserSync(() => {
      this.#checkActive();
      this.#readViewport();
    });
    let sequence = 0;
    const stream: NativeStream = {
      ended: onEnded,
      pacer: createFramePacer((image: NativeImage) => {
        if (!this.#streams.has(stream)) return;
        try {
          this.#checkActive();
          const viewport = this.#readViewport();
          const size = image.getSize();
          if (size.width <= 0 || size.height <= 0) return;
          const scale = Math.min(1, options.maxWidth / size.width, options.maxHeight / size.height);
          const encoded =
            scale < 1
              ? image.resize({
                  width: Math.max(1, Math.round(size.width * scale)),
                  height: Math.max(1, Math.round(size.height * scale)),
                  quality: "good",
                })
              : image;
          sequence += 1;
          onFrame({ sequence, width: viewport.width, height: viewport.height, image: encoded.toJPEG(options.quality) });
        } catch (error) {
          this.#remove(stream);
          onEnded?.(error);
        }
      }),
    };
    const stop = () => Effect.sync(() => this.#remove(stream));
    yield* Scope.addFinalizer(scope, stop());
    yield* browserSync(() => {
      this.#checkActive();
      this.#streams.add(stream);
      if (this.#subscribed) return;
      this.#contents.beginFrameSubscription(false, this.#onFrame);
      this.#subscribed = true;
      this.#contents.once("destroyed", this.#onDestroyed);
    }).pipe(Effect.onError(stop));
    // A still page may not paint again after the subscription starts.
    const initial = yield* this.screenshot().pipe(Effect.onError(stop));
    if (this.#streams.has(stream)) stream.pacer.offer(initial);
    return stop;
  });

  readonly stopAll = Effect.fn("BrowserNativeCapture.stopAll")(function (this: BrowserNativeCapture) {
    return Effect.sync(() => {
      for (const stream of [...this.#streams]) this.#remove(stream);
    });
  });

  #readViewport(): { width: number; height: number } {
    const viewport = this.#viewport();
    if (
      !viewport ||
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0
    )
      throw new Error("Native browser streaming needs the current view bounds.");
    return { width: Math.max(1, Math.round(viewport.width)), height: Math.max(1, Math.round(viewport.height)) };
  }

  readonly #onFrame = (image: NativeImage): void => {
    if (image.isEmpty()) return;
    for (const stream of this.#streams) stream.pacer.offer(image);
  };

  readonly #onDestroyed = (): void => {
    for (const stream of [...this.#streams]) {
      this.#remove(stream);
      stream.ended?.(new Error("Browser tab was closed."));
    }
  };

  #remove(stream: NativeStream): void {
    if (!this.#streams.delete(stream)) return;
    stream.pacer.stop();
    if (this.#streams.size > 0 || !this.#subscribed) return;
    this.#subscribed = false;
    this.#contents.off("destroyed", this.#onDestroyed);
    if (this.#contents.isDestroyed()) return;
    try {
      this.#contents.endFrameSubscription();
    } catch {
      // Native teardown can begin before isDestroyed() changes. It releases the subscription.
    }
  }
}
