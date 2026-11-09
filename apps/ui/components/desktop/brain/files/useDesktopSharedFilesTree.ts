'use client'

import type { FileEntry } from '@/app/api/_actions/workspace-file.actions'
import { joinPath, type SharedFilesTree } from '@/components/brain/useSharedFilesTree'
import { sortFileEntries } from '@/components/files/sort-file-entries'
import { listDesktopSharedFolder, type DesktopSharedEntry } from '@/lib/desktop/shared-workspace-files'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type DesktopSharedFilesTree = SharedFilesTree & {
    truncatedOf: (dir: string) => boolean
}

const toEntry = (entry: DesktopSharedEntry): FileEntry => ({ name: entry.name, type: entry.type, size: entry.size, modified: entry.modified })

/**
 * The shared-folder tree the Brain sidebar and the folder page both read.
 * Listing is the desktop folder API. Admission stays in `importDesktopSharedFile`, which the
 * panel calls on upload, so a change there shows up here without a second store.
 */
export function useDesktopSharedFilesTree(): DesktopSharedFilesTree {
    const [listings, setListings] = useState<Record<string, FileEntry[]>>({})
    const [truncated, setTruncated] = useState<Record<string, boolean>>({})
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
    const requested = useRef(new Set<string>())

    const refresh = useCallback(async (dir: string) => {
        requested.current.add(dir)
        try {
            const listing = await listDesktopSharedFolder(dir)
            setListings(current => ({ ...current, [dir]: sortFileEntries(listing.entries.map(toEntry)) }))
            setTruncated(current => ({ ...current, [dir]: listing.truncated }))
        } catch {
            setListings(current => ({ ...current, [dir]: [] }))
            setTruncated(current => ({ ...current, [dir]: false }))
        }
    }, [])

    const load = useCallback((dir: string) => {
        if (requested.current.has(dir)) return
        void refresh(dir)
    }, [refresh])

    useEffect(() => { load('') }, [load])

    const expand = useCallback((dir: string) => {
        const parts = dir.split('/').filter(Boolean)
        const chain = parts.map((_, index) => parts.slice(0, index + 1).join('/'))
        for (const path of ['', ...chain]) load(path)
        setExpanded(current => new Set([...current, ...chain]))
    }, [load])

    const toggle = useCallback((dir: string) => {
        load(dir)
        setExpanded(current => {
            const next = new Set(current)
            if (next.has(dir)) next.delete(dir)
            else next.add(dir)
            return next
        })
    }, [load])

    const entriesOf = useCallback((dir: string) => listings[dir], [listings])
    const truncatedOf = useCallback((dir: string) => truncated[dir] ?? false, [truncated])
    const knownFiles = useMemo(() => Object.entries(listings).flatMap(([dir, entries]) => entries.filter(entry => entry.type !== 'dir').map(entry => ({ path: joinPath(dir, entry.name), name: entry.name }))), [listings])

    return { entriesOf, expanded, toggle, expand, refresh, knownFiles, truncatedOf }
}
