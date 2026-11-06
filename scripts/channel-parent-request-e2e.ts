// Drives real channel commands, routing and SQLite projections on an isolated profile. The model
// boundary returns a chosen existing task to reproduce the scheduled-request continuation bug.
// No provider, live channel or user data is used. Writes .openbot-build/channel-parent-request-e2e/report.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serializeChatTagReference } from "@openbot/contracts/chat-tag-references";
import type { Channel, ChannelTask } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { z } from "zod";
import { AgentStore } from "../src/backend/agent-store";
import { ChannelImages } from "../src/backend/channel-images";
import { ChannelService } from "../src/backend/channel-service";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const root = await mkdtemp(join(tmpdir(), "openbot-channel-parent-"));
const reportPath = resolve(".openbot-build/channel-parent-request-e2e/report.json");
const database = new OpenBotDatabase(join(root, "profile"));
const agents = new AgentStore(join(root, "profile"), join(root, "home"), database);
const mailbox = new MailboxStore(join(root, "profile"), agents.sharedRoot, database);
const changes = new EventEmitter();
const actor = { id: "fixture-person", name: "Fixture Person" };
const checks: string[] = [];
const failures: string[] = [];
const awaitingRowsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    state: z.enum(["asked", "working", "replied", "failed"]),
    detail: z.string().optional(),
  }),
);
// The renderer module stays in its JSX project. The child executes its real data helper, while
// this Node-checked script validates only the process response used by the assertions below.
const awaitingHelperUrl = pathToFileURL(resolve(import.meta.dirname, "../src/renderer/src/awaiting-replies.ts"));
const awaitingChild = `
import { channelAwaitingReplies } from ${JSON.stringify(awaitingHelperUrl.href)};
const input = JSON.parse(await Bun.stdin.text());
const rows = channelAwaitingReplies({ ...input, agents: [], name: id => id ?? "unassigned" });
// Machine-readable: renderer waiting rows for the synthetic fixture.
process.stdout.write(JSON.stringify(rows));
`;
let channels: ChannelService | undefined;
let routedTaskId = "";
let interrupted = 0;
let passed = false;

function service(): ChannelService {
  assert.ok(channels);
  return channels;
}

async function until(ready: () => boolean): Promise<void> {
  const signal = AbortSignal.timeout(10_000);
  while (!ready()) await once(changes, "changed", { signal });
}

function task(channel: Channel, id: string): ChannelTask {
  const found = service()
    .store.tasks(channel.id)
    .find((item) => item.id === id);
  assert.ok(found);
  return found;
}

function awaiting(channel: Channel, tasks = service().store.tasks(channel.id)) {
  const output = execFileSync(process.execPath, ["--eval", awaitingChild], {
    input: JSON.stringify({ tasks, messages: service().store.messages(channel.id) }),
    encoding: "utf8",
    timeout: 10_000,
  });
  return awaitingRowsSchema.parse(JSON.parse(output));
}

async function send(
  channel: Channel,
  text: string,
  recipientAgentId: string | null,
  replyToMessageId: string | null = null,
) {
  await runCauseEffect(
    service().command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId: channel.id,
        text,
        recipientAgentId,
        replyToMessageId,
        attachmentDraftIds: [],
      },
      actor,
    ),
  );
}

try {
  await runCauseEffect(agents.initialize());
  await runCauseEffect(mailbox.initialize());
  const parentAgent = await runCauseEffect(
    agents.createAgent({
      name: "Fixture Parent",
      description: "Synthetic parent",
      avatarSeed: "parent",
      avatarHue: null,
    }),
  );
  const childAgent = await runCauseEffect(
    agents.createAgent({ name: "Fixture Child", description: "Synthetic child", avatarSeed: "child", avatarHue: null }),
  );
  channels = new ChannelService(database, mailbox, new ChannelImages(join(root, "images")), {
    agents: () => [parentAgent, childAgent],
    generate: () => Effect.succeed(JSON.stringify({ taskId: routedTaskId })),
    // Hold provider starts at the scheduler boundary. Commands, routing and durable state are real.
    busy: () => true,
    schedule: () => {
      throw new Error("A provider must not start in this fixture.");
    },
    interrupt: () =>
      Effect.sync(() => {
        interrupted += 1;
      }),
    changed: () => {
      changes.emit("changed");
    },
    error: (error) => {
      failures.push(error instanceof Error ? error.message : String(error));
      changes.emit("changed");
    },
  });

  async function delegated(state: "paused" | "waiting" = "paused") {
    const current = service();
    const channel = current.store.create(randomUUID(), {
      name: "Synthetic delegated work",
      title: "",
      instructions: "",
      members: [{ agentId: parentAgent.id }, { agentId: childAgent.id }],
      leadAgentId: parentAgent.id,
    });
    current.store.update(channel);
    await send(channel, "Complete the original synthetic request", parentAgent.id);
    const parent = current.store.tasks(channel.id)[0];
    assert.ok(parent);
    const child: ChannelTask = {
      ...parent,
      id: randomUUID(),
      parentTaskId: parent.id,
      rootTaskId: parent.id,
      ownerAgentId: childAgent.id,
      instruction: "Do the delegated synthetic work",
      dependencies: [],
      state: state === "paused" ? "paused" : "running",
      assignmentCount: 4,
      error: state === "paused" ? "stopped" : null,
    };
    const grandchild: ChannelTask = {
      ...child,
      id: randomUUID(),
      parentTaskId: child.id,
      state: state === "paused" ? "failed" : "queued",
      instruction: "Do the nested synthetic work",
      assignmentCount: 2,
    };
    const complete: ChannelTask = { ...child, id: randomUUID(), state: "completed", error: null };
    current.store.update(current.store.get(channel.id), {
      tasks: [
        {
          ...parent,
          state,
          dependencies: [child.id, complete.id],
          assignmentCount: 5,
          error: state === "paused" ? "stopped" : null,
        },
        { ...child, dependencies: [grandchild.id] },
        grandchild,
        complete,
      ],
    });
    return { channel, parent, child, grandchild, complete };
  }

  {
    const fixture = await delegated("waiting");
    const before = service().store.tasks(fixture.channel.id);
    const childRows = awaiting(fixture.channel);
    assert.ok(childRows.some((row) => row.id === fixture.child.id && row.state === "working"));
    assert.ok(childRows.some((row) => row.id === fixture.complete.id && row.state === "replied"));
    await send(
      fixture.channel,
      `${serializeChatTagReference("agent", childAgent.name, childAgent.id)} inspect this queued request`,
      null,
    );
    const queued = service()
      .store.tasks(fixture.channel.id)
      .find((item) => !before.some((prior) => prior.id === item.id));
    assert.ok(queued);
    assert.equal(queued.ownerAgentId, childAgent.id);
    assert.equal(queued.state, "queued");
    const rows = awaiting(fixture.channel);
    assert.ok(rows.some((row) => row.id === queued.id && row.state === "asked" && row.name === childAgent.id));
    assert.deepEqual(
      rows.filter((row) => row.id !== queued.id),
      childRows,
    );
    for (const state of ["running", "cancelled"] as const) {
      assert.ok(!awaiting(fixture.channel, [{ ...queued, state }]).some((row) => row.id === queued.id));
    }
    checks.push(
      "a busy named member's queued human request is visible while existing dependent reply rows stay unchanged",
    );
    checks.push("running and cancelled root requests are excluded from the queued reply rows");
  }

  for (const text of [
    "continue",
    "resume",
    "go on",
    "keep going",
    "please continue!",
    "@Fixture Parent, continue",
    `${serializeChatTagReference("agent", parentAgent.name, parentAgent.id)}, resume please.`,
  ]) {
    const fixture = await delegated();
    await send(fixture.channel, text, null);
    const parent = task(fixture.channel, fixture.parent.id);
    assert.equal(parent.state, "queued");
    assert.equal(parent.instruction, fixture.parent.instruction);
    assert.deepEqual(parent.dependencies, [fixture.child.id, fixture.complete.id]);
    assert.equal(parent.assignmentCount, 0);
    for (const id of [fixture.child.id, fixture.grandchild.id]) {
      const resumed = task(fixture.channel, id);
      assert.equal(resumed.state, "queued");
      assert.equal(resumed.error, null);
      assert.equal(resumed.assignmentCount, 0);
    }
    assert.equal(task(fixture.channel, fixture.complete.id).state, "completed");
    assert.equal(task(fixture.channel, fixture.complete.id).revision, fixture.complete.revision);
    assert.equal(service().store.tasks(fixture.channel.id).length, 4);
    checks.push(`plain resume retains delegated work: ${text.includes("@") ? "addressed request" : text}`);
  }

  {
    const fixture = await delegated("waiting");
    const before = service().store.tasks(fixture.channel.id);
    const interruptions = interrupted;
    await send(fixture.channel, `@Fixture Parent continue`, null);
    assert.deepEqual(service().store.tasks(fixture.channel.id), before);
    assert.equal(interrupted, interruptions);
    checks.push("a waiting parent and its active children remain active for plain continue");
  }

  for (const text of ["actually use the revised request", "continue but use the revised request"]) {
    const fixture = await delegated();
    await send(fixture.channel, text, parentAgent.id, fixture.parent.requestMessageId);
    assert.deepEqual(task(fixture.channel, fixture.parent.id).dependencies, []);
    for (const id of [fixture.child.id, fixture.grandchild.id]) {
      assert.equal(task(fixture.channel, id).state, "paused");
      assert.equal(task(fixture.channel, id).error, "The parent request changed.");
    }
    checks.push("a real correction still invalidates the earlier delegated work");
  }

  for (const origin of ["routine", "handoff", "human"] as const) {
    const fixture = await delegated("waiting");
    const before = service().store.tasks(fixture.channel.id);
    routedTaskId = fixture.parent.id;
    if (origin === "routine") {
      await runCauseEffect(
        service().command(
          {
            type: "request",
            operationId: randomUUID(),
            channelId: fixture.channel.id,
            text: "Run this independent scheduled request",
            recipientAgentId: null,
            requestMessageId: randomUUID(),
            origin: { kind: "routine", routineId: randomUUID(), routineName: "Fixture routine", runId: randomUUID() },
          },
          actor,
        ),
      );
    } else if (origin === "handoff") {
      await runCauseEffect(
        service().handoff({
          operationId: randomUUID(),
          channelId: fixture.channel.id,
          senderAgentId: childAgent.id,
          text: "Run this independent handoff request",
          recipientAgentIds: [],
          sourcePaths: [],
        }),
      );
    } else {
      await send(fixture.channel, "Include this extra constraint in the current work", null);
    }
    await until(() =>
      service()
        .store.tasks(fixture.channel.id)
        .some(
          (item) =>
            item.id !== fixture.parent.id &&
            !before.some((prior) => prior.id === item.id) &&
            (origin === "human" ? item.state === "cancelled" : item.ownerAgentId !== null),
        ),
    );
    const after = service().store.tasks(fixture.channel.id);
    if (origin === "human") {
      assert.equal(task(fixture.channel, fixture.parent.id).revision, fixture.parent.revision + 1);
      assert.equal(task(fixture.channel, fixture.child.id).error, "The parent request changed.");
      checks.push("human follow-up routing can still continue and correct an existing task");
    } else {
      for (const previous of before) assert.deepEqual(task(fixture.channel, previous.id), previous);
      const newRoot = after.find((item) => !before.some((previous) => previous.id === item.id));
      assert.ok(newRoot);
      assert.equal(newRoot.parentTaskId, null);
      assert.equal(newRoot.rootTaskId, newRoot.id);
      assert.equal(newRoot.ownerAgentId, parentAgent.id);
      assert.equal(newRoot.state, "queued");
      assert.ok(!awaiting(fixture.channel).some((row) => row.id === newRoot.id));
      checks.push(`${origin} routing selects a member without replacing another request`);
    }
  }

  assert.deepEqual(failures, []);
  passed = true;
} finally {
  if (channels) await runCauseEffect(channels.stop());
  database.close();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ passed, checks, failures }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}

// Machine-readable: completed synthetic service checks, with no conversation contents or credentials.
process.stdout.write(`${JSON.stringify({ passed, checks: checks.length, reportPath })}\n`);
