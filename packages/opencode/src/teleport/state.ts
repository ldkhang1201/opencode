// Persisted /teleport state: one JSON file per teleported session under
// `Global.Path.state/teleport/<sessionID>.json`. The file is the source of
// truth for resumability — every teleport operation must be re-drivable from
// it alone (fresh process, post-crash, flaky network). It holds the remote
// server password, hence 0600 and an atomic tmp+rename write.
import fs from "node:fs/promises"
import path from "node:path"
import { Schema, Types } from "effect"
import { optional } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"

export const Target = Schema.Struct({
  user: optional(Schema.String),
  host: Schema.String,
  /** resolved absolute remote working directory (never `~`-relative) */
  path: Schema.String,
}).annotate({ identifier: "TeleportTarget" })

export const Remote = Schema.Struct({
  home: Schema.String,
  dataDir: Schema.String,
  stateDir: Schema.String,
  /** release platform target, e.g. "linux-arm64-musl" */
  target: Schema.String,
  binaryPushed: Schema.Boolean,
  serverPid: optional(Schema.Number),
  serverPort: optional(Schema.Number),
  serverPassword: optional(Schema.String),
  serverLogPath: Schema.String,
  /** teleport-owned scratch dir on the remote (serve.log, server-info json) */
  stateDir_: Schema.String,
}).annotate({ identifier: "TeleportRemote" })

export const Local = Schema.Struct({
  tunnelPort: optional(Schema.Number),
  keyPath: optional(Schema.String),
  keyTag: Schema.String,
  controlPath: Schema.String,
  /** extra ssh flags (e.g. -p in tests) needed to re-reach the host from a fresh process */
  sshArgs: optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "TeleportLocal" })

export const Phase = Schema.Literals(["bootstrapping", "teleported", "returning", "failed"])
export type Phase = Schema.Schema.Type<typeof Phase>

export const State = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: Schema.String,
  target: Target,
  state: Phase,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  remote: Remote,
  local: Local,
  copiedFiles: Schema.Array(Schema.String),
  lastPullAt: optional(Schema.Number),
  error: optional(Schema.String),
}).annotate({ identifier: "TeleportState" })
export type State = Types.DeepMutable<Schema.Schema.Type<typeof State>>

const decode = Schema.decodeUnknownSync(State)

export function stateDir(): string {
  return path.join(Global.Path.state, "teleport")
}

function fileOf(sessionID: string, dir: string): string {
  return path.join(dir, `${sessionID}.json`)
}

export async function read(sessionID: string, dir = stateDir()): Promise<State | undefined> {
  const raw = await fs.readFile(fileOf(sessionID, dir), "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  return decode(JSON.parse(raw)) as State
}

export async function write(state: State, dir = stateDir()): Promise<void> {
  decode(state) // validate before persisting so a bad shape never hits disk
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = fileOf(state.sessionID, dir)
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
}

export async function list(dir = stateDir()): Promise<State[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const out: State[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    const raw = await fs.readFile(path.join(dir, entry), "utf8").catch(() => undefined)
    if (raw === undefined) continue
    try {
      out.push(decode(JSON.parse(raw)) as State)
    } catch {
      // junk or truncated file: skip, never break the listing
    }
  }
  return out
}

export async function remove(sessionID: string, dir = stateDir()): Promise<void> {
  await fs.rm(fileOf(sessionID, dir), { force: true })
}

export * as TeleportState from "./state"
