// Cursor 2026.11.05-86047df returns this billing refusal as answer text, then ends successfully.
// The mode file also supplies a split refusal, a quoted notice, and valid or invalid routing text.
import { readFileSync } from "node:fs";
import { serveFakeAcpAgent } from "../acp-agent";

let sessions = 0;
serveFakeAcpAgent({
  initialize: (request, peer) =>
    peer.reply(request, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }),
  "session/new": (request, peer) =>
    peer.reply(request, {
      sessionId: `cursor-payment-${process.pid}-${++sessions}`,
      models: { availableModels: [{ modelId: "auto", name: "Auto" }], currentModelId: "auto" },
    }),
  "session/prompt": (request, peer) => {
    const modePath = process.env.FAKE_MODE_PATH;
    if (!modePath) throw new Error("The fixture needs FAKE_MODE_PATH.");
    const mode = readFileSync(modePath, "utf8");
    const chunks =
      mode === "split"
        ? ["\n\nAdd a payment", " method to continue"]
        : mode === "quote"
          ? ["Cursor returned: Add a payment method to continue"]
          : mode === "valid"
            ? [JSON.stringify({ agentId: process.env.FAKE_OWNER })]
            : mode === "malformed"
              ? ["This response has no routing JSON."]
              : ["\n\nAdd a payment method to continue"];
    for (const chunk of chunks) peer.say(request.params.sessionId, chunk);
    peer.reply(request, { stopReason: "end_turn" });
  },
});
