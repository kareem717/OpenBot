// The `cursor-agent acp` of `cursor-api-key-e2e.ts`. On `initialize` it logs which Cursor key it got,
// never the key itself: `saved` for `FAKE_SAVED_KEY`, `host` for `FAKE_HOST_KEY`, `absent` for none.
import { logEntry, serveFakeAcpAgent } from "../acp-agent";

const MODEL = "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]";
const key = process.env.CURSOR_API_KEY;
const kind =
  key === undefined
    ? "absent"
    : key === process.env.FAKE_SAVED_KEY
      ? "saved"
      : key === process.env.FAKE_HOST_KEY
        ? "host"
        : "other";

serveFakeAcpAgent({
  initialize: (request, peer) => {
    logEntry({ method: request.method, key: kind });
    peer.reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  },
  "session/new": (request, peer) =>
    peer.reply(request, {
      sessionId: `s-${process.pid}`,
      models: { availableModels: [{ modelId: MODEL, name: "GPT-5.6 Sol" }], currentModelId: MODEL },
    }),
});
