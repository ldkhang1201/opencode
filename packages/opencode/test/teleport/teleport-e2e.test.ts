// End-to-end /teleport: real CLI subprocesses, a real sshd in docker, the
// real released opencode binary pushed to the "remote", a real tunnel.
//
// Gated twice:
//   - docker must be available
//   - TELEPORT_NETWORK_TESTS=1 must be set (downloads the release binary for
//     the container platform from GitHub; cached under a stable tmp dir so
//     repeat runs skip the download)
//
// Flow: session on machine A → teleport into the container → prompt it
// remotely through the tunnel (history must survive; the remote LLM hit
// arrives via host.docker.internal) → assert the local copy is frozen →
// `teleport return` from a fresh process → remote exchange is local now,
// freeze lifted, remote server dead.
import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { freePort } from "@/teleport/ssh"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { cliIt, testModelID } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

const dockerAvailable = (() => {
  try {
    return Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
})()

const networkTests = process.env.TELEPORT_NETWORK_TESTS === "1"

if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn("[teleport-e2e] docker unavailable — skipping teleport E2E")
} else if (!networkTests) {
  // eslint-disable-next-line no-console
  console.warn("[teleport-e2e] TELEPORT_NETWORK_TESTS!=1 — skipping teleport E2E (needs to download a release binary)")
}

const PASSWORD = "opencode-teleport-test-pw"
const IMAGE = "opencode-teleport-test-sshd"
const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "sshd")
// Survives tmp-home isolation so the ~190MB release download happens once.
const SHARED_CACHE = path.join(os.tmpdir(), "opencode-teleport-e2e-cache")

function docker(args: string[], opts?: { timeout?: number }) {
  const result = Bun.spawnSync(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts?.timeout ?? 120_000,
  })
  if (result.exitCode !== 0)
    throw new Error(`docker ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`)
  return result.stdout.toString()
}

function readBanner(port: number, timeoutMs = 4_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error("banner timeout"))
    }, timeoutMs)
    sock.once("data", (chunk) => {
      clearTimeout(timer)
      sock.destroy()
      resolve(chunk.toString("utf8"))
    })
    sock.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function waitBanner(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = new Error("never attempted")
  while (Date.now() < deadline) {
    try {
      const banner = await readBanner(port)
      if (banner.startsWith("SSH-")) return
      last = new Error(`unexpected banner: ${banner}`)
    } catch (error) {
      last = error
    }
    await Bun.sleep(250)
  }
  throw new Error(`no ssh banner on 127.0.0.1:${port} after ${timeoutMs}ms: ${last}`)
}

const basic = (username: string, password: string) => ({
  Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
})

describe.skipIf(!dockerAvailable || !networkTests)("teleport E2E (dockerized sshd + released binary)", () => {
  cliIt.live(
    "teleports a session, prompts it remotely through the tunnel, and returns it",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        // ------------------------------------------------------- machine A
        yield* llm.text("MARKER_A_REPLY")
        const runA = yield* opencode.run("MARKER_A_QUESTION", { format: "json" })
        opencode.expectExit(runA, 0, "run on machine A")
        const sessionID = opencode
          .parseJsonEvents(runA.stdout)
          .find((e) => typeof e.sessionID === "string")?.sessionID as string
        expect(sessionID).toBeTruthy()

        // ------------------------------------------------- sshd container
        const sshdPort = freePort()
        const container = `opencode-teleport-e2e-${process.pid}-${Date.now()}`
        docker(["build", "-t", IMAGE, FIXTURE_DIR], { timeout: 300_000 })
        docker([
          "run",
          "-d",
          "--name",
          container,
          "-p",
          `127.0.0.1:${sshdPort}:22`,
          // container → host LLM reachability on linux CI; a no-op on Docker
          // Desktop for macOS where host.docker.internal is built in
          ...(process.platform === "linux" ? ["--add-host=host.docker.internal:host-gateway"] : []),
          IMAGE,
        ])
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              Bun.spawnSync(["docker", "rm", "-f", container], { stdout: "ignore", stderr: "ignore", timeout: 60_000 })
            } catch {}
          }),
        )
        yield* Effect.promise(() => waitBanner(sshdPort, 30_000))

        const knownHosts = path.join(home, "teleport-known-hosts")
        const sshArgs = [
          `--ssh-arg=-p`,
          `--ssh-arg=${sshdPort}`,
          `--ssh-arg=-o`,
          `--ssh-arg=UserKnownHostsFile=${knownHosts}`,
          `--ssh-arg=-o`,
          `--ssh-arg=GlobalKnownHostsFile=/dev/null`,
        ]
        const target = "testuser@127.0.0.1:/home/testuser/work"

        // the remote server reaches the test LLM on the host through the
        // docker bridge, not loopback
        const remoteConfig = JSON.stringify(
          testProviderConfig(llm.url.replace("127.0.0.1", "host.docker.internal")),
        )

        // ------------------------- typed PasswordRequired path (no password)
        const noPw = yield* opencode.spawn(["teleport", target, "--session", sessionID, ...sshArgs], {
          timeoutMs: 120_000,
        })
        expect(noPw.exitCode).not.toBe(0)
        expect(noPw.stderr.toLowerCase()).toContain("password")

        // ----------------------------------------- teleport (long-lived)
        const supervisor = yield* opencode.start(
          ["teleport", target, "--session", sessionID, "--password-env", "TELEPORT_PW", ...sshArgs],
          {
            env: {
              TELEPORT_PW: PASSWORD,
              OPENCODE_CONFIG_CONTENT: remoteConfig,
              XDG_CACHE_HOME: SHARED_CACHE,
            },
          },
        )
        const infoLine = yield* awaitWithTimeout(
          supervisor.nextLine,
          "teleport did not print connection info",
          Duration.minutes(8),
        ).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // eslint-disable-next-line no-console
              console.error("[teleport-e2e] supervisor stderr:\n" + supervisor.stderrTail())
            }),
          ),
        )
        const info = JSON.parse(infoLine) as {
          url: string
          username: string
          password: string
          directory: string
          sessionID: string
        }
        expect(info.sessionID).toBe(sessionID)
        expect(info.directory).toBe("/home/testuser/work")
        const auth = basic(info.username, info.password)
        const dirQuery = `directory=${encodeURIComponent(info.directory)}`

        // ------------------------ assert through the tunnel with Basic auth
        const remoteSession = (yield* Effect.promise(async () => {
          const response = await fetch(`${info.url}/session/${sessionID}?${dirQuery}`, { headers: auth })
          if (!response.ok) throw new Error(`GET session via tunnel failed: ${response.status}`)
          return (await response.json()) as { id: string; title: string }
        })) as { id: string }
        expect(remoteSession.id).toBe(sessionID)

        // --------------------------------------- local admission is frozen
        const frozen = yield* opencode.run("should fail", {
          extraArgs: ["--session", sessionID],
          timeoutMs: 30_000,
        })
        expect(frozen.exitCode).not.toBe(0)
        expect(frozen.durationMs).toBeLessThan(25_000)
        expect((frozen.stderr + frozen.stdout).toLowerCase()).toContain("teleport")

        // ------------------------------- prompt remotely through the tunnel
        yield* llm.text("MARKER_B_REMOTE_REPLY")
        const prompted = (yield* Effect.promise(async () => {
          const response = await fetch(`${info.url}/session/${sessionID}/message?${dirQuery}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({
              model: { providerID: "test", modelID: testModelID.split("/")[1] },
              parts: [{ type: "text", text: "MARKER_B_QUESTION" }],
            }),
            signal: AbortSignal.timeout(120_000),
          })
          if (!response.ok) throw new Error(`prompt via tunnel failed: ${response.status} ${await response.text()}`)
          return await response.json()
        })) as { info: { role: string } }
        expect(prompted.info.role).toBe("assistant")

        // the remote hit carried the full machine-A history
        const hits = yield* llm.hits
        const remoteHit = hits.map((h) => JSON.stringify(h.body)).find((s) => s.includes("MARKER_B_QUESTION"))
        expect(remoteHit).toBeTruthy()
        expect(remoteHit!).toContain("MARKER_A_QUESTION")

        // the reply is visible through the tunnel
        const messages = yield* Effect.promise(async () => {
          const response = await fetch(`${info.url}/session/${sessionID}/message?${dirQuery}`, { headers: auth })
          if (!response.ok) throw new Error(`GET messages via tunnel failed: ${response.status}`)
          return JSON.stringify(await response.json())
        })
        expect(messages).toContain("MARKER_B_REMOTE_REPLY")

        // ------------------------------------------- return (fresh process)
        const returned = yield* opencode.spawn(["teleport", "return", "--session", sessionID, ...sshArgs], {
          timeoutMs: 180_000,
        })
        opencode.expectExit(returned, 0, "teleport return")

        // the foreground supervisor notices and exits 0 on its own
        const supervisorExit = yield* awaitWithTimeout(
          Effect.promise(() => supervisor.exited),
          "teleport supervisor did not exit after return",
          Duration.seconds(30),
        )
        expect(supervisorExit).toBe(0)

        // remote exchange is local now
        const exported = yield* opencode.spawn(["export", sessionID])
        opencode.expectExit(exported, 0, "export after return")
        expect(exported.stdout).toContain("MARKER_B_QUESTION")
        expect(exported.stdout).toContain("MARKER_B_REMOTE_REPLY")

        // state file gone
        const listed = yield* opencode.spawn(["teleport", "list"])
        opencode.expectExit(listed, 0, "teleport list after return")
        expect(listed.stdout).toContain("no teleported sessions")

        // freeze lifted: the session runs locally again
        yield* llm.text("MARKER_C_REPLY")
        const runC = yield* opencode.run("MARKER_C_QUESTION", {
          extraArgs: ["--session", sessionID],
          timeoutMs: 60_000,
        })
        opencode.expectExit(runC, 0, "run after return")

        // remote server is dead (transient import/export invocations aside,
        // nothing named `opencode` should be running in the container)
        yield* pollWithTimeout(
          Effect.sync(() => {
            // [o]pencode: keep the pattern from matching this sh -c cmdline itself
            const check = Bun.spawnSync(
              ["docker", "exec", container, "sh", "-c", 'pgrep -f "[o]pencode serve" >/dev/null 2>&1 || echo DEAD'],
              { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
            )
            return check.stdout.toString().includes("DEAD") ? (true as const) : undefined
          }),
          "remote opencode serve still running after return",
          Duration.seconds(20),
        )
      }),
    900_000,
  )
})
