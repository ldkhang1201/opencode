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
