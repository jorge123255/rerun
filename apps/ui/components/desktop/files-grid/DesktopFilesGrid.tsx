'use client'

// Coworker Files grid. Layout and glyphs follow apps/ui/components/files/FileGrid.tsx,
// FileTile.tsx, FileThumbnail.tsx, and FileGlyph.tsx from 2a57fa6dd53311f763bfc9abde85997b7f7e5309.
// Open, preview, rename, delete, and refusal stay on DesktopCoworkerFiles.

import { FileSheetGlyph, FolderGlyph, GLYPH_INK_MUTED } from '@/components/files/FileGlyph'
import { sortFileEntries } from '@/components/files/sort-file-entries'
import { formatBytes } from '@/lib/files/format'
import { filePreviewKind, fileTypeIcon } from '@/lib/files/preview'
import { ChevronUpIcon, type LucideIcon } from '@/lib/icons'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
    DESKTOP_FILES_EMPTY_LABEL,
    desktopFilesChildPath,
    desktopFilesExtensionBadge,
    desktopFilesImageThumbUrl,
    desktopFilesWantsTextThumb,
    isReservedDesktopFilesName,
    type DesktopFilesGridEntry,
} from './model'

export type { DesktopFilesGridEntry } from './model'

export type DesktopFilesGridProps = {
    entries: readonly DesktopFilesGridEntry[]
    currentPath: string
    /** `/api/desktop/agents/:id/files`. Image thumbs use this route and no other host. */
    filesBase: string
    selectedName?: string | null
    renamingName?: string | null
    pending?: boolean
    /** Missing key: not loaded. Empty string: the read refused or had no text. */
    textHeads?: Readonly<Record<string, string>>
    onRequestText?: (path: string) => void
    onOpenFile: (name: string) => void
    onOpenDir: (name: string) => void
    onGoUp?: () => void
    onContextMenu?: (name: string) => void
    onClearMenu?: () => void
    renderRename?: (name: string) => ReactNode
}

const TILE = 'group flex w-full cursor-default select-none flex-col items-center gap-1.5 rounded-md border border-transparent p-2 text-left outline-none transition-colors hover:border-border/70 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none'

function useGridVisible(ref: { current: HTMLElement | null }) {
    const [visible, setVisible] = useState(false)
    useEffect(() => {
        const el = ref.current
        if (!el || visible || typeof IntersectionObserver === 'undefined') return
        const observer = new IntersectionObserver(
            observed => {
                if (observed.some(entry => entry.isIntersecting)) setVisible(true)
            },
            { rootMargin: '200px' }
        )
        observer.observe(el)
        return () => observer.disconnect()
    }, [ref, visible])
    return visible
}

function SheetIcon({ icon: Glyph }: { icon: LucideIcon }) {
    return <Glyph className="absolute left-[24.5px] top-[26px] size-4" style={{ color: GLYPH_INK_MUTED }} data-files-type-icon="" />
}

function DesktopImageThumb({ src, alt, onFail }: { src: string; alt: string; onFail: () => void }) {
    return (
        <div data-files-thumb="image" className="relative size-16 overflow-hidden rounded-[5px]" style={{ backgroundColor: 'var(--iso-tile-idle)', boxShadow: 'inset 0 0 0 1px rgb(var(--iso-tile-idle-ink) / 0.22)' }}>
            {/* Same frame as FileGlyph ImageGlyph. A decode or route failure drops the thumb once. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={alt} loading="lazy" decoding="async" className="size-full object-cover" onError={onFail} />
        </div>
    )
}

function DesktopFileThumb({ entry, path, imageUrl, textHead, onRequestText, onImageFail }: {
    entry: DesktopFilesGridEntry
    path: string
    imageUrl: string | null
    textHead: string | undefined
    onRequestText?: (path: string) => void
    onImageFail?: () => void
}) {
    const ref = useRef<HTMLDivElement>(null)
    const visible = useGridVisible(ref)
    const wantsText = desktopFilesWantsTextThumb(entry)
    useEffect(() => {
        if (visible && wantsText && textHead === undefined) onRequestText?.(path)
    }, [visible, wantsText, textHead, path, onRequestText])

    if (entry.type === 'dir') {
        return <div ref={ref} data-files-thumb="folder" data-files-kind="dir"><FolderGlyph /></div>
    }

    if (imageUrl) {
        return (
            <div ref={ref} data-files-kind={filePreviewKind(entry.name)}>
                <DesktopImageThumb src={imageUrl} alt={entry.name} onFail={() => onImageFail?.()} />
            </div>
        )
    }

    const head = textHead && textHead.length > 0 ? textHead : undefined
    const glyph = fileTypeIcon(entry.name)
    return (
        <div ref={ref} data-files-thumb={head ? 'text' : 'glyph'} data-files-kind={filePreviewKind(entry.name)}>
            <FileSheetGlyph badge={head ? undefined : desktopFilesExtensionBadge(entry.name)}>
                {head ? (
                    <pre className="absolute left-[19px] top-[22px] h-[29px] w-[27px] overflow-hidden text-[4px] leading-[5.5px] font-mono whitespace-pre" style={{ color: GLYPH_INK_MUTED }}>
                        {head}
                    </pre>
                ) : (
                    glyph && <SheetIcon icon={glyph} />
                )}
            </FileSheetGlyph>
        </div>
    )
}

export function DesktopFilesGrid({
    entries,
    currentPath,
    filesBase,
    selectedName = null,
    renamingName = null,
    pending = false,
    textHeads = {},
    onRequestText,
    onOpenFile,
    onOpenDir,
    onGoUp,
    onContextMenu,
    onClearMenu,
    renderRename,
}: DesktopFilesGridProps) {
    const shown = useMemo(() => sortFileEntries(entries.filter(entry => !isReservedDesktopFilesName(entry.name))), [entries])
    const [failed, setFailed] = useState<{ folder: string; urls: ReadonlySet<string> }>({ folder: currentPath, urls: new Set() })
    if (failed.folder !== currentPath) setFailed({ folder: currentPath, urls: new Set() })
    const failedUrls = failed.folder === currentPath ? failed.urls : new Set<string>()

    const failImage = (url: string) => {
        setFailed(prev => {
            if (prev.folder === currentPath && prev.urls.has(url)) return prev
            const urls = new Set(prev.folder === currentPath ? prev.urls : [])
            urls.add(url)
            return { folder: currentPath, urls }
        })
    }

    return (
        <div data-testid="desktop-files-grid" className="grid content-start gap-1 p-3 [grid-template-columns:repeat(auto-fill,minmax(84px,1fr))]">
            {onGoUp && (
                <button
                    type="button"
                    title="Parent directory"
                    aria-label=".."
                    disabled={pending}
                    onClick={onGoUp}
                    onContextMenu={event => { event.preventDefault(); onClearMenu?.() }}
                    className={TILE}
                >
                    <FolderGlyph>
                        <ChevronUpIcon className="absolute left-1/2 top-[27px] size-5 -translate-x-1/2" style={{ color: GLYPH_INK_MUTED }} />
                    </FolderGlyph>
                    <span className="line-clamp-2 max-w-full rounded px-1 text-center text-xs leading-tight break-all">..</span>
                </button>
            )}
            {shown.map(entry => {
                const path = desktopFilesChildPath(currentPath, entry.name)
                const imageUrl = desktopFilesImageThumbUrl(filesBase, path, entry.identity, entry.size, entry.modifiedAt)
                const shownImage = imageUrl && !failedUrls.has(imageUrl) ? imageUrl : null
                const selected = selectedName === entry.name
                const thumb = (
                    <DesktopFileThumb
                        entry={entry}
                        path={path}
                        imageUrl={shownImage}
                        textHead={textHeads[path]}
                        onRequestText={onRequestText}
                        onImageFail={shownImage ? () => failImage(shownImage) : undefined}
                    />
                )
                if (renamingName === entry.name) {
                    return (
                        <div key={entry.name} data-files-name={entry.name} className={`${TILE} cursor-default`}>
                            {thumb}
                            {renderRename ? renderRename(entry.name) : <span className="line-clamp-2 max-w-full rounded px-1 text-center text-xs leading-tight break-all">{entry.name}</span>}
                        </div>
                    )
                }
                return (
                    <button
                        key={entry.name}
                        type="button"
                        data-files-name={entry.name}
                        title={entry.type === 'dir' ? entry.name : `${entry.name} — ${formatBytes(entry.size)}`}
                        aria-label={entry.name}
                        aria-selected={selected}
                        disabled={pending}
                        onClick={() => {
                            if (pending) return
                            if (entry.type === 'dir') onOpenDir(entry.name)
                            else onOpenFile(entry.name)
                        }}
                        onContextMenu={() => onContextMenu?.(entry.name)}
                        className={`${TILE}${selected ? ' border-border/70 bg-accent/60' : ''}`}
                    >
                        {thumb}
                        <span className="line-clamp-2 max-w-full rounded px-1 text-center text-xs leading-tight break-all">{entry.name}</span>
                    </button>
                )
            })}
            {shown.length === 0 && <p className="col-span-full px-2 py-6 text-center text-sm text-muted-foreground">{DESKTOP_FILES_EMPTY_LABEL}</p>}
        </div>
    )
}
