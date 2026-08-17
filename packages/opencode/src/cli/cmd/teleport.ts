import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Installation } from "../../installation"
import { BinaryCache } from "../../teleport/binary-cache"
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

export const TeleportCommand = cmd({
  command: "teleport",
  describe: "teleport sessions to remote machines",
  builder: (yargs: Argv) => yargs.command(TeleportPrefetchCommand).demandCommand(),
  async handler() {},
})
