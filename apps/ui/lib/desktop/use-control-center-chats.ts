'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { desktopControlCenterChatsSchema, type DesktopControlCenterChats } from './control-center-chats'
import { isDesktopQuitting } from './draft-writes'
import { pendingTabWrite } from './tab-writes'

type State = { key: string; data?: DesktopControlCenterChats; loading: boolean; failed: boolean }

function ownedChats(value: unknown, agentId: string): DesktopControlCenterChats {
    const data = desktopControlCenterChatsSchema.parse(value)
    if (data.agentId !== agentId || data.openChats.some(chat => chat.agentId !== agentId) || data.recentChats.some(chat => chat.agentId !== agentId)) throw new Error('Unexpected coworker')
    const uids = new Set<string>(), sessions = new Set<string>()
    const openChats = data.openChats.filter(chat => {
        if (uids.has(chat.tabUid) || (chat.sessionId !== null && sessions.has(chat.sessionId))) return false
        uids.add(chat.tabUid)
        if (chat.sessionId !== null) sessions.add(chat.sessionId)
        return true
    })
    const recentChats = data.recentChats.filter(chat => {
        if (sessions.has(chat.id)) return false
        sessions.add(chat.id)
        return true
    })
    return { ...data, openChats, recentChats: data.recentStatus === 'ok' ? recentChats : [] }
}

export function useDesktopControlCenterChats(agentId: string | null, active: boolean, scope: string) {
    const inputKey = JSON.stringify([agentId, active, scope])
    const [generation, setGeneration] = useState({ inputKey, version: 0 })
    if (generation.inputKey !== inputKey) setGeneration({ inputKey, version: generation.version + 1 })
    const key = JSON.stringify([inputKey, generation.version])
    const latestKey = useRef(key)
    latestKey.current = key
    const request = useRef<{ key: string; controller: AbortController } | null>(null)
    const [state, setState] = useState<State>({ key, loading: active, failed: false })

    const refresh = useCallback(async (): Promise<DesktopControlCenterChats | null> => {
        if (!active || !agentId || latestKey.current !== key || isDesktopQuitting()) return null
        request.current?.controller.abort()
        const read = { key, controller: new AbortController() }
        request.current = read
        const current = () => latestKey.current === key && request.current === read && !read.controller.signal.aborted && !isDesktopQuitting()
        setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, loading: true, failed: false }))
        try {
            // More tab writes can join while an earlier one is settling. Read only after the
            // complete current tail, including a just-saved close or first-message binding.
            for (let pending = pendingTabWrite(agentId); pending; pending = pendingTabWrite(agentId)) {
                await pending
                if (!current()) return null
            }
            if (!current()) return null
            const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/control-center-chats`, { cache: 'no-store', signal: read.controller.signal })
            if (!response.ok) throw new Error('Could not load chats')
            const data = ownedChats(await response.json(), agentId)
            if (!current()) return null
            setState({ key, data, loading: false, failed: false })
            return data
        } catch {
            if (current()) setState({ key, loading: false, failed: true })
            return null
        } finally {
            if (request.current === read) request.current = null
        }
    }, [key, agentId, active])

    useEffect(() => {
        if (active) void refresh()
        return () => {
            if (request.current?.key === key) {
                request.current.controller.abort()
                request.current = null
            }
        }
    }, [active, key, refresh])

    const shown: State = active && state.key === key ? state : { key, loading: active, failed: false }
    return { data: shown.data, loading: shown.loading, failed: shown.failed, refresh }
}
