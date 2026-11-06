'use client'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { usePushToTalk } from '@/components/foreman/dock/usePushToTalk'
import { useDesktopVoiceRecorder } from '../voice/useDesktopVoiceRecorder'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '../draft-writes'
import type { ForemanVoiceAccepted, ForemanVoiceTarget } from '@rerun/contracts'
import { createForemanVoiceController, type ForemanVoiceController } from './controller'
import { createForemanAudioJournal } from './journal'
import { createForemanVoiceClient } from './client'

const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
export type ForemanVoiceSlotOptions = {
    target: ForemanVoiceTarget; active: boolean; onEngage?(): void
    onAccepted?(receipt: ForemanVoiceAccepted): void; releasePolicy?: 'send' | 'review'
}
export function useForemanVoiceSlot({ target, active, onEngage, onAccepted, releasePolicy = 'send' }: ForemanVoiceSlotOptions) {
    const activeRef = useRef(active), acceptedRef = useRef(onAccepted), engageRef = useRef(onEngage)
    const controllerRef = useRef<ForemanVoiceController | null>(null)
    activeRef.current = active; acceptedRef.current = onAccepted; engageRef.current = onEngage
    const recorder = useDesktopVoiceRecorder({
        onError: message => controllerRef.current?.fail(message),
        onLimitReached: () => { void controllerRef.current?.release(true) },
    })
    const recorderRef = useRef(recorder); recorderRef.current = recorder
    const key = JSON.stringify([target.chat.workspaceId, target.chat.chatId, target.model.connectionId, target.model.model])
    const targetKey = useRef(key); targetKey.current = key
    const owner = useMemo(() => {
        const lease = { mounted: false }
        const controller = createForemanVoiceController(target, {
            recorder: { start: () => recorderRef.current.start(), stop: () => recorderRef.current.stop(), cancel: () => recorderRef.current.cancel() },
            journal: createForemanAudioJournal(), client: createForemanVoiceClient(), uuid: () => crypto.randomUUID(),
            current: () => lease.mounted && targetKey.current === key && activeRef.current && !isDesktopQuitting(),
            onAccepted: r => acceptedRef.current?.(r), onEngage: () => engageRef.current?.(),
            holdWrite: holdDraftAdmission, releasePolicy,
        })
        return { controller, lease }
    }, [key, releasePolicy])
    const { controller, lease } = owner
    controllerRef.current = controller
    const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
    useEffect(() => {
        lease.mounted = true
        return () => {
            lease.mounted = false
            // StrictMode can reattach this exact owner before the microtask.
            queueMicrotask(() => { if (!lease.mounted) void controller.close() })
        }
    }, [controller, lease])
    useEffect(() => { if (active) void controller.restore(); else void controller.cancel() }, [active, controller])
    usePushToTalk({
        enabled: active && view.restored && !view.pending && ['idle', 'starting', 'listening'].includes(view.phase),
        onStart: () => { void controller.start() }, onRelease: () => { void controller.release() },
        onAbort: () => { if (['starting', 'listening'].includes(controller.getSnapshot().phase)) void controller.cancel() },
    })
    useEffect(() => {
        if (!active) return
        const abort = () => { if (!['idle', 'sent'].includes(controller.getSnapshot().phase)) void controller.cancel() }
        const hide = () => { if (document.hidden) abort() }, keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') abort() }
        const focus = () => {
            const e = document.activeElement
            if (e && !e.closest('[data-foreman-voice-controls]') && e !== document.body && e !== document.documentElement && ['starting', 'listening'].includes(controller.getSnapshot().phase)) abort()
        }
        const observer = new MutationObserver(() => { if (document.querySelector(OVERLAYS) && ['starting', 'listening'].includes(controller.getSnapshot().phase)) abort() })
        observer.observe(document.body, { subtree: true, childList: true })
        window.addEventListener('blur', abort); window.addEventListener('keydown', keyDown)
        document.addEventListener('visibilitychange', hide); document.addEventListener('focusin', focus)
        const detach = () => {
            observer.disconnect(); window.removeEventListener('blur', abort); window.removeEventListener('keydown', keyDown)
            document.removeEventListener('visibilitychange', hide); document.removeEventListener('focusin', focus)
        }
        const unsubscribe = subscribeDraftShutdown(() => {
            if (isDesktopQuitting()) { detach(); const release = holdDraftAdmission(); void controller.cancel().finally(release) }
        })
        return () => { detach(); unsubscribe() }
    }, [controller, active])
    return { controller, view, stream: recorder.stream, releasePolicy, active }
}
export type ForemanVoiceSlotController = ReturnType<typeof useForemanVoiceSlot>
