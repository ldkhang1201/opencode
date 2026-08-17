// Freeze guard for /teleport: once a session's metadata carries a teleport
// marker in state "teleported" or "returning", local prompt/shell admission
// must fail with the typed Session.TeleportedError. The remote copy of the
// session (marker stripped on export) must NOT be blocked.
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "@/question"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionProcessor } from "@/session/processor"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.mock(LSP.Service, {
  init: () => Effect.void,
  touchFile: () => Effect.void,
  documentSymbol: () => Effect.succeed([]),
})

const mcp = Layer.mock(MCP.Service, {
  tools: () => Effect.succeed({}),
  instructions: () => Effect.succeed([]),
})

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
  ]),
)

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const frozen = (state: string) => ({
  teleport: { state, target: "alice@example.com", remoteDir: "/home/alice/work", since: 1 },
})

describe("teleport freeze guard", () => {
  it.instance(
    "prompt admission fails typed while the session is teleported or returning",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned", model: { id: model.modelID, providerID: model.providerID } })

        for (const state of ["teleported", "returning"]) {
          yield* sessions.setMetadata({ sessionID: chat.id, metadata: frozen(state) })
          const error = yield* prompt
            .prompt({ sessionID: chat.id, model, noReply: true, parts: [{ type: "text", text: "hi" }] })
            .pipe(Effect.flip)
          expect(error._tag).toBe("SessionTeleportedError")
          if (error._tag !== "SessionTeleportedError") throw new Error("unreachable")
          expect(error.sessionID).toBe(chat.id)
          expect(error.target).toBe("alice@example.com")
        }
      }),
    { config: cfg },
  )

  it.instance(
    "shell admission fails typed while the session is teleported",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned", model: { id: model.modelID, providerID: model.providerID } })
        yield* sessions.setMetadata({ sessionID: chat.id, metadata: frozen("teleported") })

        const error = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "true" }).pipe(Effect.flip)
        expect(error._tag).toBe("SessionTeleportedError")
      }),
    { config: cfg },
  )

  it.instance(
    "a session without the marker (remote-shaped copy) is admitted",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned", model: { id: model.modelID, providerID: model.providerID } })
        // unrelated metadata and non-frozen teleport states must not block
        yield* sessions.setMetadata({ sessionID: chat.id, metadata: { other: true, teleport: { state: "failed" } } })

        const message = yield* prompt.prompt({
          sessionID: chat.id,
          model,
          noReply: true,
          parts: [{ type: "text", text: "hello from the remote" }],
        })
        expect(message.info.role).toBe("user")
      }),
    { config: cfg },
  )
})
