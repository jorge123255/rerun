'use client'

import type { ReactNode } from 'react'
import { FilesImportMenu } from './menu'
import { FilesImportTray } from './tray'
import { useFilesImportQueue, type FilesImportControllerOptions } from './hook'

type FilesImportSurfaceProps = FilesImportControllerOptions & {
    children: ReactNode
}

/**
 * Drop target, multi-file/folder menu, and progress tray for coworker Files.
 * Root mounts this in place of the single `.txt`/`.md` import control.
 */
export function FilesImportSurface({ children, ...options }: FilesImportSurfaceProps) {
    const imports = useFilesImportQueue(options)
    return (
        <div className="relative flex min-h-0 flex-1 flex-col" onDragOver={imports.onDragOver} onDragLeave={imports.onDragLeave} onDrop={imports.onDrop}>
            {imports.dragOver && (
                <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/50 bg-primary/5">
                    <p className="text-sm font-medium text-primary">Drop files or folders to import</p>
                </div>
            )}
            <div className="flex items-center justify-end gap-1 px-3 py-2">
                <FilesImportMenu onPick={imports.enqueueEntries} disabled={options.disabled} />
            </div>
            {children}
            <FilesImportTray items={imports.items} onCancel={imports.cancel} onRetry={imports.retry} onDismiss={imports.dismiss} />
        </div>
    )
}
