import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { validateSession } from "../tui/validate-session"
import { ServerAuth } from "@/server/auth"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    const directory = (() => {
      if (!args.dir) return undefined
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        // If the directory doesn't exist locally (remote attach), pass it through.
        return args.dir
      }
    })()

    if (args.mini) {
      const { runMini } = await import("./run")
      await runMini({
        attach: args.url,
        directory,
        password: args.password,
        username: args.username,
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    const { TuiConfig } = await import("@/config/tui")
    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exitCode = 1
      return
    }

    const headers = ServerAuth.headers({ password: args.password, username: args.username })
    const config = await TuiConfig.get()

    try {
      await validateSession({
        url: args.url,
        sessionID: args.session,
        directory,
        headers,
      })
    } catch (error) {
      UI.error(errorMessage(error))
      process.exitCode = 1
      return
    }

    const { Effect } = await import("effect")
    const { run } = await import("../tui/layer")
    const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
    const { TeleportHandoff, TeleportReturn, createTeleportClient } = await import("@opencode-ai/tui/teleport")

    // Relaunch loop: a TeleportHandoff exit reason re-attaches the TUI to the
    // remote tunnel; a TeleportReturn exit reason pulls the session back via
    // the server we originally attached to and re-runs against it.
    const original: { url: string; headers: RequestInit["headers"]; directory: string | undefined } = {
      url: args.url,
      headers,
      directory,
    }
    let current = { ...original, sessionID: args.session as string | undefined, teleport: false }
    let first = true
    while (true) {
      const result = await Effect.runPromise(
        run({
          url: current.url,
          config,
          pluginHost: createLegacyTuiPluginHost(),
          args: {
            continue: first ? args.continue : undefined,
            sessionID: current.sessionID,
            fork: first ? args.fork : undefined,
            teleport: current.teleport,
          },
          directory: current.directory,
          headers: current.headers,
        }),
      )
      first = false
      const reason = result.reason
      if (reason instanceof TeleportHandoff) {
        current = {
          url: reason.url,
          headers: reason.headers,
          directory: reason.directory,
          sessionID: reason.sessionID,
          teleport: true,
        }
        continue
      }
      if (reason instanceof TeleportReturn) {
        const prompts = await import("@clack/prompts")
        const spinner = prompts.spinner()
        spinner.start("Returning session")
        try {
          await createTeleportClient({
            url: original.url,
            headers: original.headers,
            directory: original.directory,
          }).return(reason.sessionID, { scrub: reason.scrub })
          spinner.stop("Session returned")
        } catch (error) {
          spinner.stop("Failed to return session", 1)
          UI.error(errorMessage(error))
        }
        current = { ...original, sessionID: reason.sessionID, teleport: false }
        continue
      }
      break
    }
  },
})
