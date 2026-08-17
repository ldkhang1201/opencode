import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { AppProcess } from "@opencode-ai/core/process"
import { Archive } from "@/util/archive"
import { withTransientReadRetry } from "@/util/effect-http-client"

/**
 * POSIX sh probe. Runs on the remote (e.g. `ssh host sh -s < probeScript` or
 * `sh -c probeScript`) and prints KEY=VALUE lines consumed by `parseProbe`.
 *
 * Platform detection is a line-for-line port of the repo-root `install`
 * script (os/arch normalisation, Rosetta, musl and avx2/baseline handling),
 * except the raw facts are printed and the mapping happens in `targetOf`.
 */
export const probeScript = `
uname_s=$(uname -s)
uname_m=$(uname -m)

musl=no
case "$uname_s" in
  Linux*)
    if [ -f /etc/alpine-release ]; then
      musl=yes
    fi
    if command -v ldd >/dev/null 2>&1; then
      if ldd --version 2>&1 | grep -qi musl; then
        musl=yes
      fi
    fi
    ;;
esac

rosetta=no
case "$uname_s" in
  Darwin*)
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      rosetta=yes
    fi
    ;;
esac

avx2=no
case "$uname_s" in
  Linux*)
    if grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
      avx2=yes
    fi
    ;;
  Darwin*)
    if [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)" = "1" ]; then
      avx2=yes
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    ps='(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
    out=""
    if command -v powershell.exe >/dev/null 2>&1; then
      out=$(powershell.exe -NoProfile -NonInteractive -Command "$ps" 2>/dev/null || true)
    elif command -v pwsh >/dev/null 2>&1; then
      out=$(pwsh -NoProfile -NonInteractive -Command "$ps" 2>/dev/null || true)
    fi
    out=$(printf '%s' "$out" | tr -d '\\r' | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
    if [ "$out" = "true" ] || [ "$out" = "1" ]; then
      avx2=yes
    fi
    ;;
esac

opencode_version=""
if [ -x "$HOME/.opencode/bin/opencode" ]; then
  opencode_version=$("$HOME/.opencode/bin/opencode" --version 2>/dev/null || true)
fi

printf 'uname_s=%s\\n' "$uname_s"
printf 'uname_m=%s\\n' "$uname_m"
printf 'musl=%s\\n' "$musl"
printf 'rosetta=%s\\n' "$rosetta"
printf 'avx2=%s\\n' "$avx2"
printf 'home=%s\\n' "$HOME"
printf 'data_dir=%s\\n' "\${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
printf 'config_dir=%s\\n' "\${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
printf 'state_dir=%s\\n' "\${XDG_STATE_HOME:-$HOME/.local/state}/opencode"
printf 'opencode_version=%s\\n' "$opencode_version"
`

export class Probe extends Schema.Class<Probe>("TeleportProbe")({
  uname_s: Schema.String,
  uname_m: Schema.String,
  musl: Schema.Boolean,
  rosetta: Schema.Boolean,
  avx2: Schema.Boolean,
  home: Schema.String,
  data_dir: Schema.String,
  config_dir: Schema.String,
  state_dir: Schema.String,
  opencode_version: Schema.String,
}) {}

export class ProbeParseError extends Schema.TaggedErrorClass<ProbeParseError>()("TeleportProbeParseError", {
  missing: Schema.Array(Schema.String),
}) {
  override get message() {
    return `invalid probe output, missing keys: ${this.missing.join(", ")}`
  }
}

const STRING_KEYS = ["uname_s", "uname_m", "home", "data_dir", "config_dir", "state_dir", "opencode_version"] as const
const BOOLEAN_KEYS = ["musl", "rosetta", "avx2"] as const

const decodeProbe = Schema.decodeUnknownSync(Probe)

/** Parse `probeScript` output. Ignores non KEY=VALUE noise (ssh banners, motd). */
export function parseProbe(output: string): Probe {
  const record: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    record[match[1]] = match[2]
  }
  const missing = [...STRING_KEYS, ...BOOLEAN_KEYS].filter((key) => record[key] === undefined)
  if (missing.length > 0) throw new ProbeParseError({ missing })
  return decodeProbe({
    ...Object.fromEntries(STRING_KEYS.map((key) => [key, record[key]])),
    ...Object.fromEntries(BOOLEAN_KEYS.map((key) => [key, record[key] === "yes"])),
  })
}

export class UnsupportedPlatformError extends Schema.TaggedErrorClass<UnsupportedPlatformError>()(
  "TeleportUnsupportedPlatformError",
  {
    os: Schema.String,
    arch: Schema.String,
  },
) {
  override get message() {
    return `Unsupported OS/Arch: ${this.os}/${this.arch}`
  }
}

/** Release targets published by `packages/opencode/script/build.ts` that the `install` script can select. */
export const targets: readonly string[] = [
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
]

/**
 * Map a probe to the release artifact target string, mirroring the repo-root
 * `install` script exactly: os/arch normalisation, Rosetta remap before the
 * combo check, `-baseline` for x64 without avx2, `-musl` for musl linux.
 */
export function targetOf(probe: Probe): string {
  let os = probe.uname_s.toLowerCase()
  if (probe.uname_s.startsWith("Darwin")) os = "darwin"
  if (probe.uname_s.startsWith("Linux")) os = "linux"
  if (/^(MINGW|MSYS|CYGWIN)/.test(probe.uname_s)) os = "windows"

  let arch = probe.uname_m
  if (arch === "aarch64") arch = "arm64"
  if (arch === "x86_64") arch = "x64"

  if (os === "darwin" && arch === "x64" && probe.rosetta) arch = "arm64"

  const combo = `${os}-${arch}`
  const supported = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"]
  if (!supported.includes(combo)) throw new UnsupportedPlatformError({ os, arch })

  const baseline = arch === "x64" && !probe.avx2
  const musl = os === "linux" && probe.musl
  return combo + (baseline ? "-baseline" : "") + (musl ? "-musl" : "")
}

/** Local cache location for a release binary: `<cache>/teleport/bin/v<version>/<target>/opencode`. */
export function cachedPath(version: string, target: string): string {
  return path.join(Global.Path.cache, "teleport", "bin", `v${version}`, target, "opencode")
}

export class BinaryNotCachedError extends Schema.TaggedErrorClass<BinaryNotCachedError>()(
  "TeleportBinaryNotCachedError",
  {
    version: Schema.String,
    target: Schema.String,
  },
) {
  override get message() {
    return `opencode v${this.version} for ${this.target} is not in the local teleport cache and downloading is disabled. Run \`opencode teleport prefetch ${this.target}\` while online, then try again.`
  }
}

export class DownloadFailedError extends Schema.TaggedErrorClass<DownloadFailedError>()(
  "TeleportDownloadFailedError",
  {
    version: Schema.String,
    target: Schema.String,
    url: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const detail = this.cause instanceof Error ? `: ${this.cause.message}` : ""
    return `failed to download opencode v${this.version} for ${this.target} from ${this.url}${detail}. If you are offline, run \`opencode teleport prefetch ${this.target}\` while online, then try again.`
  }
}

export interface EnsureOptions {
  readonly download?: boolean
}

export interface Interface {
  readonly ensure: (
    version: string,
    target: string,
    opts?: EnsureOptions,
  ) => Effect.Effect<string, BinaryNotCachedError | DownloadFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeleportBinaryCache") {}

/** Release artifact URL, matching the `install` script and `script/build.ts` naming. */
function releaseUrl(version: string, target: string) {
  const ext = target.startsWith("linux") ? "tar.gz" : "zip"
  return `https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-${target}.${ext}`
}

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service | FSUtil.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))

    const download = Effect.fnUntraced(
      function* (url: string, file: string) {
        const dir = yield* fs.makeTempDirectoryScoped({ directory: Global.Path.tmp, prefix: "teleport-bin-" })
        const archive = path.join(dir, path.basename(url))

        const response = yield* httpOk.execute(HttpClientRequest.get(url))
        const bytes = yield* response.arrayBuffer
        if (bytes.byteLength === 0) return yield* Effect.fail(new Error(`empty response from ${url}`))
        yield* fs.writeWithDirs(archive, new Uint8Array(bytes))

        if (archive.endsWith(".tar.gz")) {
          yield* appProcess
            .run(ChildProcess.make("tar", ["-xzf", archive, "-C", dir], { extendEnv: true }))
            .pipe(Effect.flatMap(AppProcess.requireSuccess))
        } else {
          yield* Effect.tryPromise(() => Archive.extractZip(archive, dir))
        }

        let extracted: string | undefined
        for (const candidate of [path.join(dir, "opencode"), path.join(dir, "opencode.exe")]) {
          if (yield* fs.isFile(candidate)) {
            extracted = candidate
            break
          }
        }
        if (!extracted) return yield* Effect.fail(new Error(`archive did not contain an opencode binary: ${url}`))

        yield* fs.ensureDir(path.dirname(file))
        const partial = `${file}.partial`
        yield* fs.copyFile(extracted, partial)
        yield* fs.chmod(partial, 0o755)
        yield* fs.rename(partial, file)
        return file
      },
      Effect.scoped,
    )

    const ensure = Effect.fn("TeleportBinaryCache.ensure")(function* (
      version: string,
      target: string,
      opts?: EnsureOptions,
    ) {
      const file = cachedPath(version, target)
      if (yield* fs.isFile(file)) return file
      if (opts?.download === false) return yield* new BinaryNotCachedError({ version, target })
      const url = releaseUrl(version, target)
      yield* Effect.logInfo("downloading opencode binary", { version, target, url })
      return yield* download(url, file).pipe(
        Effect.mapError((cause) => new DownloadFailedError({ version, target, url, cause })),
      )
    })

    return Service.of({ ensure })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [httpClient, AppProcess.node, FSUtil.node],
})

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

/** Promise variant of `Service.ensure` for non-Effect call sites (CLI). */
export const ensure = (version: string, target: string, opts?: EnsureOptions) =>
  runPromise((svc) => svc.ensure(version, target, opts))

export * as BinaryCache from "./binary-cache"
