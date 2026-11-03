// Checks memory storage through the real stores, tool staging service and SQLite database.
// No account, model provider or network is used. Writes a repeatable JSON report.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_MEMORY_CONTEXT_BUDGET_BYTES } from "@openbot/contracts/agent-memory-context";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { AgentMemories } from "../src/backend/agent/agent-memories";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { AgentStore } from "../src/backend/agent-store";
import { ChannelMemoryStore } from "../src/backend/channel-memory-store";
import { ChannelStore } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MessagingMemoryStore } from "../src/backend/messaging/messaging-memory-store";
import { MessagingStore } from "../src/backend/messaging/messaging-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import type { DynamicToolCallParams } from "../src/backend/protocol";

const output = resolve(import.meta.dirname, "../.openbot-build/unlimited-memory-storage-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-unlimited-memory-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const report: { checks: { name: string; passed: boolean; detail: unknown }[] } = { checks: [] };

async function open() {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  await runCauseEffect(store.initialize());
  const conversation = new ConversationRuntime(
    store,
    () => {},
    () => store.list(),
  );
  const memories = new AgentMemories({
    store,
    conversation,
    emit: () => {},
    emitError: (code) => {
      throw new Error(`Unexpected memory service error: ${code}`);
    },
    // A saved preference below the number of existing records must not restore a quota.
    limit: () => 1,
  });
  return {
    database,
    store,
    conversation,
    memories,
    channels: new ChannelMemoryStore(database),
    messaging: new MessagingMemoryStore(database),
  };
}

function call(turn: string, id: string, tool: string, args: unknown): DynamicToolCallParams {
  return { threadId: "memory-check-thread", turnId: turn, callId: id, namespace: "openbot", tool, arguments: args };
}

function checked(name: string, detail: unknown): void {
  report.checks.push({ name, passed: true, detail });
}

let service = await open();
try {
  const agent = await runCauseEffect(
    service.store.createAgent({
      name: "Memory check",
      description: "Storage checks.",
      avatarSeed: "memory-check",
      avatarHue: null,
    }),
  );
  const duplicate = await runCauseEffect(
    service.store.createAgent({
      name: "Memory copy",
      description: "Copy checks.",
      avatarSeed: "memory-copy",
      avatarHue: null,
    }),
  );
  for (let index = 0; index < 600; index += 1)
    service.memories.create({ agentId: agent.id, text: `Saved memory number ${index}.` });
  assert.equal(service.memories.list(agent.id).length, 600);
  checked("600 agent memories survive an existing preference of 1", { count: 600, oldPreference: 1 });

  const staged = service.memories.handleTool(
    call("remember-turn", "remember-call", "remember", {
      text: "A memory saved by a completed tool turn.",
      inclusion: "searchable",
    }),
    agent.id,
  );
  assert.equal(staged?.success, true);
  assert.equal(service.memories.list(agent.id).length, 600, "A staged memory is not visible before commit.");
  service.memories.finishTurn("remember-turn", "completed");
  assert.equal(service.memories.list(agent.id).length, 601);
  checked("remember commits beyond the former maximum", { count: 601 });

  const cancelled = service.memories.handleTool(
    call("cancelled-turn", "cancelled-call", "remember", {
      text: "This cancelled memory must not persist.",
      inclusion: "searchable",
    }),
    agent.id,
  );
  assert.equal(cancelled?.success, true);
  service.memories.finishTurn("cancelled-turn", "interrupted");
  assert.equal(service.memories.list(agent.id).length, 601);
  checked("an interrupted turn still discards its staged memory", { count: 601 });

  const channels = new ChannelStore(service.database);
  channels.update(
    channels.create("channel-check", {
      name: "Memory channel",
      title: "",
      instructions: "",
      members: [],
      leadAgentId: null,
    }),
  );
  const connectionId = new MessagingStore(service.database).ensureConnection(
    "slack",
    "workspace-check",
    "Memory workspace",
  ).connectionId;
  for (let index = 0; index < 100; index += 1) {
    service.channels.createManual("channel-check", `Channel fact ${index}.`);
    service.messaging.saveFromTool(connectionId, {
      text: `Messaging fact ${index}.`,
      sourceTurnId: "messaging-turn",
      commandId: `messaging-call-${index}`,
    });
  }
  assert.equal(service.channels.count("channel-check"), 100);
  assert.equal(service.messaging.count(connectionId), 100);
  checked("channel and messaging storage each exceed 64 records", { channel: 100, messaging: 100 });

  const first = service.memories.list(agent.id)[0];
  assert.ok(first);
  service.memories.create({ agentId: agent.id, text: first.text });
  assert.equal(service.memories.list(agent.id).length, 601);
  service.memories.update({ agentId: agent.id, memoryId: first.id, text: "An edited fact above the former maximum." });
  service.memories.duplicate(agent.id, duplicate.id);
  assert.equal(service.memories.list(duplicate.id).length, 601);
  checked("duplicate folding, edits and agent copying preserve all memories", { copied: 601 });

  assert.throws(() =>
    service.memories.create({ agentId: agent.id, text: "x".repeat(INPUT_LIMITS.agentMemoryText + 1) }),
  );
  assert.equal(service.memories.list(agent.id).length, 601);
  checked("the text bound still refuses oversized memory entries", { maximumCharacters: INPUT_LIMITS.agentMemoryText });

  const budgetAgent = await runCauseEffect(
    service.store.createAgent({
      name: "Context budget",
      description: "Context checks.",
      avatarSeed: "context-budget",
      avatarHue: null,
    }),
  );
  for (let index = 0; index < 20; index += 1)
    service.memories.create({ agentId: budgetAgent.id, text: `Budget entry ${index}: ${"x".repeat(470)}` });
  const selections = service.memories.selectionState(budgetAgent.id);
  assert.throws(() =>
    service.memories.setInclusions({
      agentId: budgetAgent.id,
      changes: selections.selections.map((entry) => ({
        memoryId: entry.memoryId,
        inclusion: "essential",
        expectedRevision: entry.revision,
      })),
    }),
  );
  assert.deepEqual(service.memories.selectionState(budgetAgent.id), selections);
  assert.equal(service.memories.list(budgetAgent.id).length, 20);
  checked("the separate essential-context budget still rejects oversized selections atomically", {
    maximumBytes: AGENT_MEMORY_CONTEXT_BUDGET_BYTES,
    storedMemoriesPreserved: 20,
  });

  service.conversation.dispose();
  service.database.close();
  service = await open();
  assert.equal(service.memories.list(agent.id).length, 601);
  assert.equal(service.memories.list(duplicate.id).length, 601);
  assert.equal(service.channels.count("channel-check"), 100);
  assert.equal(service.messaging.count(connectionId), 100);
  checked("all records survive closing and reopening the real database", {
    agent: 601,
    copy: 601,
    channel: 100,
    messaging: 100,
  });

  const remove = service.memories.list(agent.id)[0];
  assert.ok(remove);
  const forgotten = service.memories.handleTool(
    call("forget-turn", "forget-call", "forget_memory", { memoryId: remove.id }),
    agent.id,
  );
  assert.equal(forgotten?.success, true);
  service.memories.finishTurn("forget-turn", "completed");
  assert.equal(service.memories.list(agent.id).length, 600);
  assert.ok(service.channels.deleteByText("channel-check", "Channel fact 0."));
  assert.equal(service.channels.count("channel-check"), 99);
  const messaging = service.messaging.list(connectionId)[0];
  assert.ok(messaging);
  assert.ok(service.messaging.delete(connectionId, messaging.id));
  assert.equal(service.messaging.count(connectionId), 99);
  service.memories.clear(agent.id);
  service.channels.clear("channel-check");
  service.messaging.clear(connectionId);
  assert.equal(service.memories.list(agent.id).length, 0);
  assert.equal(service.channels.count("channel-check"), 0);
  assert.equal(service.messaging.count(connectionId), 0);
  assert.equal(service.memories.list(duplicate.id).length, 601);
  checked("forget, delete and clear work without changing another owner's memories", { remainingCopy: 601 });
} finally {
  service.conversation.dispose();
  service.database.close();
  await rm(root, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
}
process.stdout.write(`${JSON.stringify({ passed: report.checks.length, artifact: join(output, "report.json") })}\n`);
