// Unit tests for the pure/local parts of the Teleport service. The full
// bootstrap path is covered by the dockerized E2E in teleport-e2e.test.ts.
import { describe, expect, test } from "bun:test"
import {
  importScript,
  parseServeLog,
  resolveRemoteDir,
  sanitizeTag,
  serveScript,
  exportScript,
  stripTeleport,
} from "@/teleport/index"

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
