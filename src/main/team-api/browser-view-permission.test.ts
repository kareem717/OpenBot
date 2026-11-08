// @vitest-environment node

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { TeamMemberSummary } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_PROTOCOL_VERSION_HEADER } from "@openbot/contracts/team-protocol/v1";
import { TEAM_PROTOCOL_V9 } from "@openbot/contracts/team-protocol/v9";
import { describe, expect, it } from "vitest";
import type { BrowserViewGateway } from "../browser-view-gateway";
import type { TeamApiBrowser, TeamApiBrowserView } from "./dependencies";
import { routeBrowser } from "./route-browser";

const unused = (): never => {
  throw new Error("This operation is outside the view-session request.");
};
const browser: TeamApiBrowser = {
  isPrivate: () => false,
  listTabs: unused,
  getControlState: unused,
  open: unused,
  activate: unused,
  navigate: unused,
  reload: unused,
  close: unused,
  capturePreview: unused,
  setVisible: unused,
  getDisplayState: unused,
  loadUrl: unused,
  takeUserControl: unused,
  releaseUserControl: unused,
  releaseUserControlHeldBy: unused,
  stop: unused,
  importSignIn: unused,
  startView: unused,
  dispatchViewInput: unused,
  copyViewSelection: unused,
};

describe("card takeover view authorization", () => {
  it.each(["owner", "admin", "member"] satisfies TeamMemberSummary["role"][])(
    "uses the authenticated %s role, not an owner flag supplied by the client",
    async (role) => {
      const sessions: Parameters<BrowserViewGateway["createSession"]>[0][] = [];
      const browserView: TeamApiBrowserView = {
        createSession: (input) => {
          sessions.push(input);
          return {
            id: "fixture-view",
            tabId: input.tabId,
            streamPath: "/v1/browser/view/sessions/fixture-view/stream",
          };
        },
        handlesUpgrade: unused,
        handleUpgrade: unused,
        stop: unused,
        closeMemberSession: unused,
        revokeTeamSession: unused,
      };
      const request = new IncomingMessage(new Socket());
      request.method = "POST";
      request.url = TEAM_API_ROUTES.browser.viewSessions;
      request.headers[TEAM_PROTOCOL_VERSION_HEADER.toLowerCase()] = String(TEAM_PROTOCOL_V9);
      request.push(JSON.stringify({ tabId: "fixture-tab", owner: true, memberId: "forged-owner" }));
      request.push(null);
      const response = new ServerResponse(request);
      const member: TeamMemberSummary = {
        id: "authenticated-member",
        username: "fixture",
        email: "fixture@example.test",
        name: "Fixture Member",
        avatarUrl: null,
        role,
        disabled: false,
        createdAt: "2026-11-07T00:00:00Z",
      };
      const outcome = await routeBrowser(
        {
          request,
          response,
          member,
          method: "POST",
          url: new URL(TEAM_API_ROUTES.browser.viewSessions, "https://host.example.test"),
          protocol: TEAM_PROTOCOL_V9,
          capabilities: new Set(),
          token: "fixture-token",
          sessionId: "authenticated-session",
          sessionExpiresAt: "2026-11-08T00:00:00Z",
          agentLevel: () => "manage",
          json: (status) => {
            expect(status).toBe(201);
            return "handled";
          },
          empty: unused,
        },
        { browser, browserView },
      );
      expect(outcome).toBe("handled");
      expect(sessions).toEqual([
        { memberId: member.id, teamSessionId: "authenticated-session", tabId: "fixture-tab", owner: role === "owner" },
      ]);
      request.destroy();
      response.destroy();
    },
  );
});
