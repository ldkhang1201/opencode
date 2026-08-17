import { describe, expect, test } from "bun:test"
import {
  basicAuthHeaders,
  createTeleportClient,
  handoffFromInfo,
  handoffFromStatus,
  isLocalTransportUrl,
  isPasswordRequiredBody,
  jumpUrl,
  returnableState,
  targetLabel,
  teleportMetadata,
  TeleportHandoff,
  TeleportPasswordRequired,
  TeleportError,
  TeleportReturn,
  type TeleportStatus,
} from "../src/teleport"

const status: TeleportStatus = {
  sessionID: "ses_123",
  target: { user: "me", host: "gpu-box", path: "/work/repo" },
  state: "teleported",
  local: { tunnelPort: 41234 },
  remote: { serverPassword: "secret", serverPort: 4096 },
}

describe("basicAuthHeaders", () => {
  test("matches ServerAuth.headers construction", () => {
    expect(basicAuthHeaders("hunter2")).toEqual({
      Authorization: `Basic ${Buffer.from("opencode:hunter2").toString("base64")}`,
    })
    expect(basicAuthHeaders("pw", "user")).toEqual({
      Authorization: `Basic ${Buffer.from("user:pw").toString("base64")}`,
    })
  })
})

describe("TeleportHandoff", () => {
  test("defaults username and exposes basic auth headers", () => {
    const handoff = new TeleportHandoff({ url: "http://127.0.0.1:1", password: "pw", sessionID: "ses" })
    expect(handoff.username).toBe("opencode")
    expect(handoff.headers).toEqual(basicAuthHeaders("pw"))
  })
})

describe("TeleportReturn", () => {
  test("leaves scrub undefined by default so the server default (scrub) applies", () => {
    expect(new TeleportReturn("ses").scrub).toBeUndefined()
    expect(new TeleportReturn("ses", true).scrub).toBe(true)
    expect(new TeleportReturn("ses", false).scrub).toBe(false)
  })
})

describe("returnableState", () => {
  test("only teleported/returning sessions can be returned", () => {
    expect(returnableState("teleported")).toBe(true)
    expect(returnableState("returning")).toBe(true)
    expect(returnableState("failed")).toBe(false)
    expect(returnableState("bootstrapping")).toBe(false)
  })
})

describe("isLocalTransportUrl", () => {
  test("accepts loopback and the in-process worker url", () => {
    expect(isLocalTransportUrl("http://127.0.0.1:4096")).toBe(true)
    expect(isLocalTransportUrl("http://localhost:4096")).toBe(true)
    expect(isLocalTransportUrl("http://LOCALHOST:4096")).toBe(true)
    expect(isLocalTransportUrl("http://[::1]:4096")).toBe(true)
    expect(isLocalTransportUrl("http://opencode.internal")).toBe(true)
  })

  test("rejects remote hosts and malformed urls", () => {
    expect(isLocalTransportUrl("http://gpu-box:4096")).toBe(false)
    expect(isLocalTransportUrl("http://192.168.1.10:4096")).toBe(false)
    expect(isLocalTransportUrl("https://example.com")).toBe(false)
    expect(isLocalTransportUrl("not a url")).toBe(false)
  })
})

describe("jumpUrl / handoffFromStatus", () => {
  test("builds tunnel url from local.tunnelPort", () => {
    expect(jumpUrl(status)).toBe("http://127.0.0.1:41234")
    expect(jumpUrl({ ...status, local: {} })).toBeUndefined()
  })

  test("builds handoff from a teleported status", () => {
    const handoff = handoffFromStatus(status)
    expect(handoff).toBeDefined()
    expect(handoff!.url).toBe("http://127.0.0.1:41234")
    expect(handoff!.password).toBe("secret")
    expect(handoff!.directory).toBe("/work/repo")
    expect(handoff!.sessionID).toBe("ses_123")
  })

  test("refuses non-teleported or incomplete statuses", () => {
    expect(handoffFromStatus({ ...status, state: "bootstrapping" })).toBeUndefined()
    expect(handoffFromStatus({ ...status, local: {} })).toBeUndefined()
    expect(handoffFromStatus({ ...status, remote: {} })).toBeUndefined()
  })
})

describe("handoffFromInfo", () => {
  test("uses the server-provided url and directory", () => {
    const handoff = handoffFromInfo({
      url: "http://127.0.0.1:9999",
      username: "opencode",
      password: "pw",
      directory: "/remote/dir",
      sessionID: "ses_9",
    })
    expect(handoff.url).toBe("http://127.0.0.1:9999")
    expect(handoff.directory).toBe("/remote/dir")
    expect(handoff.sessionID).toBe("ses_9")
  })
})

describe("isPasswordRequiredBody", () => {
  test("recognizes name/_tag/type/code variants, also nested", () => {
    expect(isPasswordRequiredBody({ name: "PasswordRequiredError" })).toBe(true)
    expect(isPasswordRequiredBody({ _tag: "TeleportPasswordRequired" })).toBe(true)
    expect(isPasswordRequiredBody({ type: "PasswordRequired" })).toBe(true)
    expect(isPasswordRequiredBody({ data: { name: "PasswordRequiredError" } })).toBe(true)
    expect(isPasswordRequiredBody({ error: { _tag: "PasswordRequired" } })).toBe(true)
    expect(isPasswordRequiredBody({ name: "SomeOtherError" })).toBe(false)
    expect(isPasswordRequiredBody(undefined)).toBe(false)
    expect(isPasswordRequiredBody("PasswordRequired")).toBe(false)
  })
})

describe("targetLabel", () => {
  test("formats user@host:path", () => {
    expect(targetLabel({ user: "me", host: "box", path: "/x" })).toBe("me@box:/x")
    expect(targetLabel({ host: "box" })).toBe("box")
    expect(targetLabel(undefined)).toBe("unknown")
  })
})

describe("teleportMetadata", () => {
  test("parses the freeze marker with a string target (server shape)", () => {
    expect(teleportMetadata({ teleport: { state: "teleported", target: "me@box:/x", since: 1 } })).toEqual({
      state: "teleported",
      host: "me@box:/x",
    })
  })

  test("parses the freeze marker", () => {
    expect(teleportMetadata({ teleport: { state: "teleported", target: { host: "box" } } })).toEqual({
      state: "teleported",
      host: "box",
    })
    expect(teleportMetadata({ teleport: { state: "returning" } })).toEqual({ state: "returning", host: undefined })
    expect(teleportMetadata({ teleport: "nope" })).toBeUndefined()
    expect(teleportMetadata({})).toBeUndefined()
    expect(teleportMetadata(undefined)).toBeUndefined()
  })
})

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { fetch: fn, calls }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("createTeleportClient", () => {
  test("start POSTs target and password with auth + directory headers", async () => {
    const { fetch, calls } = stub(() =>
      json({ url: "http://127.0.0.1:1", username: "opencode", password: "pw", directory: "/d", sessionID: "ses" }),
    )
    const client = createTeleportClient({
      url: "http://localhost:4096",
      fetch,
      headers: basicAuthHeaders("local"),
      directory: "/my dir",
    })
    const info = await client.start("ses", { target: "me@box", password: "ssh-pw" })
    expect(info.sessionID).toBe("ses")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://localhost:4096/session/ses/teleport")
    expect(calls[0].init?.method).toBe("POST")
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("authorization")).toBe(basicAuthHeaders("local").Authorization)
    expect(headers.get("x-opencode-directory")).toBe(encodeURIComponent("/my dir"))
    expect(headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ target: "me@box", password: "ssh-pw" })
  })

  test("start throws TeleportPasswordRequired on a recognizable error body", async () => {
    const { fetch } = stub(() => json({ name: "PasswordRequiredError", message: "need password" }, 409))
    const client = createTeleportClient({ url: "http://localhost:4096", fetch })
    expect(client.start("ses", { target: "me@box" })).rejects.toBeInstanceOf(TeleportPasswordRequired)
  })

  test("start throws TeleportError with the server message otherwise", async () => {
    const { fetch } = stub(() => json({ name: "SshError", message: "connection refused" }, 500))
    const client = createTeleportClient({ url: "http://localhost:4096", fetch })
    expect(client.start("ses", { target: "me@box" })).rejects.toThrow("connection refused")
  })

  test("status GET uses directory query param and returns undefined on 404", async () => {
    const { fetch, calls } = stub((url) => (url.includes("ses_gone") ? json({}, 404) : json(status)))
    const client = createTeleportClient({ url: "http://localhost:4096", fetch, directory: "/d" })
    const result = await client.status("ses_123")
    expect(result?.state).toBe("teleported")
    expect(new URL(calls[0].url).searchParams.get("directory")).toBe(encodeURIComponent("/d"))
    expect(calls[0].init?.method).toBe("GET")
    expect(await client.status("ses_gone")).toBeUndefined()
  })

  test("list GETs /teleport", async () => {
    const { fetch, calls } = stub(() => json([status]))
    const client = createTeleportClient({ url: "http://localhost:4096/", fetch })
    const result = await client.list()
    expect(result).toHaveLength(1)
    expect(calls[0].url).toBe("http://localhost:4096/teleport")
  })

  test("return POSTs scrub only when explicitly set (absent means server default: scrub)", async () => {
    const { fetch, calls } = stub(() => json({}))
    const client = createTeleportClient({ url: "http://localhost:4096", fetch })
    await client.return("ses", { scrub: true })
    expect(calls[0].url).toBe("http://localhost:4096/session/ses/teleport/return")
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ scrub: true })
    await client.return("ses")
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({})
    await client.return("ses", { scrub: undefined })
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({})
    await client.return("ses", { scrub: false })
    expect(JSON.parse(calls[3].init?.body as string)).toEqual({ scrub: false })
  })

  test("pull POSTs /teleport/pull", async () => {
    const { fetch, calls } = stub(() => json({}))
    const client = createTeleportClient({ url: "http://localhost:4096", fetch })
    await client.pull("ses")
    expect(calls[0].url).toBe("http://localhost:4096/session/ses/teleport/pull")
    expect(calls[0].init?.method).toBe("POST")
  })

  test("errors are typed TeleportError instances", async () => {
    const { fetch } = stub(() => new Response("nope", { status: 500 }))
    const client = createTeleportClient({ url: "http://localhost:4096", fetch })
    expect(client.list()).rejects.toBeInstanceOf(TeleportError)
  })
})
