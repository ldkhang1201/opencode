// /teleport orchestration: move a session to a remote machine over SSH, keep
// a supervised tunnel + opportunistic pull loop while it lives there, and
// bring it back (remote authoritative). Every step is idempotent and driven
// from the persisted state file (src/teleport/state.ts) so a fresh process —
// or a crashed server — can resume any phase. Secrets never enter argv: the
// ssh password goes through a one-shot askpass (ssh.ts) and the remote server
// password only ever travels inside exec-stdin scripts and 0600 files.
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Context, Duration, Effect, Fiber, Layer, Schedule, Schema, Scope, Semaphore } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Installation } from "@/installation"
import { InstanceStore } from "@/project/instance-store"
import { ServerAuth } from "@/server/auth"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionTransfer } from "@/session/transfer"
import { BinaryCache } from "./binary-cache"
import { TeleportSsh } from "./ssh"
import { TeleportState } from "./state"

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class PasswordRequiredError extends Schema.TaggedErrorClass<PasswordRequiredError>()(
  "TeleportPasswordRequiredError",
  { target: Schema.String },
) {
  override get message() {
    return `key authentication to ${this.target} failed — a password is required`
  }
}

export class AlreadyTeleportedError extends Schema.TaggedErrorClass<AlreadyTeleportedError>()(
  "TeleportAlreadyTeleportedError",
  { sessionID: Schema.String, target: Schema.String },
) {
  override get message() {
    return `session ${this.sessionID} is already teleported to ${this.target}`
  }
}

export class NotTeleportedError extends Schema.TaggedErrorClass<NotTeleportedError>()("TeleportNotTeleportedError", {
  sessionID: Schema.String,
}) {
  override get message() {
    return `session ${this.sessionID} is not teleported`
  }
}

export class UnsupportedTargetError extends Schema.TaggedErrorClass<UnsupportedTargetError>()(
  "TeleportUnsupportedTargetError",
  { target: Schema.String },
) {
  override get message() {
    return `teleport does not support ${this.target} remotes yet`
  }
}

export class RemoteUnreachableError extends Schema.TaggedErrorClass<RemoteUnreachableError>()(
  "TeleportRemoteUnreachableError",
  { sessionID: Schema.String, message: Schema.String },
) {}

export class TeleportError extends Schema.TaggedErrorClass<TeleportError>()("TeleportError", {
  step: Schema.String,
  message: Schema.String,
}) {}

export type StartError =
  | PasswordRequiredError
  | AlreadyTeleportedError
  | UnsupportedTargetError
  | TeleportError
  | Session.BusyError
  | BinaryCache.BinaryNotCachedError
  | BinaryCache.DownloadFailedError
export type OpError = NotTeleportedError | TeleportError

// ---------------------------------------------------------------------------
// pure helpers (unit-tested in test/teleport/service.test.ts)
// ---------------------------------------------------------------------------

/** Session ids contain `_`, which the ssh key-tag alphabet rejects. */
export function sanitizeTag(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9.-]/g, "-")
}

/** Resolve the target path against the remote home; no path means home itself. */
export function resolveRemoteDir(home: string, targetPath?: string): string {
  if (!targetPath) return home
  if (targetPath === "~") return home
  if (targetPath.startsWith("~/")) return path.posix.join(home, targetPath.slice(2))
  return targetPath
}

const LISTENING = /listening on http:\/\/[^\s:]+:(\d+)/

/** Extract the port from `opencode serve` stdout captured in serve.log. */
export function parseServeLog(log: string): number | undefined {
  const match = LISTENING.exec(log)
  return match ? Number(match[1]) : undefined
}

const VALID_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/

function envPrefix(env: Record<string, string>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!VALID_ENV_KEY.test(key)) throw new Error(`invalid env key ${JSON.stringify(key)}`)
    parts.push(`${key}=${TeleportSsh.shellQuote(value)}`)
  }
  return parts.length ? parts.join(" ") + " " : ""
}

export interface ServeScriptInput {
  binPath: string
  dir: string
  teleportDir: string
  logPath: string
  password: string
  env: Record<string, string>
}

/**
 * Detached remote `opencode serve` spawn. Runs via exec-stdin so the password
 * never appears in argv or in serve.log (env assignments are not echoed).
 */
export function serveScript(input: ServeScriptInput): string {
  const q = TeleportSsh.shellQuote
  const env = envPrefix({ OPENCODE_SERVER_PASSWORD: input.password, ...input.env })
  return [
    "set -eu",
    `mkdir -p ${q(input.teleportDir)}`,
    `mkdir -p ${q(input.dir)}`,
    `cd ${q(input.dir)}`,
    `${env}nohup ${q(input.binPath)} serve --hostname 127.0.0.1 --port 0 </dev/null >${q(input.logPath)} 2>&1 &`,
    'echo "PID=$!"',
  ].join("\n")
}

export function importScript(input: { binPath: string; dir: string; file: string; env: Record<string, string> }) {
  const q = TeleportSsh.shellQuote
  return [
    "set -eu",
    `mkdir -p ${q(input.dir)}`,
    `cd ${q(input.dir)}`,
    `${envPrefix(input.env)}${q(input.binPath)} import ${q(input.file)}`,
    `rm -f -- ${q(input.file)}`,
  ].join("\n")
}

export function exportScript(input: { binPath: string; dir: string; sessionID: string }) {
  const q = TeleportSsh.shellQuote
  return ["set -eu", `cd ${q(input.dir)}`, `${q(input.binPath)} export ${q(input.sessionID)}`].join("\n")
}

/**
 * Retarget a resumed (failed/interrupted) state at the freshly parsed target:
 * tunnel, pull, return and abort all dial `st.target.{user,host}`, so retrying
 * at a different host must not leave them pointing at the old one. The path is
 * left alone — it is re-resolved against the remote home in the probe step.
 */
export function resumeState(existing: TeleportState.State, parsed: TeleportSsh.Target): TeleportState.State {
  existing.target.host = parsed.host
  if (parsed.user === undefined) delete existing.target.user // the schema rejects an explicit undefined
  else existing.target.user = parsed.user
  return existing
}

export interface PullLoopInput {
  sessionID: string
  pull: Effect.Effect<void, OpError>
  /** runs exactly once when the loop stops because the state file is gone */
  release: Effect.Effect<void>
  /** test hook; production ticks every minute */
  interval?: Duration.Duration
}

/**
 * Supervised pull-loop body. Sleeps first: right after start() the transcript
 * was just imported, and recover() in short-lived processes must not fire an
 * immediate pull that races the owning supervisor's imports. Transient
 * failures (and defects) are logged and retried forever; NotTeleportedError —
 * the state file is gone, an out-of-band return/abort — runs `release` once
 * and stops the loop instead of leaking the tunnel plus a warning per tick.
 */
export function pullLoopEffect(input: PullLoopInput): Effect.Effect<void> {
  const tick = input.pull.pipe(
    Effect.as("continue" as const),
    Effect.catchTag("TeleportNotTeleportedError", () => Effect.succeed("stop" as const)),
    Effect.catchCause((cause) =>
      Effect.logWarning("teleport pull failed", { sessionID: input.sessionID, cause }).pipe(
        Effect.as("continue" as const),
      ),
    ),
  )
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(input.interval ?? Duration.minutes(1))
      if ((yield* tick) === "stop") break
    }
    yield* input.release
  })
}

/**
 * Per-session in-process mutex over start/pull/return/abort: all four mutate
 * the same state file and session row, and pull's check-then-import must
 * never interleave with return's authoritative import (the pull would
 * re-freeze the just-returned row). Cross-process races (e.g. a CLI
 * `teleport pull` racing a server-side return) remain possible — the state
 * file carries no on-disk lock — and are accepted for v1.
 */
export function makeSessionLocks(): (
  sessionID: string,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  const locks = new Map<string, Semaphore.Semaphore>()
  return (sessionID) => {
    let lock = locks.get(sessionID)
    if (!lock) {
      lock = Semaphore.makeUnsafe(1)
      locks.set(sessionID, lock)
    }
    return lock.withPermits(1)
  }
}

/** Remove the teleport freeze marker; undefined when nothing else remains. */
export function stripTeleport(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  const { teleport: _teleport, ...rest } = metadata
  return Object.keys(rest).length ? rest : undefined
}

/** Banner-tolerant JSON parse: take everything from the first `{`. */
function parseJsonOutput(stdout: string): unknown {
  const start = stdout.indexOf("{")
  if (start === -1) throw new Error(`no JSON found in output: ${stdout.slice(0, 200)}`)
  return JSON.parse(stdout.slice(start))
}

async function resolveVersion(requested?: string): Promise<string> {
  if (requested) return requested.replace(/^v/, "")
  if (Installation.isLocal()) return Installation.latest("curl")
  return InstallationVersion
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export interface StartInput {
  sessionID: SessionID
  target: string
  password?: string
  sshArgs?: string[]
  binaryVersion?: string
  onPhase?: (phase: string, detail?: string) => void
}

export interface Info {
  url: string
  username: string
  password: string
  directory: string
  sessionID: string
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Info, StartError>
  readonly pull: (sessionID: SessionID) => Effect.Effect<void, OpError>
  readonly ret: (sessionID: SessionID, opts?: { scrub?: boolean; sshArgs?: string[] }) => Effect.Effect<void, OpError>
  readonly abort: (
    sessionID: SessionID,
    opts?: { force?: boolean; sshArgs?: string[] },
  ) => Effect.Effect<void, OpError | RemoteUnreachableError>
  readonly list: () => Effect.Effect<TeleportState.State[]>
  readonly status: (sessionID: SessionID) => Effect.Effect<TeleportState.State | undefined>
  /** stop this process's tunnel + pull loop without touching the remote (the session stays teleported) */
  readonly disconnect: (sessionID: SessionID) => Effect.Effect<void>
  /** crash recovery on server start: re-establish tunnels/pulls for "teleported" sessions; never initiates returns */
  readonly recover: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Teleport") {}

const binOf = (home: string) => path.posix.join(home, ".opencode", "bin", "opencode")

const io = <A>(step: string, run: () => Promise<A>): Effect.Effect<A, TeleportError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new TeleportError({ step, message: cause instanceof Error ? cause.message : String(cause) }),
  })

const trim = (value: string, max = 800) => (value.length > max ? value.slice(-max) : value)

interface RegistryEntry {
  tunnel?: TeleportSsh.TunnelHandle
  pull?: Fiber.Fiber<unknown, unknown>
}

/** MasterHandle rebuilt from persisted state: with the ephemeral key in
 * extraArgs, ssh falls back to a direct connection when the control socket is
 * gone, so every operation works from a fresh process. */
function masterOf(st: TeleportState.State, sshArgs?: string[]): TeleportSsh.MasterHandle {
  const target: TeleportSsh.Target = { host: st.target.host }
  if (st.target.user !== undefined) target.user = st.target.user
  const args = [...(sshArgs ?? st.local.sshArgs ?? [])]
  if (st.local.keyPath) args.push("-i", st.local.keyPath, "-o", "IdentitiesOnly=yes")
  return { target, destination: TeleportSsh.destination(target), controlPath: st.local.controlPath, extraArgs: args }
}

const layer: Layer.Layer<
  Service,
  never,
  Session.Service | SessionRunState.Service | Database.Service | BinaryCache.Service | InstanceStore.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service
    const database = yield* Database.Service
    const binaries = yield* BinaryCache.Service
    const store = yield* InstanceStore.Service
    const scope = yield* Scope.Scope

    // The process that ran start()/recover() owns the tunnel + pull fiber.
    const registry = new Map<string, RegistryEntry>()

    // Intra-process serialization of start/pull/ret/abort per session (see
    // makeSessionLocks for the cross-process caveat).
    const locks = makeSessionLocks()

    const stopRegistry = Effect.fnUntraced(function* (sessionID: string) {
      const entry = registry.get(sessionID)
      if (!entry) return
      registry.delete(sessionID)
      if (entry.pull) yield* Fiber.interrupt(entry.pull)
      if (entry.tunnel) yield* Effect.promise(() => entry.tunnel!.stop())
    })

    // Graceful runtime disposal must not orphan `ssh -N` tunnel children.
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...registry.keys()], stopRegistry, { discard: true }).pipe(Effect.ignore),
    )

    const persist = (st: TeleportState.State) =>
      Effect.promise(() => {
        st.updatedAt = Date.now()
        return TeleportState.write(st)
      })

    const exec = Effect.fnUntraced(function* (
      step: string,
      master: TeleportSsh.MasterHandle,
      script: string,
      opts?: TeleportSsh.ExecOptions,
    ) {
      const result = yield* io(step, () => TeleportSsh.exec(master, script, opts))
      if (result.code !== 0)
        return yield* new TeleportError({
          step,
          message: `remote command failed (exit ${result.code}): ${trim(result.stderr || result.stdout)}`,
        })
      return result
    })

    const remoteExport = Effect.fnUntraced(function* (st: TeleportState.State, master: TeleportSsh.MasterHandle) {
      const out = yield* exec(
        "export",
        master,
        exportScript({ binPath: binOf(st.remote.home), dir: st.target.path, sessionID: st.sessionID }),
      )
      return yield* io("export", async () => parseJsonOutput(out.stdout) as SessionTransfer.ExportData)
    })

    const localImport = Effect.fnUntraced(function* (
      sessionID: SessionID,
      data: SessionTransfer.ExportData,
      metadata: Record<string, unknown> | null,
    ) {
      const info = yield* sessions
        .get(sessionID)
        .pipe(Effect.mapError((error) => new TeleportError({ step: "import", message: error.message })))
      const ctx = yield* store.load({ directory: info.directory })
      yield* SessionTransfer.importSession(data, ctx, { overwrite: true, metadata }).pipe(
        Effect.provideService(Database.Service, database),
      )
      return info
    })

    const healthCheck = (port: number, password: string, step: string) =>
      Effect.tryPromise({
        try: async () => {
          await fetch(`http://127.0.0.1:${port}/`, {
            headers: ServerAuth.headers({ password }),
            signal: AbortSignal.timeout(2_000),
          })
        },
        catch: (cause) =>
          new TeleportError({ step, message: `health check through tunnel failed: ${String(cause)}` }),
      }).pipe(Effect.retry(Schedule.spaced(Duration.millis(500)).pipe(Schedule.both(Schedule.recurs(60)))))

    const pullUnlocked = Effect.fnUntraced(function* (sessionID: SessionID) {
      const st = yield* Effect.promise(() => TeleportState.read(sessionID))
      if (!st) return yield* new NotTeleportedError({ sessionID })
      if (st.state !== "teleported") return
      const master = masterOf(st)
      const data = yield* remoteExport(st, master)
      // a return may have started while we exported: it persists "returning"
      // FIRST, so re-reading here keeps the pull from re-freezing the row
      // after the return's authoritative import
      const fresh = yield* Effect.promise(() => TeleportState.read(sessionID))
      if (!fresh || fresh.state !== "teleported") return
      const local = yield* sessions
        .get(sessionID)
        .pipe(Effect.mapError((error) => new TeleportError({ step: "pull", message: error.message })))
      yield* localImport(sessionID, data, (local.metadata as Record<string, unknown> | undefined) ?? null)
      fresh.lastPullAt = Date.now()
      yield* persist(fresh)
    })

    const pull: Interface["pull"] = Effect.fn("Teleport.pull")(function* (sessionID) {
      return yield* locks(sessionID)(pullUnlocked(sessionID))
    })

    const pullLoop = (sessionID: SessionID) =>
      pullLoopEffect({
        sessionID,
        pull: pull(sessionID),
        // out-of-band return/abort removed the state file: drop this session's
        // registry entry inline — stopRegistry would interrupt the very fiber
        // running this loop before it could stop the tunnel
        release: Effect.gen(function* () {
          const entry = registry.get(sessionID)
          if (!entry) return
          registry.delete(sessionID)
          if (entry.tunnel) yield* Effect.promise(() => entry.tunnel!.stop())
        }),
      }).pipe(Effect.forkIn(scope))

    /** Establish the tunnel + health check + pull fiber for a bootstrapped state. */
    const connect = Effect.fnUntraced(function* (st: TeleportState.State, step: string) {
      if (st.remote.serverPort === undefined || st.remote.serverPassword === undefined || !st.local.keyPath)
        return yield* new TeleportError({ step, message: "state file is missing server or key details" })
      yield* stopRegistry(st.sessionID)
      const localPort = TeleportSsh.freePort()
      const target: TeleportSsh.Target = { host: st.target.host }
      if (st.target.user !== undefined) target.user = st.target.user
      const tunnel = TeleportSsh.tunnel({
        target,
        identityFile: st.local.keyPath,
        localPort,
        remotePort: st.remote.serverPort,
        extraArgs: [...(st.local.sshArgs ?? [])],
      })
      const entry: RegistryEntry = { tunnel }
      registry.set(st.sessionID, entry)
      // "connected" only proves the local listener; prove end-to-end HTTP
      // (AllowTcpForwarding may be off server-side).
      yield* healthCheck(localPort, st.remote.serverPassword, step).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            yield* stopRegistry(st.sessionID)
          }),
        ),
      )
      st.local.tunnelPort = localPort
      yield* persist(st)
      entry.pull = yield* pullLoop(SessionID.make(st.sessionID))
      return {
        url: `http://127.0.0.1:${localPort}`,
        username: "opencode",
        password: st.remote.serverPassword,
        directory: st.target.path,
        sessionID: st.sessionID,
      } satisfies Info
    })

    const startUnlocked = Effect.fnUntraced(function* (input: StartInput) {
      const onPhase = input.onPhase ?? (() => {})
      const parsed = TeleportSsh.parseTarget(input.target)
      if (TeleportSsh.TargetParseError.isInstance(parsed))
        return yield* new TeleportError({ step: "target", message: parsed.data.message })

      const session = yield* sessions
        .get(input.sessionID)
        .pipe(Effect.mapError((error) => new TeleportError({ step: "session", message: error.message })))

      const existing = yield* Effect.promise(() => TeleportState.read(input.sessionID))
      if (existing?.state === "teleported" && registry.has(input.sessionID))
        return yield* new AlreadyTeleportedError({
          sessionID: input.sessionID,
          target: TeleportSsh.destination(parsed),
        })
      if (existing?.state === "returning")
        return yield* new TeleportError({
          step: "session",
          message: "session is being returned — finish `opencode teleport return` first",
        })

      // A running local agent loop would immediately diverge from the frozen
      // copy — refuse busy sessions with the same signal prompt/revert
      // admission uses, before any remote side effect.
      yield* runState.assertNotBusy(input.sessionID)

      const now = Date.now()
      const tag = sanitizeTag(input.sessionID)
      const st: TeleportState.State = existing ? resumeState(existing, parsed) : {
        version: 1,
        sessionID: input.sessionID,
        target: { ...(parsed.user !== undefined ? { user: parsed.user } : {}), host: parsed.host, path: parsed.path ?? "" },
        state: "bootstrapping",
        createdAt: now,
        updatedAt: now,
        remote: {
          home: "",
          dataDir: "",
          stateDir: "",
          target: "",
          binaryPushed: false,
          serverLogPath: "",
          stateDir_: "",
        },
        local: {
          keyTag: tag,
          controlPath: path.join(os.tmpdir(), `oc-tp-${tag.slice(-10)}.sock`),
          ...(input.sshArgs?.length ? { sshArgs: [...input.sshArgs] } : {}),
        },
        copiedFiles: [],
      }
      if (input.sshArgs?.length) st.local.sshArgs = [...input.sshArgs]
      if (st.state !== "teleported") st.state = "bootstrapping"
      delete st.error // the schema rejects an explicit undefined
      // persist before any side effect so a crash is always resumable
      yield* persist(st)

      const failed = <A, E>(self: Effect.Effect<A, E>) =>
        self.pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              if (st.state !== "teleported") st.state = "failed"
              st.error = error instanceof Error ? error.message : String(error)
              yield* persist(st)
            }),
          ),
        )

      return yield* failed(
        Effect.gen(function* () {
          // 2. master connection (BatchMode first, askpass on retry)
          onPhase("connect", TeleportSsh.destination(parsed))
          const sshArgs = [...(st.local.sshArgs ?? [])]
          const keyArgs = st.local.keyPath ? ["-i", st.local.keyPath, "-o", "IdentitiesOnly=yes"] : []
          // a stale ControlPersist master would shadow the new connection
          yield* Effect.promise(() =>
            TeleportSsh.close({
              target: parsed,
              destination: TeleportSsh.destination(parsed),
              controlPath: st.local.controlPath,
              extraArgs: sshArgs,
            }),
          )
          const open = (password?: string) =>
            Effect.tryPromise({
              try: () =>
                TeleportSsh.open(parsed, {
                  controlPath: st.local.controlPath,
                  extraArgs: [...sshArgs, ...keyArgs],
                  ...(password !== undefined ? { password } : {}),
                }),
              catch: (cause) => cause,
            })
          const master = yield* open().pipe(
            Effect.catch((cause) => {
              if (TeleportSsh.SshOpenError.isInstance(cause) && cause.data.authFailure) {
                if (input.password === undefined)
                  return Effect.fail(new PasswordRequiredError({ target: TeleportSsh.destination(parsed) }))
                return open(input.password).pipe(
                  Effect.mapError((retry) =>
                    TeleportSsh.SshOpenError.isInstance(retry) && retry.data.authFailure
                      ? new PasswordRequiredError({ target: TeleportSsh.destination(parsed) })
                      : new TeleportError({
                          step: "connect",
                          message: retry instanceof Error ? retry.message : String(retry),
                        }),
                  ),
                )
              }
              return Effect.fail(
                new TeleportError({
                  step: "connect",
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
              )
            }),
          )

          // 3. ephemeral key — reconnects are passwordless from here on
          onPhase("key")
          const keyDir = path.join(Global.Path.state, "teleport", "keys")
          const { privateKeyPath } = yield* io("key", () => TeleportSsh.installKey(master, tag, keyDir))
          st.local.keyPath = privateKeyPath
          st.local.keyTag = tag
          yield* persist(st)

          // 4. probe + binary
          onPhase("probe")
          const probeOut = yield* exec("probe", master, BinaryCache.probeScript)
          const probe = yield* io("probe", async () => BinaryCache.parseProbe(probeOut.stdout))
          const platform = yield* io("probe", async () => BinaryCache.targetOf(probe))
          if (platform.startsWith("windows"))
            return yield* new UnsupportedTargetError({ target: platform })
          const remoteDir = resolveRemoteDir(probe.home, parsed.path)
          const teleportDir = path.posix.join(probe.state_dir, "teleport", tag)
          st.target.path = remoteDir
          st.remote.home = probe.home
          st.remote.dataDir = probe.data_dir
          st.remote.stateDir = probe.state_dir
          st.remote.target = platform
          st.remote.stateDir_ = teleportDir
          st.remote.serverLogPath = path.posix.join(teleportDir, "serve.log")
          yield* persist(st)

          const version = yield* io("version", () => resolveVersion(input.binaryVersion))
          if (probe.opencode_version !== version) {
            onPhase("binary", `opencode v${version} for ${platform}`)
            const file = yield* binaries.ensure(version, platform, { download: true })
            yield* io("binary", () =>
              TeleportSsh.push(master, {
                content: file,
                remotePath: binOf(probe.home),
                mode: "0755",
                onProgress: (bytes) => onPhase("binary", `${Math.floor(bytes / 1024 / 1024)} MiB`),
              }),
            )
            st.remote.binaryPushed = true
            yield* persist(st)
          }

          // 5. credentials + env-injected config
          onPhase("credentials")
          const env: Record<string, string> = { OPENCODE_DISABLE_AUTOUPDATE: "1" }
          if (process.env.OPENCODE_CONFIG_CONTENT) env.OPENCODE_CONFIG_CONTENT = process.env.OPENCODE_CONFIG_CONTENT
          if (process.env.OPENCODE_AUTH_CONTENT) env.OPENCODE_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
          const authFile = path.join(Global.Path.data, "auth.json")
          const hasAuth = yield* Effect.promise(() =>
            fs.access(authFile).then(
              () => true,
              () => false,
            ),
          )
          if (hasAuth) {
            const remoteAuth = path.posix.join(probe.data_dir, "auth.json")
            yield* io("credentials", () =>
              TeleportSsh.push(master, { content: authFile, remotePath: remoteAuth, mode: "0600" }),
            )
            if (!st.copiedFiles.includes(remoteAuth)) st.copiedFiles.push(remoteAuth)
            yield* persist(st)
          }

          // 6. export local → import remote (freeze marker stripped)
          onPhase("session")
          const data = yield* SessionTransfer.exportSession(input.sessionID).pipe(
            Effect.provideService(Session.Service, sessions),
            Effect.mapError((error) => new TeleportError({ step: "session", message: String(error) })),
          )
          const cleanMetadata = stripTeleport(data.info.metadata as Record<string, unknown> | undefined)
          const payload = JSON.stringify({
            ...data,
            info: (() => {
              const { metadata: _m, ...rest } = data.info as Record<string, unknown>
              return cleanMetadata ? { ...rest, metadata: cleanMetadata } : rest
            })(),
          })
          const importFile = path.posix.join(teleportDir, `import-${tag}.json`)
          yield* exec("session", master, `mkdir -p ${TeleportSsh.shellQuote(teleportDir)}`)
          yield* io("session", () =>
            TeleportSsh.push(master, { content: new Blob([payload]), remotePath: importFile, mode: "0600" }),
          )
          yield* exec(
            "session",
            master,
            importScript({ binPath: binOf(probe.home), dir: remoteDir, file: importFile, env }),
          )

          // 7/8. remote server: reuse a live one when version+password line up
          onPhase("server")
          const serverJson = path.posix.join(teleportDir, "server.json")
          const infoOut = yield* exec("server", master, `cat ${TeleportSsh.shellQuote(serverJson)} 2>/dev/null || true`)
          let serverPid: number | undefined
          let serverPort: number | undefined
          let serverPassword: string | undefined
          const known = (() => {
            try {
              const parsedInfo = parseJsonOutput(infoOut.stdout) as Record<string, unknown>
              return parsedInfo
            } catch {
              return undefined
            }
          })()
          if (known && typeof known.pid === "number" && typeof known.port === "number") {
            const alive = yield* io("server", () => TeleportSsh.exec(master, `kill -0 ${Math.floor(known.pid as number)} 2>/dev/null`))
            const password = typeof known.password === "string" ? known.password : st.remote.serverPassword
            if (alive.code === 0 && known.version === version && password) {
              serverPid = known.pid
              serverPort = known.port
              serverPassword = password
            } else if (alive.code === 0) {
              // wrong version or unknown password: reap it, a fresh one follows
              yield* io("server", () => TeleportSsh.exec(master, `kill ${Math.floor(known.pid as number)} 2>/dev/null || true`))
            }
          }

          if (serverPort === undefined || serverPassword === undefined) {
            serverPassword = crypto.randomBytes(18).toString("base64url")
            const spawned = yield* exec(
              "server",
              master,
              serveScript({
                binPath: binOf(probe.home),
                dir: remoteDir,
                teleportDir,
                logPath: st.remote.serverLogPath,
                password: serverPassword,
                env,
              }),
            )
            const pidMatch = /PID=(\d+)/.exec(spawned.stdout)
            if (!pidMatch)
              return yield* new TeleportError({ step: "server", message: `no PID in spawn output: ${spawned.stdout}` })
            serverPid = Number(pidMatch[1])

            // poll serve.log for the listening line (up to ~20s)
            serverPort = yield* Effect.gen(function* () {
              const out = yield* exec(
                "server",
                master,
                `cat ${TeleportSsh.shellQuote(st.remote.serverLogPath)} 2>/dev/null || true`,
              )
              const port = parseServeLog(out.stdout)
              if (port === undefined)
                return yield* new TeleportError({ step: "server", message: `server not listening yet: ${trim(out.stdout)}` })
              return port
            }).pipe(Effect.retry(Schedule.spaced(Duration.millis(500)).pipe(Schedule.both(Schedule.recurs(40)))))

            yield* io("server", () =>
              TeleportSsh.push(master, {
                content: new Blob([JSON.stringify({ pid: serverPid, port: serverPort, version, password: serverPassword })]),
                remotePath: serverJson,
                mode: "0600",
              }),
            )
          }

          st.remote.serverPid = serverPid
          st.remote.serverPort = serverPort
          st.remote.serverPassword = serverPassword
          yield* persist(st)

          // 9. tunnel + end-to-end health check
          onPhase("tunnel")
          const info = yield* connect(st, "tunnel")

          // 10. freeze LAST
          onPhase("freeze")
          yield* sessions.setMetadata({
            sessionID: input.sessionID,
            metadata: {
              ...session.metadata,
              teleport: {
                state: "teleported",
                target: input.target,
                remoteDir,
                since: Date.now(),
              },
            },
          })
          st.state = "teleported"
          yield* persist(st)
          onPhase("done", info.url)
          return info
        }),
      )
    })

    const start: Interface["start"] = Effect.fn("Teleport.start")(function* (input) {
      return yield* locks(input.sessionID)(startUnlocked(input))
    })

    const retUnlocked = Effect.fnUntraced(function* (
      sessionID: SessionID,
      opts?: { scrub?: boolean; sshArgs?: string[] },
    ) {
      const st = yield* Effect.promise(() => TeleportState.read(sessionID))
      if (!st) return yield* new NotTeleportedError({ sessionID })
      // Only a live (or already returning) teleport can be returned: a
      // failed/bootstrapping one has no remote server to export from, and
      // persisting "returning" would advertise an impossible "return pending"
      // retry while start() refuses to resume.
      if (st.state !== "teleported" && st.state !== "returning")
        return yield* new TeleportError({
          step: "return",
          message: `session ${sessionID} is ${st.state} — run \`opencode teleport abort\` to clean it up`,
        })
      st.state = "returning"
      yield* persist(st)

      // stop the pull loop first so the final import can't race a pull
      const entry = registry.get(sessionID)
      if (entry?.pull) yield* Fiber.interrupt(entry.pull)

      const master = masterOf(st, opts?.sshArgs)

      // best-effort idle wait through the tunnel (never blocks the return)
      if (entry?.tunnel && st.local.tunnelPort !== undefined && st.remote.serverPassword) {
        const port = st.local.tunnelPort
        const password = st.remote.serverPassword
        yield* Effect.tryPromise(async () => {
          const response = await fetch(
            `http://127.0.0.1:${port}/session/status?directory=${encodeURIComponent(st.target.path)}`,
            { headers: ServerAuth.headers({ password }), signal: AbortSignal.timeout(2_000) },
          )
          const statuses = (await response.json()) as Record<string, { type?: string }>
          if (statuses?.[sessionID]?.type === "busy") throw new Error("busy")
        }).pipe(
          Effect.retry(Schedule.spaced(Duration.seconds(2)).pipe(Schedule.both(Schedule.recurs(15)))),
          Effect.ignore,
        )
      }

      // final export: remote is authoritative; clears the freeze marker in the
      // same row write (remote metadata never carries the marker)
      const data = yield* remoteExport(st, master)
      yield* localImport(sessionID, data, stripTeleport((data.info as { metadata?: Record<string, unknown> }).metadata) ?? null)

      // scrub copied credentials (exact list) + teleport scratch dir
      const q = TeleportSsh.shellQuote
      if (opts?.scrub !== false && st.copiedFiles.length > 0) {
        yield* exec("scrub", master, st.copiedFiles.map((file) => `rm -f -- ${q(file)}`).join("\n")).pipe(Effect.ignore)
      }

      // kill the remote server + server-info; tolerate "already gone"
      if (st.remote.serverPid !== undefined) {
        yield* io("server", () =>
          TeleportSsh.exec(master, `kill ${Math.floor(st.remote.serverPid!)} 2>/dev/null || true`),
        ).pipe(Effect.ignore)
      }
      if (st.remote.stateDir_) {
        const cleanup =
          opts?.scrub !== false
            ? `rm -rf -- ${q(st.remote.stateDir_)}`
            : `rm -f -- ${q(path.posix.join(st.remote.stateDir_, "server.json"))}`
        yield* exec("server", master, cleanup).pipe(Effect.ignore)
      }

      yield* io("key", () => TeleportSsh.removeKey(master, st.local.keyTag)).pipe(Effect.ignore)
      yield* Effect.promise(() => TeleportSsh.close(master))
      yield* stopRegistry(sessionID)
      if (st.local.keyPath) {
        yield* Effect.promise(() =>
          Promise.all([
            fs.rm(st.local.keyPath!, { force: true }),
            fs.rm(`${st.local.keyPath}.pub`, { force: true }),
          ]).then(() => undefined),
        )
      }
      yield* Effect.promise(() => TeleportState.remove(sessionID))
    })

    const ret: Interface["ret"] = Effect.fn("Teleport.return")(function* (sessionID, opts) {
      return yield* locks(sessionID)(retUnlocked(sessionID, opts))
    })

    const abortUnlocked = Effect.fnUntraced(function* (
      sessionID: SessionID,
      opts?: { force?: boolean; sshArgs?: string[] },
    ) {
      const st = yield* Effect.promise(() => TeleportState.read(sessionID))
      if (!st) return yield* new NotTeleportedError({ sessionID })
      yield* stopRegistry(sessionID)

      const master = masterOf(st, opts?.sshArgs)
      const reap = Effect.gen(function* () {
        if (st.remote.serverPid !== undefined) {
          const result = yield* io("abort", () =>
            TeleportSsh.exec(master, `kill ${Math.floor(st.remote.serverPid!)} 2>/dev/null || true`),
          )
          if (result.code === 255) return yield* new TeleportError({ step: "abort", message: "ssh transport failed" })
        }
        if (st.remote.stateDir_)
          yield* io("abort", () =>
            TeleportSsh.exec(master, `rm -rf -- ${TeleportSsh.shellQuote(st.remote.stateDir_)}`),
          ).pipe(Effect.ignore)
        yield* io("abort", () => TeleportSsh.removeKey(master, st.local.keyTag)).pipe(Effect.ignore)
      })
      const reaped = yield* reap.pipe(Effect.exit)
      if (reaped._tag === "Failure" && opts?.force !== true)
        return yield* new RemoteUnreachableError({
          sessionID,
          message: "remote is unreachable — the server may still be running; use --force to clear local state anyway",
        })

      yield* Effect.promise(() => TeleportSsh.close(master))
      const info = yield* sessions.get(sessionID).pipe(Effect.option)
      if (info._tag === "Some") {
        yield* sessions.setMetadata({
          sessionID,
          metadata: stripTeleport(info.value.metadata as Record<string, unknown> | undefined) ?? {},
        })
      }
      if (st.local.keyPath) {
        yield* Effect.promise(() =>
          Promise.all([
            fs.rm(st.local.keyPath!, { force: true }),
            fs.rm(`${st.local.keyPath}.pub`, { force: true }),
          ]).then(() => undefined),
        )
      }
      yield* Effect.promise(() => TeleportState.remove(sessionID))
    })

    const abort: Interface["abort"] = Effect.fn("Teleport.abort")(function* (sessionID, opts) {
      return yield* locks(sessionID)(abortUnlocked(sessionID, opts))
    })

    const list: Interface["list"] = Effect.fn("Teleport.list")(function* () {
      return yield* Effect.promise(() => TeleportState.list())
    })

    const status: Interface["status"] = Effect.fn("Teleport.status")(function* (sessionID) {
      return yield* Effect.promise(() => TeleportState.read(sessionID))
    })

    const disconnect: Interface["disconnect"] = Effect.fn("Teleport.disconnect")(function* (sessionID) {
      yield* stopRegistry(sessionID)
    })

    const recover: Interface["recover"] = Effect.fn("Teleport.recover")(function* () {
      const states = yield* Effect.promise(() => TeleportState.list())
      for (const st of states) {
        if (registry.has(st.sessionID)) continue
        const sessionID = SessionID.make(st.sessionID)
        // Only "teleported" sessions are reconnected (tunnel + read-only pull
        // mirror). A "returning" state file is deliberately left alone: returns
        // are user-initiated only, so an interrupted one stays "return pending"
        // until the user retries it (/list picker or `opencode teleport return`).
        if (st.state === "teleported") {
          yield* connect(st, "recover").pipe(
            Effect.catchCause((cause) => Effect.logWarning("teleport recovery failed", { sessionID, cause })),
            Effect.forkIn(scope),
          )
        }
      }
    })

    return Service.of({ start, pull, ret, abort, list, status, disconnect, recover })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, SessionRunState.node, Database.node, BinaryCache.node, InstanceStore.node],
})

export * as Teleport from "."
