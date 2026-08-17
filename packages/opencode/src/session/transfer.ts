// Shared session transfer primitives: the library form of `opencode export`
// and `opencode import`, usable in-process (the teleport service moves
// sessions between machines with these). The CLI commands delegate here.
import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import type { InstanceContext } from "@/project/instance-context"
import type { SessionID } from "@/session/schema"
import path from "path"
import { and, eq, notInArray } from "drizzle-orm"
import { Effect, Schema } from "effect"

export type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }
export type ImportOptions = {
  // Remote-authoritative merge: update the full session row and existing
  // message/part payloads instead of the default additive-only semantics.
  overwrite?: boolean
  // When provided, replaces info.metadata before the row write (null = strip).
  // Teleport uses this to keep the local freeze marker out of the remote copy
  // and to preserve it atomically during opportunistic pulls.
  metadata?: Record<string, unknown> | null
}

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

export const exportSession = Effect.fn("SessionTransfer.export")(function* (sessionID: SessionID) {
  const svc = yield* Session.Service
  const info = yield* svc.get(sessionID)
  const messages = yield* svc.messages({ sessionID: info.id })
  return { info, messages }
})

export const importSession = Effect.fn("SessionTransfer.import")(function* (
  data: ExportData,
  ctx: InstanceContext,
  options?: ImportOptions,
) {
  const { db } = yield* Database.Service
  const overwrite = options?.overwrite === true

  const raw: Record<string, unknown> = {
    ...data.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  }
  if (options?.metadata !== undefined) {
    // The schema rejects an explicit `metadata: undefined` key, so stripping
    // (metadata: null) must remove the key entirely.
    if (options.metadata === null) delete raw.metadata
    else raw.metadata = options.metadata
  }
  const info = Schema.decodeUnknownSync(Session.Info)(raw) as Session.Info
  const row = Session.toRow(info)
  const { id: _id, ...rowWithoutID } = row
  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: overwrite
        ? // drizzle skips undefined fields in updates, so an absent metadata
          // must be written as an explicit null to clear the column.
          { ...rowWithoutID, metadata: rowWithoutID.metadata ?? null }
        : { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.orDie)

  const keptMessages: SessionV1.Info["id"][] = []
  const keptParts: SessionV1.Part["id"][] = []
  for (const msg of data.messages) {
    const msgInfo = decodeMessageInfo(msg.info) as SessionV1.Info
    const { id, sessionID: _, ...msgData } = msgInfo
    keptMessages.push(id)
    const messageValues = {
      id,
      session_id: row.id,
      time_created: msgInfo.time?.created ?? Date.now(),
      data: msgData as never,
    }
    const messageInsert = db.insert(MessageTable).values(messageValues)
    yield* (
      overwrite
        ? messageInsert.onConflictDoUpdate({
            target: MessageTable.id,
            set: { time_created: messageValues.time_created, data: messageValues.data },
          })
        : messageInsert.onConflictDoNothing()
    )
      .run()
      .pipe(Effect.orDie)

    for (const part of msg.parts) {
      const partInfo = decodePart(part) as SessionV1.Part
      const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
      keptParts.push(partId)
      const partValues = {
        id: partId,
        message_id: messageID,
        session_id: row.id,
        data: partData,
      }
      const partInsert = db.insert(PartTable).values(partValues)
      yield* (
        overwrite
          ? partInsert.onConflictDoUpdate({ target: PartTable.id, set: { data: partValues.data } })
          : partInsert.onConflictDoNothing()
      )
        .run()
        .pipe(Effect.orDie)
    }
  }

  if (overwrite) {
    // Remote authoritative: local message/part rows the export no longer
    // carries (remote revert/cleanup) must be deleted, or every pull/return
    // would resurrect them. Parts of kept messages are covered too: any part
    // id absent from the export goes away.
    yield* db
      .delete(PartTable)
      .where(
        keptParts.length
          ? and(eq(PartTable.session_id, row.id), notInArray(PartTable.id, keptParts))
          : eq(PartTable.session_id, row.id),
      )
      .run()
      .pipe(Effect.orDie)
    yield* db
      .delete(MessageTable)
      .where(
        keptMessages.length
          ? and(eq(MessageTable.session_id, row.id), notInArray(MessageTable.id, keptMessages))
          : eq(MessageTable.session_id, row.id),
      )
      .run()
      .pipe(Effect.orDie)
  }

  return info.id
})

export * as SessionTransfer from "./transfer"
