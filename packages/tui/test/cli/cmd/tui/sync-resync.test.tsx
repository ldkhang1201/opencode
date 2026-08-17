/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { mount } from "./sync-fixture"
import { json } from "../../../fixture/tui-sdk"

const sessionID = "ses_resync"

function info(title: string) {
  return {
    id: sessionID,
    slug: "resync",
    projectID: "proj_test",
    directory: "/tmp/opencode/packages/tui",
    title,
    version: "1",
    time: { created: 1, updated: 1 },
  }
}

describe("tui sync resync", () => {
  test("resync drops the full-sync cache and refetches the session", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let gets = 0
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}/message`) return json([])
      if (url.pathname === `/session/${sessionID}/todo`) return json([])
      if (url.pathname === `/session/${sessionID}/diff`) return json([])
      if (url.pathname === `/session/${sessionID}`) {
        gets += 1
        return json(info(`title ${gets}`))
      }
      return undefined
    }, tmp.path)

    try {
      await sync.session.sync(sessionID)
      expect(gets).toBe(1)
      expect(sync.session.get(sessionID)?.title).toBe("title 1")

      // Cached: a second sync is a no-op.
      await sync.session.sync(sessionID)
      expect(gets).toBe(1)

      // After an SSE gap the cache is dropped and everything refetched.
      await sync.session.resync(sessionID)
      expect(gets).toBe(2)
      expect(sync.session.get(sessionID)?.title).toBe("title 2")
    } finally {
      app.renderer.destroy()
    }
  })
})
