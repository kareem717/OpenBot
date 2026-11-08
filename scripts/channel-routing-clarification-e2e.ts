// Drives a routing question and the person's reply through real channel commands and SQLite.
// The model boundary selects the member only when it receives the person's latest direction.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { AgentStore } from "../src/backend/agent-store";
import { ChannelImages } from "../src/backend/channel-images";
import { ChannelService } from "../src/backend/channel-service";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const root = await mkdtemp(join(tmpdir(), "openbot-routing-clarification-"));
const reportPath = resolve(".openbot-build/channel-routing-clarification-e2e/report.json");
const database = new OpenBotDatabase(join(root, "profile"));
const agents = new AgentStore(join(root, "profile"), join(root, "home"), database);
const mailbox = new MailboxStore(join(root, "profile"), agents.sharedRoot, database);
const changes = new EventEmitter();
const errors: unknown[] = [];
const checks: string[] = [];
const actor = { id: "fixture-person", name: "Fixture Person" };
const initial = "hjhjk";
const clarification = "Get Chrissy to process the synthetic routine.";
const question = "The original request is not clear. Which member should handle it?";
let channels: ChannelService | undefined;
let modelCalls = 0;
let starts = 0;
let passed = false;

async function until(ready: () => boolean): Promise<void> {
  const signal = AbortSignal.timeout(10_000);
  while (!ready()) await once(changes, "changed", { signal });
}

try {
  await runCauseEffect(agents.initialize());
  await runCauseEffect(mailbox.initialize());
  const lead = await runCauseEffect(
    agents.createAgent({
      name: "Lead",
      description: "Fixture lead",
      avatarSeed: "lead",
      avatarHue: null,
    }),
  );
  const owner = await runCauseEffect(
    agents.createAgent({
      name: "Chrissy",
      description: "Fixture routine owner",
      avatarSeed: "owner",
      avatarHue: null,
    }),
  );
  const service = new ChannelService(database, mailbox, new ChannelImages(join(root, "images")), {
    agents: () => [lead, owner],
    busy: () => false,
    generate: (_lead, prompt) =>
      Effect.sync(() => {
        modelCalls += 1;
        // This boundary models a decision from the actual supplied context. Without the latest
        // reply in that context, the model can only ask the same question about the old request.
        return JSON.stringify(prompt.includes(clarification) ? { agentId: owner.id } : { question });
      }),
    spareGeneration: () => false,
    schedule: () => {
      starts += 1;
      changes.emit("changed");
    },
    interrupt: () => Effect.void,
    changed: () => changes.emit("changed"),
    error: (error) => {
      errors.push(error);
      changes.emit("changed");
    },
  });
  channels = service;
  const channel = service.store.create(randomUUID(), {
    name: "Routing clarification fixture",
    title: "",
    instructions: "",
    members: [{ agentId: lead.id }, { agentId: owner.id }],
    leadAgentId: lead.id,
  });
  service.store.update(channel);
  await runCauseEffect(
    service.command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId: channel.id,
        text: initial,
        recipientAgentId: null,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      actor,
    ),
  );
  await until(() => service.store.tasks(channel.id).some((task) => task.state === "paused"));
  const originalTask = service.store.tasks(channel.id)[0];
  const coordinator = service.store.messages(channel.id).find((message) => message.author.kind === "coordinator");
  assert.ok(originalTask && coordinator);
  assert.equal(originalTask.instruction, initial);
  assert.equal(coordinator.taskId, originalTask.id);
  assert.equal(starts, 0);
  checks.push("An unclear request pauses its real task and posts a linked coordinator question.");

  await runCauseEffect(
    service.command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId: channel.id,
        text: clarification,
        recipientAgentId: null,
        replyToMessageId: coordinator.id,
        attachmentDraftIds: [],
      },
      actor,
    ),
  );
  await until(() => service.store.tasks(channel.id).some((task) => task.ownerAgentId === owner.id));
  await until(() => starts === 1);
  const tasks = service.store.tasks(channel.id);
  const resumed = tasks[0];
  assert.ok(resumed);
  assert.equal(tasks.length, 1);
  assert.equal(resumed.id, originalTask.id);
  assert.equal(resumed.instruction, initial, "The original task instruction stays available as context.");
  assert.equal(resumed.ownerAgentId, owner.id);
  assert.equal(resumed.error, null);
  assert.notEqual(resumed.requestMessageId, originalTask.requestMessageId);
  assert.ok(resumed.sourceMessageIds.includes(originalTask.requestMessageId));
  assert.ok(resumed.sourceMessageIds.includes(resumed.requestMessageId));
  assert.equal(service.store.message(channel.id, resumed.requestMessageId)?.message.text, clarification);
  assert.equal(service.store.messages(channel.id).filter((message) => message.author.kind === "coordinator").length, 1);
  assert.equal(modelCalls, 2);
  checks.push(
    "A reply to the question reaches routing as the latest direction and selects the requested member without repeating the question.",
  );
  checks.push(
    "The same task keeps its original instruction and both source ids while its current request changes to the clarification.",
  );

  await runCauseEffect(service.wake(channel.id));
  await runCauseEffect(service.stop());
  assert.equal(starts, 1);
  assert.equal(service.store.assignments(channel.id).length, 1);
  assert.equal(modelCalls, 2);
  assert.equal(errors.length, 0);
  checks.push("The selected task has one queued mailbox delivery and further wake calls do not route it again.");
  passed = true;
} finally {
  if (channels) await runCauseEffect(channels.stop());
  database.close();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify({ passed, checks, modelCalls, starts, errors: errors.map(String) }, null, 2)}\n`,
  );
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ passed, checks, reportPath })}\n`);
