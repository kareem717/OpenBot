// Drives the real Cursor process adapter and channel scheduler against the recorded billing reply.
// No provider account or user data is used. Writes .openbot-build/cursor-payment-required-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentModelOption, AgentSummary } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import type { CauseCode } from "@openbot/telemetry";
import { Effect } from "effect";
import { generateTextWithoutTools } from "../src/backend/agent/profile-generation";
import type { AgentClient } from "../src/backend/agent-client";
import { toChannelOperationError } from "../src/backend/channel-effects";
import { ChannelImages } from "../src/backend/channel-images";
import { ChannelRoutineScheduler } from "../src/backend/channel-routine-scheduler";
import { ChannelService } from "../src/backend/channel-service";
import type { AgentCliInfo } from "../src/backend/cli";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { getString } from "../src/backend/protocol";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";
import { installFakeAgent, runTurn, startThread, stopClients } from "./provider-fakes/host";

const directory = resolve(".openbot-build/cursor-payment-required-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-cursor-payment-"));
const modePath = join(root, "mode");
const clients: AgentClient[] = [];
const changes = new EventEmitter();
const checks: string[] = [];
const errors: unknown[] = [];
const database = new OpenBotDatabase(join(root, "data"));
const mailbox = new MailboxStore(join(root, "data"), join(root, "shared"), database);
const actor = { id: "fixture-person", name: "Fixture Person" };
const model: AgentModelOption = {
  id: "auto",
  name: "Auto",
  description: "Fixture model.",
  provider: "cursor",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["medium"],
};
const message = sourceText("error.backend.providerPaymentMethodRequired");
let channels: ChannelService | undefined;
let scheduler: ChannelRoutineScheduler | undefined;
let passed = false;

function agent(name: string): AgentSummary {
  return {
    id: `agent-${randomUUID()}`,
    name,
    title: "",
    description: "Fixture channel member.",
    notifications: false,
    provider: "cursor",
    model: "auto",
    reasoningEffort: "medium",
    threadId: null,
    workspacePath: join(root, name),
    preview: "",
    updatedAt: null,
    avatarSeed: name,
    avatarHue: null,
    avatarUrl: null,
  };
}

async function until(read: () => boolean): Promise<void> {
  const signal = AbortSignal.timeout(20_000);
  while (!read()) await once(changes, "changed", { signal });
}

try {
  const lead = agent("Lead");
  const helper = agent("Helper");
  const executable = join(root, "cursor", "cursor-agent");
  await installFakeAgent(executable, "cursor-payment-required", { FAKE_MODE_PATH: modePath, FAKE_OWNER: lead.id });
  const cli: AgentCliInfo = { executable, version: "2026.11.05-86047df", source: "managed" };
  const driver = requireProviderDriver("cursor");
  const client = driver.createClient(cli, 10_000, NO_PROVIDER_CREDENTIALS);
  clients.push(client);
  client.start();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const threadId = await startThread(client, { cwd: workspace, model: "auto" });
  let causeCode: string | null = null;
  client.on("notification", (notification) => {
    if (notification.method === "error") causeCode = getString(notification.params, "causeCode");
  });

  for (const mode of ["billing", "split"]) {
    await writeFile(modePath, mode);
    causeCode = null;
    const turn = await runTurn(client, threadId);
    assert.equal(turn.status, "failed");
    assert.equal(turn.error, message);
    assert.equal(turn.reply, "", "A provider refusal is not an assistant answer.");
    assert.equal(causeCode, "billing" satisfies CauseCode);
    checks.push(`${mode}: billing failure, no successful answer`);
  }
  for (const mode of ["quote", "valid"]) {
    await writeFile(modePath, mode);
    const turn = await runTurn(client, threadId);
    assert.equal(turn.status, "completed");
    assert.equal(turn.error, null);
    assert.ok(turn.reply);
    if (mode === "valid") assert.equal(JSON.parse(turn.reply).agentId, lead.id);
    checks.push(`${mode}: ordinary answer preserved`);
  }

  await runCauseEffect(mailbox.initialize());
  database.replaceAgents(randomUUID(), [lead, helper], "fixture.agents-created");
  const service = new ChannelService(database, mailbox, new ChannelImages(join(root, "images")), {
    agents: () => [lead, helper],
    busy: () => true,
    generate: (_lead, prompt) => {
      const profile = driver.createProfileClient?.(cli, 10_000, NO_PROVIDER_CREDENTIALS);
      assert.ok(profile);
      return generateTextWithoutTools(profile, model, prompt).pipe(toChannelOperationError);
    },
    spareGeneration: () => false,
    schedule: () => changes.emit("changed"),
    interrupt: () => Effect.void,
    changed: (id) => {
      scheduler?.reconcile(id);
      changes.emit("changed");
    },
    error: (error) => errors.push(error),
  });
  channels = service;
  const channelId = randomUUID();
  await runCauseEffect(
    service.command(
      {
        type: "save",
        operationId: randomUUID(),
        channelId,
        draft: {
          name: "Billing fixture",
          title: "",
          instructions: "",
          members: [{ agentId: lead.id }, { agentId: helper.id }],
          leadAgentId: lead.id,
        },
      },
      actor,
    ),
  );
  await writeFile(modePath, "billing");
  await runCauseEffect(
    service.command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId,
        text: "Check the fixture.",
        recipientAgentId: null,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      actor,
    ),
  );
  await until(() => service.store.tasks(channelId).some((task) => task.state === "paused"));
  const task = service.store.tasks(channelId)[0];
  assert.ok(task);
  assert.equal(task.error, message, "The channel shows the actionable provider failure, not a JSON error.");
  assert.equal(task.ownerAgentId, null, "The refused router must not guess an owner.");
  assert.equal(service.store.assignments(channelId).length, 0);
  assert.equal(errors.length, 0, "No parser failure or duplicate provider-error toast is emitted.");
  checks.push("channel routing: billing notice is shown without a JSON error or an assignment");

  await writeFile(modePath, "valid");
  await runCauseEffect(
    service.command(
      { type: "resume", operationId: randomUUID(), channelId, taskId: task.id, recipientAgentId: null },
      actor,
    ),
  );
  await until(() =>
    service.store.tasks(channelId).some((item) => item.id === task.id && item.ownerAgentId === lead.id),
  );
  const resumed = service.store.tasks(channelId).find((item) => item.id === task.id);
  assert.equal(resumed?.state, "queued");
  assert.equal(resumed?.error, null);
  assert.equal(service.store.tasks(channelId).length, 1, "Resume keeps the original task.");
  checks.push("channel routing: resume succeeds after provider billing is fixed");

  scheduler = new ChannelRoutineScheduler({
    channels: service,
    hooks: {
      changed: () => changes.emit("changed"),
      emitError: (_code, error) => errors.push(error),
      excludedChannels: () => new Set(),
      usageLimited: () => false,
    },
  });
  const routine = scheduler.create({
    channelId,
    name: "Billing check",
    instruction: "Check the fixture without an explicit recipient.",
    active: true,
    timezone: "UTC",
    schedule: { kind: "interval", amount: 5, unit: "minutes", anchorAt: new Date().toISOString() },
  });
  const due = Date.parse(routine.trigger.nextRunAt ?? "");
  assert.ok(Number.isFinite(due));
  await writeFile(modePath, "billing");
  await runCauseEffect(scheduler.processDue(new Date(due)));
  await until(() => service.store.tasks(channelId).some((item) => item.id !== task.id && item.state === "paused"));
  const blocked = service.store.tasks(channelId).find((item) => item.id !== task.id && item.state === "paused");
  assert.ok(blocked);
  assert.equal(blocked.error, message);
  for (const minute of [1, 2]) await runCauseEffect(scheduler.processDue(new Date(due + minute * 300_000)));
  assert.equal(scheduler.listRuns({ channelId, routineId: routine.id }).length, 1);
  assert.equal(service.store.tasks(channelId).length, 2, "Later ticks do not create duplicate stopped tasks.");
  assert.ok(Date.parse(scheduler.list(channelId)[0]?.trigger.nextRunAt ?? "") > due + 600_000);
  checks.push("routine: unresolved billing creates one alert and advances later scheduled ticks");

  await writeFile(modePath, "valid");
  await runCauseEffect(
    service.command(
      { type: "resume", operationId: randomUUID(), channelId, taskId: blocked.id, recipientAgentId: null },
      actor,
    ),
  );
  await until(() =>
    service.store.tasks(channelId).some((item) => item.id === blocked.id && item.ownerAgentId === lead.id),
  );
  await runCauseEffect(scheduler.processDue(new Date(due + 900_000)));
  await until(() => service.store.tasks(channelId).filter((item) => item.ownerAgentId === lead.id).length === 3);
  assert.equal(scheduler.listRuns({ channelId, routineId: routine.id }).length, 2);
  assert.equal(errors.length, 0);
  checks.push("routine: resume clears the billing blocker and later scheduled runs route normally");
  passed = true;
} finally {
  if (channels) await runCauseEffect(channels.stop());
  await stopClients(clients);
  database.close();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "report.json"), `${JSON.stringify({ passed, checks }, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ passed, checks })}\n`);
