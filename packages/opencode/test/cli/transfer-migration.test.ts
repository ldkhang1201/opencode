// Phase-1 gate for the /teleport feature: proves the existing export → import
// primitives produce a session that is fully RUNNABLE on a different
// "machine" (separate OPENCODE_TEST_HOME + different project directory), not
// merely viewable. The continue-request sent to the LLM must carry the
// original conversation (history survived the migration) and the new
// machine's environment (system prompt is built at prompt time by
// src/session/system.ts, so the agent sees the machine it now runs on).
//
// If this test ever breaks because the CLI switches to the event-sourced V2
// engine (core session_message/session_input tables), the teleport transfer
// format must grow to carry those rows — see the teleport plan.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { cliIt } from "../lib/cli-process"

describe("session migration: export on machine A, import + continue on machine B", () => {
  cliIt.live(
    "imported session is runnable with full history and new-machine environment",
    ({ opencode, llm, home }) =>
      Effect.gen(function* () {
        // machine A: one exchange with distinctive markers
        yield* llm.text("BRAVO_REPLY_FROM_MACHINE_A")
        const runA = yield* opencode.run("ALPHA_QUESTION_ABOUT_TELEPORT", { format: "json" })
        opencode.expectExit(runA, 0, "run on machine A")
        const events = opencode.parseJsonEvents(runA.stdout)
        const sessionID = events.find((e) => typeof e.sessionID === "string")?.sessionID as string
        expect(sessionID).toBeTruthy()

        // machine A: export to a file
        const exp = yield* opencode.spawn(["export", sessionID])
        opencode.expectExit(exp, 0, "export on machine A")
        const exportFile = path.join(home, "exported-session.json")
        yield* Effect.promise(() => fs.writeFile(exportFile, exp.stdout))

        // machine B: fresh home + different project directory
        const homeB = path.join(home, "machine-b-home")
        const projectB = path.join(home, "machine-b-project")
        yield* Effect.promise(() => fs.mkdir(homeB, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(projectB, { recursive: true }))
        const envB = {
          OPENCODE_TEST_HOME: homeB,
          HOME: homeB,
          XDG_CONFIG_HOME: path.join(homeB, ".config"),
          XDG_DATA_HOME: path.join(homeB, ".local/share"),
          XDG_STATE_HOME: path.join(homeB, ".local/state"),
          XDG_CACHE_HOME: path.join(homeB, ".cache"),
        }

        const imp = yield* opencode.spawn(["import", exportFile], { env: envB, cwd: projectB })
        opencode.expectExit(imp, 0, "import on machine B")
        expect(imp.stdout).toContain(sessionID)

        // machine B: continue the imported session
        const runB = yield* opencode.run("CHARLIE_FOLLOWUP_ON_MACHINE_B", {
          extraArgs: ["--session", sessionID],
          env: envB,
          cwd: projectB,
          timeoutMs: 45_000,
        })
        if (runB.exitCode !== 0) {
          const log = yield* Effect.promise(() =>
            Bun.file(path.join(homeB, ".local/share/opencode/log/opencode.log"))
              .text()
              .catch(() => "NO LOG FILE"),
          )
          console.log("MACHINE B LOG (tail):\n" + log.split("\n").slice(-40).join("\n"))
        }
        opencode.expectExit(runB, 0, "continue on machine B")

        // the continue request carries machine A's history + machine B's environment
        const hits = yield* llm.hits
        const followup = hits
          .map((h) => JSON.stringify(h.body))
          .find((s) => s.includes("CHARLIE_FOLLOWUP_ON_MACHINE_B"))
        expect(followup).toBeTruthy()
        expect(followup!).toContain("ALPHA_QUESTION_ABOUT_TELEPORT")
        expect(followup!).toContain("BRAVO_REPLY_FROM_MACHINE_A")
        expect(followup!).toContain("machine-b-project")
      }),
    180_000,
  )
})
