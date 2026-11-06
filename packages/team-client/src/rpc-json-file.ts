import { RPC_JSON_FILE_MAX_BYTES, type RpcJsonFile } from "@openbot/contracts/team-protocol/rpc-json-files-v1";
import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";

/** Integrity is checked by the file receiver; the original HTTP codec checks this parsed body next. */
export function decodeRpcJsonFileBody(
  file: { name: string; mimeType: string; bytes: Uint8Array },
  metadata: RpcJsonFile,
): TeamProtocolV2Json {
  if (
    file.name !== metadata.name ||
    file.mimeType !== metadata.mimeType ||
    file.bytes.byteLength !== metadata.size ||
    file.bytes.byteLength > RPC_JSON_FILE_MAX_BYTES
  )
    throw new Error("Invalid JSON response file contents.");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
  } catch {
    // JSON parser errors can include response text. Keep it out of diagnostics and client errors.
    throw new Error("Invalid JSON response file contents.");
  }
  return decodeTeamProtocolV2Json(body);
}
