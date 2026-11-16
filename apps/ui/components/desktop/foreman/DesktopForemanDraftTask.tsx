'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopForemanChatRef, DesktopForemanModelRef } from '@rerun/contracts'
import { buildDesktopModelView } from '@/lib/desktop/chat-model'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { createDesktopForemanDraftPorts, sendDesktopForemanFirstMessage, type DesktopForemanDraftTask as DraftTask } from '@/lib/desktop/foreman-client/draft-task'
import { saveDesktopModelEffort } from '../DesktopModelEffort'
import type { DesktopForemanMessage } from './DesktopForemanChatLayer'
import { DesktopForemanColumn } from './DesktopForemanColumn'
import { DesktopForemanHistory, DesktopForemanNewTask, DesktopForemanThreadCrumb, requestDesktopForemanNewTaskFocus, useDesktopForemanConversations } from './DesktopForemanConversations'
import { DesktopForemanModelPill } from './DesktopForemanModelPill'
import type { DesktopForemanPanelProps } from './DesktopForemanPanel'

const NO_MESSAGES: DesktopForemanMessage[] = []

/**
 * « New task » before its first message, as upstream foreman.store.newChat(): the crumb reads
 * « General / New task », the team welcome shows, the caret is in the composer, and nothing is
 * saved. The first message creates the conversation and is sent in it; leaving any other way
 * drops the draft. Attachments and voice need a saved conversation: they appear once it exists.
 * The model picked here is saved on the conversation before that first message goes.
 */
export function DesktopForemanDraftTask({ draft, base, onDiscard, ...props }: DesktopForemanPanelProps & {
    draft: DraftTask
    /** The saved conversation under the draft: General, or the thread « New task » was pressed in. */
    base: DesktopForemanChatRef
    /** Drops the draft. Quiet when the panel is closing: nothing is shown in its place. */
    onDiscard: (quiet?: boolean) => void
}) {
    const current = useRef({ props, onDiscard })
    current.current = { props, onDiscard }
    const lifetime = useRef<AbortController | null>(null)
    useEffect(() => {
        const controller = new AbortController()
        lifetime.current = controller
        return () => controller.abort()
    }, [])
    const [model, setModel] = useState<DesktopForemanModelRef | null>(null)
    const picked = useRef(model)
    picked.current = model
    const [efforts, setEfforts] = useState<Record<string, string>>()
    const [sending, setSending] = useState(false)
    const [focusRequest, setFocusRequest] = useState(`new-task:${draft.chat.chatId}`)
    const seenComposerFocus = useRef(props.composerFocusRequest)
    useEffect(() => {
        if (seenComposerFocus.current === props.composerFocusRequest) return
        seenComposerFocus.current = props.composerFocusRequest
        setFocusRequest(`key:${props.composerFocusRequest}`)
    }, [props.composerFocusRequest])
    const ports = useMemo(() => createDesktopForemanDraftPorts(draft.chat, async (text, options) => {
        const signal = lifetime.current?.signal
        const open = current.current.props.onSelectConversation
        if (!signal || signal.aborted || !open || isDesktopQuitting() || !text.trim()) return false
        setSending(true)
        try {
            await sendDesktopForemanFirstMessage(draft, { text, coworkerMentions: options?.coworkerMentions, model: picked.current }, async chat => {
                requestDesktopForemanNewTaskFocus(chat.chatId)
                try { await open(chat) } catch (error) { requestDesktopForemanNewTaskFocus(null); throw error }
            }, signal)
            // The saved conversation takes this panel's place: the composer stays held until it does.
            return true
        } catch (error) {
            if (!signal.aborted) setSending(false)
            throw error
        }
    }), [draft])
    const baseThread = !!props.target
    const conversations = useDesktopForemanConversations({
        chat: draft.chat, thread: true, emptyThread: true, draft: true,
        onSelect: props.onSelectConversation && (async target => {
            // The conversation under the draft is still the open one: going back to it only drops the draft.
            if (target === null ? !baseThread : baseThread && target.chatId === base.chatId) { current.current.onDiscard(); return }
            await current.current.props.onSelectConversation?.(target)
        }),
        onFocusComposer: () => setFocusRequest(`new-task:${crypto.randomUUID()}`),
    })
    const close = useCallback(() => { current.current.onDiscard(true); current.current.props.onClose() }, [])
    const providers = props.providers
    const view = providers && props.composerTrailing == null && !props.hidden && props.controlledOpen !== false ? buildDesktopModelView({
        connections: providers.connections.filter(connection => !connection.credentialRejected),
        workspace: providers.default, conversation: model, coworker: null, efforts: efforts ?? providers.efforts,
    }) : undefined
    return <DesktopForemanColumn fill={props.fill} chat={draft.chat} ports={ports} live={null} messages={NO_MESSAGES}
        mentionTargets={props.mentionTargets} team={props.team} firstName={props.firstName} nextRoutine={props.nextRoutine} routineNow={props.routineNow}
        onOpenCalledChat={props.onOpenCalledChat} agentNameOf={props.agentNameOf}
        controlledOpen={props.controlledOpen} hidden={props.hidden} centerOpen={props.centerOpen} onOpenChange={props.onOpenChange} onLayout={props.onLayout}
        separateConversation intakeFinished sendDisabled={sending} focusRequest={focusRequest}
        className={props.className} onClose={close}
        headerCrumb={conversations.enabled ? <DesktopForemanThreadCrumb conversations={conversations} disabled={!!props.hidden} state="quiet" /> : undefined}
        headerActions={conversations.enabled && <>
            <DesktopForemanHistory conversations={conversations} disabled={!!props.hidden} />
            <DesktopForemanNewTask conversations={conversations} disabled={!!props.hidden} />
        </>}
        composerTrailing={props.composerTrailing ?? (view && <div className="flex min-w-0 items-center">
            <DesktopForemanModelPill view={view} connections={providers?.connections} saving={false} onSettings={props.onOpenModelSettings} disabled={sending}
                onEffort={async (connectionId, id, effort) => { setEfforts(await saveDesktopModelEffort(connectionId, id, effort)) }}
                onPick={async next => { setModel(next) }} />
        </div>)}
    />
}
