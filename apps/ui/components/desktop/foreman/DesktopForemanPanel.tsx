'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DesktopForemanChatRef, DesktopForemanModelRef } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { flushDesktopForemanUiSaves } from '@/lib/desktop/foreman-client'
import { createDesktopForemanClient, desktopForemanMessages, readDesktopForemanState, type DesktopForemanClientState } from '@/lib/desktop/foreman-client/runtime-client'
import { createClientDockFeed } from '@/lib/desktop/foreman-dock/feed'
import { useMemo } from 'react'
import type { ForemanPlacement } from '@/lib/foreman-layout'
import { useForemanVoiceSlot } from '@/lib/desktop/foreman-voice/useForemanVoiceSlot'
import { ForemanVoiceSlot } from '@/components/desktop/foreman-voice/ForemanVoiceSlot'
import { registerForemanVoiceQuit } from '@/lib/desktop/foreman-voice/quit'
import { DesktopCompanyResearch } from './company-brief/DesktopCompanyResearch'
import { DesktopForemanColumn } from './DesktopForemanColumn'

export type DesktopForemanCommand = { id: string; chat: DesktopForemanChatRef; text: string; signal: AbortSignal; settle: (error?: Error) => void }
export type DesktopForemanPanelProps = {
    command?: DesktopForemanCommand | null
    onOpenCoworker: (target: { agentId: string; sessionId?: string }) => void | Promise<void>
    onOpenBox: (spaceId: string) => void | Promise<void>
    onClose: () => void
    agentNameOf: (agentId: string) => string
    workspaceModel?: string
    modelChoice?: DesktopForemanModelRef
    workspaceModelChoice?: DesktopForemanModelRef
    composerTrailing?: ReactNode
    controlledOpen?: boolean
    hidden?: boolean
    centerOpen?: boolean
    onOpenChange?: (open: boolean) => void
    onOpenTranscriptionSettings?: () => void
    onLayout?: (layout: { scope: string; open: boolean; placement: ForemanPlacement; dragging: boolean; mobile: boolean }) => void
    className?: string
}
/** Real local Foreman conversation in the original docked column; the board remains mounted. */
export function DesktopForemanPanel(props: DesktopForemanPanelProps) {
    const [initial, setInitial] = useState<DesktopForemanClientState | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [retry, setRetry] = useState(0)
    useEffect(() => {
        const controller = new AbortController()
        void (async () => {
            await flushDesktopForemanUiSaves() // Wait for admitted writes; opening also allows a failed save to recover.
            if (controller.signal.aborted) return
            const next = await readDesktopForemanState(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
            if (!controller.signal.aborted) { setInitial(next); setError(null) }
        })().catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not open Foreman.') })
        return () => controller.abort()
    }, [retry])
    useEffect(() => { if (error && props.command) props.command.settle(new Error(error)) }, [error, props.command])
    if (initial) return <ConnectedForeman key={`${initial.chat.workspaceId}:${initial.chat.chatId}`} {...props} initial={initial} />
    return <section className={props.className} aria-label="Foreman"><div className="flex min-h-40 flex-col items-start gap-3 rounded-3xl border bg-background p-5"><p role={error ? 'alert' : 'status'}>{error ?? 'Opening Foreman…'}</p>{error && <Button size="sm" onClick={() => setRetry(value => value + 1)}>Try again</Button>}<Button size="sm" variant="ghost" onClick={props.onClose}>Close</Button></div></section>
}
function ConnectedForeman({ initial, ...props }: DesktopForemanPanelProps & { initial: DesktopForemanClientState }) {
    const [state, setState] = useState(initial)
    const projectFeed = useMemo(() => createClientDockFeed(initial.chat), [initial.chat.workspaceId, initial.chat.chatId])
    const [dockFeed, setDockFeed] = useState(() => projectFeed(initial))
    const [voiceSlot, setVoiceSlot] = useState<ReactNode>(null)
    const [error, setError] = useState<string | null>(null)
    const current = useRef(props)
    current.current = props
    const active = useRef(false)
    const [client, setClient] = useState<ReturnType<typeof createDesktopForemanClient> | null>(null)
    useEffect(() => {
        const client = createDesktopForemanClient(initial, {
            onState: next => { if (active.current) { setState(next); setDockFeed(projectFeed(next)); setError(null) } },
            onError: message => { if (active.current) setError(message) },
            onOpenCoworker: target => { if (active.current && !isDesktopQuitting()) return current.current.onOpenCoworker(target) },
            onOpenBox: spaceId => { if (active.current && !isDesktopQuitting()) return current.current.onOpenBox(spaceId) },
            modelChoice: () => current.current.modelChoice,
        })
        setClient(client)
        active.current = true
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const poll = async () => {
            if (cancelled) return
            if (!isDesktopQuitting()) try { await client.refresh() } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : 'Could not refresh Foreman.') }
            if (!cancelled) timer = setTimeout(() => void poll(), 1500)
        }
        void poll()
        const events = new EventSource(`/api/desktop/foreman/events?${new URLSearchParams(initial.chat)}`)
        events.onmessage = event => {
            if (cancelled || typeof event.data !== 'string' || event.data.length > 256 * 1024) return
            try { client.acceptEvent(JSON.parse(event.data)) } catch { /* A malformed event never becomes an action. */ }
        }
        return () => { cancelled = true; active.current = false; if (timer) clearTimeout(timer); events.close(); client.close() }
    }, [initial])
    const consumed = useRef(new Set<string>())
    const [focusRequest, setFocusRequest] = useState<string>()
    useEffect(() => {
        const command = props.command
        if (!client || !command || consumed.current.has(command.id)) return
        consumed.current.add(command.id)
        const signal = command.signal
        void (async () => {
            signal.throwIfAborted()
            if (command.chat.chatId !== initial.chat.chatId || command.chat.workspaceId !== initial.chat.workspaceId) throw new Error('Foreman conversation changed.')
            if (command.text.trim() && !await client.ports.conversation.sendMessage(command.text.trim(), signal)) throw new Error('Foreman did not accept this message.')
            if (!command.text.trim()) signal.throwIfAborted()
            setFocusRequest(command.id)
            command.settle()
        })().catch(error => command.settle(error instanceof Error ? error : new Error('Could not ask Foreman.')))
    }, [client, props.command, initial.chat.chatId, initial.chat.workspaceId])
    const close = useCallback(() => { if (active.current) current.current.onClose() }, [])
    if (!client) return <div role="status" className={props.className}>Opening Foreman…</div>
    return <>
    {(props.modelChoice ?? state.model ?? props.workspaceModelChoice) && <ForemanVoiceOwner target={{ chat: state.chat, model: (props.modelChoice ?? state.model ?? props.workspaceModelChoice)! }}
        active={!props.hidden && !state.view.live} engage={() => {}}
        accepted={() => { void client.refresh() }} onSlot={setVoiceSlot} onSettings={props.onOpenTranscriptionSettings} />}
    <DesktopCompanyResearch chat={state.chat} active={!!props.controlledOpen && !props.hidden} refreshKey={JSON.stringify(state.view)} />
    <DesktopForemanColumn
        controlledOpen={props.controlledOpen} hidden={props.hidden} centerOpen={props.centerOpen} onOpenChange={props.onOpenChange} onLayout={props.onLayout}
        dockFeed={dockFeed} voiceSlot={voiceSlot}        focusRequest={focusRequest} chat={state.chat} ports={client.ports} live={state.view.live} messages={desktopForemanMessages(state)}
        streaming={!!state.view.live} orbState={state.view.live ? 'thinking' : 'idle'} agentNameOf={props.agentNameOf}
        className={props.className} onClose={close} refreshKey={JSON.stringify(state.view)}
        headerActions={error ? <span className="max-w-48 truncate text-xs text-destructive" role="alert" title={error}>{error}</span> : undefined}
        composerTrailing={props.composerTrailing ?? <span className="truncate text-xs text-muted-foreground">{state.model?.model ?? props.workspaceModel ?? 'Workspace default'}</span>}
    /></>
}

function ForemanVoiceOwner({ target, active, engage, accepted, onSlot, onSettings }: {
    target: import('@rerun/contracts').ForemanVoiceTarget; active: boolean; engage(): void; accepted(): void
    onSlot(slot: ReactNode): void; onSettings?: () => void
}) {
    const voice = useForemanVoiceSlot({ target, active, onEngage: engage, onAccepted: accepted, releasePolicy: 'send' })
    useEffect(() => registerForemanVoiceQuit(() => voice.controller.prepareForQuit()), [voice.controller])
    useEffect(() => { onSlot(<ForemanVoiceSlot voice={voice} onOpenTranscriptionSettings={onSettings ?? (() => {})} />); return () => onSlot(null) }, [voice.view, voice.stream, voice.active, voice.controller, onSettings, onSlot])
    return null
}
