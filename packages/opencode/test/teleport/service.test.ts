// Unit tests for the pure/local parts of the Teleport service. The full
// bootstrap path is covered by the dockerized E2E in teleport-e2e.test.ts,
// state-machine behavior by test/teleport/service-ops.test.ts.
import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
import {
  importScript,
  makeSessionLocks,
  NotTeleportedError,
  parseServeLog,
  pullLoopEffect,
  resolveRemoteDir,
  resumeState,
  sanitizeTag,
  serveScript,
  exportScript,
  stripTeleport,
  TeleportError,
  type OpError,
} from "@/teleport/index"
import type { TeleportState } from "@/teleport/state"

describe("teleport service helpers", () => {
  test("sanitizeTag maps session ids onto the ssh key tag alphabet", () => {
    expect(sanitizeTag("ses_ff120d4fcffePucbs4CihQBmC2")).toBe("ses-ff120d4fcffePucbs4CihQBmC2")
    expect(sanitizeTag("weird id!")).toBe("weird-id-")
  })

  test("resolveRemoteDir resolves ~ against the remote home", () => {
    expect(resolveRemoteDir("/home/alice")).toBe("/home/alice")
    expect(resolveRemoteDir("/home/alice", "/srv/work")).toBe("/srv/work")
    expect(resolveRemoteDir("/home/alice", "~")).toBe("/home/alice")
    expect(resolveRemoteDir("/home/alice", "~/projects/x")).toBe("/home/alice/projects/x")
  })

  test("parseServeLog finds the listening port, banner tolerant", () => {
    expect(parseServeLog("")).toBeUndefined()
    expect(parseServeLog("warming up...\n")).toBeUndefined()
    expect(parseServeLog("motd banner\nopencode server listening on http://127.0.0.1:40123\nmore")).toBe(40123)
  })

  test("serveScript keeps the password out of argv and inside a quoted env assignment", () => {
    const script = serveScript({
      binPath: "/home/alice/.opencode/bin/opencode",
      dir: "/home/alice/work",
      teleportDir: "/home/alice/.local/state/opencode/teleport/ses_x",
      logPath: "/home/alice/.local/state/opencode/teleport/ses_x/serve.log",
      password: "s3cr3t'pw",
      env: { OPENCODE_CONFIG_CONTENT: '{"a":1}' },
    })
    // password appears only as a single-quoted env assignment on the spawn line
    expect(script).toContain("OPENCODE_SERVER_PASSWORD='s3cr3t'\\''pw'")
    expect(script).toContain("OPENCODE_CONFIG_CONTENT='{\"a\":1}'")
    expect(script).toContain("nohup")
    expect(script).toContain("serve --hostname 127.0.0.1 --port 0")
    expect(script).toContain("</dev/null")
    expect(script).toContain("echo \"PID=$!\"")
    expect(script).toContain("mkdir -p '/home/alice/work'")
  })

  test("import/export scripts cd into the remote dir and quote everything", () => {
    const imp = importScript({
      binPath: "/home/alice/.opencode/bin/opencode",
      dir: "/home/alice/my work",
      file: "/tmp/import.json",
      env: {},
    })
    expect(imp).toContain("mkdir -p '/home/alice/my work'")
    expect(imp).toContain("cd '/home/alice/my work'")
    expect(imp).toContain("'/home/alice/.opencode/bin/opencode' import '/tmp/import.json'")
    expect(imp).toContain("rm -f -- '/tmp/import.json'")

    const exp = exportScript({
      binPath: "/home/alice/.opencode/bin/opencode",
      dir: "/home/alice/my work",
      sessionID: "ses_x",
    })
    expect(exp).toContain("cd '/home/alice/my work'")
    expect(exp).toContain("'/home/alice/.opencode/bin/opencode' export 'ses_x'")
  })

  test("stripTeleport removes only the teleport key", () => {
    expect(stripTeleport(undefined)).toBeUndefined()
    expect(stripTeleport({ teleport: { state: "teleported" } })).toBeUndefined()
    expect(stripTeleport({ teleport: { state: "teleported" }, other: 1 })).toEqual({ other: 1 })
    expect(stripTeleport({ other: 1 })).toEqual({ other: 1 })
  })
})

function stateFixture(): TeleportState.State {
  return {
    version: 1,
    sessionID: "ses_x",
    target: { user: "alice", host: "host-a.example.com", path: "/home/alice/work" },
    state: "failed",
    createdAt: 1,
    updatedAt: 1,
    remote: {
      home: "",
      dataDir: "",
      stateDir: "",
      target: "",
      binaryPushed: false,
      serverLogPath: "",
      stateDir_: "",
    },
    local: { keyTag: "ses-x", controlPath: "/tmp/oc-tp-x.sock" },
    copiedFiles: [],
  }
}

describe("resumeState", () => {
  test("retargets a resumed state at the newly parsed user/host", () => {
    const st = resumeState(stateFixture(), { user: "bob", host: "host-b.example.com" })
    expect(st.target.host).toBe("host-b.example.com")
    expect(st.target.user).toBe("bob")
    // path is re-resolved against the remote home during the probe step
    expect(st.target.path).toBe("/home/alice/work")
  })

  test("drops a stale user when the new target has none (the schema rejects explicit undefined)", () => {
    const st = resumeState(stateFixture(), { host: "host-b.example.com" })
    expect(st.target.host).toBe("host-b.example.com")
    expect("user" in st.target).toBe(false)
  })
})

describe("pullLoopEffect", () => {
  test("retries transient failures/defects and stops with a single release on NotTeleportedError", async () => {
    const outcomes: Effect.Effect<void, OpError>[] = [
      Effect.fail(new TeleportError({ step: "pull", message: "flaky network" })),
      Effect.die(new Error("defect")),
      Effect.void,
      Effect.fail(new NotTeleportedError({ sessionID: "ses_x" })),
    ]
    let pulls = 0
    let released = 0
    await Effect.runPromise(
      pullLoopEffect({
        sessionID: "ses_x",
        pull: Effect.suspend(() => outcomes[pulls++] ?? Effect.die(new Error("pulled past the state-file removal"))),
        release: Effect.sync(() => {
          released += 1
        }),
        interval: Duration.millis(1),
      }),
    )
    expect(pulls).toBe(4)
    expect(released).toBe(1)
  })
})

describe("makeSessionLocks", () => {
  test("serializes same-session effects and leaves different sessions concurrent", async () => {
    const locks = makeSessionLocks()
    const running = new Map<string, number>()
    let overlapSame = 0
    let overlapOther = 0
    const critical = (key: string) =>
      Effect.gen(function* () {
        running.set(key, (running.get(key) ?? 0) + 1)
        overlapSame = Math.max(overlapSame, running.get(key)!)
        overlapOther = Math.max(overlapOther, running.size)
        yield* Effect.sleep(Duration.millis(25))
        running.set(key, running.get(key)! - 1)
        if (running.get(key) === 0) running.delete(key)
      })
    await Effect.runPromise(
      Effect.all(
        [locks("a")(critical("a")), locks("a")(critical("a")), locks("b")(critical("b"))],
        { concurrency: "unbounded" },
      ),
    )
    expect(overlapSame).toBe(1) // same session never overlaps
    expect(overlapOther).toBe(2) // different sessions do
  })
})
