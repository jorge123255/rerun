'use client'

import { entriesFromDataTransfer, type UploadEntry } from '@/lib/files/upload'
import { useEffect, useMemo, useRef, useState } from 'react'
import { filesImportEntries } from './entries'
import { FILES_IMPORT_RELOAD_MS, filesImportShouldReload, filesImportTotalProgress, FilesImportQueue } from './queue'
import type { FilesImportItem, FilesImportWriter } from './types'

export type FilesImportControllerOptions = {
    rootDir: string
    write: FilesImportWriter
    disabled?: boolean
    onRejected?: (message: string) => void
    onFileSaved?: (item: FilesImportItem) => void
}

/**
 * Panel wiring for coworker Files. Chat keeps `useFileUploads`.
 * A confirmed save in the open folder reloads that folder once, after 500ms.
 */
export function useFilesImportQueue({ rootDir, write, disabled = false, onRejected, onFileSaved }: FilesImportControllerOptions) {
    const writeRef = useRef(write)
    const rootRef = useRef(rootDir)
    const disabledRef = useRef(disabled)
    const rejectedRef = useRef(onRejected)
    const savedRef = useRef(onFileSaved)
    const queueRef = useRef<FilesImportQueue | null>(null)
    const [items, setItems] = useState<FilesImportItem[]>([])
    const [dragOver, setDragOver] = useState(false)

    useEffect(() => {
        writeRef.current = write
        rootRef.current = rootDir
        disabledRef.current = disabled
        rejectedRef.current = onRejected
        savedRef.current = onFileSaved
    })

    useEffect(() => {
        let mounted = true
        let reloadTimer: ReturnType<typeof setTimeout> | undefined
        const queue = new FilesImportQueue({
            write: request => writeRef.current(request),
            onChange: items => { if (mounted) setItems(items) },
            onRejected: message => rejectedRef.current?.(message),
            onFileSaved: item => {
                if (!mounted || !filesImportShouldReload(rootRef.current, item)) return
                if (reloadTimer) clearTimeout(reloadTimer)
                reloadTimer = setTimeout(() => {
                    reloadTimer = undefined
                    if (rootRef.current === item.dir) savedRef.current?.(item)
                }, FILES_IMPORT_RELOAD_MS)
            },
        })
        queueRef.current = queue
        return () => {
            mounted = false
            queueRef.current = null
            if (reloadTimer) clearTimeout(reloadTimer)
            queue.cancelAll()
        }
    }, [])

    const active = items.some(item => item.status === 'queued' || item.status === 'uploading' || item.status === 'finishing')
    const totalProgress = useMemo(() => filesImportTotalProgress(items), [items])

    const enqueueEntries = (entries: UploadEntry[]) => {
        const queue = queueRef.current
        if (!queue || disabledRef.current || entries.length === 0) return []
        return queue.enqueue(filesImportEntries(entries), rootRef.current)
    }

    const onDragOver = (event: React.DragEvent) => {
        if (disabledRef.current || !event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragOver(true)
    }

    const onDragLeave = (event: React.DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragOver(false)
    }

    const onDrop = (event: React.DragEvent) => {
        event.preventDefault()
        setDragOver(false)
        const queue = queueRef.current
        if (!queue || disabledRef.current || !event.dataTransfer.types.includes('Files')) return
        const dropDir = rootRef.current
        void entriesFromDataTransfer(event.dataTransfer).then(entries => {
            if (queueRef.current === queue && entries.length) queue.enqueue(filesImportEntries(entries), dropDir)
        })
    }

    const dismiss = () => {
        if (active) queueRef.current?.cancelAll()
        else queueRef.current?.clearSettled()
    }

    return {
        items,
        active,
        totalProgress,
        dragOver,
        enqueueEntries,
        onDragOver,
        onDragLeave,
        onDrop,
        cancel: (id: string) => queueRef.current?.cancel(id),
        retry: (id: string) => queueRef.current?.retry(id),
        dismiss,
        receipt: () => queueRef.current?.receipt() ?? { items: [], savedCount: 0, failedCount: 0, active: false },
    }
}
