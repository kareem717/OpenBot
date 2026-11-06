// Drives the real channel scheduler, mailbox, and SQLite service through provider event boundaries.
// Checks that a completed turn with only progress cannot silently complete a person's task or a
// required child assignment. Valid replies and intentionally quiet routine roots stay complete.
// Uses only a temporary profile. Writes .openbot-build/channel-empty-result-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSummary, ChannelTask, ConversationMessage } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { ChannelImages } from "../src/backend/channel-images";
import { ChannelService } from "../src/backend/channel-service";
import type { ChannelAssignment } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const directory = resolve(".openbot-build/channel-empty-result-e2e");
const profile = await mkdtemp(join(tmpdir(), "openbot-channel-empty-result-"));
const events = new EventEmitter();
const errors: unknown[] = [];
const checks: { name: string; state: string; assignmentState: string }[] = [];
const database = new OpenBotDatabase(join(profile, "data"));
const mailbox = new MailboxStore(join(profile, "data"), join(profile, "shared"), database);
function fixtureAgent(name: string): AgentSummary {
  return {
    id: `agent-${randomUUID()}`,
    name,
    title: "",
    description: "Fixture channel member.",
    notifications: false,
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "medium",
    threadId: null,
    workspacePath: join(profile, name),
    preview: "",
    updatedAt: null,
    avatarSeed: name,
    avatarHue: null,
    avatarUrl: null,
  };
}
const lead = fixtureAgent("Lead");
const helper = fixtureAgent("Helper");
const agents = [lead, helper];
const service = new ChannelService(database, mailbox, new ChannelImages(join(profile, "images")), {
  agents: () => agents,
  busy: () => false,
  generate: () => Effect.succeed(JSON.stringify({ agentIds: [lead.id] })),
  spareGeneration: () => false,
  schedule: () => events.emit("changed"),
  interrupt: () => Effect.void,
  changed: () => events.emit("changed"),
  error: (error) => {
    errors.push(error);
    events.emit("changed");
  },
});
const person = { id: "fixture-person", name: "Alex" };
interface Run {
  channelId: string;
  task: ChannelTask;
  assignment: ChannelAssignment;
  threadId: string;
  turnId: string;
}

function waitFor<T>(label: string, read: () => T | null | undefined | false): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (errors.length) {
        cleanup();
        reject(new Error(`${label}: channel service reported an error.`));
        return;
      }
      const value = read();
      if (!value) return;
      cleanup();
      resolve(value);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label}: service event deadline exceeded.`));
    }, 20_000);
    const cleanup = () => {
      clearTimeout(timeout);
      events.off("changed", finish);
    };
    events.on("changed", finish);
    finish();
  });
}

async function startAssignment(channelId: string, taskId: string): Promise<Run> {
  const assignment = await waitFor("assignment delivery", () =>
    service.store
      .assignments(channelId)
      .find((item) => item.taskId === taskId && item.state === "starting" && item.deliveryId),
  );
  assert.ok(assignment.deliveryId);
  const delivery = mailbox.getDelivery(assignment.deliveryId);
  assert.ok(delivery);
  const prepared = await runCauseEffect(service.prepare(delivery));
  assert.ok(prepared);
  const turnId = randomUUID();
  await runCauseEffect(mailbox.markStarting(assignment.deliveryId));
  await runCauseEffect(mailbox.markRunning(assignment.deliveryId, turnId));
  await runCauseEffect(service.accepted(assignment.deliveryId, `session-${randomUUID()}`, turnId));
  const task = service.store.tasks(channelId).find((item) => item.id === taskId);
  assert.ok(task);
  return { channelId, task, assignment, threadId: prepared.threadId, turnId };
}

async function start(name: string, routine = false): Promise<Run> {
  const channelId = randomUUID();
  await runCauseEffect(
    service.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId,
        draft: {
          name,
          title: "",
          instructions: "Fixture requests only.",
          members: agents.map((agent) => ({ agentId: agent.id })),
          leadAgentId: lead.id,
        },
      },
      person,
    ),
  );
  await runCauseEffect(
    service.command(
      routine
        ? {
            type: "request",
            operationId: randomUUID(),
            channelId,
            text: "Check the fixture.",
            recipientAgentId: lead.id,
            requestMessageId: randomUUID(),
            origin: { kind: "routine", routineId: randomUUID(), routineName: "Quiet fixture", runId: randomUUID() },
          }
        : {
            type: "send",
            operationId: randomUUID(),
            channelId,
            text: "Check the fixture and report the result.",
            recipientAgentId: lead.id,
            replyToMessageId: null,
            attachmentDraftIds: [],
          },
      person,
    ),
  );
  const task = service.store.tasks(channelId).find((item) => item.parentTaskId === null);
  assert.ok(task);
  return startAssignment(channelId, task.id);
}

function capture(run: Run, fields: Partial<ConversationMessage>): void {
  service.event({
    type: "conversation",
    snapshot: {
      agentId: run.task.ownerAgentId ?? lead.id,
      threadId: run.threadId,
      activeTurnId: run.turnId,
      revision: 1,
      messages: [
        {
          id: randomUUID(),
          turnId: run.turnId,
          author: "assistant",
          text: "",
          createdAt: new Date().toISOString(),
          status: "completed",
          ...fields,
        },
      ],
    },
  });
}

async function finish(run: Run, expected: ChannelTask["state"], status: "completed" | "interrupted" = "completed") {
  assert.ok(run.assignment.deliveryId);
  await runCauseEffect(mailbox.markTerminal(run.assignment.deliveryId, status));
  service.event({
    type: "turn-completed",
    agentId: run.task.ownerAgentId ?? lead.id,
    threadId: run.threadId,
    turnId: run.turnId,
    status,
    origin: "user",
  });
  await waitFor("assignment completion", () =>
    service.store.assignments(run.channelId).find((item) => item.id === run.assignment.id && item.state === status),
  );
  const task = service.store.tasks(run.channelId).find((item) => item.id === run.task.id);
  assert.ok(task);
  assert.equal(task.state, expected);
  if (expected === "paused" && status === "completed")
    assert.equal(task.error, sourceText("error.backend.channelNoReply"));
  checks.push({ name: service.store.get(run.channelId).name, state: task.state, assignmentState: status });
}

async function resume(run: Run): Promise<Run> {
  await runCauseEffect(
    service.command(
      {
        type: "resume",
        operationId: randomUUID(),
        channelId: run.channelId,
        taskId: run.task.id,
        recipientAgentId: null,
      },
      person,
    ),
  );
  return startAssignment(run.channelId, run.task.id);
}

let passed = false;
try {
  await runCauseEffect(mailbox.initialize());
  database.replaceAgents(randomUUID(), agents, "fixture.agents-created");
  await finish(await start("empty turn pauses"), "paused");
  const progress = await start("commentary pauses");
  capture(progress, { itemType: "commentary", text: "I will check this." });
  await finish(progress, "paused");
  const plan = await start("plan alone pauses");
  capture(plan, { itemType: "plan", text: "Check the fixture, then report." });
  await finish(plan, "paused");
  const final = await start("final reply completes");
  capture(final, { itemType: "final_answer", text: "The fixture passed." });
  await finish(final, "completed");
  const result = await start("explicit result completes");
  await runCauseEffect(
    service.tool(result.channelId, lead.id, result.turnId, randomUUID(), "channel_result", {
      text: "The result is ready.",
    }),
  );
  await finish(result, "completed");
  const attachment = await start("attachment completes");
  capture(attachment, {
    attachments: [
      {
        id: randomUUID(),
        name: "fixture.txt",
        size: 1,
        kind: "file",
        mimeType: "text/plain",
        previewKind: "none",
        previewUrl: null,
      },
    ],
  });
  await finish(attachment, "completed");
  const question = await start("question completes");
  capture(question, {
    itemType: "question_prompt",
    questionPrompt: { requestId: randomUUID(), questions: [], resolution: null },
  });
  await finish(question, "completed");
  const change = await start("visible channel change completes");
  await runCauseEffect(
    service.tool(change.channelId, lead.id, change.turnId, randomUUID(), "channel_set_instructions", {
      instructions: "Updated fixture instructions.",
    }),
  );
  await finish(change, "completed");
  await finish(await start("quiet routine root stays complete", true), "completed");
  const oldReply = await start("old reply cannot confirm resumed task");
  capture(oldReply, { itemType: "final_answer", text: "Earlier result." });
  await finish(oldReply, "paused", "interrupted");
  await finish(await resume(oldReply), "paused");
  const oldChange = await start("old change cannot confirm resumed task");
  await runCauseEffect(
    service.tool(oldChange.channelId, lead.id, oldChange.turnId, randomUUID(), "channel_set_instructions", {
      instructions: "Earlier fixture change.",
    }),
  );
  await finish(oldChange, "paused", "interrupted");
  await finish(await resume(oldChange), "paused");
  for (const routine of [false, true]) {
    const parent = await start(
      routine ? "routine child still requires a result" : "empty child does not unblock parent",
      routine,
    );
    await runCauseEffect(
      service.tool(parent.channelId, lead.id, parent.turnId, randomUUID(), "channel_assign", {
        recipientAgentId: helper.id,
        task: "Check a child fixture.",
        expectedResult: "Report the fixture result.",
        sourceMessageIds: [parent.task.requestMessageId],
      }),
    );
    await finish(parent, "waiting");
    const child = service.store.tasks(parent.channelId).find((item) => item.parentTaskId === parent.task.id);
    assert.ok(child);
    const childRun = await startAssignment(parent.channelId, child.id);
    await finish(childRun, "paused");
    assert.equal(service.store.tasks(parent.channelId).find((item) => item.id === parent.task.id)?.state, "waiting");
    assert.equal(
      service.store.assignments(parent.channelId).filter((item) => item.taskId === child.id).length,
      1,
      "The empty child is not run again automatically.",
    );
  }
  assert.equal(errors.length, 0);
  passed = true;
} finally {
  await runCauseEffect(service.stop());
  database.close();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "report.json"), JSON.stringify({ passed, checks }, null, 2));
  await rm(profile, { recursive: true, force: true });
}
// Machine-readable summary of service outcomes, with no conversation content.
process.stdout.write(`${JSON.stringify({ passed, cases: checks.length, report: join(directory, "report.json") })}\n`);
