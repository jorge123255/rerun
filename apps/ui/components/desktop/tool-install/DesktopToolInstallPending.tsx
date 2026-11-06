'use client'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { isToolUIPart, getToolName, type UIMessage } from 'ai'
import { stripBridgePrefix } from '@rerun/contracts'
import { desktopToolInstallReferenceOf, desktopToolInstallReferenceSchema, type DesktopToolInstallReference } from '@/lib/desktop/tool-install-reference'
import { readDesktopToolInstallBody } from '@/lib/desktop/tool-install-client'
import { DesktopToolInstallCard } from './DesktopToolInstallCard'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
const responseSchema = z.strictObject({ installations: z.array(desktopToolInstallReferenceSchema).max(24), more: z.boolean() })
export function DesktopToolInstallPending(props: { agentId: string; sessionId: string; messages: UIMessage[]; active: boolean; disabled?: boolean }) {
    return <Pending key={JSON.stringify([props.agentId, props.sessionId])} {...props} />
}
function Pending({ agentId, sessionId, messages, active, disabled }: { agentId: string; sessionId: string; messages: UIMessage[]; active: boolean; disabled?: boolean }) {
    const [rows, setRows] = useState<DesktopToolInstallReference[]>([]), [error, setError] = useState(''), [more, setMore] = useState(false)
    const shown = new Set(messages.flatMap(message => message.parts.flatMap(part => {
        if (!isToolUIPart(part) || stripBridgePrefix(getToolName(part)) !== 'tool_install' || part.state !== 'output-available') return []
        const ref = desktopToolInstallReferenceOf(part.output)
        return ref && ref.agentId === agentId && ref.sessionId === sessionId && ref.toolCallId === part.toolCallId ? [ref.operationId] : []
    })))
    useEffect(() => {
        if (!active) return
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        async function load() {
            if (controller.signal.aborted) return
            try {
                if (!isDesktopQuitting()) {
                    const response = await fetch(`/api/desktop/sessions/${encodeURIComponent(sessionId)}/tool-install?pending=1`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
                    // The endpoint returns only at most 24 fixed-size opaque references.
                    const raw = await readDesktopToolInstallBody(response, controller.signal, 24000)
                    if (!response.ok) throw new Error('Pending installations could not be checked.')
                    const body = responseSchema.parse(raw)
                    if (body.installations.some(row => row.agentId !== agentId || row.sessionId !== sessionId)) throw new Error('Installation conversation changed.')
                    if (!controller.signal.aborted) { setRows(body.installations); setMore(body.more); setError('') }
                }
            } catch { if (!controller.signal.aborted) setError('Pending installations could not be checked.') }
            if (!controller.signal.aborted) timer = setTimeout(() => void load(), 3000)
        }
        void load()
        return () => { controller.abort(); if (timer) clearTimeout(timer) }
    }, [active, agentId, sessionId])
    return <>{rows.filter(row => !shown.has(row.operationId)).map(row => <DesktopToolInstallCard key={row.operationId} sessionId={sessionId} operationId={row.operationId} active={active} disabled={disabled} />)}{more && <p className="text-xs text-muted-foreground">More installations remain. Review these to reveal the next requests.</p>}{error && <p className="text-xs text-muted-foreground" role="status">{error}</p>}</>
}
