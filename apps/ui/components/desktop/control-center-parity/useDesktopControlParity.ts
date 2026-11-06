'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { z } from 'zod'
import type { ControlSection } from '@/components/control-center/types'
import { ServerIcon } from 'lucide-react'
import { parseQuery, searchItems } from '@/lib/control-center/search'
import type { DesktopAgentView } from '../DesktopApp'
import { desktopBoardStateSchema, type DesktopBoardState } from '@/lib/desktop/spaces'
import { readDesktopToolInstallBody } from '@/lib/desktop/tool-install-client'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { readDesktopForemanState } from '@/lib/desktop/foreman-client/runtime-client'
import type { DesktopForemanChatRef } from '@/lib/desktop/foreman-client/identity'
import { createParityActions } from '@/lib/desktop/control-center-parity/adapter'
import { projectParitySnapshot } from '@/lib/desktop/control-center-parity/snapshot'
import { buildParityCommands, mergeParitySections, parityCommandSections } from '@/lib/desktop/control-center-parity/commands'
import type { ParityPage } from '@/lib/desktop/control-center-parity/types'
import { useControlCenterParity } from './useControlCenterParity'
import { controlContextAvailable, controlContextKey } from './context'
import { originalControlLabels } from './labels'
const agentsSchema = z.object({ agents: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), createdAt: z.string(), updatedAt: z.string(), enabled: z.boolean().optional() })).max(1000) })
export type DesktopParityCallbacks = {
    onTemplates?: () => void
    onExternalMcp?: () => void
    onServers?: () => void
    runtimeWorkspaceId?: number
    runtimeLaunchNonce?: string
    onOpenDesktop?: (agentId: string) => void
    onAskAssistant?: (chat: DesktopForemanChatRef, text: string, signal: AbortSignal) => Promise<void>
}
export function useDesktopControlParity(input: DesktopParityCallbacks & { open: boolean; scope: string; page: ParityPage; query: string; board?: DesktopBoardState; agents: DesktopAgentView[]; disabled: boolean; darkTheme: boolean; close: () => void }) {
    const latest = useRef(input); latest.current = input
    const serverAttempt = useRef<AbortController | null>(null)
    const [serverBusy, setServerBusy] = useState(false)
    const [serverNotice, setServerNotice] = useState<string | null>(null)
    const contextKey = controlContextKey(input)
    useLayoutEffect(() => {
        serverAttempt.current?.abort(); serverAttempt.current = null
        setServerBusy(false); setServerNotice(null)
        return () => { serverAttempt.current?.abort(); serverAttempt.current = null }
    }, [contextKey, input.open, input.disabled])
    const [foreman, setForeman] = useState<DesktopForemanChatRef | null>(null)
    useEffect(() => {
        setForeman(null)
        if (!input.open || input.disabled || !input.onAskAssistant || !Number.isSafeInteger(input.runtimeWorkspaceId) || (input.runtimeWorkspaceId ?? 0) <= 0) return
        const controller = new AbortController()
        void readDesktopForemanState(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])).then(value => { if (!controller.signal.aborted && value.chat.workspaceId === String(input.runtimeWorkspaceId)) setForeman(value.chat) }).catch(() => {})
        return () => controller.abort()
    }, [input.open, input.disabled, input.onAskAssistant, input.runtimeWorkspaceId, input.runtimeLaunchNonce])
    const project = (agents: DesktopAgentView[], board: DesktopBoardState, chat: DesktopForemanChatRef | null) => projectParitySnapshot({ workspaceId: String(latest.current.runtimeWorkspaceId), workspaceRevision: String(board.revision), agents, board, chats: [], pendingAgentIds: new Set(), foreman: chat, quitting: isDesktopQuitting(), blocked: latest.current.disabled || !latest.current.open })
    const actions = createParityActions(async parentSignal => {
        const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15000)])
        const captured = { ...latest.current }
        if (!controlContextAvailable(captured, latest.current, isDesktopQuitting())) throw new Error('Workspace identity unavailable')
        async function read(path: string) { const response = await fetch(path, { cache: 'no-store', signal }); const body = await readDesktopToolInstallBody(response, signal, 1_000_000); if (!response.ok) throw new Error('Current workspace is unavailable'); return body }
        const [agents, spaces, chat] = await Promise.all([read('/api/desktop/agents'), read('/api/desktop/spaces'), latest.current.onAskAssistant ? readDesktopForemanState(signal) : null])
        signal.throwIfAborted()
        if (!controlContextAvailable(captured, latest.current, isDesktopQuitting())) throw new Error('Control Center selection changed')
        if (chat && chat.chat.workspaceId !== String(captured.runtimeWorkspaceId)) throw new Error('Foreman workspace changed')
        const board = z.object({ board: desktopBoardStateSchema }).parse(spaces).board
        return project(agentsSchema.parse(agents).agents, board, chat?.chat ?? null)
    }, () => ({
        global: {
            ...(latest.current.onTemplates ? { browse_templates: (_workspace, execution) => { execution.signal.throwIfAborted(); latest.current.onTemplates!() } } : {}),
            ...(latest.current.onExternalMcp ? { api_keys: (_workspace, execution) => { execution.signal.throwIfAborted(); latest.current.onExternalMcp!() } } : {}),
        },
        ...(latest.current.onOpenDesktop ? { desktop: (id, execution) => { execution.signal.throwIfAborted(); latest.current.onOpenDesktop!(id) } } : {}),
        ...(latest.current.onAskAssistant ? { assistant: (chat, text, execution) => latest.current.onAskAssistant!(chat, text, execution.signal) } : {}),
    }), intent => {
        if (intent.kind === 'global' && intent.command === 'browse_templates') return input.onTemplates ? { state: 'ready' } : { state: 'omit' }
        if (intent.kind === 'global' && intent.command === 'api_keys') return input.onExternalMcp ? { state: 'ready' } : { state: 'omit' }
        if (intent.kind === 'desktop') return input.onOpenDesktop ? { state: 'ready' } : { state: 'omit' }
        if (intent.kind === 'assistant') return input.onAskAssistant ? { state: 'ready' } : { state: 'omit' }
        return { state: 'omit' }
    })
    const parity = useControlCenterParity(actions, input.open && !input.disabled, contextKey)
    const snapshot = input.board && Number.isSafeInteger(input.runtimeWorkspaceId) && (input.runtimeWorkspaceId ?? 0) > 0 ? project(input.agents, input.board, foreman?.workspaceId === String(input.runtimeWorkspaceId) ? foreman : null) : null
    return { state: { ...parity.state, busy: parity.state.busy || serverBusy, notice: serverNotice ?? parity.state.notice }, merge: (sections: ControlSection[]) => {
        let additions: ControlSection[] = []
        if (snapshot) {
            const commands = buildParityCommands(snapshot, input.page, input.query, actions, { darkTheme: input.darkTheme })
            additions = parityCommandSections(commands, command => { void parity.controller.execute(command).then(accepted => { if (accepted) latest.current.close() }) }, input.page)
        }
        const { scope, text } = parseQuery(input.query)
        if (input.open && !input.disabled && !isDesktopQuitting() && input.page.kind === 'root' && scope !== 'agents' && input.onServers) {
            const captured = { ...input }
            const servers = searchItems([{ id: 'command-servers', label: 'Servers', disabledReason: !Number.isSafeInteger(input.runtimeWorkspaceId) || (input.runtimeWorkspaceId ?? 0) <= 0 ? 'The current workspace identity is unavailable.' : undefined, keywords: ['machine', 'computer', 'remote', 'connection'], leading: { kind: 'icon' as const, icon: ServerIcon }, onSelect: () => {
                if (serverAttempt.current || !controlContextAvailable(captured, latest.current, isDesktopQuitting())) return
                const operation = new AbortController(); serverAttempt.current = operation
                setServerBusy(true); setServerNotice(null)
                void (async () => {
                    try {
                        const fresh = await actions.read(operation.signal)
                        operation.signal.throwIfAborted()
                        if (!controlContextAvailable(captured, latest.current, isDesktopQuitting()) || fresh.workspace.id !== String(captured.runtimeWorkspaceId) || fresh.workspace.revision !== String(captured.board?.revision) || !latest.current.onServers) return
                        latest.current.onServers(); latest.current.close()
                    } catch {
                        if (!operation.signal.aborted && controlContextAvailable(captured, latest.current, isDesktopQuitting())) setServerNotice('Servers could not open. Check the current workspace and try again.')
                    } finally {
                        if (serverAttempt.current === operation) { serverAttempt.current = null; setServerBusy(false) }
                    }
                })()
            } }], text)
            if (servers.length) additions.push({ id: 'settings', heading: 'Settings', rows: servers })
        }
        return originalControlLabels(mergeParitySections(sections, additions, input.query), input.darkTheme)
    } }
}
