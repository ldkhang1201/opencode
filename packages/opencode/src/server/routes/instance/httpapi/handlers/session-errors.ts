import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { Session } from "@/session/session"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, E, R>(
  self: Effect.Effect<A, Session.BusyError | E, R>,
): Effect.Effect<A, ApiError.SessionBusyError | Exclude<E, Session.BusyError>, R> {
  return Effect.catch(
    self,
    (error): Effect.Effect<never, ApiError.SessionBusyError | Exclude<E, Session.BusyError>> =>
      error instanceof Session.BusyError
        ? Effect.fail(
            new ApiError.SessionBusyError({
              sessionID: error.sessionID,
              message: `Session is busy: ${error.sessionID}`,
            }),
          )
        : Effect.fail(error as Exclude<E, Session.BusyError>),
  )
}

export function mapTeleported<A, E, R>(
  self: Effect.Effect<A, Session.TeleportedError | E, R>,
): Effect.Effect<A, ApiError.SessionTeleportedError | Exclude<E, Session.TeleportedError>, R> {
  return Effect.catch(
    self,
    (error): Effect.Effect<never, ApiError.SessionTeleportedError | Exclude<E, Session.TeleportedError>> =>
      error instanceof Session.TeleportedError
        ? Effect.fail(
            new ApiError.SessionTeleportedError({
              sessionID: error.sessionID,
              target: error.target,
              message: error.message,
            }),
          )
        : Effect.fail(error as Exclude<E, Session.TeleportedError>),
  )
}
