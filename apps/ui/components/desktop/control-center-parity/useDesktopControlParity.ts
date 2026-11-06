'use client'
import { useEffect, useRef, useState } from 'react'
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
const agentsSchema = z.object({ agents: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), createdAt: z.string(), updatedAt: z.string(), enabled: z.boolean().optional() })).max(1000) })
export type DesktopParityCallbacks = {
    onTemplates?: () => void
    onExternalMcp?: () => void
    onServers?: () => void
    runtimeWorkspaceId?: number
    onOpenDesktop?: (agentId: string) => void
    onAskAssistant?: (chat: DesktopForemanChatRef, text: string, signal: AbortSignal) => Promise<void>
}
export function useDesktopControlParity(input: DesktopParityCallbacks & { open: boolean; scope: string; page: ParityPage; query: string; board?: DesktopBoardState; agents: DesktopAgentView[]; disabled: boolean; darkTheme: boolean; close: () => void }) {
    const latest = useRef(input); latest.current = input
    const [foreman, setForeman] = useState<DesktopForemanChatRef | null>(null)
    useEffect(() => {
        setForeman(null)
        if (!input.open || !input.onAskAssistant) return
        const controller = new AbortController()
        void readDesktopForemanState(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])).then(value => { if (!controller.signal.aborted) setForeman(value.chat) }).catch(() => {})
        return () => controller.abort()
    }, [input.open, input.onAskAssistant])
    const project = (agents: DesktopAgentView[], board: DesktopBoardState, chat: DesktopForemanChatRef | null) => projectParitySnapshot({ workspaceId: String(latest.current.runtimeWorkspaceId ?? 1), workspaceRevision: String(board.revision), agents, board, chats: [], pendingAgentIds: new Set(), foreman: chat, quitting: isDesktopQuitting(), blocked: latest.current.disabled || !latest.current.open })
    const actions = createParityActions(async signal => {
        const capturedScope = latest.current.scope
        async function read(path: string) { const response = await fetch(path, { cache: 'no-store', signal }); const body = await readDesktopToolInstallBody(response, signal, 1_000_000); if (!response.ok) throw new Error('Current workspace is unavailable'); return body }
        const [agents, spaces, chat] = await Promise.all([read('/api/desktop/agents'), read('/api/desktop/spaces'), latest.current.onAskAssistant ? readDesktopForemanState(signal) : null])
        signal.throwIfAborted()
        if (capturedScope !== latest.current.scope) throw new Error('Control Center selection changed')
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
    const parity = useControlCenterParity(actions, input.open && !input.disabled, `${input.scope}:${input.board?.revision}`)
    const snapshot = input.board ? project(input.agents, input.board, foreman) : null
    return { state: parity.state, merge: (sections: ControlSection[]) => {
        let additions: ControlSection[] = []
        if (snapshot) {
            const commands = buildParityCommands(snapshot, input.page, input.query, actions, { darkTheme: input.darkTheme })
            additions = parityCommandSections(commands, command => { void parity.controller.execute(command).then(accepted => { if (accepted) latest.current.close() }) }, input.page)
        }
        const { scope, text } = parseQuery(input.query)
        if (input.open && !input.disabled && !isDesktopQuitting() && input.page.kind === 'root' && scope !== 'agents' && input.onServers) {
            const capturedScope = input.scope
            const servers = searchItems([{ id: 'command-servers', label: 'Servers', keywords: ['machine', 'computer', 'remote', 'connection'], leading: { kind: 'icon' as const, icon: ServerIcon }, onSelect: () => {
                if (!latest.current.open || latest.current.disabled || latest.current.scope !== capturedScope || isDesktopQuitting()) return
                latest.current.onServers?.(); latest.current.close()
            } }], text)
            if (servers.length) additions.push({ id: 'settings', heading: 'Settings', rows: servers })
        }
        return mergeParitySections(sections, additions, input.query)
    } }
}
