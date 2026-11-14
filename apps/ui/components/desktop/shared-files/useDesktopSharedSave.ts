'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'

type SaveSharedFile = (request: { workspaceId: number; path: string; version: string; identity?: string }) => Promise<boolean>

export function useDesktopSharedSave(workspaceId: number | null | undefined, scope: string) {
    const owner = useMemo(() => ({ workspaceId, scope }), [workspaceId, scope])
    const pending = useRef<symbol | null>(null)
    const [status, setStatus] = useState<{ owner: typeof owner; saving: boolean; savedName?: string } | null>(null)
    const visible = status?.owner === owner ? status : null
    const bridge = typeof window === 'undefined' ? undefined
        : (window as Window & { desktopApp?: { saveSharedFile?: SaveSharedFile } }).desktopApp?.saveSharedFile

    useEffect(() => () => { pending.current = null }, [owner])

    const save = async (path: string, version?: string, identity?: string) => {
        if (!workspaceId || !bridge || !version || pending.current || isDesktopQuitting()) return
        const token = Symbol()
        pending.current = token
        setStatus({ owner, saving: true })
        try {
            if (await bridge({ workspaceId, path, version, ...(identity && { identity }) }) && pending.current === token) {
                setStatus({ owner, saving: false, savedName: path.split('/').at(-1) })
            }
        } catch (error) {
            if (pending.current === token) toast.error(error instanceof Error
                ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
                : 'The shared file could not be saved.')
        } finally {
            if (pending.current === token) {
                pending.current = null
                setStatus(current => current?.owner === owner && current.saving ? null : current)
            }
        }
    }
    return { available: !!workspaceId && !!bridge, saving: visible?.saving ?? false, savedName: visible?.savedName, save }
}
