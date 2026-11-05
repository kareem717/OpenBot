import type { Effect } from "effect";
import type { WebContentsView } from "electron";
import { z } from "zod";
import type { BrowserOperationError } from "./browser-effects";

const point = { x: z.number().int().min(0).max(32_768), y: z.number().int().min(0).max(32_768) };

/** Coordinates refer to the image from the last native snapshot, not CSS pixels. */
export const browserNativeInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), ...point }),
  z.strictObject({ kind: z.literal("type"), text: z.string().min(1).max(16_384) }),
  z.strictObject({
    kind: z.literal("press"),
    key: z.enum([
      "Enter",
      "Tab",
      "Shift+Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Control+A",
      "Meta+A",
    ]),
  }),
  z.strictObject({
    kind: z.literal("scroll"),
    ...point,
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(50).describe("Wheel notches."),
  }),
]);

export type BrowserNativeInput = z.infer<typeof browserNativeInputSchema>;

export interface BrowserNativeSnapshot {
  snapshotId: string;
  image: string;
  width: number;
  height: number;
}

export interface BrowserNativeInputResult {
  verification: "confirmed" | "unverifiable";
}

/** Main owns the native window and OS driver. No caller can supply a process or window ID. */
export interface BrowserNativeControl {
  ready(): boolean;
  open(tabId: string, view: WebContentsView): Effect.Effect<void, BrowserOperationError>;
  close(tabId: string): Effect.Effect<void, BrowserOperationError>;
  snapshot(tabId: string, checkAccess: () => void): Effect.Effect<BrowserNativeSnapshot, BrowserOperationError>;
  input(
    tabId: string,
    snapshotId: string,
    input: BrowserNativeInput,
    checkAccess: () => void,
  ): Effect.Effect<BrowserNativeInputResult, BrowserOperationError>;
}
