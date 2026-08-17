import { createMemo, createSignal, Match, onCleanup, onMount, Switch } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogPassword } from "../ui/dialog-password"
import { DialogSelect } from "../ui/dialog-select"
import { Spinner } from "./spinner"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { useExit } from "../context/exit"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { useCommandShortcut } from "../keymap"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"
import {
  createTeleportClient,
  handoffFromInfo,
  handoffFromStatus,
  isLocalTransportUrl,
  returnableState,
  targetLabel,
  TeleportPasswordRequired,
  type TeleportStatus,
} from "../teleport"

type Stage = "loading" | "picker" | "target" | "password" | "progress"

export function DialogTeleport(props: { target?: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const route = useRoute()
  const exit = useExit()
  const toast = useToast()
  const { theme } = useTheme()
  const jumpShortcut = useCommandShortcut("dialog.select.submit")

  const client = createTeleportClient({
    url: sdk.url,
    fetch: sdk.fetch,
    headers: sdk.headers,
    directory: sdk.directory,
  })

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const [stage, setStage] = createSignal<Stage>(props.target ? "target" : "loading")
  const [teleports, setTeleports] = createSignal<TeleportStatus[]>([])
  const [progress, setProgress] = createSignal("Working...")
  const [pendingTarget, setPendingTarget] = createSignal(props.target ?? "")

  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  onMount(() => {
    if (props.target) return
    client
      .list()
      .then((list) => {
        if (disposed) return
        if (list.length === 0) {
          setStage("target")
          return
        }
        setTeleports(list)
        dialog.setSize("large")
        setStage("picker")
      })
      .catch(() => {
        if (!disposed) setStage("target")
      })
  })

  async function start(target: string, password?: string) {
    const id = sessionID()
    if (!id) {
      toast.show({ message: "Open a session to teleport it", variant: "warning" })
      dialog.clear()
      return
    }
    const trimmed = target.trim()
    if (!trimmed) return
    setPendingTarget(trimmed)
    setProgress(`Connecting to ${trimmed}...`)
    setStage("progress")
    const poll = setInterval(() => {
      void client
        .status(id)
        .then((status) => {
          if (!status || disposed) return
          setProgress(`${Locale.titlecase(status.state)} ${targetLabel(status.target)}...`)
        })
        .catch(() => {})
    }, 1000)
    try {
      const info = await client.start(id, { target: trimmed, password })
      // The handoff url is a loopback listener on the SERVER machine; a TUI
      // attached over the network cannot reach it — teleport itself succeeded,
      // only the hot-handoff is unavailable.
      if (!isLocalTransportUrl(sdk.url)) {
        toast.show({
          message: `Session teleported. Attach from the server machine: opencode attach ${info.url} --session ${info.sessionID}`,
          variant: "info",
          duration: 10000,
        })
        if (!disposed) dialog.clear()
        return
      }
      const handoff = handoffFromInfo(info)
      if (disposed) {
        toast.show({ message: "Teleport ready — /teleport to jump", variant: "info" })
        return
      }
      exit(handoff)
    } catch (error) {
      if (disposed) return
      if (error instanceof TeleportPasswordRequired) {
        setStage("password")
        return
      }
      toast.show({ title: "Teleport failed", message: errorMessage(error), variant: "error", duration: 5000 })
      setStage("target")
    } finally {
      clearInterval(poll)
    }
  }

  function jump(status: TeleportStatus) {
    const handoff = handoffFromStatus(status)
    if (!handoff) {
      toast.show({
        message:
          status.state === "teleported"
            ? "Teleport tunnel is not available yet"
            : `Session is ${status.state} — cannot jump`,
        variant: "warning",
      })
      return
    }
    // see start(): the tunnel listener only exists on the server machine
    if (!isLocalTransportUrl(sdk.url)) {
      toast.show({
        message: `Session teleported. Attach from the server machine: opencode attach ${handoff.url} --session ${handoff.sessionID}`,
        variant: "info",
        duration: 10000,
      })
      return
    }
    exit(handoff)
  }

  async function returnHere(status: TeleportStatus) {
    if (!returnableState(status.state)) {
      toast.show({
        message: `Session is ${status.state} — cannot return here; use \`opencode teleport abort\``,
        variant: "warning",
      })
      return
    }
    setProgress(`Returning session from ${targetLabel(status.target)}...`)
    setStage("progress")
    try {
      await client.return(status.sessionID)
      toast.show({ message: "Session returned", variant: "success" })
      if (sessionID() === status.sessionID) {
        await sync.session.resync(status.sessionID)
      } else {
        route.navigate({ type: "session", sessionID: status.sessionID })
      }
      dialog.clear()
    } catch (error) {
      toast.show({ title: "Return failed", message: errorMessage(error), variant: "error", duration: 5000 })
      if (!disposed) setStage("picker")
    }
  }

  const options = createMemo(() =>
    teleports().map((status) => {
      const session = sync.session.get(status.sessionID)
      const synced = status.lastPullAt ? ` · synced ${Locale.todayTimeOrDateTime(status.lastPullAt)}` : ""
      return {
        title: session?.title ?? status.sessionID,
        value: status,
        description: status.state + synced,
        details: [targetLabel(status.target)],
      }
    }),
  )

  return (
    <Switch>
      <Match when={stage() === "loading"}>
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            Teleport
          </text>
          <Spinner color={theme.textMuted}>Loading teleported sessions...</Spinner>
        </box>
      </Match>
      <Match when={stage() === "picker"}>
        <DialogSelect
          title="Teleported sessions"
          options={options()}
          current={teleports().find((status) => status.sessionID === sessionID())}
          onSelect={(option) => jump(option.value)}
          actions={[
            {
              command: "dialog.teleport.return",
              title: "return here",
              onTrigger: (option) => void returnHere(option.value),
            },
          ]}
          footerHints={[{ title: "jump", label: jumpShortcut() }]}
        />
      </Match>
      <Match when={stage() === "target"}>
        <DialogPrompt
          title="Teleport session"
          placeholder="user@host[:/path]"
          value={pendingTarget()}
          onConfirm={(value) => void start(value)}
        />
      </Match>
      <Match when={stage() === "password"}>
        <DialogPassword
          title={`Password for ${pendingTarget()}`}
          placeholder="SSH password"
          onConfirm={(value) => void start(pendingTarget(), value)}
        />
      </Match>
      <Match when={stage() === "progress"}>
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            Teleport
          </text>
          <Spinner color={theme.textMuted}>{progress()}</Spinner>
        </box>
      </Match>
    </Switch>
  )
}
