import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { BinaryCache } from "../../src/teleport/binary-cache"

/** Canonical probe output builder. Set a key to `undefined` to omit the line. */
function sample(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    uname_s: "Linux",
    uname_m: "x86_64",
    musl: "no",
    rosetta: "no",
    avx2: "yes",
    home: "/home/u",
    data_dir: "/home/u/.local/share/opencode",
    config_dir: "/home/u/.config/opencode",
    state_dir: "/home/u/.local/state/opencode",
    opencode_version: "1.2.3",
  }
  const merged = { ...base, ...overrides }
  return Object.entries(merged)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

describe("probeScript", () => {
  test("runs under POSIX sh on this machine and parses into a Probe", async () => {
    const proc = Bun.spawn(["sh", "-c", BinaryCache.probeScript], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
    const [output, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")

    const probe = BinaryCache.parseProbe(output)
    expect(probe.uname_s).toMatch(/^(Darwin|Linux)/)
    expect(probe.uname_m.length).toBeGreaterThan(0)
    expect(typeof probe.musl).toBe("boolean")
    expect(typeof probe.rosetta).toBe("boolean")
    expect(typeof probe.avx2).toBe("boolean")
    if (process.platform === "darwin") expect(probe.musl).toBe(false)
    expect(probe.home).toBe(os.homedir())

    const home = os.homedir()
    const dataBase = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
    const configBase = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
    const stateBase = process.env.XDG_STATE_HOME || path.join(home, ".local", "state")
    expect(probe.data_dir).toBe(path.join(dataBase, "opencode"))
    expect(probe.config_dir).toBe(path.join(configBase, "opencode"))
    expect(probe.state_dir).toBe(path.join(stateBase, "opencode"))
    expect(typeof probe.opencode_version).toBe("string")
  })
})

describe("parseProbe", () => {
  test("parses KEY=VALUE lines into typed fields", () => {
    const probe = BinaryCache.parseProbe(sample())
    expect(probe.uname_s).toBe("Linux")
    expect(probe.uname_m).toBe("x86_64")
    expect(probe.musl).toBe(false)
    expect(probe.rosetta).toBe(false)
    expect(probe.avx2).toBe(true)
    expect(probe.home).toBe("/home/u")
    expect(probe.data_dir).toBe("/home/u/.local/share/opencode")
    expect(probe.config_dir).toBe("/home/u/.config/opencode")
    expect(probe.state_dir).toBe("/home/u/.local/state/opencode")
    expect(probe.opencode_version).toBe("1.2.3")
  })

  test("maps yes to true", () => {
    const probe = BinaryCache.parseProbe(sample({ musl: "yes", rosetta: "yes", avx2: "yes" }))
    expect(probe.musl).toBe(true)
    expect(probe.rosetta).toBe(true)
    expect(probe.avx2).toBe(true)
  })

  test("tolerates CRLF line endings and non KEY=VALUE noise (ssh banners, motd)", () => {
    const output = "Welcome to the server!\r\n" + sample().replace(/\n/g, "\r\n") + "\r\nLast login: today\r\n"
    const probe = BinaryCache.parseProbe(output)
    expect(probe.uname_s).toBe("Linux")
    expect(probe.opencode_version).toBe("1.2.3")
  })

  test("preserves '=' inside values", () => {
    const probe = BinaryCache.parseProbe(sample({ home: "/home/u=weird" }))
    expect(probe.home).toBe("/home/u=weird")
  })

  test("allows empty opencode_version (no existing install)", () => {
    const probe = BinaryCache.parseProbe(sample({ opencode_version: "" }))
    expect(probe.opencode_version).toBe("")
  })

  test("throws a typed error naming the missing keys", () => {
    expect(() => BinaryCache.parseProbe(sample({ musl: undefined }))).toThrow(/musl/)
    expect(() => BinaryCache.parseProbe("")).toThrow(/uname_s/)
  })
})

describe("targetOf", () => {
  const target = (overrides: Record<string, string | undefined> = {}) =>
    BinaryCache.targetOf(BinaryCache.parseProbe(sample(overrides)))

  test("maps every target the install script supports", () => {
    // linux x64 (glibc)
    expect(target({ uname_s: "Linux", uname_m: "x86_64", avx2: "yes" })).toBe("linux-x64")
    expect(target({ uname_s: "Linux", uname_m: "x86_64", avx2: "no" })).toBe("linux-x64-baseline")
    // linux x64 (musl)
    expect(target({ uname_s: "Linux", uname_m: "x86_64", musl: "yes", avx2: "yes" })).toBe("linux-x64-musl")
    expect(target({ uname_s: "Linux", uname_m: "x86_64", musl: "yes", avx2: "no" })).toBe("linux-x64-baseline-musl")
    // linux arm64 — never baseline, avx2 is x64-only
    expect(target({ uname_s: "Linux", uname_m: "aarch64", avx2: "no" })).toBe("linux-arm64")
    expect(target({ uname_s: "Linux", uname_m: "aarch64", musl: "yes", avx2: "no" })).toBe("linux-arm64-musl")
    expect(target({ uname_s: "Linux", uname_m: "arm64", avx2: "no" })).toBe("linux-arm64")
    // darwin
    expect(target({ uname_s: "Darwin", uname_m: "arm64", avx2: "no" })).toBe("darwin-arm64")
    expect(target({ uname_s: "Darwin", uname_m: "x86_64", avx2: "yes" })).toBe("darwin-x64")
    expect(target({ uname_s: "Darwin", uname_m: "x86_64", avx2: "no" })).toBe("darwin-x64-baseline")
    // windows (POSIX sh environments)
    expect(target({ uname_s: "MINGW64_NT-10.0-19045", uname_m: "x86_64", avx2: "yes" })).toBe("windows-x64")
    expect(target({ uname_s: "MSYS_NT-10.0", uname_m: "x86_64", avx2: "no" })).toBe("windows-x64-baseline")
    expect(target({ uname_s: "CYGWIN_NT-10.0", uname_m: "x86_64", avx2: "yes" })).toBe("windows-x64")
  })

  test("darwin x64 under Rosetta is really arm64", () => {
    expect(target({ uname_s: "Darwin", uname_m: "x86_64", rosetta: "yes", avx2: "yes" })).toBe("darwin-arm64")
    // rosetta remap happens before the baseline check, so avx2=no must not add -baseline
    expect(target({ uname_s: "Darwin", uname_m: "x86_64", rosetta: "yes", avx2: "no" })).toBe("darwin-arm64")
  })

  test("musl only applies to linux", () => {
    expect(target({ uname_s: "MINGW64_NT-10.0", uname_m: "x86_64", musl: "yes", avx2: "yes" })).toBe("windows-x64")
    expect(target({ uname_s: "Darwin", uname_m: "arm64", musl: "yes" })).toBe("darwin-arm64")
  })

  test("throws a typed error for unsupported os/arch combos", () => {
    expect(() => target({ uname_s: "FreeBSD", uname_m: "x86_64" })).toThrow(/[Uu]nsupported/)
    expect(() => target({ uname_s: "Linux", uname_m: "riscv64" })).toThrow(/[Uu]nsupported/)
    expect(() => target({ uname_s: "MINGW64_NT-10.0", uname_m: "aarch64" })).toThrow(/[Uu]nsupported/)
  })

  test("every mappable target is in the published targets table", () => {
    expect([...BinaryCache.targets].sort()).toEqual(
      [
        "linux-x64",
        "linux-x64-baseline",
        "linux-x64-musl",
        "linux-x64-baseline-musl",
        "linux-arm64",
        "linux-arm64-musl",
        "darwin-x64",
        "darwin-x64-baseline",
        "darwin-arm64",
        "windows-x64",
        "windows-x64-baseline",
      ].sort(),
    )
  })
})

describe("ensure", () => {
  test("returns the cached path without downloading when the binary is already cached", async () => {
    const version = `0.0.0-test-${Math.random().toString(36).slice(2)}`
    const file = BinaryCache.cachedPath(version, "linux-arm64")
    await Bun.write(file, "#!/bin/sh\nexit 0\n")
    expect(await BinaryCache.ensure(version, "linux-arm64", { download: false })).toBe(file)
    expect(await BinaryCache.ensure(version, "linux-arm64")).toBe(file)
  })

  test("fails offline with a message telling the user to prefetch", async () => {
    const version = `0.0.0-test-${Math.random().toString(36).slice(2)}`
    const error = await BinaryCache.ensure(version, "linux-x64", { download: false }).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeDefined()
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain("opencode teleport prefetch linux-x64")
  })
})

describe("cachedPath", () => {
  test("lays out the cache under Global.Path.cache/teleport/bin/v<version>/<target>/opencode", () => {
    expect(BinaryCache.cachedPath("1.2.3", "linux-arm64-musl")).toBe(
      path.join(Global.Path.cache, "teleport", "bin", "v1.2.3", "linux-arm64-musl", "opencode"),
    )
    expect(BinaryCache.cachedPath("0.0.1", "darwin-arm64")).toBe(
      path.join(Global.Path.cache, "teleport", "bin", "v0.0.1", "darwin-arm64", "opencode"),
    )
  })
})

// Real download from GitHub releases. Opt in with TELEPORT_NETWORK_TESTS=1.
const networkTest = process.env.TELEPORT_NETWORK_TESTS ? test : test.skip

describe("prefetch (network)", () => {
  networkTest(
    "downloads the latest release for this machine's target and the binary runs",
    async () => {
      const { Installation } = await import("../../src/installation")
      const version = await Installation.latest("curl")
      expect(version).toMatch(/^\d+\.\d+\.\d+/)

      const proc = Bun.spawn(["sh", "-c", BinaryCache.probeScript], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      })
      const output = await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
      const target = BinaryCache.targetOf(BinaryCache.parseProbe(output))

      const file = await BinaryCache.ensure(version, target, { download: true })
      expect(file).toBe(BinaryCache.cachedPath(version, target))

      const run = Bun.spawn([file, "--version"], { stdout: "pipe", stderr: "pipe" })
      const [stdout, exitCode] = await Promise.all([new Response(run.stdout).text(), run.exited])
      expect(exitCode).toBe(0)
      expect(stdout.trim()).toBe(version)
    },
    300000,
  )
})
