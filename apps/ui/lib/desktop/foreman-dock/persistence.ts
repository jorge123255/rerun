import type { DesktopForemanChatRef } from '@/lib/desktop/foreman-client/identity'
import { sameForemanChat } from '@/lib/desktop/foreman-client/identity'
import { flushDesktopForemanUiSaves } from '@/lib/desktop/foreman-client/actions'
import type { DesktopForemanPlacement } from '@/lib/desktop/foreman-client/persistence'
import type { DockExtras } from './layout'

export type DockChange = { placement?: DesktopForemanPlacement; dock?: DockExtras }
export type DockSaveBinding = {
    chat: DesktopForemanChatRef
    current: () => DesktopForemanChatRef | null
    /** Synchronous patch of the SAME useDesktopForemanUi owner; it admits a canonical UI save. */
    commit: (change: DockChange) => void
    flush?: () => Promise<boolean>
}
export function createDockPersistence(binding: DockSaveBinding, delay = 180) {
    const chat = { ...binding.chat }
    let pending: DockChange | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const valid = () => !disposed && sameForemanChat(chat, binding.current())
    const admit = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
        if (!valid()) { pending = null; return }
        const change = pending
        pending = null
        if (change) binding.commit(structuredClone(change))
    }
    return {
        activate() { disposed = false },
        change(change: DockChange) {
            if (!valid()) return
            pending = { ...pending, ...structuredClone(change) }
            if (timer) clearTimeout(timer)
            timer = setTimeout(admit, delay)
        },
        async flush() {
            if (!valid()) return false
            admit()
            return (binding.flush ?? flushDesktopForemanUiSaves)()
        },
        dispose() { admit(); disposed = true },
    }
}

/** Bind directly to the current H33 hook; no second HTTP client, snapshot cache or revision. */
export function bindForemanPlacement(input: {
    chat: DesktopForemanChatRef; current: () => DesktopForemanChatRef | null
    setPlacement: (placement: DesktopForemanPlacement) => void
    setDock: (dock: DockExtras) => void
}): DockSaveBinding {
    return { chat: input.chat, current: input.current, commit(change) {
        if (!sameForemanChat(input.chat, input.current())) return
        if (change.placement) input.setPlacement(change.placement)
        if (change.dock) input.setDock(change.dock)
    } }
}

const quitFlushes = new Set<() => Promise<boolean>>()
export function registerDockQuitFlush(flush: () => Promise<boolean>) {
    quitFlushes.add(flush)
    return () => { quitFlushes.delete(flush) }
}
/** Root awaits this BEFORE its existing canonical UI-save drain and shutdown acknowledgement. */
export async function flushForemanDockPlacements() {
    const results = await Promise.allSettled([...quitFlushes].map(flush => flush()))
    return results.every(result => result.status === 'fulfilled' && result.value)
}
