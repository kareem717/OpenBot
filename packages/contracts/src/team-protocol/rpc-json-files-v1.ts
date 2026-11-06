// Optional transport extension. The released JSON frame limit and HTTP body codecs stay unchanged.
import { isDynamicRecord, isString } from "../runtime-values";

export const RPC_JSON_FILES_CAPABILITY = "rpc-json-files-v1";
export const RPC_JSON_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const RPC_JSON_FILE_MIME = "application/vnd.openbot.rpc-json+json";

export interface RpcJsonFile {
  transferId: string;
  name: string;
  mimeType: string;
  size: number;
}

/** The file is bound to one pending RPC, before the host starts its transfer. */
export function rpcJsonFileName(requestId: string): string {
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(requestId)) throw new Error("Invalid JSON response request id.");
  return `rpc-json-${requestId}.json`;
}

export function decodeRpcJsonFile(value: unknown, requestId: string): RpcJsonFile {
  if (
    !isDynamicRecord(value) ||
    !isString(value.transferId) ||
    !/^[A-Za-z0-9:_-]{1,128}$/u.test(value.transferId) ||
    value.name !== rpcJsonFileName(requestId) ||
    value.mimeType !== RPC_JSON_FILE_MIME ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > RPC_JSON_FILE_MAX_BYTES
  )
    throw new Error("Invalid JSON response file.");
  return { transferId: value.transferId, name: value.name, mimeType: value.mimeType, size: value.size };
}
