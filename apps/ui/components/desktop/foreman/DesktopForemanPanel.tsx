'use client'

import { useDesktopLocale } from '../DesktopLocale'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConnectionsList, DesktopCoworkerCallTarget, DesktopForemanChatRef, DesktopForemanModelRef } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
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
import { useDesktopForemanIntake } from '@/lib/desktop/foreman-intake'
import { createDesktopForemanIntakeClient } from '@/lib/desktop/foreman-intake/client'
import { DesktopForemanFilePermissions } from './DesktopForemanFilePermissions'
import { buildDesktopModelView } from '@/lib/desktop/chat-model'
import { DesktopForemanModelPill } from './DesktopForemanModelPill'
import { DesktopForemanContext } from './DesktopForemanContext'

export type DesktopForemanCommand = { id: string; chat: DesktopForemanChatRef; text: string; signal: AbortSignal; settle: (error?: Error) => void }
export type DesktopForemanPanelProps = {
    mentionTargets?: DesktopCoworkerCallTarget[]
    command?: DesktopForemanCommand | null
    onOpenCoworker: (target: { agentId: string; sessionId?: string }) => void | Promise<void>
    onOpenBox: (spaceId: string) => void | Promise<void>
    onClose: () => void
    agentNameOf: (agentId: string) => string
    /** Opens the template library on one local template's review. Nothing is installed from it. */
    onReviewTemplate?: (template: { templateId: string; revision: string }) => void
    providers?: ConnectionsList
    modelChoice?: DesktopForemanModelRef
    onOpenModelSettings?: () => void
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
    const { t } = useDesktopLocale()
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
        })().catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not open the Chief of Staff chat.') })
        return () => controller.abort()
    }, [retry])
    useEffect(() => { if (error && props.command) props.command.settle(new Error(error)) }, [error, props.command])
    if (initial) return <ConnectedForeman key={`${initial.chat.workspaceId}:${initial.chat.chatId}`} {...props} initial={initial} />
    return <section className={props.className} aria-label={t('foreman.name')}><div className="flex min-h-40 flex-col items-start gap-3 rounded-3xl border bg-background p-5"><p role={error ? 'alert' : 'status'}>{error ?? t('foreman.opening')}</p>{error && <Button size="sm" onClick={() => setRetry(value => value + 1)}>{t('creation.tryAgain')}</Button>}<Button size="sm" variant="ghost" onClick={props.onClose}>{t('foreman.close')}</Button></div></section>
}
function ConnectedForeman({ initial, ...props }: DesktopForemanPanelProps & { initial: DesktopForemanClientState }) {
    const { t } = useDesktopLocale()
    const [state, setState] = useState(initial)
    const intakePorts = useMemo(() => createDesktopForemanIntakeClient(), [])
    const intake = useDesktopForemanIntake({ chat: initial.chat, ports: intakePorts, active: !!props.controlledOpen && !props.hidden })
    const intakeEligible = initial.messages.length === 0 || intake.hasSavedProgress
    const intakeOpen = intakeEligible && !intake.finished
    const pendingStarter = !!state.starter && !state.starter.decision?.settled
    const projectFeed = useMemo(() => createClientDockFeed(initial.chat), [initial.chat.workspaceId, initial.chat.chatId])
    const [dockFeed, setDockFeed] = useState(() => projectFeed(initial))
    const [voice, setVoice] = useState<{ slot: ReactNode; busy: boolean } | null>(null)
    const [modelSaving, setModelSaving] = useState(false)
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
            workspaceModel: () => {
                const selected = current.current.providers?.default
                return selected ? { connectionId: selected.connectionId, model: selected.model } : undefined
            },
        })
        setClient(client)
        active.current = true
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let events: EventSource | undefined, generation = 0
        const currentFeed = (value: number) => !cancelled && value === generation && !isDesktopQuitting()
        const poll = async (value: number) => {
            if (!currentFeed(value)) return
            try { await client.refresh() } catch (error) { if (currentFeed(value)) setError(error instanceof Error ? error.message : 'Could not refresh the Chief of Staff chat.') }
            if (currentFeed(value)) timer = setTimeout(() => void poll(value), 1500)
        }
        const pauseFeed = () => {
            ++generation
            if (timer) clearTimeout(timer)
            timer = undefined
            if (events) { events.onmessage = null; events.close(); events = undefined }
        }
        const resumeFeed = () => {
            if (cancelled || isDesktopQuitting() || events) return
            const value = ++generation
            const source = new EventSource(`/api/desktop/foreman/events?${new URLSearchParams(initial.chat)}`)
            events = source
            source.onmessage = event => {
                if (!currentFeed(value) || events !== source || typeof event.data !== 'string' || event.data.length > 256 * 1024) return
                try { client.acceptEvent(JSON.parse(event.data)) } catch { /* A malformed event never becomes an action. */ }
            }
            void poll(value)
        }
        // Keep the client and persistence writer alive so admitted draft saves can
        // finish. The unbounded SSE must close before Next's graceful shutdown.
        const unsubscribe = subscribeDraftShutdown(() => { if (isDesktopQuitting()) pauseFeed(); else resumeFeed() })
        resumeFeed()
        return () => { cancelled = true; active.current = false; unsubscribe(); pauseFeed(); client.close() }
    }, [initial])
    const consumed = useRef(new Set<string>())
    const [focusRequest, setFocusRequest] = useState<string>()
    useEffect(() => {
        const command = props.command
        if (!client || !command || consumed.current.has(command.id) || intakeEligible && !intake.restored) return
        consumed.current.add(command.id)
        const signal = command.signal
        void (async () => {
            signal.throwIfAborted()
            if (command.chat.chatId !== initial.chat.chatId || command.chat.workspaceId !== initial.chat.workspaceId) throw new Error('The Chief of Staff conversation changed.')
            if (intakeOpen && command.text.trim()) throw new Error('Finish the company questions before asking your Chief of Staff to plan your team.')
            if (command.text.trim() && !await client.ports.conversation.sendMessage(command.text.trim(), signal)) throw new Error('Your Chief of Staff did not accept this message.')
            if (!command.text.trim()) signal.throwIfAborted()
            setFocusRequest(command.id)
            command.settle()
        })().catch(error => command.settle(error instanceof Error ? error : new Error('Could not ask your Chief of Staff.')))
    }, [client, props.command, initial.chat.chatId, initial.chat.workspaceId, intakeOpen, intakeEligible, intake.restored])
    const close = useCallback(() => { if (active.current) current.current.onClose() }, [])
    if (!client) return <div role="status" className={props.className}>{t('foreman.opening')}</div>
    const providers = props.providers
    const view = providers && buildDesktopModelView({
        connections: providers.connections.filter(connection => !connection.credentialRejected),
        workspace: providers.default,
        conversation: state.model,
        coworker: null,
    })
    const effective = view?.effective
    const voiceModel = props.modelChoice ?? state.model ?? (effective?.available && effective.connectionId && effective.model
        ? { connectionId: effective.connectionId, model: effective.model } : undefined)
    const pendingSend = state.ui.snapshot?.pendingSend
    return <>
    {voiceModel && <ForemanVoiceOwner target={{ chat: state.chat, model: voiceModel }}
        active={!props.hidden && !state.view.live && !state.question && !intakeOpen && !pendingStarter && !modelSaving} engage={() => {}}
        accepted={() => { void client.refresh() }} onSlot={setVoice} onSettings={props.onOpenTranscriptionSettings} />}
    {!intakeOpen && <DesktopCompanyResearch chat={state.chat} active={!!props.controlledOpen && !props.hidden} refreshKey={JSON.stringify(state.view)} />}
    <DesktopForemanColumn
        mentionTargets={props.mentionTargets}
        sessionId={state.sessionId} pendingSend={!!pendingSend} retryAttachedMessage={!!pendingSend?.documents && !pendingSend.text}
        imageModel={providers?.connections.some(connection => connection.id === voiceModel?.connectionId && connection.provider === 'codex')}
        controlledOpen={props.controlledOpen} hidden={props.hidden} centerOpen={props.centerOpen} onOpenChange={props.onOpenChange} onLayout={props.onLayout}
        dockFeed={dockFeed} voiceSlot={voiceModel ? voice?.slot : undefined} sendDisabled={modelSaving} intake={intakeOpen ? intake : undefined} focusRequest={focusRequest} chat={state.chat} ports={client.ports} live={state.view.live} messages={desktopForemanMessages(state)} retrySnapshot={state.retrySnapshot}
        question={state.question} onAnswerQuestion={client.answerQuestion}
        starter={state.starter} onStarterAnswer={client.answerStarter} intakeFinished={intake.finished}
        streaming={!!state.view.live} orbState={state.view.live ? 'thinking' : 'idle'} agentNameOf={props.agentNameOf} onReviewTemplate={props.onReviewTemplate}
        className={props.className} onClose={close} refreshKey={JSON.stringify(state.view)}
        headerActions={<><DesktopForemanFilePermissions chat={state.chat} disabled={!!props.hidden} />{error && <span className="max-w-48 truncate text-xs text-destructive" role="alert" title={error}>{error}</span>}</>}
        composerTrailing={props.composerTrailing ?? (!props.hidden && props.controlledOpen !== false && view && <div className="flex min-w-0 items-center">
            <DesktopForemanModelPill view={view} saving={modelSaving} onSettings={props.onOpenModelSettings}
                disabled={!!state.view.live || !!state.question || !!state.ui.snapshot?.pendingSend || !!voice?.busy}
                onPick={async model => {
                    setModelSaving(true)
                    try { await client.setModel(state.model, model) } finally { setModelSaving(false) }
                }} />
            <DesktopForemanContext context={state.context} effective={view.effective} />
        </div>)}
    /></>
}

function ForemanVoiceOwner({ target, active, engage, accepted, onSlot, onSettings }: {
    target: import('@rerun/contracts').ForemanVoiceTarget; active: boolean; engage(): void; accepted(): void
    onSlot(controls: { slot: ReactNode; busy: boolean } | null): void; onSettings?: () => void
}) {
    const voice = useForemanVoiceSlot({ target, active, onEngage: engage, onAccepted: accepted, releasePolicy: 'send' })
    useEffect(() => registerForemanVoiceQuit(() => voice.controller.prepareForQuit()), [voice.controller])
    useEffect(() => {
        onSlot({ slot: <ForemanVoiceSlot voice={voice} onOpenTranscriptionSettings={onSettings ?? (() => {})} />,
            busy: voice.view.phase !== 'sent' && (!!voice.view.pending || ['restoring', 'starting', 'listening', 'saving', 'transcribing', 'sending'].includes(voice.view.phase)) })
        return () => onSlot(null)
    }, [voice.view, voice.stream, voice.active, voice.controller, onSettings, onSlot])
    return null
}
