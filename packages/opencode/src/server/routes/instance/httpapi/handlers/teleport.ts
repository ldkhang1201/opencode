import { Effect, Scope } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Teleport } from "@/teleport"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import type { StartPayload, ReturnPayload, AbortPayload } from "../groups/teleport"

function mapStart(error: Teleport.StartError) {
  switch (error._tag) {
    case "TeleportPasswordRequiredError":
      return new ApiError.TeleportPasswordRequiredError({ target: error.target, message: error.message })
    case "TeleportAlreadyTeleportedError":
      return new ApiError.ConflictError({ message: error.message, resource: "teleport" })
    case "TeleportUnsupportedTargetError":
      return new ApiError.InvalidRequestError({ message: error.message })
    case "SessionBusyError":
      // same 409 shape the session endpoints use for busy sessions
      return new ApiError.SessionBusyError({
        sessionID: error.sessionID,
        message: `Session is busy: ${error.sessionID}`,
      })
    case "TeleportError":
      return new ApiError.TeleportFailedError({ step: error.step, message: error.message })
    default:
      return new ApiError.TeleportFailedError({ message: error.message })
  }
}

function mapOp(error: Teleport.OpError): ApiError.ApiNotFoundError | ApiError.TeleportFailedError {
  switch (error._tag) {
    case "TeleportNotTeleportedError":
      return ApiError.notFound(error.message)
    default:
      return new ApiError.TeleportFailedError({ step: error.step, message: error.message })
  }
}

function mapAbort(error: Teleport.OpError | Teleport.RemoteUnreachableError) {
  if (error._tag === "TeleportRemoteUnreachableError")
    return new ApiError.ServiceUnavailableError({ message: error.message, service: "teleport" })
  return mapOp(error)
}

export const teleportHandlers = HttpApiBuilder.group(InstanceHttpApi, "teleport", (handlers) =>
  Effect.gen(function* () {
    const teleport = yield* Teleport.Service
    const scope = yield* Scope.Scope

    // Crash recovery at server start: re-establish tunnels + pull loops for
    // "teleported" sessions, retry "returning" ones in the background.
    yield* teleport.recover().pipe(
      Effect.catchCause((cause) => Effect.logWarning("teleport recovery failed", { cause })),
      Effect.forkIn(scope),
    )

    const list = Effect.fn("TeleportHttpApi.list")(function* () {
      return yield* teleport.list()
    })

    const start = Effect.fn("TeleportHttpApi.start")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof StartPayload.Type
    }) {
      return yield* teleport
        .start({
          sessionID: ctx.params.sessionID,
          target: ctx.payload.target,
          ...(ctx.payload.password !== undefined ? { password: ctx.payload.password } : {}),
          ...(ctx.payload.sshArgs?.length ? { sshArgs: [...ctx.payload.sshArgs] } : {}),
          ...(ctx.payload.binaryVersion !== undefined ? { binaryVersion: ctx.payload.binaryVersion } : {}),
        })
        .pipe(Effect.mapError(mapStart))
    })

    const status = Effect.fn("TeleportHttpApi.status")(function* (ctx: { params: { sessionID: SessionID } }) {
      const state = yield* teleport.status(ctx.params.sessionID)
      if (!state) return yield* ApiError.notFound(`session is not teleported: ${ctx.params.sessionID}`)
      return state
    })

    const ret = Effect.fn("TeleportHttpApi.return")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ReturnPayload.Type
    }) {
      yield* teleport
        .ret(ctx.params.sessionID, ctx.payload.scrub !== undefined ? { scrub: ctx.payload.scrub } : {})
        .pipe(Effect.mapError(mapOp))
      return true
    })

    const pull = Effect.fn("TeleportHttpApi.pull")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* teleport.pull(ctx.params.sessionID).pipe(Effect.mapError(mapOp))
      return true
    })

    const abort = Effect.fn("TeleportHttpApi.abort")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof AbortPayload.Type
    }) {
      yield* teleport
        .abort(ctx.params.sessionID, ctx.payload.force !== undefined ? { force: ctx.payload.force } : {})
        .pipe(Effect.mapError(mapAbort))
      return true
    })

    return handlers
      .handle("list", list)
      .handle("start", start)
      .handle("status", status)
      .handle("return", ret)
      .handle("pull", pull)
      .handle("abort", abort)
  }),
)
