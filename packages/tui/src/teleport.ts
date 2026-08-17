import { isRecord } from "./util/record"

export const TELEPORT_USERNAME = "opencode"

export type TeleportTargetInfo = {
  user?: string
  host: string
  path?: string
}

export type TeleportStatus = {
  sessionID: string
  target: TeleportTargetInfo
  state: "bootstrapping" | "teleported" | "returning" | "failed"
  local: { tunnelPort?: number; [key: string]: unknown }
  remote: { serverPassword?: string; serverPort?: number; [key: string]: unknown }
  lastPullAt?: number
  error?: string
}

export type TeleportInfo = {
  url: string
  username: string
  password: string
  directory: string
  sessionID: string
}

/** Mirrors packages/server/src/auth.ts ServerAuth.headers */
export function basicAuthHeaders(password: string, username = TELEPORT_USERNAME): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
}

/**
 * Exit reason: the TUI should re-attach to the remote opencode server behind
 * the ssh tunnel. The CLI relaunch loop re-runs the TUI against `url`.
 */
export class TeleportHandoff {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly directory?: string
  readonly sessionID: string

  constructor(input: { url: string; username?: string; password: string; directory?: string; sessionID: string }) {
    this.url = input.url
    this.username = input.username ?? TELEPORT_USERNAME
    this.password = input.password
    this.directory = input.directory
    this.sessionID = input.sessionID
  }

  get headers(): Record<string, string> {
    return basicAuthHeaders(this.password, this.username)
  }
}

/**
 * Exit reason: the TUI wants the session pulled back to the machine it was
 * teleported from. The CLI relaunch loop POSTs the return endpoint on the
 * original (local) server and re-runs the TUI against the original transport.
 */
export class TeleportReturn {
  /** `scrub` undefined means "not specified": the relaunch loop omits it so the server default (scrub) applies. */
  constructor(
    readonly sessionID: string,
    readonly scrub?: boolean,
  ) {}
}

export class TeleportPasswordRequired extends Error {
  constructor(message = "Password required") {
    super(message)
    this.name = "TeleportPasswordRequired"
  }
}

export class TeleportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TeleportError"
  }
}

export function isPasswordRequiredBody(body: unknown): boolean {
  if (!isRecord(body)) return false
  for (const key of ["name", "_tag", "type", "code"]) {
    const value = body[key]
    if (typeof value === "string" && value.includes("PasswordRequired")) return true
  }
  return isPasswordRequiredBody(body["data"]) || isPasswordRequiredBody(body["error"])
}

export function errorMessageOf(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  if (typeof body["message"] === "string" && body["message"]) return body["message"]
  return errorMessageOf(body["data"]) ?? errorMessageOf(body["error"])
}

/** Only teleported/returning sessions can be returned; failed/bootstrapping ones need `opencode teleport abort`. */
export function returnableState(state: TeleportStatus["state"]): boolean {
  return state === "teleported" || state === "returning"
}

/**
 * Which operation Enter runs in the teleport picker: `/teleport` is
 * jump-first, `/list` is return-first (call the session back here).
 */
export type TeleportPickerMode = "jump" | "return"

export type TeleportPickerOp = "jump" | "return"

/** mode → Enter (primary) and bound-action (secondary) operations */
export function pickerActions(mode: TeleportPickerMode): { primary: TeleportPickerOp; secondary: TeleportPickerOp } {
  if (mode === "return") return { primary: "return", secondary: "jump" }
  return { primary: "jump", secondary: "return" }
}

/**
 * Entry state label. An interrupted return (state "returning") persists until
 * the user retries it; in return-first mode Enter is that retry, so say so.
 */
export function pickerDescription(state: TeleportStatus["state"], mode: TeleportPickerMode): string {
  if (mode === "return" && state === "returning") return "return pending — select to retry"
  return state
}

/**
 * With nothing teleported, `/teleport` falls through to the target prompt
 * (start a new teleport); `/list` has nothing to call back, so it closes.
 */
export function pickerEmptyBehavior(mode: TeleportPickerMode): "prompt" | "close" {
  return mode === "jump" ? "prompt" : "close"
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "opencode.internal"])

/**
 * True when the TUI's sdk base url terminates on this machine: loopback or the
 * in-process worker transport (http://opencode.internal). Only then does a
 * TeleportHandoff make sense — its url is a 127.0.0.1:<tunnelPort> listener on
 * the SERVER machine, unreachable from a remotely attached TUI.
 */
export function isLocalTransportUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function jumpUrl(status: TeleportStatus): string | undefined {
  const port = status.local?.tunnelPort
  if (typeof port !== "number") return undefined
  return `http://127.0.0.1:${port}`
}

export function handoffFromStatus(status: TeleportStatus): TeleportHandoff | undefined {
  if (status.state !== "teleported") return undefined
  const url = jumpUrl(status)
  const password = status.remote?.serverPassword
  if (!url || typeof password !== "string" || password === "") return undefined
  return new TeleportHandoff({
    url,
    username: TELEPORT_USERNAME,
    password,
    directory: status.target?.path,
    sessionID: status.sessionID,
  })
}

export function handoffFromInfo(info: TeleportInfo): TeleportHandoff {
  return new TeleportHandoff({
    url: info.url,
    username: info.username || TELEPORT_USERNAME,
    password: info.password,
    directory: info.directory,
    sessionID: info.sessionID,
  })
}

export function targetLabel(target: TeleportTargetInfo | undefined): string {
  if (!target) return "unknown"
  return `${target.user ? target.user + "@" : ""}${target.host}${target.path ? ":" + target.path : ""}`
}

/** Parse the freeze marker the server stores on session.metadata.teleport */
export function teleportMetadata(metadata: { [key: string]: unknown } | undefined) {
  if (!metadata) return undefined
  const value = metadata["teleport"]
  if (!isRecord(value)) return undefined
  if (typeof value["state"] !== "string") return undefined
  // The server stores the raw target spec ("user@host[:/path]") as a string;
  // tolerate an object form too.
  const target = value["target"]
  const host =
    typeof target === "string"
      ? target
      : isRecord(target) && typeof target["host"] === "string"
        ? target["host"]
        : undefined
  return { state: value["state"], host }
}

export type TeleportClientInput = {
  url: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  directory?: string
}

export type TeleportClient = ReturnType<typeof createTeleportClient>

/**
 * Raw HTTP client for the teleport endpoints. All raw calls live here so a
 * server-side contract change is a one-file fix.
 */
export function createTeleportClient(input: TeleportClientInput) {
  const call: typeof fetch = input.fetch ?? fetch
  const base = input.url.replace(/\/+$/, "")

  function request(path: string, init?: { method?: "GET" | "POST"; body?: unknown }) {
    const method = init?.method ?? "GET"
    const headers = new Headers(input.headers)
    const url = new URL(base + path)
    // Mirror the SDK directory convention: query param for GET, header otherwise.
    if (input.directory) {
      if (method === "GET") url.searchParams.set("directory", encodeURIComponent(input.directory))
      else headers.set("x-opencode-directory", encodeURIComponent(input.directory))
    }
    if (init?.body !== undefined) headers.set("content-type", "application/json")
    return call(url.toString(), {
      method,
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
  }

  async function fail(response: Response): Promise<never> {
    const body: unknown = await response.json().catch(() => undefined)
    if (isPasswordRequiredBody(body)) throw new TeleportPasswordRequired(errorMessageOf(body))
    throw new TeleportError(errorMessageOf(body) ?? `Teleport request failed (${response.status})`)
  }

  return {
    /**
     * POST /session/:sessionID/teleport — long-running (binary push).
     * Throws TeleportPasswordRequired when the target wants a password.
     */
    async start(sessionID: string, options: { target: string; password?: string }): Promise<TeleportInfo> {
      const response = await request(`/session/${sessionID}/teleport`, { method: "POST", body: options })
      if (!response.ok) return fail(response)
      return (await response.json()) as TeleportInfo
    },
    /** GET /session/:sessionID/teleport — undefined when 404 */
    async status(sessionID: string): Promise<TeleportStatus | undefined> {
      const response = await request(`/session/${sessionID}/teleport`)
      if (response.status === 404) return undefined
      if (!response.ok) return fail(response)
      return (await response.json()) as TeleportStatus
    },
    /** GET /teleport */
    async list(): Promise<TeleportStatus[]> {
      const response = await request(`/teleport`)
      if (!response.ok) return fail(response)
      const body = (await response.json()) as TeleportStatus[]
      return Array.isArray(body) ? body : []
    },
    /** POST /session/:sessionID/teleport/return — resolves when the session is back local */
    async return(sessionID: string, options?: { scrub?: boolean }): Promise<void> {
      const response = await request(`/session/${sessionID}/teleport/return`, {
        method: "POST",
        // omit an unspecified scrub so the server default (scrub) applies
        body: options?.scrub === undefined ? {} : { scrub: options.scrub },
      })
      if (!response.ok) return fail(response)
    },
    /** POST /session/:sessionID/teleport/pull — one-shot sync */
    async pull(sessionID: string): Promise<void> {
      const response = await request(`/session/${sessionID}/teleport/pull`, { method: "POST", body: {} })
      if (!response.ok) return fail(response)
    },
  }
}
