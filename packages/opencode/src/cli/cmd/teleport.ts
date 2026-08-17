import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import { Deferred, Duration, Effect } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Installation } from "../../installation"
import { BinaryCache } from "../../teleport/binary-cache"
import { Teleport } from "../../teleport"
import { TeleportState } from "../../teleport/state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"

/** Detect this machine's release target by running the probe locally. */
async function localTarget(): Promise<string> {
  if (process.platform === "win32") {
    // No POSIX sh guaranteed locally; the install script only supports windows-x64.
    if (process.arch !== "x64") throw new Error(`Unsupported OS/Arch: windows/${process.arch}`)
    return "windows-x64"
  }
  const proc = Bun.spawn(["sh", "-c", BinaryCache.probeScript], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`platform probe failed with exit code ${exitCode}`)
  return BinaryCache.targetOf(BinaryCache.parseProbe(output))
}

async function resolveVersion(requested?: string): Promise<string> {
  if (requested) return requested.replace(/^v/, "")
  // Dev builds report "local"; resolve like the install script does for "latest".
  if (Installation.isLocal()) return Installation.latest("curl")
  return InstallationVersion
}

export const TeleportPrefetchCommand = cmd({
  command: "prefetch [target...]",
  describe: "download opencode binaries into the local cache for offline teleport",
  builder: (yargs: Argv) =>
    yargs
      // The global `.version()` flag would otherwise intercept `--version` here.
      .version(false)
      .positional("target", {
        describe: `release target(s) to prefetch; defaults to this machine's target`,
        type: "string",
        array: true,
        choices: BinaryCache.targets as string[],
      })
      .option("version", {
        describe: "version to prefetch, for ex '1.0.180'; defaults to the running version",
        type: "string",
      }),
  handler: async (args: { target?: string[]; version?: string }) => {
    prompts.intro("Teleport prefetch")
    const targets = args.target?.length ? args.target : [await localTarget()]
    const version = await resolveVersion(args.version)
    for (const target of targets) {
      const spinner = prompts.spinner()
      spinner.start(`Fetching opencode v${version} for ${target}`)
      const file = await BinaryCache.ensure(version, target, { download: true }).catch((error: unknown) => {
        spinner.stop(`Failed to fetch v${version} for ${target}`, 1)
        prompts.log.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
        return undefined
      })
      if (file) spinner.stop(`Cached v${version} for ${target} at ${file}`)
    }
    prompts.outro("Done")
  },
})

const toCliError = (error: unknown) =>
  new CliError({ message: error instanceof Error ? error.message : String(error) })

/** Pick the session a state-file-scoped command (return/pull/abort) targets. */
const pickTeleported = (session?: string) =>
  Effect.gen(function* () {
    if (session) return SessionID.make(session)
    const states = yield* Effect.promise(() => TeleportState.list())
    if (states.length === 1) return SessionID.make(states[0].sessionID)
    if (states.length === 0) return yield* fail("no teleported sessions")
    return yield* fail(
      `multiple teleported sessions — pass --session <id>: ${states.map((s) => s.sessionID).join(", ")}`,
    )
  })

const sshArgsOf = (args: { "ssh-arg"?: string[] }) =>
  args["ssh-arg"]?.length ? { sshArgs: args["ssh-arg"] } : {}

const TeleportStartCommand = effectCmd({
  command: "$0 <target>",
  describe: "move the current session to a remote machine over ssh",
  builder: (yargs) =>
    yargs
      .positional("target", {
        describe: "remote target, e.g. user@host or user@host:/path",
        type: "string",
        demandOption: true,
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to teleport; defaults to the most recently updated session",
        type: "string",
      })
      .option("password-env", {
        describe: "name of an environment variable holding the ssh password",
        type: "string",
      })
      .option("ssh-arg", {
        describe: "extra ssh flag (repeatable)",
        type: "string",
        array: true,
        hidden: true,
      })
      .option("binary-version", {
        describe: "opencode version to install remotely; defaults to the running version",
        type: "string",
      }),
  handler: Effect.fn("Cli.teleport")(function* (args) {
    const teleport = yield* Teleport.Service
    const sessions = yield* Session.Service

    const sessionID = yield* Effect.gen(function* () {
      if (args.session) return SessionID.make(args.session)
      const list = yield* sessions.list()
      const newest = list.sort((a, b) => b.time.updated - a.time.updated)[0]
      if (!newest) return yield* fail("no sessions found — start one first or pass --session")
      return newest.id
    })

    let password: string | undefined
    if (args["password-env"]) {
      password = process.env[args["password-env"]]
      if (!password) return yield* fail(`environment variable ${args["password-env"]} is empty`)
    }

    const progress = (phase: string, detail?: string) =>
      process.stderr.write(`teleport: ${phase}${detail ? ` ${detail}` : ""}\n`)

    const info = yield* teleport
      .start({
        sessionID,
        target: args.target,
        ...(password !== undefined ? { password } : {}),
        ...sshArgsOf(args),
        ...(args["binary-version"] ? { binaryVersion: args["binary-version"] } : {}),
        onPhase: progress,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "TeleportPasswordRequiredError"
            ? new CliError({ message: `${error.message}; re-run with --password-env <VAR>` })
            : toCliError(error),
        ),
      )

    // machine-readable connection info for `opencode attach` / scripts
    process.stdout.write(JSON.stringify(info) + "\n")
    process.stderr.write(
      `teleport: attach with \`opencode attach ${info.url} -p <password> --session ${info.sessionID} --dir ${info.directory}\`\n`,
    )

    // Foreground supervisor: keep the tunnel + 60s pull loop alive until
    // SIGINT/SIGTERM or until the session returns (state file removed or
    // flipped to "returning" by another process).
    const stop = yield* Deferred.make<void>()
    const signal = () => Effect.runFork(Deferred.succeed(stop, void 0))
    process.once("SIGINT", signal)
    process.once("SIGTERM", signal)
    const poll = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(Duration.seconds(5))
        const st = yield* Effect.promise(() => TeleportState.read(sessionID))
        if (!st || st.state === "returning") return
      }
    })
    yield* Effect.race(Deferred.await(stop), poll)
    process.removeListener("SIGINT", signal)
    process.removeListener("SIGTERM", signal)
    yield* teleport.disconnect(sessionID)
  }),
})

const TeleportListCommand = effectCmd({
  command: "list",
  describe: "list teleported sessions",
  instance: false,
  handler: Effect.fn("Cli.teleport.list")(function* () {
    const teleport = yield* Teleport.Service
    const states = yield* teleport.list()
    if (states.length === 0) {
      process.stdout.write("no teleported sessions\n")
      return
    }
    const stamp = (value?: number) => (value ? new Date(value).toISOString() : "-")
    const rows = [
      ["SESSION", "HOST", "STATE", "SINCE", "LAST PULL"],
      ...states.map((st) => [
        st.sessionID,
        st.target.user ? `${st.target.user}@${st.target.host}` : st.target.host,
        st.state,
        stamp(st.createdAt),
        stamp(st.lastPullAt),
      ]),
    ]
    const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)))
    for (const row of rows) {
      process.stdout.write(row.map((cell, i) => cell.padEnd(widths[i] + 2)).join("") + "\n")
    }
  }),
})

const TeleportReturnCommand = effectCmd({
  command: "return",
  describe: "bring a teleported session back (remote is authoritative)",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("session", { alias: ["s"], describe: "session id", type: "string" })
      .option("scrub", {
        describe: "remove copied credentials and teleport scratch files from the remote",
        type: "boolean",
        default: true,
      })
      .option("ssh-arg", { describe: "extra ssh flag (repeatable)", type: "string", array: true, hidden: true }),
  handler: Effect.fn("Cli.teleport.return")(function* (args) {
    const teleport = yield* Teleport.Service
    const sessionID = yield* pickTeleported(args.session)
    yield* teleport.ret(sessionID, { scrub: args.scrub, ...sshArgsOf(args) }).pipe(Effect.mapError(toCliError))
    process.stdout.write(`returned session: ${sessionID}\n`)
  }),
})

const TeleportPullCommand = effectCmd({
  command: "pull",
  describe: "pull the latest remote transcript into the frozen local copy",
  instance: false,
  builder: (yargs) => yargs.option("session", { alias: ["s"], describe: "session id", type: "string" }),
  handler: Effect.fn("Cli.teleport.pull")(function* (args) {
    const teleport = yield* Teleport.Service
    const sessionID = yield* pickTeleported(args.session)
    yield* teleport.pull(sessionID).pipe(Effect.mapError(toCliError))
    process.stdout.write(`pulled session: ${sessionID}\n`)
  }),
})

const TeleportAbortCommand = effectCmd({
  command: "abort",
  describe: "abandon a teleport: kill the remote server and unfreeze the local copy",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("session", { alias: ["s"], describe: "session id", type: "string" })
      .option("force", {
        describe: "clear local state even when the remote is unreachable",
        type: "boolean",
        default: false,
      })
      .option("ssh-arg", { describe: "extra ssh flag (repeatable)", type: "string", array: true, hidden: true }),
  handler: Effect.fn("Cli.teleport.abort")(function* (args) {
    const teleport = yield* Teleport.Service
    const sessionID = yield* pickTeleported(args.session)
    yield* teleport.abort(sessionID, { force: args.force, ...sshArgsOf(args) }).pipe(Effect.mapError(toCliError))
    process.stdout.write(`aborted teleport for session: ${sessionID}\n`)
  }),
})

export const TeleportCommand = cmd({
  command: "teleport",
  describe: "teleport sessions to remote machines",
  builder: (yargs: Argv) =>
    yargs
      .command(TeleportPrefetchCommand)
      .command(TeleportListCommand)
      .command(TeleportReturnCommand)
      .command(TeleportPullCommand)
      .command(TeleportAbortCommand)
      .command(TeleportStartCommand),
  async handler() {},
})
