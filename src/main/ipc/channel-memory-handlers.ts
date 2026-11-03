// What a channel remembers: the notes every member of it carries into a turn.

import { decodeChannelMemory } from "@openbot/contracts/ipc";
import { CHANNEL_MEMORY_PAGES_CAPABILITY } from "@openbot/contracts/team-protocol/channel-memory-pages-v1";
import { CHANNEL_ROUTES } from "@openbot/contracts/team-protocol/channels-v1";
import { readChannelMemories } from "@openbot/team-client/team-api-requests";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { decodeVoid } from "../remote-host-decoding";
import type { RemoteServerManager } from "../remote-server-manager";
import {
  parseChannelId,
  parseCreateChannelMemory,
  parseDeleteChannelMemory,
  parseUpdateChannelMemory,
} from "./agent-inputs";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler } from "./scoped-handler";

interface ChannelMemoryIpcDependencies {
  service: AgentService;
  remoteServers: RemoteServerManager;
}

export function channelMemoryIpcHandlers({
  service,
  remoteServers,
}: ChannelMemoryIpcDependencies): Pick<IpcGroupHandlers, "channelMemories"> {
  return {
    channelMemories: {
      listChannelMemories: scopedHandler(parseChannelId, {
        local: (channelId) => service.listChannelMemories(channelId),
        remote: (channelId, serverId) =>
          runCauseEffect(
            readChannelMemories(
              (method, path, decode, body) => remoteServers.request(serverId, path, decode, { method, body }),
              channelId,
              remoteServers.supportsCapability(serverId, CHANNEL_MEMORY_PAGES_CAPABILITY),
            ),
          ),
      }),
      createChannelMemory: scopedHandler(parseCreateChannelMemory, {
        local: (parsed) => service.createChannelMemory(parsed),
        remote: (parsed, serverId) =>
          runCauseEffect(
            remoteServers.request(serverId, CHANNEL_ROUTES.memoryCreate, decodeChannelMemory, {
              method: "POST",
              body: parsed,
            }),
          ),
      }),
      updateChannelMemory: scopedHandler(parseUpdateChannelMemory, {
        local: (parsed) => service.updateChannelMemory(parsed),
        remote: (parsed, serverId) =>
          runCauseEffect(
            remoteServers.request(serverId, CHANNEL_ROUTES.memoryUpdate, decodeChannelMemory, {
              method: "POST",
              body: parsed,
            }),
          ),
      }),
      deleteChannelMemory: scopedHandler(parseDeleteChannelMemory, {
        local: (parsed) => service.deleteChannelMemory(parsed),
        remote: (parsed, serverId) =>
          runCauseEffect(
            remoteServers.request(serverId, CHANNEL_ROUTES.memoryDelete, decodeVoid, {
              method: "POST",
              body: parsed,
            }),
          ),
      }),
      clearChannelMemories: scopedHandler(parseChannelId, {
        local: (channelId) => service.clearChannelMemories(channelId),
        remote: (channelId, serverId) =>
          runCauseEffect(
            remoteServers.request(serverId, CHANNEL_ROUTES.memoryClear, decodeVoid, {
              method: "POST",
              body: { channelId },
            }),
          ),
      }),
    },
  };
}
