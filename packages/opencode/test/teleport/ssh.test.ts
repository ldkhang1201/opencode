import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import {
  askpassScript,
  backoffDelay,
  close,
  encodeExecInput,
  exec,
  freePort,
  installKey,
  installKeyScript,
  keyMarker,
  open,
  parseTarget,
  push,
  pushCommand,
  removeKey,
  removeKeyScript,
  shellQuote,
  SshOpenError,
  TargetParseError,
  tunnel,
  type MasterHandle,
  type Target,
  type TunnelHandle,
  type TunnelState,
} from "@/teleport/ssh"

function parsed(input: string): Target {
  const result = parseTarget(input)
  if (TargetParseError.isInstance(result))
    throw new Error(`expected parse success for ${input}: ${result.data.message}`)
  return result
}

function parseError(input: string) {
  const result = parseTarget(input)
  if (!TargetParseError.isInstance(result)) throw new Error(`expected parse error for ${JSON.stringify(input)}`)
  return result
}

describe("teleport/ssh parseTarget", () => {
  test("parses bare host", () => {
    expect(parsed("example.com")).toEqual({ host: "example.com" })
  })

  test("parses user@host", () => {
    expect(parsed("alice@example.com")).toEqual({ user: "alice", host: "example.com" })
  })

  test("parses user@host:/abs/path", () => {
    expect(parsed("alice@example.com:/srv/work")).toEqual({ user: "alice", host: "example.com", path: "/srv/work" })
  })

  test("parses host:~/relative-to-home path", () => {
    expect(parsed("example.com:~/projects/x")).toEqual({ host: "example.com", path: "~/projects/x" })
  })

  test("rejects :port suffix (ports come from ssh config, not the target)", () => {
    const err = parseError("alice@example.com:2222")
    expect(err.data.message).toContain("port")
  })

  test("rejects relative paths after colon", () => {
    parseError("example.com:relative/path")
  })

  test("rejects empty and malformed input", () => {
    parseError("")
    parseError("   ")
    parseError("@example.com")
    parseError("alice@")
    parseError("alice@host with space")
    parseError("-badhost")
    parseError("alice@-badhost")
  })
})

describe("teleport/ssh backoffDelay", () => {
  test("doubles from 1s and caps at 30s", () => {
    expect(backoffDelay(1)).toBe(1_000)
    expect(backoffDelay(2)).toBe(2_000)
    expect(backoffDelay(3)).toBe(4_000)
    expect(backoffDelay(4)).toBe(8_000)
    expect(backoffDelay(5)).toBe(16_000)
    expect(backoffDelay(6)).toBe(30_000)
    expect(backoffDelay(7)).toBe(30_000)
    expect(backoffDelay(100)).toBe(30_000)
  })

  test("clamps nonsense attempts to the first delay", () => {
    expect(backoffDelay(0)).toBe(1_000)
    expect(backoffDelay(-3)).toBe(1_000)
  })
})

describe("teleport/ssh shellQuote", () => {
  test("quotes simple and special strings", () => {
    expect(shellQuote("plain")).toBe("'plain'")
    expect(shellQuote("with space")).toBe("'with space'")
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
    expect(shellQuote('$HOME `x` "y"')).toBe("'$HOME `x` \"y\"'")
  })
})

describe("teleport/ssh script generation", () => {
  test("askpassScript is a one-shot sh helper referencing only the password file path", () => {
    const script = askpassScript("/tmp/x dir/pw")
    expect(script.startsWith("#!/bin/sh\n")).toBe(true)
    expect(script).toContain("'/tmp/x dir/pw'")
    expect(script).toContain("rm -f")
    // the password itself must never be embedded anywhere
    expect(script).not.toContain("password")
  })

  test("askpass helper prints the password once, then the file is gone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-askpass-unit-"))
    try {
      const pwfile = path.join(dir, "pw")
      await fs.writeFile(pwfile, "s3cret-value", { mode: 0o600 })
      const helper = path.join(dir, "helper.sh")
      await fs.writeFile(helper, askpassScript(pwfile), { mode: 0o700 })

      const first = Bun.spawnSync([helper], { stdout: "pipe", stderr: "pipe" })
      expect(first.exitCode).toBe(0)
      expect(first.stdout.toString()).toBe("s3cret-value")
      expect(await fs.exists(pwfile)).toBe(false)

      const second = Bun.spawnSync([helper], { stdout: "pipe", stderr: "pipe" })
      expect(second.stdout.toString()).toBe("")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("pushCommand mkdirs, streams to tmp, chmods, then atomically renames", () => {
    const cmd = pushCommand("/srv/my dir/file.bin", "/srv/my dir/.file.bin.tmp", "0755")
    expect(cmd).toBe(
      "mkdir -p '/srv/my dir' && cat > '/srv/my dir/.file.bin.tmp' && chmod '0755' '/srv/my dir/.file.bin.tmp' && mv -f '/srv/my dir/.file.bin.tmp' '/srv/my dir/file.bin'",
    )
  })

  test("keyMarker tags keys", () => {
    expect(keyMarker("abc")).toBe("opencode-teleport-abc")
  })

  test("installKeyScript greps before appending and fixes modes", () => {
    const script = installKeyScript("ssh-ed25519 AAAA opencode-teleport-mytag", "mytag")
    expect(script).toContain("umask 077")
    expect(script).toContain("mkdir -p")
    expect(script).toContain("chmod 700")
    expect(script).toContain("chmod 600")
    expect(script).toContain("grep -qF -- 'opencode-teleport-mytag'")
    expect(script).toContain("printf '%s\\n' 'ssh-ed25519 AAAA opencode-teleport-mytag'")
  })

  test("removeKeyScript anchors the tag and escapes regex characters", () => {
    const script = removeKeyScript("my.tag")
    expect(script).toContain("opencode-teleport-my\\.tag$")
    expect(script).toContain("grep -v")
    expect(script).toContain("mv -f")
    // exits cleanly when the file does not exist
    expect(script).toContain("exit 0")
  })

  test("installKey and removeKey reject shell-hostile tags", () => {
    expect(() => installKeyScript("ssh-ed25519 AAAA", "bad tag")).toThrow()
    expect(() => removeKeyScript("bad/tag")).toThrow()
    expect(() => removeKeyScript("")).toThrow()
  })
})

describe("teleport/ssh encodeExecInput", () => {
  test("plain script passes through with trailing newline", () => {
    expect(new TextDecoder().decode(encodeExecInput("echo hi"))).toBe("echo hi\n")
  })

  test("script with payload stays fully textual (base64 heredoc piped into the script)", () => {
    // raw bytes after the script are NOT safe: busybox ash reads stdin in 1KiB
    // blocks and would swallow them into its parse buffer
    const payload = new Uint8Array([0, 1, 2, 255, 10, 13, 0])
    const text = new TextDecoder().decode(encodeExecInput("cat", payload))
    expect(text).toContain("opencode_teleport_main() {\ncat\n}")
    expect(text).toContain("base64 -d <<'OPENCODE_TELEPORT_PAYLOAD_EOF' | opencode_teleport_main")
    expect(text).toContain(`\n${Buffer.from(payload).toString("base64")}\n`)
    expect(text.endsWith("OPENCODE_TELEPORT_PAYLOAD_EOF\n")).toBe(true)
  })

  test("long payloads are wrapped into heredoc-safe base64 lines", () => {
    const payload = new Uint8Array(1024).fill(7)
    const text = new TextDecoder().decode(encodeExecInput("cat", payload))
    const lines = text.split("\n")
    const start = lines.findIndex((line) => line.startsWith("base64 -d <<"))
    const end = lines.indexOf("OPENCODE_TELEPORT_PAYLOAD_EOF")
    const body = lines.slice(start + 1, end)
    expect(body.length).toBeGreaterThan(1)
    for (const line of body) expect(line.length).toBeLessThanOrEqual(76)
    expect(Buffer.from(body.join(""), "base64")).toEqual(Buffer.from(payload))
  })

  test("local sh -s round-trips a binary payload through the script's stdin", () => {
    const payload = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256))
    const input = encodeExecInput("echo begin\ncat\necho end", payload)
    const result = Bun.spawnSync(["/bin/sh", "-s"], { stdin: new Uint8Array(input), stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode).toBe(0)
    const stdout = Buffer.from(result.stdout)
    expect(stdout.subarray(0, 6).toString()).toBe("begin\n")
    expect(stdout.subarray(stdout.length - 4).toString()).toBe("end\n")
    expect(stdout.subarray(6, stdout.length - 4).equals(payload)).toBe(true)
  })

  test("payload script exit code propagates", () => {
    const input = encodeExecInput("cat > /dev/null; exit 5", new Uint8Array([1, 2, 3]))
    const result = Bun.spawnSync(["/bin/sh", "-s"], { stdin: new Uint8Array(input), stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode).toBe(5)
  })
})

describe("teleport/ssh freePort", () => {
  test("returns a bindable loopback port", async () => {
    const port = freePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer()
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => server.close(() => resolve()))
    })
  })
})

// ---------------------------------------------------------------------------
// Integration tests against a real sshd in docker.
// ---------------------------------------------------------------------------

const dockerAvailable = (() => {
  try {
    return Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
})()

if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn("[teleport/ssh.test.ts] docker unavailable — skipping sshd integration tests")
}

const PASSWORD = "opencode-teleport-test-pw"
const IMAGE = "opencode-teleport-test-sshd"
const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "sshd")

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

async function waitBanner(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = new Error("never attempted")
  while (Date.now() < deadline) {
    try {
      const banner = await readBanner(port)
      if (banner.startsWith("SSH-")) return banner
      last = new Error(`unexpected banner: ${banner}`)
    } catch (error) {
      last = error
    }
    await Bun.sleep(250)
  }
  throw new Error(`no ssh banner on 127.0.0.1:${port} after ${timeoutMs}ms: ${last}`)
}

async function askpassLeftovers(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir()).catch(() => [] as string[])
  return entries.filter((entry) => entry.startsWith("opencode-teleport-askpass-"))
}

describe.skipIf(!dockerAvailable)("teleport/ssh integration (dockerized sshd)", () => {
  const container = `opencode-teleport-test-${process.pid}-${Date.now()}`
  const sshdPort = freePort()
  const tmpDirs: string[] = []
  const masters: MasterHandle[] = []
  const tunnels: TunnelHandle[] = []
  let workDir = ""
  let knownHosts = ""
  let master: MasterHandle | undefined
  let privateKeyPath = ""

  const target: Target = { user: "testuser", host: "127.0.0.1" }
  const baseExtraArgs = () => [
    "-p",
    String(sshdPort),
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
  ]
  const requireMaster = () => {
    if (!master) throw new Error("fixture master not established (earlier test failed)")
    return master
  }

  afterAll(async () => {
    for (const handle of tunnels) await handle.stop().catch(() => {})
    for (const handle of masters) await close(handle).catch(() => {})
    try {
      Bun.spawnSync(["docker", "rm", "-f", container], { stdout: "ignore", stderr: "ignore", timeout: 60_000 })
    } catch {}
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  test("boots the sshd fixture container", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-teleport-itest-"))
    tmpDirs.push(workDir)
    knownHosts = path.join(workDir, "known_hosts")
    docker(["build", "-t", IMAGE, FIXTURE_DIR], { timeout: 300_000 })
    docker(["run", "-d", "--name", container, "-p", `127.0.0.1:${sshdPort}:22`, IMAGE])
    await waitBanner(sshdPort, 30_000)
  }, 300_000)

  test("BatchMode open without a key fails with an auth error", async () => {
    let error: unknown
    try {
      const handle = await open(target, {
        controlPath: path.join(workDir, "m0.sock"),
        extraArgs: [...baseExtraArgs(), "-o", "IdentitiesOnly=yes", "-o", "IdentityFile=none"],
      })
      masters.push(handle)
    } catch (caught) {
      error = caught
    }
    if (!SshOpenError.isInstance(error)) throw new Error(`expected SshOpenError, got ${error}`)
    expect(error.data.authFailure).toBe(true)
  }, 30_000)

  test("open with password authenticates via one-shot askpass and cleans up", async () => {
    const before = await askpassLeftovers()
    master = await open(target, {
      controlPath: path.join(workDir, "m1.sock"),
      password: PASSWORD,
      extraArgs: [...baseExtraArgs(), "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no"],
    })
    masters.push(master)
    // every askpass temp dir created during open() must be gone again
    const after = await askpassLeftovers()
    expect(after.filter((entry) => !before.includes(entry))).toEqual([])
    const result = await exec(master, "whoami")
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("testuser")
  }, 60_000)

  test("wrong password surfaces an auth failure and still cleans up askpass files", async () => {
    const before = await askpassLeftovers()
    let error: unknown
    try {
      await open(target, {
        controlPath: path.join(workDir, "m1-bad.sock"),
        password: "definitely-wrong",
        extraArgs: [...baseExtraArgs(), "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no"],
      })
    } catch (caught) {
      error = caught
    }
    if (!SshOpenError.isInstance(error)) throw new Error(`expected SshOpenError, got ${error}`)
    expect(error.data.authFailure).toBe(true)
    const after = await askpassLeftovers()
    expect(after.filter((entry) => !before.includes(entry))).toEqual([])
  }, 60_000)

  test("exec pipes the script over stdin and supports binary payload round-trips", async () => {
    const handle = requireMaster()

    const plain = await exec(handle, "printf out; printf err >&2; exit 7")
    expect(plain.code).toBe(7)
    expect(plain.stdout).toBe("out")
    expect(plain.stderr).toBe("err")

    const payload = Buffer.from(Array.from({ length: 64 * 1024 + 3 }, (_, i) => (i * 7 + 13) % 256))
    const roundtrip = await exec(handle, "base64", { stdin: new Uint8Array(payload) })
    expect(roundtrip.code).toBe(0)
    expect(roundtrip.stdout.replace(/\s+/g, "")).toBe(payload.toString("base64"))
  }, 60_000)

  test("push streams content atomically with mode and progress", async () => {
    const handle = requireMaster()
    const size = 300 * 1024 + 17
    const bytes = Buffer.alloc(size)
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256
    const sha = createHash("sha256").update(bytes).digest("hex")
    const remotePath = "/home/testuser/push dir/file's.bin"
    const progress: number[] = []

    await push(handle, {
      content: new Blob([bytes]),
      remotePath,
      mode: "0755",
      onProgress: (transferred) => progress.push(transferred),
    })

    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1]).toBe(size)
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1])

    const check = await exec(
      handle,
      `sha256sum < "/home/testuser/push dir/file's.bin" | awk '{print $1}'; stat -c %a "/home/testuser/push dir/file's.bin"; ls "/home/testuser/push dir"`,
    )
    expect(check.code).toBe(0)
    const lines = check.stdout.trim().split("\n")
    expect(lines[0]).toBe(sha)
    expect(lines[1]).toBe("755")
    // atomic: no temp files left behind
    expect(lines.slice(2)).toEqual(["file's.bin"])
  }, 60_000)

  test("push accepts a local file path as content", async () => {
    const handle = requireMaster()
    const local = path.join(workDir, "local-content.txt")
    await fs.writeFile(local, "from a local file\n")
    await push(handle, { content: local, remotePath: "/home/testuser/from-path.txt" })
    const result = await exec(handle, "cat /home/testuser/from-path.txt; stat -c %a /home/testuser/from-path.txt")
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("from a local file\n644\n")
  }, 60_000)

  test("installKey is idempotent and enables a passwordless BatchMode open", async () => {
    const handle = requireMaster()
    const keyDir = path.join(workDir, "keys")

    const first = await installKey(handle, "itest", keyDir)
    privateKeyPath = first.privateKeyPath
    expect(privateKeyPath).toContain("opencode-teleport-itest")
    const stat = await fs.stat(privateKeyPath)
    expect((stat.mode & 0o777).toString(8)).toBe("600")
    const dirStat = await fs.stat(keyDir)
    expect((dirStat.mode & 0o777).toString(8)).toBe("700")

    const second = await installKey(handle, "itest", keyDir)
    expect(second.privateKeyPath).toBe(privateKeyPath)

    const count = await exec(handle, "grep -c 'opencode-teleport-itest' ~/.ssh/authorized_keys")
    expect(count.stdout.trim()).toBe("1")

    const keyed = await open(target, {
      controlPath: path.join(workDir, "m2.sock"),
      extraArgs: [...baseExtraArgs(), "-i", privateKeyPath, "-o", "IdentitiesOnly=yes"],
    })
    masters.push(keyed)
    const who = await exec(keyed, "whoami")
    expect(who.stdout.trim()).toBe("testuser")
    await close(keyed)
  }, 60_000)

  test("tunnel forwards TCP to the remote loopback", async () => {
    const localPort = freePort()
    const states: TunnelState[] = []
    const handle = tunnel({
      target,
      identityFile: privateKeyPath,
      localPort,
      remotePort: 22,
      onStateChange: (state) => states.push(state),
      extraArgs: baseExtraArgs(),
    })
    tunnels.push(handle)
    const banner = await waitBanner(localPort, 20_000)
    expect(banner).toStartWith("SSH-")
    expect(states).toContain("connecting")
    expect(states).toContain("connected")
    expect(handle.state).toBe("connected")
  }, 60_000)

  test("tunnel respawns after the container restarts", async () => {
    const localPort = freePort()
    const states: TunnelState[] = []
    const handle = tunnel({
      target,
      identityFile: privateKeyPath,
      localPort,
      remotePort: 22,
      onStateChange: (state) => states.push(state),
      extraArgs: baseExtraArgs(),
    })
    tunnels.push(handle)
    await waitBanner(localPort, 20_000)

    docker(["restart", "-t", "1", container], { timeout: 60_000 })

    const banner = await waitBanner(localPort, 45_000)
    expect(banner).toStartWith("SSH-")
    expect(states).toContain("reconnecting")
    expect(states.filter((state) => state === "connected").length).toBeGreaterThanOrEqual(2)

    await handle.stop()
    expect(handle.state).toBe("stopped")
    // listener is gone after stop
    await Bun.sleep(200)
    await expect(readBanner(localPort, 1_500)).rejects.toThrow()
  }, 120_000)

  test("removeKey is idempotent and revokes key access", async () => {
    // the password master died with the container restart; reconnect with the key
    const keyed = await open(target, {
      controlPath: path.join(workDir, "m3.sock"),
      extraArgs: [...baseExtraArgs(), "-i", privateKeyPath, "-o", "IdentitiesOnly=yes"],
    })
    masters.push(keyed)

    await removeKey(keyed, "itest")
    await removeKey(keyed, "itest")
    const count = await exec(keyed, "grep -c 'opencode-teleport-itest' ~/.ssh/authorized_keys || true")
    expect(count.stdout.trim()).toBe("0")

    let error: unknown
    try {
      const denied = await open(target, {
        controlPath: path.join(workDir, "m4.sock"),
        extraArgs: [...baseExtraArgs(), "-i", privateKeyPath, "-o", "IdentitiesOnly=yes"],
      })
      masters.push(denied)
    } catch (caught) {
      error = caught
    }
    if (!SshOpenError.isInstance(error)) throw new Error(`expected SshOpenError, got ${error}`)
    expect(error.data.authFailure).toBe(true)

    // close tears down the control socket; a second close is safe
    await close(keyed)
    await close(keyed)
    expect(await fs.exists(path.join(workDir, "m3.sock"))).toBe(false)
  }, 60_000)
})
