// Unit tests for the shared session transfer lib (teleport phase 1). The
// fixture is a real `opencode export` capture (see fixtures/exported-session.json)
// so the decode path is exercised against production-shaped data.
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session as SessionNs } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { exportSession, importSession, type ExportData } from "../../src/session/transfer"
import { SessionID } from "../../src/session/schema"
import fixtureJson from "./fixtures/exported-session.json"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Database.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const fixture = () => structuredClone(fixtureJson) as unknown as ExportData

// Clone message[i], rewriting ids so it acts as a new remote-appended message.
function appendedMessage(data: ExportData, marker: string) {
  const extra = structuredClone(data.messages[0])
  extra.info.id = extra.info.id.slice(0, -4) + "zzzz"
  extra.parts = extra.parts.map((p: any) => ({
    ...p,
    id: p.id.slice(0, -4) + "zzzz",
    messageID: extra.info.id,
    ...(p.type === "text" ? { text: marker } : {}),
  }))
  return extra
}

describe("session transfer lib", () => {
  it.instance("importSession remaps the session to the local instance and makes it readable", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const data = fixture()
      const id = yield* importSession(data, ctx)
      expect(id as string).toBe(data.info.id)

      const svc = yield* SessionNs.Service
      const info = yield* svc.get(id)
      expect(info.directory).toBe(ctx.directory)
      expect(info.projectID).toBe(ctx.project.id)

      const messages = yield* svc.messages({ sessionID: id })
      expect(messages).toHaveLength(2)
      expect(JSON.stringify(messages)).toContain("FIXTURE_USER_QUESTION")
      expect(JSON.stringify(messages)).toContain("FIXTURE_ASSISTANT_REPLY")
    }),
  )

  it.instance("re-import without overwrite is additive-only (existing rows untouched)", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      yield* importSession(fixture(), ctx)

      const changed = fixture()
      changed.info.title = "CHANGED TITLE"
      ;(changed.messages[0].parts[0] as any).text = "TAMPERED"
      yield* importSession(changed, ctx)

      const svc = yield* SessionNs.Service
      const changedID = SessionID.make(changed.info.id)
      const info = yield* svc.get(changedID)
      expect(info.title).not.toBe("CHANGED TITLE")
      const messages = yield* svc.messages({ sessionID: changedID })
      expect(JSON.stringify(messages)).toContain("FIXTURE_USER_QUESTION")
      expect(JSON.stringify(messages)).not.toContain("TAMPERED")
    }),
  )

  it.instance("re-import with overwrite updates the session row and message content, and appends new messages", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      yield* importSession(fixture(), ctx)

      const changed = fixture()
      changed.info.title = "REMOTE TITLE"
      ;(changed.messages[0].parts[0] as any).text = "REMOTE_EDIT"
      changed.messages.push(appendedMessage(changed, "APPENDED_REMOTE_MESSAGE"))
      yield* importSession(changed, ctx, { overwrite: true })

      const svc = yield* SessionNs.Service
      const changedID = SessionID.make(changed.info.id)
      const info = yield* svc.get(changedID)
      expect(info.title).toBe("REMOTE TITLE")
      const messages = yield* svc.messages({ sessionID: changedID })
      expect(messages).toHaveLength(3)
      const text = JSON.stringify(messages)
      expect(text).toContain("REMOTE_EDIT")
      expect(text).not.toContain("FIXTURE_USER_QUESTION")
      expect(text).toContain("APPENDED_REMOTE_MESSAGE")
    }),
  )

  it.instance("re-import with overwrite deletes messages and parts absent from the export (remote authoritative)", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      yield* importSession(fixture(), ctx)

      // remote reverted the assistant reply: the export carries only message 0
      const trimmed = fixture()
      trimmed.messages = [trimmed.messages[0]]
      yield* importSession(trimmed, ctx, { overwrite: true })

      const svc = yield* SessionNs.Service
      const id = SessionID.make(trimmed.info.id)
      const messages = yield* svc.messages({ sessionID: id })
      expect(messages).toHaveLength(1)
      const text = JSON.stringify(messages)
      expect(text).toContain("FIXTURE_USER_QUESTION")
      expect(text).not.toContain("FIXTURE_ASSISTANT_REPLY")
    }),
  )

  it.instance("re-import with overwrite deletes parts dropped from kept messages", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      yield* importSession(fixture(), ctx)

      const trimmed = fixture()
      const dropped = trimmed.messages[1].parts.pop()!
      yield* importSession(trimmed, ctx, { overwrite: true })

      const svc = yield* SessionNs.Service
      const messages = yield* svc.messages({ sessionID: SessionID.make(trimmed.info.id) })
      expect(messages).toHaveLength(2)
      const assistant = messages.find((msg) => msg.info.id === trimmed.messages[1].info.id)!
      expect(assistant.parts.map((part) => part.id)).not.toContain(dropped.id)
      expect(assistant.parts).toHaveLength(trimmed.messages[1].parts.length)
    }),
  )

  it.instance("re-import without overwrite never deletes local rows", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      yield* importSession(fixture(), ctx)

      const trimmed = fixture()
      trimmed.messages = [trimmed.messages[0]]
      yield* importSession(trimmed, ctx)

      const svc = yield* SessionNs.Service
      const messages = yield* svc.messages({ sessionID: SessionID.make(trimmed.info.id) })
      expect(messages).toHaveLength(2)
      expect(JSON.stringify(messages)).toContain("FIXTURE_ASSISTANT_REPLY")
    }),
  )

  it.instance("import metadata option replaces the exported metadata in the same row write", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const data = fixture()
      ;(data.info as any).metadata = { teleport: { state: "teleported", target: "user@host" }, keep: "original" }
      const id = yield* importSession(data, ctx, {
        overwrite: true,
        metadata: { teleport: { state: "teleported", target: "elsewhere" } },
      })

      const svc = yield* SessionNs.Service
      const info = yield* svc.get(id)
      expect(info.metadata).toEqual({ teleport: { state: "teleported", target: "elsewhere" } })
    }),
  )

  it.instance("import metadata: null strips metadata even when the export carries some", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const seeded = fixture()
      ;(seeded.info as any).metadata = { teleport: { state: "teleported", target: "user@host" } }
      yield* importSession(seeded, ctx, { overwrite: true })

      const svc = yield* SessionNs.Service
      const id = SessionID.make(seeded.info.id)
      expect((yield* svc.get(id)).metadata).toEqual({ teleport: { state: "teleported", target: "user@host" } })

      const again = fixture()
      ;(again.info as any).metadata = { teleport: { state: "teleported", target: "user@host" } }
      yield* importSession(again, ctx, { overwrite: true, metadata: null })
      expect((yield* svc.get(id)).metadata).toBeUndefined()
    }),
  )

  it.instance("import without the metadata option keeps the exported metadata", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const data = fixture()
      ;(data.info as any).metadata = { keep: "me" }
      const id = yield* importSession(data, ctx, { overwrite: true })

      const svc = yield* SessionNs.Service
      expect((yield* svc.get(id)).metadata).toEqual({ keep: "me" })
    }),
  )

  it.instance("exportSession round-trips what importSession wrote", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const data = fixture()
      const id = yield* importSession(data, ctx)

      const out = yield* exportSession(id)
      expect(out.info.id).toBe(id)
      expect(out.info.directory).toBe(ctx.directory)
      expect(out.messages).toHaveLength(2)
      expect(JSON.stringify(out.messages)).toContain("FIXTURE_ASSISTANT_REPLY")
    }),
  )
})
