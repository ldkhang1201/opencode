import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { Show, createEffect, createSignal, onMount, type JSX } from "solid-js"
import { Spinner } from "../component/spinner"
import { useTuiConfig } from "../config"
import { useBindings, useCommandShortcut } from "../keymap"

export type DialogPasswordProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  busy?: boolean
  busyText?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

/**
 * DialogPrompt with masked input. The real value only ever lives inside the
 * textarea buffer, which is rendered invisible (text color == panel
 * background, selection disabled); an overlay shows one "*" per character.
 */
export function DialogPassword(props: DialogPasswordProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const submitShortcut = useCommandShortcut("dialog.prompt.submit")
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  const [length, setLength] = createSignal(0)
  let textarea: TextareaRenderable

  function confirm() {
    if (props.busy) return
    props.onConfirm?.(textarea.plainText)
  }

  useBindings(() => ({
    target: textareaTarget,
    enabled: textareaTarget() !== undefined && !props.busy,
    // Dialog form semantics must win over the global managed textarea input layer.
    priority: 1,
    commands: [
      {
        name: "dialog.prompt.submit",
        title: "Submit dialog prompt",
        category: "Dialog",
        run: confirm,
      },
    ],
    bindings: tuiConfig.keybinds.gather("dialog.prompt", ["dialog.prompt.submit"]),
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        {props.description?.()}
        <box position="relative">
          <textarea
            height={3}
            ref={(val: TextareaRenderable) => {
              textarea = val
              setTextareaTarget(val)
            }}
            wrapMode="char"
            selectable={false}
            placeholder={props.placeholder ?? "Enter password"}
            placeholderColor={theme.textMuted}
            textColor={theme.backgroundPanel}
            focusedTextColor={theme.backgroundPanel}
            cursorColor={props.busy ? theme.backgroundElement : theme.text}
            cursorStyle={tuiConfig.cursor}
            onContentChange={() => {
              if (!textarea || textarea.isDestroyed) return
              setLength([...textarea.plainText].length)
            }}
          />
          <Show when={length() > 0}>
            <text
              position="absolute"
              left={0}
              top={0}
              width="100%"
              wrapMode="char"
              fg={props.busy ? theme.textMuted : theme.text}
            >
              {"*".repeat(length())}
            </text>
          </Show>
        </box>
        <Show when={props.busy}>
          <Spinner color={theme.textMuted}>{props.busyText ?? "Working..."}</Spinner>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>processing...</text>}>
          <Show when={submitShortcut()}>
            <text fg={theme.text}>
              {submitShortcut()} <span style={{ fg: theme.textMuted }}>submit</span>
            </text>
          </Show>
        </Show>
      </box>
    </box>
  )
}

DialogPassword.show = (dialog: DialogContext, title: string, options?: Omit<DialogPasswordProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPassword
          title={title}
          {...options}
          onConfirm={(value) => resolve(value)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
