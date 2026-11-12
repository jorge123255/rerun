'use client'

import { desktopWorkspaceRoutineMutationSchema, desktopWorkspaceRoutineMutationResultSchema, desktopWorkspaceRoutinesViewSchema, type DesktopWorkspaceRoutineMutation, type DesktopWorkspaceRoutineMutationResult, type DesktopWorkspaceRoutinesView } from '@rerun/contracts'

const url = '/api/desktop/workspace/routines'

export function createDesktopWorkspaceRoutinesClient() {
    return {
        async list(signal?: AbortSignal): Promise<DesktopWorkspaceRoutinesView> {
            const response = await fetch(url, { cache: 'no-store', signal })
            const body = await response.json().catch(() => null)
            if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Routines could not be loaded.')
            return desktopWorkspaceRoutinesViewSchema.parse(body)
        },
        async mutate(input: DesktopWorkspaceRoutineMutation, signal?: AbortSignal): Promise<DesktopWorkspaceRoutineMutationResult> {
            const response = await fetch(url, { method: 'POST', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(desktopWorkspaceRoutineMutationSchema.parse(input)) })
            const body = await response.json().catch(() => null)
            if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'The routine could not be changed.')
            return desktopWorkspaceRoutineMutationResultSchema.parse(body)
        },
    }
}

export type DesktopWorkspaceRoutinesClient = ReturnType<typeof createDesktopWorkspaceRoutinesClient>
