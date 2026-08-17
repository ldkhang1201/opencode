// State-machine tests for the Teleport service: resumed starts retarget the
// persisted state, return refuses non-returnable phases, concurrent pull vs
// return serialize through the per-session mutex, and busy sessions are never
// teleported. Where a "remote" must answer (pull/return exports) the `ssh`
// binary is faked via PATH — no network, no docker.
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Duration, Effect, Layer } from "effect"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session as SessionNs } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Teleport } from "@/teleport"
import { TeleportState } from "@/teleport/state"
import { importSession, type ExportData } from "@/session/transfer"
import { SessionID } from "@/session/schema"
import { requireInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import fixtureJson from "../session/fixtures/exported-session.json"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Teleport.node,
      SessionRunState.node,
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

function stateFixture(sessionID: string, phase: TeleportState.Phase): TeleportState.State {
  return {
    version: 1,
    sessionID,
    target: { user: "testuser", host: "oc-teleport-test.invalid", path: "/home/testuser/work" },
    state: phase,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    remote: {
      home: "/home/testuser",
      dataDir: "/home/testuser/.local/share/opencode",
      stateDir: "/home/testuser/.local/state/opencode",
      target: "linux-arm64",
      binaryPushed: true,
      serverLogPath: "",
      stateDir_: "",
    },
    local: { keyTag: "oc-test", controlPath: path.join(os.tmpdir(), `oc-tp-test-${process.pid}.sock`) },
    copiedFiles: [],
  }
}

// ---------------------------------------------------------------------------
// fake ssh: consumes the piped script; export invocations log a start/end
// span (pid-keyed) and answer with a canned `opencode export` payload
// ---------------------------------------------------------------------------

const FAKE_SSH = `#!/usr/bin/env bun
import fs from "node:fs"
let script = ""
try {
  script = fs.readFileSync(0, "utf8")
} catch {}
if (script.includes("' export '")) {
  const log = process.env.OC_FAKE_SSH_LOG
  const stamp = (event) => log && fs.appendFileSync(log, process.pid + " " + event + " " + Date.now() + "\\n")
  stamp("start")
  const ms = Number(process.env.OC_FAKE_SSH_SLEEP_MS ?? "0")
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
  process.stdout.write(fs.readFileSync(process.env.OC_FAKE_SSH_EXPORT, "utf8"))
  stamp("end")
}
process.exit(0)
`

async function installFakeSsh(input: { exportData: ExportData; sleepMs: number }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-fake-ssh-"))
  await fs.writeFile(path.join(dir, "ssh"), FAKE_SSH, { mode: 0o755 })
  const exportFile = path.join(dir, "export.json")
  await fs.writeFile(exportFile, JSON.stringify(input.exportData))
  const logFile = path.join(dir, "calls.log")
  const saved = {
    PATH: process.env.PATH,
    OC_FAKE_SSH_EXPORT: process.env.OC_FAKE_SSH_EXPORT,
    OC_FAKE_SSH_LOG: process.env.OC_FAKE_SSH_LOG,
    OC_FAKE_SSH_SLEEP_MS: process.env.OC_FAKE_SSH_SLEEP_MS,
  }
  process.env.PATH = dir + path.delimiter + (process.env.PATH ?? "")
  process.env.OC_FAKE_SSH_EXPORT = exportFile
  process.env.OC_FAKE_SSH_LOG = logFile
  process.env.OC_FAKE_SSH_SLEEP_MS = String(input.sleepMs)
  return {
    logFile,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      void fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function readSpans(logFile: string) {
  const raw = await fs.readFile(logFile, "utf8").catch(() => "")
  const spans = new Map<string, { start: number; end: number }>()
  for (const line of raw.split("\n")) {
    if (!line) continue
    const [pid, event, at] = line.split(" ")
    const span = spans.get(pid) ?? { start: 0, end: 0 }
    if (event === "start") span.start = Number(at)
    else span.end = Number(at)
    spans.set(pid, span)
  }
  return [...spans.values()]
}

// fake ssh relies on a bun shebang; skip where shebangs do not execute
const itInstance = process.platform === "win32" ? it.instance.skip : it.instance

describe("teleport service state machine", () => {
  it.instance("start on a resumed state retargets the persisted user/host at the new target", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const data = fixture()
      yield* importSession(data, ctx)
      const sessionID = SessionID.make(data.info.id)

      // a previous teleport to host A failed mid-bootstrap
      const st = stateFixture(sessionID, "failed")
      st.target = { user: "alice", host: "resume-a.invalid", path: "/home/alice/work" }
      yield* Effect.promise(() => TeleportState.write(st))

      // retry at host B: unreachable, so start fails — but every persisted
      // field the reconnect/return/abort path dials must already be host B
      const teleport = yield* Teleport.Service
      const error = yield* awaitWithTimeout(
        teleport.start({ sessionID, target: "bob@resume-b.invalid:/srv/work" }).pipe(Effect.flip),
        "start did not fail",
        Duration.seconds(60),
      )
      expect(error._tag).toBe("TeleportError")

      const resumed = yield* Effect.promise(() => TeleportState.read(sessionID))
      expect(resumed?.target.host).toBe("resume-b.invalid")
      expect(resumed?.target.user).toBe("bob")
      expect(resumed?.state).toBe("failed")

      yield* Effect.promise(() => TeleportState.remove(sessionID))
    }),
  )

  it.instance("return refuses failed/bootstrapping teleports and points at abort", () =>
    Effect.gen(function* () {
      const teleport = yield* Teleport.Service
      for (const phase of ["failed", "bootstrapping"] as const) {
        const sessionID = SessionID.make(`ses_retguard${phase}`)
        yield* Effect.promise(() => TeleportState.write(stateFixture(sessionID, phase)))

        const error = yield* teleport.ret(sessionID).pipe(Effect.flip)
        expect(error._tag).toBe("TeleportError")
        expect(error.message).toContain("teleport abort")

        // the state must NOT have been wedged into "returning" — recover()
        // would otherwise retry an impossible remote export forever
        const after = yield* Effect.promise(() => TeleportState.read(sessionID))
        expect(after?.state).toBe(phase)

        yield* Effect.promise(() => TeleportState.remove(sessionID))
      }
    }),
  )

  it.instance("start refuses busy sessions with a typed BusyError before any ssh/bootstrap work", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const data = fixture()
      yield* importSession(data, ctx)
      const sessionID = SessionID.make(data.info.id)

      const runState = yield* SessionRunState.Service
      const gate = yield* Deferred.make<void>()
      const dummy = { info: {}, parts: [] } as unknown as SessionV1.WithParts
      yield* runState
        .startShell(sessionID, Effect.succeed(dummy), Deferred.await(gate).pipe(Effect.as(dummy)))
        .pipe(Effect.forkScoped)
      // wait until the runner reports busy (same signal prompt admission uses)
      yield* awaitWithTimeout(
        Effect.gen(function* () {
          while ((yield* runState.assertNotBusy(sessionID).pipe(Effect.exit))._tag === "Success")
            yield* Effect.sleep(Duration.millis(5))
        }),
        "session never became busy",
        Duration.seconds(5),
      )

      const teleport = yield* Teleport.Service
      const error = yield* awaitWithTimeout(
        teleport.start({ sessionID, target: "testuser@busy-host.invalid" }).pipe(Effect.flip),
        "start did not fail",
        Duration.seconds(60),
      )
      expect(error._tag).toBe("SessionBusyError")

      // refused before any side effect: no state file was persisted
      expect(yield* Effect.promise(() => TeleportState.read(sessionID))).toBeUndefined()

      yield* Deferred.succeed(gate, void 0)
    }),
  )

  itInstance("recover() never initiates a return: a 'returning' state file waits for the user", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const data = fixture()
      yield* importSession(data, ctx)
      const sessionID = SessionID.make(data.info.id)

      // an interrupted return persisted "returning"
      yield* Effect.promise(() => TeleportState.write(stateFixture(sessionID, "returning")))

      // a working fake remote: if recover() retried the return it would
      // succeed here (export answered) and remove the state file
      const env = yield* Effect.promise(() => installFakeSsh({ exportData: fixture(), sleepMs: 0 }))
      yield* Effect.addFinalizer(() => Effect.sync(env.restore))

      const teleport = yield* Teleport.Service
      yield* teleport.recover()
      // grace period: an auto-return would have been forked into the scope
      yield* Effect.sleep(Duration.millis(750))

      // no remote export ran and the pending return is still on disk,
      // waiting for an explicit /list selection or `opencode teleport return`
      expect(yield* Effect.promise(() => readSpans(env.logFile))).toHaveLength(0)
      const after = yield* Effect.promise(() => TeleportState.read(sessionID))
      expect(after?.state).toBe("returning")

      // explicit resumption still works: ret() accepts the "returning" phase
      yield* awaitWithTimeout(teleport.ret(sessionID), "explicit return did not finish", Duration.seconds(30))
      expect(yield* Effect.promise(() => TeleportState.read(sessionID))).toBeUndefined()
    }),
  )

  itInstance("concurrent pull and return serialize through the per-session mutex", () =>
    Effect.gen(function* () {
      const ctx = yield* requireInstance
      const data = fixture()
      yield* importSession(data, ctx)
      const sessionID = SessionID.make(data.info.id)
      const sessions = yield* SessionNs.Service
      yield* sessions.setMetadata({
        sessionID,
        metadata: { teleport: { state: "teleported", target: "testuser@fake", remoteDir: "/work", since: 1 } },
      })
      yield* Effect.promise(() => TeleportState.write(stateFixture(sessionID, "teleported")))

      const env = yield* Effect.promise(() => installFakeSsh({ exportData: fixture(), sleepMs: 150 }))
      yield* Effect.addFinalizer(() => Effect.sync(env.restore))

      const teleport = yield* Teleport.Service
      const [pullExit, retExit] = yield* awaitWithTimeout(
        Effect.all(
          [
            teleport.pull(sessionID).pipe(Effect.exit),
            Effect.sleep(Duration.millis(30)).pipe(Effect.andThen(teleport.ret(sessionID).pipe(Effect.exit))),
          ],
          { concurrency: "unbounded" },
        ),
        "pull/return did not settle",
        Duration.seconds(30),
      )
      expect(pullExit._tag).toBe("Success")
      expect(retExit._tag).toBe("Success")

      // the two remote exports must never overlap: pull's check-then-import
      // re-freezes a just-returned row when it interleaves with return
      const spans = (yield* Effect.promise(() => readSpans(env.logFile))).sort((a, b) => a.start - b.start)
      expect(spans).toHaveLength(2)
      expect(spans[1].start).toBeGreaterThanOrEqual(spans[0].end)

      // returned: state file gone, freeze marker cleared (remote authoritative)
      expect(yield* Effect.promise(() => TeleportState.read(sessionID))).toBeUndefined()
      const info = yield* sessions.get(sessionID)
      expect((info.metadata as Record<string, unknown> | undefined)?.["teleport"]).toBeUndefined()
    }),
  )
})
