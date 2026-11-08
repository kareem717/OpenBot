import { sha256 } from "@noble/hashes/sha2.js";
import {
  RPC_JSON_FILE_MAX_BYTES,
  RPC_JSON_FILE_MIME,
  rpcJsonFileName,
} from "@openbot/contracts/team-protocol/rpc-json-files-v1";
import {
  decodeTeamProtocolV2FileChunk,
  decodeTeamProtocolV2FileControlFrame,
  encodeTeamProtocolV2Frame,
} from "@openbot/contracts/team-protocol/v2";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { FileTransferError, fileTransferError, MOBILE_ATTACHMENT_BYTES } from "./file-upload";

function transferFailure(message: string): FileTransferError {
  return new FileTransferError({ message });
}

interface Download {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  received: number;
  digest: string;
  complete: boolean;
  /** An allowed larger file. It does not count against the attachment total. */
  allowed: boolean;
  jsonRequest?: string;
  timer: ReturnType<typeof setTimeout>;
}

interface DownloadAllowance {
  maxBytes: number;
  /** Without a type, the allowance takes a larger file of any type. */
  mimeType: string | undefined;
  taken: boolean;
}

/** Receives the released file protocol; bytes are exposed only after digest validation. */
export function createRemoteFileReceiver<E, R>(send: (data: string) => Effect.Effect<void, E, R>) {
  const downloads = new Map<string, Download>();
  // Requests that wait for one file larger than an attachment, such as a transfer file. Each one
  // takes the first larger file of its type that fits it, and it ends with its request.
  const allowances = new Set<DownloadAllowance>();
  const jsonRequests = new Map<string, { progress: () => void; failed: (error: Error) => void }>();
  const waiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  // The reason of each file that ended before its request read it. The host sends the file before it
  // answers the request, so a refused file usually has no waiter yet. Its request then fails with this
  // reason at once, not with a timeout a minute later.
  const ended = new Map<string, string>();
  function remove(id: string) {
    const entry = downloads.get(id);
    if (entry) clearTimeout(entry.timer);
    downloads.delete(id);
  }
  /** Ends the download and the request that waits for it, so the request does not wait for the timeout. */
  function fail(id: string, message: string) {
    const entry = downloads.get(id);
    if (entry?.jsonRequest) jsonRequests.get(entry.jsonRequest)?.failed(new Error(message));
    remove(id);
    const waiter = waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(id);
      waiter.reject(new Error(message));
      return;
    }
    // A JSON request hears of the failure above and never takes the file.
    if (entry?.jsonRequest) return;
    ended.set(id, message);
    for (const old of ended.keys()) {
      if (ended.size <= 32) break;
      ended.delete(old);
    }
  }
  function expire(id: string) {
    fail(id, sourceText("error.remote.downloadTimeout"));
  }
  function touch(id: string) {
    const entry = downloads.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => expire(id), 60_000);
      if (entry.jsonRequest) jsonRequests.get(entry.jsonRequest)?.progress();
    }
    const waiter = waiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => expire(id), 60_000);
    }
  }
  const sendFrame = (data: string) => send(data).pipe(Effect.mapError(fileTransferError));
  const takeBytes = Effect.fn("RemoteFileReceiver.takeBytes")(function* (id: string) {
    const reason = ended.get(id);
    if (reason !== undefined) {
      ended.delete(id);
      return yield* transferFailure(reason);
    }
    if (!downloads.get(id)?.complete) {
      if (waiters.has(id) || waiters.size >= 10)
        return yield* transferFailure(sourceText("error.remote.tooManyDownloads"));
      yield* Effect.callback<void, FileTransferError>((resume) => {
        const timer = setTimeout(() => expire(id), 60_000);
        const waiter = {
          resolve: () => resume(Effect.void),
          reject: (error: Error) => resume(Effect.fail(fileTransferError(error))),
          timer,
        };
        waiters.set(id, waiter);
        return Effect.sync(() => {
          clearTimeout(timer);
          if (waiters.get(id) === waiter) waiters.delete(id);
        });
      });
    }
    const entry = downloads.get(id);
    if (!entry?.complete) return yield* transferFailure(sourceText("error.remote.downloadIncompleteRetry"));
    remove(id);
    return { name: entry.name, mimeType: entry.mimeType, bytes: entry.bytes };
  });
  const take = Effect.fn("RemoteFileReceiver.take")(function* (id: string) {
    const file = yield* takeBytes(id);
    const parts: string[] = [];
    for (let offset = 0; offset < file.bytes.length; offset += 8192)
      parts.push(String.fromCharCode(...file.bytes.subarray(offset, offset + 8192)));
    return { name: file.name, mimeType: file.mimeType, base64: btoa(parts.join("")) };
  });
  const cancelJson = Effect.fn("RemoteFileReceiver.cancelJson")(function* (requestId: string) {
    const name = rpcJsonFileName(requestId);
    jsonRequests.delete(name);
    for (const [id, entry] of downloads) {
      if (entry.jsonRequest !== name) continue;
      fail(id, sourceText("error.remote.downloadIncompleteRetry"));
      if (!entry.complete)
        yield* sendFrame(
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "file-cancel",
            transferId: id,
            reason: "The JSON response request ended.",
          }),
        );
    }
  });
  const receive = Effect.fn("RemoteFileReceiver.receive")(function* (data: string | ArrayBuffer) {
    if (typeof data !== "string") {
      const chunk = yield* Effect.try({ try: () => decodeTeamProtocolV2FileChunk(data), catch: fileTransferError });
      const entry = downloads.get(chunk.transferId);
      // A timed-out transfer may still have chunks in flight. Cancel only that
      // transfer; an expired download must not invalidate the peer connection.
      if (!entry) {
        yield* sendFrame(
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "file-cancel",
            transferId: chunk.transferId,
            reason: "The attachment download is no longer active.",
          }),
        );
        return true;
      }
      if (entry.complete || chunk.offset !== entry.received || chunk.offset + chunk.bytes.length > entry.bytes.length)
        return yield* transferFailure("The host sent an invalid attachment chunk.");
      entry.bytes.set(chunk.bytes, chunk.offset);
      entry.received += chunk.bytes.length;
      if (chunk.bytes.length > 0) touch(chunk.transferId);
      yield* sendFrame(
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "file-ack",
          transferId: chunk.transferId,
          receivedThrough: entry.received,
        }),
      );
      return true;
    }
    const frame = yield* Effect.try({
      try: () => decodeTeamProtocolV2FileControlFrame(data),
      catch: fileTransferError,
    });
    if (frame.type === "file-open") {
      if (downloads.has(frame.transferId)) return yield* transferFailure("The host repeated an attachment transfer.");
      const total = [...downloads.values()]
        .filter((entry) => !entry.allowed)
        .reduce((sum, entry) => sum + entry.bytes.length, 0);
      const json = frame.mimeType === RPC_JSON_FILE_MIME;
      const jsonRequest = json ? jsonRequests.get(frame.name) : undefined;
      const jsonTotal = [...downloads.values()]
        .filter((entry) => entry.jsonRequest !== undefined)
        .reduce((sum, entry) => sum + entry.bytes.length, 0);
      const open = [...allowances].filter(
        (entry) => !entry.taken && (entry.mimeType === undefined || entry.mimeType === frame.mimeType),
      );
      const allowance =
        !json && frame.size > MOBILE_ATTACHMENT_BYTES ? open.find((entry) => frame.size <= entry.maxBytes) : undefined;
      const invalidJson =
        json &&
        (!jsonRequest ||
          frame.size < 1 ||
          frame.size > RPC_JSON_FILE_MAX_BYTES ||
          jsonTotal + frame.size > RPC_JSON_FILE_MAX_BYTES ||
          [...downloads.values()].some((entry) => entry.jsonRequest === frame.name));
      if (allowance) allowance.taken = true;
      if (
        (json && downloads.size >= 10) ||
        invalidJson ||
        (!json &&
          !allowance &&
          (frame.size > MOBILE_ATTACHMENT_BYTES ||
            total + frame.size > MOBILE_ATTACHMENT_BYTES * 2 ||
            downloads.size >= 10))
      ) {
        if (jsonRequest) jsonRequest.failed(new Error(sourceText("error.remote.responseTooLarge")));
        yield* sendFrame(
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "file-cancel",
            transferId: frame.transferId,
            reason: json
              ? sourceText("error.remote.responseTooLarge")
              : "Attachments must be 10 MB or smaller. Download fewer files at once.",
          }),
        );
        // A request can wait for this file before it starts. It ends now, not at the timeout. A request
        // that allows a larger file gets the limit that it allows.
        fail(
          frame.transferId,
          sourceText(
            frame.size <= MOBILE_ATTACHMENT_BYTES
              ? "error.remote.tooManyDownloads"
              : open.length > 0
                ? "error.remote.fileTooLarge"
                : "error.remote.attachmentTooLarge",
          ),
        );
        return true;
      }
      downloads.set(frame.transferId, {
        name: frame.name,
        mimeType: frame.mimeType,
        bytes: new Uint8Array(frame.size),
        received: 0,
        digest: frame.sha256,
        complete: false,
        allowed: allowance !== undefined || json,
        ...(json ? { jsonRequest: frame.name } : {}),
        timer: setTimeout(() => expire(frame.transferId), 60_000),
      });
      touch(frame.transferId);
      yield* sendFrame(
        encodeTeamProtocolV2Frame({ version: 2, type: "file-ack", transferId: frame.transferId, receivedThrough: 0 }),
      );
      return true;
    }
    if (frame.type === "file-complete") {
      const entry = downloads.get(frame.transferId);
      if (!entry) return true;
      if (entry.received !== entry.bytes.length) {
        fail(frame.transferId, sourceText("error.remote.downloadIncomplete"));
        return yield* transferFailure(sourceText("error.remote.downloadIncomplete"));
      }
      const digest = Array.from(sha256(entry.bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (digest !== entry.digest) {
        fail(frame.transferId, sourceText("error.remote.downloadDamaged"));
        return yield* transferFailure(sourceText("error.remote.downloadDamaged"));
      }
      entry.complete = true;
      touch(frame.transferId);
      const waiter = waiters.get(frame.transferId);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(frame.transferId);
        waiter.resolve();
      }
      return true;
    }
    // A cancel can come before the file starts, while a request already waits for it.
    if (frame.type === "file-cancel" && (downloads.has(frame.transferId) || waiters.has(frame.transferId))) {
      const retry = downloads.get(frame.transferId)?.jsonRequest !== undefined;
      fail(
        frame.transferId,
        sourceText(retry ? "error.remote.downloadIncompleteRetry" : "error.remote.downloadStopped"),
      );
      return true;
    }
    return false;
  });
  return {
    /**
     * Lets one file of `mimeType` (any type without it) and up to `maxBytes` arrive while a request waits for it. Call the
     * answer when the request ends; a file still arriving then keeps its place.
     */
    allow(maxBytes: number, mimeType?: string) {
      const allowance: DownloadAllowance = { maxBytes, mimeType, taken: false };
      allowances.add(allowance);
      return () => {
        allowances.delete(allowance);
      };
    },
    expectJson(requestId: string, progress: () => void, failed: (error: Error) => void) {
      const name = rpcJsonFileName(requestId);
      if (jsonRequests.has(name)) throw new Error("Repeated JSON response request.");
      jsonRequests.set(name, { progress, failed });
    },
    cancelJson,
    clear() {
      jsonRequests.clear();
      for (const id of downloads.keys()) remove(id);
      ended.clear();
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(sourceText("error.remote.attachmentConnectionClosed")));
      }
      waiters.clear();
    },
    take,
    takeBytes,
    receive,
  };
}
