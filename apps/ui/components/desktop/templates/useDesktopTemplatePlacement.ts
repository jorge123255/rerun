'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GridPosition } from '@rerun/ui/iso-grid'
import { createDesktopTemplatesClient, type DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import { holdDraftAdmission, isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { desktopSpaceAt } from '../desktop-space-layout'
import type { DesktopTemplateDetail, DesktopTemplateInstallReceipt } from './types'

export type DesktopTemplatePlacement = {
    id: string
    template: DesktopTemplateDetail
    again: boolean
    positions: GridPosition[]
    spaceId?: string
    submitted: boolean
    saving: boolean
    error?: string
}
export type DesktopBeginTemplatePlacement = (template: DesktopTemplateDetail, again: boolean) => void

/** The original board flow keeps each unsent drop visible and binds the whole team to its first Box. */
export function templatePlacementBoard(board: DesktopBoardState, placement: DesktopTemplatePlacement): DesktopBoardState {
    return { ...board, placements: [...board.placements, ...placement.positions.map((position, index) => ({
        agentId: `template-placement-${placement.id}-${index}`, spaceId: placement.spaceId!, ...position,
    }))] }
}

export function useDesktopTemplatePlacement(
    onInstalled: (receipt: DesktopTemplateInstallReceipt) => Promise<void>,
    createClient: () => DesktopTemplatesClient = createDesktopTemplatesClient,
) {
    const [placement, setPlacement] = useState<DesktopTemplatePlacement | null>(null)
    const current = useRef<DesktopTemplatePlacement | null>(null)
    const client = useRef<DesktopTemplatesClient | null>(null)
    const alive = useRef(false)
    const flight = useRef(false)
    const result = useRef<DesktopTemplateInstallReceipt | null>(null)
    const installed = useRef(onInstalled)
    installed.current = onInstalled
    const publish = useCallback((next: DesktopTemplatePlacement | null) => {
        current.current = next
        if (alive.current) setPlacement(next)
    }, [])

    useEffect(() => {
        alive.current = true
        return () => { alive.current = false; client.current?.dispose(); client.current = null }
    }, [createClient])

    const begin = useCallback((template: DesktopTemplateDetail, again: boolean) => {
        if (!alive.current || current.current || flight.current || isDesktopQuitting() || !template.agents.length) return false
        // Each explicit placement owns its own client/Use-again rotation. A library recovery
        // may have finished the previous request while this hook was no longer presenting it.
        client.current?.dispose()
        client.current = createClient()
        result.current = null
        publish({ id: crypto.randomUUID(), template, again, positions: [], submitted: false, saving: false })
        return true
    }, [publish, createClient])

    const cancel = useCallback(() => {
        if (flight.current || current.current?.submitted) return
        publish(null)
    }, [publish])

    // Unknown acknowledgement returns to the same library receipt; it is never an implicit cancel.
    const review = useCallback(() => {
        if (flight.current || !current.current) return null
        const template = current.current.template
        publish(null)
        result.current = null
        return { templateId: template.templateId, revision: template.revision }
    }, [publish])

    const place = useCallback(async (anchor: GridPosition, board: DesktopBoardState) => {
        const draft = current.current, owner = client.current
        if (!draft || !owner || !alive.current || flight.current || isDesktopQuitting()) return
        let next = draft
        if (!draft.submitted) {
            let checked = { ...draft, positions: [] as GridPosition[] }
            // Revalidate earlier drops against the latest board before accepting the next one.
            for (const position of [...draft.positions, anchor]) {
                const destination = desktopSpaceAt(templatePlacementBoard(board, checked), position)
                if (!destination || checked.spaceId && destination.id !== checked.spaceId) {
                    publish({ ...draft, error: 'That spot is no longer available. Cancel and choose the placement again.' })
                    return
                }
                checked = { ...checked, spaceId: destination.id, positions: [...checked.positions, { ...position }] }
            }
            next = { ...checked, error: undefined }
            if (next.positions.length < next.template.agents.length) { publish(next); return }
        }
        // Every retry uses the complete, frozen target. The server also owns the exact admitted
        // request, including after a restart or a response lost before this client saw its ID.
        const fixed = { ...next, submitted: true, saving: true, error: undefined }
        flight.current = true
        publish(fixed)
        const release = holdDraftAdmission()
        try {
            result.current ??= await owner.install(fixed.template, {
                ...(fixed.again ? { again: true } : {}),
                target: { spaceId: fixed.spaceId!, positions: fixed.positions },
            })
            if (!alive.current || client.current !== owner) return
            if (isDesktopQuitting()) {
                publish({ ...fixed, saving: false, error: 'Installation is saved. Retry to reopen its coworkers after closing is cancelled.' })
                return
            }
            await installed.current(result.current)
            if (alive.current && client.current === owner) { publish(null); result.current = null }
        } catch (cause) {
            if (alive.current && client.current === owner) publish({ ...fixed, saving: false,
                error: cause instanceof Error ? cause.message : 'Could not confirm installation. Retry this same placement or review its saved status.' })
        } finally { flight.current = false; release() }
    }, [publish])

    return { placement, begin, cancel, review, place }
}
