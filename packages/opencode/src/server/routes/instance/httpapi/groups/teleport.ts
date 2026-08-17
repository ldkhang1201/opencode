import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { TeleportState } from "@/teleport/state"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import {
  ApiNotFoundError,
  ConflictError,
  InvalidRequestError,
  ServiceUnavailableError,
  SessionBusyError,
  TeleportFailedError,
  TeleportPasswordRequiredError,
} from "../errors"
import { described } from "./metadata"

export const TeleportInfo = Schema.Struct({
  url: Schema.String,
  username: Schema.String,
  password: Schema.String,
  directory: Schema.String,
  sessionID: Schema.String,
}).annotate({ identifier: "TeleportInfo" })

export const StartPayload = Schema.Struct({
  target: Schema.String,
  password: Schema.optional(Schema.String),
  sshArgs: Schema.optional(Schema.Array(Schema.String)),
  binaryVersion: Schema.optional(Schema.String),
})

export const ReturnPayload = Schema.Struct({
  scrub: Schema.optional(Schema.Boolean),
})

export const AbortPayload = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
})

export const TeleportPaths = {
  list: "/teleport",
  start: "/session/:sessionID/teleport",
  status: "/session/:sessionID/teleport",
  return: "/session/:sessionID/teleport/return",
  pull: "/session/:sessionID/teleport/pull",
  abort: "/session/:sessionID/teleport/abort",
} as const

export const TeleportApi = HttpApi.make("teleport")
  .add(
    HttpApiGroup.make("teleport")
      .add(
        HttpApiEndpoint.get("list", TeleportPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(TeleportState.State), "Teleported sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "teleport.list",
            summary: "List teleported sessions",
            description: "List the persisted teleport state of every session currently living on a remote machine.",
          }),
        ),
        HttpApiEndpoint.post("start", TeleportPaths.start, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: StartPayload,
          success: described(TeleportInfo, "Teleport connection info"),
          error: [
            ApiNotFoundError,
            ConflictError,
            InvalidRequestError,
            SessionBusyError,
            TeleportFailedError,
            TeleportPasswordRequiredError,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "teleport.start",
            summary: "Teleport session",
            description:
              "Move a session to a remote machine over ssh: bootstrap the remote, start a detached server, tunnel to it and freeze the local copy.",
          }),
        ),
        HttpApiEndpoint.get("status", TeleportPaths.status, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(TeleportState.State, "Teleport state"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "teleport.status",
            summary: "Get teleport state",
            description: "Get the persisted teleport state for a session (404 when it is not teleported).",
          }),
        ),
        HttpApiEndpoint.post("return", TeleportPaths.return, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ReturnPayload,
          success: described(Schema.Boolean, "Session returned"),
          error: [ApiNotFoundError, TeleportFailedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "teleport.return",
            summary: "Return teleported session",
            description:
              "Bring a teleported session back: final remote export (remote authoritative), unfreeze, scrub credentials and stop the remote server.",
          }),
        ),
        HttpApiEndpoint.post("pull", TeleportPaths.pull, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Pulled"),
          error: [ApiNotFoundError, TeleportFailedError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "teleport.pull",
            summary: "Pull teleported session",
            description: "One opportunistic sync of the remote transcript into the frozen local copy.",
          }),
        ),
        HttpApiEndpoint.post("abort", TeleportPaths.abort, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: AbortPayload,
          success: described(Schema.Boolean, "Teleport aborted"),
          error: [ApiNotFoundError, TeleportFailedError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "teleport.abort",
            summary: "Abort teleport",
            description:
              "Abandon a teleport: kill the remote server when reachable and unfreeze the local copy (last pulled transcript wins).",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "teleport",
          description: "Teleport sessions to remote machines.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode teleport HttpApi",
      version: "0.0.1",
      description: "Teleport routes.",
    }),
  )
