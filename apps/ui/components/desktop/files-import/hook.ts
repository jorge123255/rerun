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
    const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const mounted = useRef(false)
    const [items, setItems] = useState<FilesImportItem[]>([])
    const [dragOver, setDragOver] = useState(false)
    const queueRef = useRef<FilesImportQueue | null>(null)
    if (!queueRef.current) {
        queueRef.current = new FilesImportQueue({
            write: request => writeRef.current(request),
            onChange: items => { if (mounted.current) setItems(items) },
            onRejected: message => rejectedRef.current?.(message),
            onFileSaved: item => {
                if (!mounted.current || !filesImportShouldReload(rootRef.current, item)) return
                const dir = item.dir
                if (reloadTimer.current) clearTimeout(reloadTimer.current)
                reloadTimer.current = setTimeout(() => {
                    reloadTimer.current = null
                    if (rootRef.current === dir) savedRef.current?.(item)
                }, FILES_IMPORT_RELOAD_MS)
            },
        })
    }

    useEffect(() => {
        writeRef.current = write
        rootRef.current = rootDir
        disabledRef.current = disabled
        rejectedRef.current = onRejected
        savedRef.current = onFileSaved
    })

    const queue = queueRef.current
    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
            if (reloadTimer.current) clearTimeout(reloadTimer.current)
            reloadTimer.current = null
            queue.cancelAll()
        }
    }, [queue])

    const active = items.some(item => item.status === 'queued' || item.status === 'uploading' || item.status === 'finishing')
    const totalProgress = useMemo(() => filesImportTotalProgress(items), [items])

    const enqueueEntries = (entries: UploadEntry[]) => {
        if (!mounted.current || disabledRef.current || entries.length === 0) return []
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
        if (disabledRef.current || !event.dataTransfer.types.includes('Files')) return
        const dropDir = rootRef.current
        void entriesFromDataTransfer(event.dataTransfer).then(entries => {
            if (mounted.current && entries.length) queue.enqueue(filesImportEntries(entries), dropDir)
        })
    }

    const dismiss = () => {
        if (active) queue.cancelAll()
        else queue.clearSettled()
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
        cancel: (id: string) => queue.cancel(id),
        retry: (id: string) => queue.retry(id),
        dismiss,
        receipt: () => queue.receipt(),
    }
}
