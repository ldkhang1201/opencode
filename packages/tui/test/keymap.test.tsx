/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../src/config/keybind"
import {
  findSlashCommand,
  getOpencodeModeStack,
  OPENCODE_BASE_MODE,
  OpencodeKeymapProvider,
  parseSlashInput,
  registerOpencodeKeymap,
} from "../src/keymap"

function createResolvedKeymapConfig(input: TuiKeybind.KeybindOverrides = {}) {
  const keybinds = TuiKeybind.parse(input)
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

test("legacy page key aliases compile as page keys", async () => {
  const sequences: Record<string, string[][]> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig({
      messages_page_up: "pgup",
      messages_page_down: "pgdown",
    })
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const offLayer = keymap.registerLayer({
      bindings: config.keybinds.gather("session", ["session.page.up", "session.page.down"]),
    })
    const bindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: ["session.page.up", "session.page.down"],
    })
    sequences.up =
      bindings.get("session.page.up")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    sequences.down =
      bindings.get("session.page.down")?.map((binding) => binding.sequence.map((part) => part.stroke.name)) ?? []
    onCleanup(() => {
      offLayer()
      offKeymap()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(sequences).toEqual({
      up: [["pageup"]],
      down: [["pagedown"]],
    })
  } finally {
    app.renderer.destroy()
  }
})

test("mode-less bindings stay active when opencode mode changes", async () => {
  const counts: Record<string, Record<string, number>> = {}

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createResolvedKeymapConfig()
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const offGlobal = keymap.registerLayer({
      commands: [
        { name: "session.list", run() {} },
        { name: "session.new", run() {} },
        { name: "session.page.up", run() {} },
        { name: "session.first", run() {} },
      ],
      bindings: config.keybinds.gather("test.global", [
        "session.list",
        "session.new",
        "session.page.up",
        "session.first",
      ]),
    })
    const offBase = keymap.registerLayer({
      mode: OPENCODE_BASE_MODE,
      commands: [{ name: "model.list", run() {} }],
      bindings: config.keybinds.gather("test.base", ["model.list"]),
    })
    const activeCounts = () =>
      Object.fromEntries(
        Array.from(
          keymap.getCommandBindings({
            visibility: "active",
            commands: ["session.list", "session.new", "session.page.up", "session.first", "model.list"],
          }),
          ([command, bindings]) => [command, bindings.length],
        ),
      )

    counts.base = activeCounts()
    const popQuestion = getOpencodeModeStack(keymap).push("question")
    counts.question = activeCounts()
    popQuestion()
    const popAutocomplete = getOpencodeModeStack(keymap).push("autocomplete")
    counts.autocomplete = activeCounts()
    popAutocomplete()

    onCleanup(() => {
      offBase()
      offGlobal()
      offKeymap()
    })

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    expect(counts).toEqual({
      base: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "model.list": 1 },
      question: { "session.list": 1, "session.new": 1, "session.page.up": 2, "session.first": 2, "model.list": 0 },
      autocomplete: {
        "session.list": 1,
        "session.new": 1,
        "session.page.up": 2,
        "session.first": 2,
        "model.list": 0,
      },
    })
  } finally {
    app.renderer.destroy()
  }
})

describe("parseSlashInput", () => {
  test("bare slash command", () => {
    expect(parseSlashInput("/teleport")).toEqual({ name: "teleport", args: "" })
  })

  test("slash command with arguments", () => {
    expect(parseSlashInput("/teleport user@host:/path")).toEqual({ name: "teleport", args: "user@host:/path" })
  })

  test("trims argument whitespace", () => {
    expect(parseSlashInput("/teleport   user@host  ")).toEqual({ name: "teleport", args: "user@host" })
  })

  test("tolerates trailing blank lines", () => {
    expect(parseSlashInput("/list\n\n")).toEqual({ name: "list", args: "" })
  })

  test("rejects multiline input with non-empty extra lines", () => {
    expect(parseSlashInput("/teleport user@host\nplease do it")).toBeUndefined()
  })

  test("rejects non-slash text", () => {
    expect(parseSlashInput("hello world")).toBeUndefined()
    expect(parseSlashInput("")).toBeUndefined()
  })

  test("rejects a lone slash", () => {
    expect(parseSlashInput("/")).toBeUndefined()
    expect(parseSlashInput("/ args")).toBeUndefined()
  })
})

describe("findSlashCommand", () => {
  const entries = [
    { display: "/teleport", onSelect: () => {} },
    { display: "/list", aliases: ["/teleported"], onSelect: () => {} },
  ]

  test("matches by display name", () => {
    expect(findSlashCommand(entries, "teleport")).toBe(entries[0])
  })

  test("matches by alias", () => {
    expect(findSlashCommand(entries, "teleported")).toBe(entries[1])
  })

  test("returns undefined for unknown names", () => {
    expect(findSlashCommand(entries, "nope")).toBeUndefined()
    expect(findSlashCommand(entries, "tele")).toBeUndefined()
  })
})
