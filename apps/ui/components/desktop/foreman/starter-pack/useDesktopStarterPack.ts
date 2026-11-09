'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createDesktopTemplatesClient, type DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import type { DesktopTemplateSummary } from '@/components/desktop/templates/types'
import { availableStarterTemplates } from './starter-pack'

type StarterPackState = { templates: DesktopTemplateSummary[]; loading: boolean; error: string | null }

/**
 * The workspace's own templates, read through the authenticated local template client. Nothing is
 * fetched from a hosted library and nothing is installed here: this only answers what the rail may
 * offer.
 *
 * A result that arrives after the workspace changed, after the panel closed, or after a retry is
 * dropped rather than painted over the newer list: the cards one workspace owns are never shown as
 * another's.
 */
export function useDesktopStarterPack({ workspaceId, active, client }: {
    workspaceId: string
    active: boolean
    /** Injected in tests; the panel owns the real client lifetime. */
    client?: DesktopTemplatesClient
}) {
    const [state, setState] = useState<StarterPackState>({ templates: [], loading: true, error: null })
    const [attempt, setAttempt] = useState(0)
    const generation = useRef(0)

    useEffect(() => {
        if (!active) return
        const own = client ?? createDesktopTemplatesClient()
        const run = ++generation.current
        setState({ templates: [], loading: true, error: null })
        void own.list()
            .then(list => {
                if (run !== generation.current) return
                setState({ templates: availableStarterTemplates(list), loading: false, error: null })
            })
            .catch(error => {
                if (run !== generation.current) return
                setState({ templates: [], loading: false, error: error instanceof Error && error.message ? error.message : 'Could not read the templates of this workspace.' })
            })
        return () => {
            generation.current += 1
            if (!client) own.dispose()
        }
    }, [workspaceId, active, attempt, client])

    const reload = useCallback(() => setAttempt(value => value + 1), [])

    return { ...state, reload }
}
