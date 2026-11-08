// Drives the real scheduler, channel command service and mailbox on an isolated SQLite profile.
// The provider boundary is held while the owner is busy. No live account or user data is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { AgentStore } from "../src/backend/agent-store";
import { ChannelImages } from "../src/backend/channel-images";
import { ChannelRoutineScheduler } from "../src/backend/channel-routine-scheduler";
import { ChannelService } from "../src/backend/channel-service";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const root = await mkdtemp(join(tmpdir(), "openbot-channel-routine-busy-"));
const reportPath = resolve(".openbot-build/channel-routine-busy-e2e/report.json");
const database = new OpenBotDatabase(join(root, "profile"));
const agents = new AgentStore(join(root, "profile"), join(root, "home"), database);
const mailbox = new MailboxStore(join(root, "profile"), agents.sharedRoot, database);
const changes = new EventEmitter();
const checks: string[] = [];
const errors: unknown[] = [];
const busyOwners = new Set<string>();
let channels: ChannelService | undefined;
let scheduler: ChannelRoutineScheduler | undefined;
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
    agents.createAgent({ name: "Lead", description: "Fixture lead", avatarSeed: "lead", avatarHue: null }),
  );
  const owner = await runCauseEffect(
    agents.createAgent({ name: "Owner", description: "Fixture owner", avatarSeed: "owner", avatarHue: null }),
  );
  const activeOwner = await runCauseEffect(
    agents.createAgent({ name: "Active Owner", description: "Fixture owner", avatarSeed: "active", avatarHue: null }),
  );
  const foregroundOwner = await runCauseEffect(
    agents.createAgent({
      name: "Foreground Owner",
      description: "Fixture owner",
      avatarSeed: "foreground",
      avatarHue: null,
    }),
  );
  const service = new ChannelService(database, mailbox, new ChannelImages(join(root, "images")), {
    agents: () => [lead, owner, activeOwner, foregroundOwner],
    // The live hook also checks active snapshots, single-turn providers and usage limits. This
    // fixture drives real mailbox lane states instead of starting a provider process.
    busy: (id) => {
      const held = mailbox.hasQueuedNonRoutine(id) || mailbox.laneActive(id, null);
      if (held) busyOwners.add(id);
      changes.emit("changed");
      return held;
    },
    generate: () => Effect.succeed(JSON.stringify({ agentId: owner.id })),
    spareGeneration: () => false,
    schedule: () => {
      starts += 1;
      changes.emit("changed");
    },
    interrupt: () => Effect.void,
    changed: (id) => {
      scheduler?.reconcile(id);
      changes.emit("changed");
    },
    error: (error) => {
      errors.push(error);
      changes.emit("changed");
    },
  });
  channels = service;
  scheduler = new ChannelRoutineScheduler({
    channels: service,
    hooks: {
      changed: () => changes.emit("changed"),
      emitError: (_code, error) => errors.push(error),
      excludedChannels: () => new Set(),
      usageLimited: () => false,
    },
  });
  async function background(member: AgentSummary) {
    const receipt = await runCauseEffect(
      mailbox.enqueue({
        sender: {
          kind: "routine",
          routineId: randomUUID(),
          runId: randomUUID(),
          routineName: "Background review",
          scheduledFor: new Date().toISOString(),
        },
        recipientAgentIds: [member.id],
        text: "Review synthetic history.",
        draftIds: [],
      }),
    );
    const delivery = receipt.deliveries[0];
    assert.ok(delivery);
    return delivery;
  }
  async function scheduled(member: AgentSummary) {
    const channel = service.store.create(randomUUID(), {
      name: "Scheduled busy-owner fixture",
      title: "",
      instructions: "",
      members: [{ agentId: member.id }],
      leadAgentId: member.id,
    });
    service.store.update(channel);
    assert.ok(scheduler);
    const routine = scheduler.create({
      channelId: channel.id,
      name: "Check and recovery",
      instruction: "Inspect the synthetic fixture and report the result.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "interval", amount: 15, unit: "minutes", anchorAt: new Date().toISOString() },
    });
    const due = new Date(routine.trigger.nextRunAt ?? "");
    assert.ok(Number.isFinite(due.getTime()));
    await runCauseEffect(scheduler.processDue(due));
    return { channel, routine };
  }

  const queuedBackground = await background(owner);
  const priority = await scheduled(owner);
  await until(() => starts === 1);
  const priorityAssignment = service.store.assignments(priority.channel.id)[0];
  assert.ok(priorityAssignment?.deliveryId);
  assert.equal(mailbox.nextQueued(owner.id)?.delivery.id, priorityAssignment.deliveryId);
  assert.equal(mailbox.getDelivery(queuedBackground.id)?.delivery.status, "queued");
  assert.equal(
    service.mayDrain(owner.id),
    true,
    "The reserved channel delivery can drain ahead of the background routine.",
  );
  checks.push("Channel work is reserved and placed before a queued background routine without raising the turn limit.");

  const runningBackground = await background(activeOwner);
  await runCauseEffect(mailbox.markStarting(runningBackground.id));
  await runCauseEffect(mailbox.markRunning(runningBackground.id, "fixture-background-turn"));
  const { channel, routine } = await scheduled(activeOwner);
  await until(() => busyOwners.has(activeOwner.id));
  const run = scheduler.listRuns({ channelId: channel.id, routineId: routine.id })[0];
  const task = service.store.tasks(channel.id)[0];
  assert.ok(run && task);
  assert.equal(task.state, "queued");
  assert.equal(run.status, "queued");
  assert.equal(service.store.assignments(channel.id).length, 0);
  assert.equal(starts, 1);
  assert.equal(mailbox.getDelivery(runningBackground.id)?.delivery.status, "running");
  checks.push("A scheduled request is durable and waits without starting a second turn for a busy owner.");

  await runCauseEffect(scheduler.resumePendingRuns());
  assert.equal(service.store.tasks(channel.id).length, 1);
  assert.equal(service.store.messages(channel.id).filter((item) => item.id === run.requestMessageId).length, 1);
  checks.push("Pending-run recovery reuses the same request and task while the owner is busy.");

  await runCauseEffect(mailbox.markTerminal(runningBackground.id, "completed", null));
  service.event({
    type: "turn-completed",
    agentId: activeOwner.id,
    threadId: "fixture-background-thread",
    turnId: "fixture-background-turn",
    status: "completed",
    origin: "routine",
  });
  await until(() => starts === 2);
  const assignment = service.store.assignments(channel.id)[0];
  assert.ok(assignment?.deliveryId);
  assert.equal(assignment.taskId, task.id);
  assert.equal(assignment.agentId, activeOwner.id);
  assert.equal(mailbox.getDelivery(assignment.deliveryId)?.delivery.status, "queued");
  assert.equal(scheduler.listRuns({ channelId: channel.id, routineId: routine.id })[0]?.status, "running");
  checks.push("The running routine is not preempted; its completion starts exactly one waiting channel assignment.");

  const foreground = await runCauseEffect(
    mailbox.enqueue({
      sender: { kind: "user" },
      recipientAgentIds: [foregroundOwner.id],
      text: "A prior person request.",
      draftIds: [],
    }),
  );
  const foregroundCase = await scheduled(foregroundOwner);
  await until(() => busyOwners.has(foregroundOwner.id));
  assert.equal(service.store.assignments(foregroundCase.channel.id).length, 0);
  assert.equal(mailbox.hasQueuedNonRoutine(foregroundOwner.id), true);
  const foregroundDelivery = foreground.deliveries[0];
  assert.ok(foregroundDelivery);
  await runCauseEffect(mailbox.cancel(foregroundOwner.id, foregroundDelivery.id));
  service.event({ type: "queue-changed", snapshot: mailbox.listQueue(foregroundOwner.id) });
  await until(() => starts === 3);
  assert.equal(service.store.assignments(foregroundCase.channel.id).length, 1);
  checks.push("A prior queued person request keeps its place; its queue change wakes the channel after it ends.");

  await runCauseEffect(mailbox.reorderQueue(owner.id, [queuedBackground.id, priorityAssignment.deliveryId]));
  assert.equal(
    service.mayDrain(owner.id),
    false,
    "The misplaced background head waits behind the existing channel reservation.",
  );
  await runCauseEffect(service.recover());
  assert.equal(mailbox.nextQueued(owner.id)?.delivery.id, priorityAssignment.deliveryId);
  assert.equal(service.mayDrain(owner.id), true);
  assert.equal(service.store.assignments(priority.channel.id)[0]?.id, priorityAssignment.id);
  checks.push(
    "Recovery restores a reserved channel delivery ahead of a misplaced background head without creating another assignment.",
  );

  await runCauseEffect(service.wake(channel.id));
  await runCauseEffect(scheduler.resumePendingRuns());
  await runCauseEffect(service.stop());
  assert.equal(starts, 3);
  assert.equal(service.store.assignments(channel.id).length, 1);
  assert.equal(service.store.tasks(channel.id).length, 1);
  assert.equal(errors.length, 0);
  checks.push("Further wake and recovery calls do not duplicate the reserved assignment.");
  passed = true;
} finally {
  if (channels) await runCauseEffect(channels.stop());
  database.close();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ passed, checks, starts, errors: errors.map(String) }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ passed, checks, reportPath })}\n`);
