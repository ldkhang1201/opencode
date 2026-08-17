import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TeleportState } from "@/teleport/state"

function sample(sessionID: string): TeleportState.State {
  return {
    version: 1,
    sessionID,
    target: { user: "alice", host: "example.com", path: "/home/alice/work" },
    state: "bootstrapping",
    createdAt: 1000,
    updatedAt: 1000,
    remote: {
      home: "/home/alice",
      dataDir: "/home/alice/.local/share/opencode",
      stateDir: "/home/alice/.local/state/opencode",
      target: "linux-arm64-musl",
      binaryPushed: false,
      serverLogPath: "/home/alice/.local/state/opencode/teleport/ses_x/serve.log",
      stateDir_: "/home/alice/.local/state/opencode/teleport/ses_x",
    },
    local: {
      keyTag: "ses-x",
      controlPath: "/tmp/oc-tp.sock",
    },
    copiedFiles: [],
  }
}

describe("teleport/state", () => {
  test("write/read round-trips and enforces 0600", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-teleport-state-"))
    try {
      const state = sample("ses_roundtrip")
      state.remote.serverPid = 42
      state.remote.serverPort = 4096
      state.remote.serverPassword = "secret"
      state.local.tunnelPort = 5000
      state.local.keyPath = "/keys/opencode-teleport-ses-roundtrip"
      state.copiedFiles = ["/home/alice/.local/share/opencode/auth.json"]
      state.lastPullAt = 1234

      await TeleportState.write(state, dir)
      const back = await TeleportState.read("ses_roundtrip", dir)
      expect(back).toEqual(state)

      const file = path.join(dir, "ses_roundtrip.json")
      const stat = await fs.stat(file)
      expect((stat.mode & 0o777).toString(8)).toBe("600")
      // atomic write: no temp leftovers
      expect((await fs.readdir(dir)).sort()).toEqual(["ses_roundtrip.json"])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("read of a missing state returns undefined", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-teleport-state-"))
    try {
      expect(await TeleportState.read("ses_nope", dir)).toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("list scans the directory and remove is idempotent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-teleport-state-"))
    try {
      await TeleportState.write(sample("ses_one"), dir)
      await TeleportState.write({ ...sample("ses_two"), state: "teleported" }, dir)
      // junk files must not break list
      await fs.writeFile(path.join(dir, "garbage.txt"), "nope")
      await fs.writeFile(path.join(dir, "bad.json"), "{not json")

      const all = await TeleportState.list(dir)
      expect(all.map((s) => s.sessionID).sort()).toEqual(["ses_one", "ses_two"])

      await TeleportState.remove("ses_one", dir)
      await TeleportState.remove("ses_one", dir)
      expect((await TeleportState.list(dir)).map((s) => s.sessionID)).toEqual(["ses_two"])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("list of a missing directory is empty", async () => {
    expect(await TeleportState.list(path.join(os.tmpdir(), "oc-teleport-state-definitely-missing"))).toEqual([])
  })
})
