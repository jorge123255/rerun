'use client'

import { AttachmentTile } from '@/components/chat/AttachmentTile'
import { MEDIA_CELL_ASPECT } from '@/components/chat/ChatVideoTile'
import { CARD_MAX_IMAGE_TOTAL_BYTES, type FileCard, type FileCardEntry } from '@rerun/contracts'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DesktopCardVideoFrame, DesktopCardVideoTile } from './DesktopCardVideoTile'
import { DesktopFileLightbox } from './DesktopFileLightbox'
import { DesktopCardError, isDesktopCardImage, isDesktopCardVideo, readDesktopCardImage, readDesktopCardVideo } from '@/lib/desktop/file-card'

type MediaKind = 'image' | 'video'
type MediaLoad = { status: 'loading' } | { status: 'ready'; src: string } | { status: 'error'; message: string }
type MediaState = { key: string; items: ReadonlyMap<number, MediaLoad> }
type MediaItem = { index: number; file: FileCardEntry; kind: MediaKind }
type LoadedMediaItem = MediaItem & { load: MediaLoad }

const EMPTY_MEDIA: ReadonlyMap<number, MediaLoad> = new Map()
const MAX_ALBUM_TILES = 4
const MEDIA_BUDGET_MESSAGE = 'This card’s images and videos exceed the 24 MB preview budget.'

function mediaItems(files: readonly FileCardEntry[]): MediaItem[] {
    return files.flatMap((file, index) => {
        const kind: MediaKind | null = isDesktopCardImage(file.path) ? 'image' : isDesktopCardVideo(file.path) ? 'video' : null
        return kind ? [{ index, file, kind }] : []
    })
}

function mediaMessage(error: unknown, kind: MediaKind): string {
    if (error instanceof DesktopCardError) return error.message
    return kind === 'video' ? 'This video can’t be played.' : 'This image can’t be displayed.'
}

function MediaPlaceholder({ shape = 'cell', kind, status, message }: {
    shape?: 'cell' | 'wide' | 'natural'
    kind: MediaKind
    status: 'loading' | 'error'
    message?: string
}) {
    return (
        <span className={cn(
            'grid place-items-center overflow-hidden rounded-2xl bg-muted px-2 text-center text-xs',
            shape === 'natural' ? 'h-60 w-64 max-w-full' : cn('w-full', MEDIA_CELL_ASPECT[shape]),
            status === 'error' ? 'text-destructive' : 'text-muted-foreground',
        )}>
            {status === 'error'
                ? message ?? (kind === 'video' ? 'This video can’t be played' : 'This image can’t be displayed')
                : kind === 'video' ? 'Loading video…' : 'Loading image…'}
        </span>
    )
}

function DesktopMediaTile({ item, shape, onOpen, onError }: {
    item: LoadedMediaItem
    shape: 'natural' | 'cell' | 'wide'
    onOpen: () => void
    onError: (index: number, src: string) => void
}) {
    const { file, index, kind } = item
    const load = item.load
    if (load.status === 'ready') {
        if (kind === 'video') return <DesktopCardVideoTile src={load.src} name={file.name} shape={shape} onOpen={onOpen} onError={() => onError(index, load.src)} />
        const natural = shape === 'natural'
        return (
            <button
                type="button"
                onClick={onOpen}
                title={file.name}
                aria-label={`Open ${file.name}`}
                className={cn('overflow-hidden rounded-2xl bg-muted transition-opacity hover:opacity-90', natural ? 'max-h-72 max-w-full' : cn('w-full', MEDIA_CELL_ASPECT[shape]))}
            >
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated bytes as a released object URL */}
                <img src={load.src} alt={file.name} loading="lazy" decoding="async"
                    onError={() => onError(index, load.src)}
                    className={natural ? 'max-h-72 max-w-full object-contain' : 'size-full object-cover'} />
            </button>
        )
    }
    return (
        <button type="button" onClick={onOpen} title={file.name} aria-label={`Open ${file.name}`} className={cn('block text-left', shape === 'natural' ? 'max-w-full' : 'w-full')}>
            <MediaPlaceholder shape={shape === 'natural' ? 'natural' : shape} kind={kind} status={load.status} message={load.status === 'error' ? load.message : undefined} />
        </button>
    )
}

function DesktopMixedImageTile({ item, disabled, onOpen, onError }: {
    item: LoadedMediaItem
    disabled: boolean
    onOpen: () => void
    onError: (index: number, src: string) => void
}) {
    const { file, index } = item
    const load = item.load
    const frame = 'relative overflow-hidden rounded-2xl bg-muted transition-opacity disabled:cursor-default enabled:hover:opacity-90 size-28'
    if (load.status === 'ready') {
        return (
            <button type="button" onClick={onOpen} disabled={disabled} title={file.name} aria-label={`Open ${file.name}`} className={frame}>
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated bytes as a released object URL */}
                <img src={load.src} alt={file.name} loading="lazy" decoding="async"
                    onError={() => onError(index, load.src)}
                    className="size-full object-cover" />
            </button>
        )
    }
    return (
        <button type="button" onClick={onOpen} disabled={disabled} title={load.status === 'error' && load.message ? `${file.name} — ${load.message}` : file.name} aria-label={`Open ${file.name}`} className={cn(frame, 'grid place-items-center p-1.5 text-center')}>
            <span className={load.status === 'error' ? 'text-[10px] leading-tight text-destructive' : 'text-[10px] leading-tight text-muted-foreground'}>
                {load.status === 'error' ? 'Image unavailable' : 'Loading…'}
            </span>
        </button>
    )
}

function DesktopMixedVideoTile({ item, disabled, onOpen, onError }: {
    item: LoadedMediaItem
    disabled: boolean
    onOpen: () => void
    onError: (index: number, src: string) => void
}) {
    const { file, index } = item
    const load = item.load
    if (load.status === 'ready') {
        return <DesktopCardVideoFrame src={load.src} name={file.name} disabled={disabled} onOpen={onOpen} onError={() => onError(index, load.src)} />
    }
    const failed = load.status === 'error'
    return (
        <button
            type="button"
            onClick={onOpen}
            disabled={disabled}
            title={failed ? `${file.name} — ${load.message}` : file.name}
            aria-label={`Open ${file.name}`}
            className="relative size-28 overflow-hidden rounded-2xl bg-muted p-1.5 text-center transition-opacity disabled:cursor-default enabled:hover:opacity-90"
        >
            <span className={cn('grid size-full place-items-center text-[10px] leading-tight', failed ? 'text-destructive' : 'text-muted-foreground')}>
                {failed ? 'Video unavailable' : 'Loading…'}
            </span>
        </button>
    )
}

function DesktopMediaAlbum({ items, onOpen, onError }: {
    items: readonly LoadedMediaItem[]
    onOpen: (index: number) => void
    onError: (index: number, src: string) => void
}) {
    if (items.length === 1) {
        const only = items[0]!
        return (
            <figure className="flex min-w-0 flex-col items-start gap-1">
                <DesktopMediaTile item={only} shape="natural" onOpen={() => onOpen(only.index)} onError={onError} />
                <figcaption className="max-w-full truncate px-1 text-[11px] text-muted-foreground">{only.file.name}</figcaption>
            </figure>
        )
    }

    const shown = items.slice(0, MAX_ALBUM_TILES)
    const hidden = items.length - shown.length
    return (
        <div className="grid w-full max-w-md grid-cols-2 gap-1.5">
            {shown.map((item, index) => {
                const wide = shown.length === 3 && index === 0
                return (
                    <figure key={`${item.index}:${item.file.path}`} className={cn('relative flex min-w-0 flex-col gap-1', wide && 'col-span-2')}>
                        <DesktopMediaTile item={item} shape={wide ? 'wide' : 'cell'} onOpen={() => onOpen(item.index)} onError={onError} />
                        {hidden > 0 && index === shown.length - 1 && (
                            <button
                                type="button"
                                onClick={() => onOpen(item.index)}
                                aria-label={`Open ${hidden} more`}
                                className={cn('absolute inset-x-0 top-0 grid place-items-center rounded-2xl bg-black/55 text-2xl font-medium text-white', MEDIA_CELL_ASPECT.cell)}
                            >
                                +{hidden}
                            </button>
                        )}
                        <figcaption className="truncate px-1 text-[11px] text-muted-foreground">{item.file.name}</figcaption>
                    </figure>
                )
            })}
        </div>
    )
}

/**
 * A recorded card_file result on the Mac. Text and PDF keep the original document glyph. A PDF is
 * never an album entry and is fetched only when its lightbox opens. Images and
 * MP4 videos use the original single-item album, two-column album and captions; mixed cards keep the
 * original flex row of square tiles. Audio keeps the original square waveform tile and is fetched
 * only when its lightbox opens. Media bytes come only from this conversation's authenticated routes,
 * one released object URL per tile, with replaced, deleted and invalid files shown explicitly. Only
 * the visible album previews are fetched; the hidden ones are fetched by the paged lightbox.
 */
export function DesktopFileCard({ agentId, card }: { agentId?: string; card: FileCard }) {
    const [openIndex, setOpenIndex] = useState<number | null>(null)
    const files = card.files
    const media = mediaItems(files)
    const allMedia = files.length > 0 && media.length === files.length
    // The album shows at most four tiles; the hidden ones are fetched by the paged lightbox when
    // the user reaches them. Mixed cards show every image and video, so they all get thumbnails.
    const thumbnails = allMedia ? media.slice(0, MAX_ALBUM_TILES) : media
    const mediaKey = `${agentId ?? ''}\u0000${thumbnails.map(({ index, file, kind }) => `${index}:${kind}:${file.path}:${file.identity ?? ''}`).join('\u0000')}`
    const mediaRef = useRef(thumbnails)
    const ownedUrls = useRef(new Map<number, string>())
    mediaRef.current = thumbnails
    const [state, setState] = useState<MediaState>({ key: '', items: EMPTY_MEDIA })

    useEffect(() => {
        const current = mediaRef.current
        if (!current.length) {
            setState({ key: mediaKey, items: EMPTY_MEDIA })
            return
        }
        const controller = new AbortController()
        let active = true
        const urls = new Map<number, string>()
        ownedUrls.current = urls
        const loadingItems = new Map<number, MediaLoad>()
        for (const { index } of current) loadingItems.set(index, { status: 'loading' })
        setState({ key: mediaKey, items: loadingItems })
        if (!agentId) {
            const unavailableItems = new Map<number, MediaLoad>()
            for (const { index } of current) unavailableItems.set(index, { status: 'error', message: 'This conversation has no workspace.' })
            setState({ key: mediaKey, items: unavailableItems })
            return () => controller.abort()
        }
        void (async () => {
            let total = 0
            let overBudget = false
            for (const { index, file, kind } of current) {
                if (!active) return
                if (overBudget || total >= CARD_MAX_IMAGE_TOTAL_BYTES) {
                    setState(previous => previous.key === mediaKey
                        ? { key: mediaKey, items: new Map(previous.items).set(index, { status: 'error' as const, message: MEDIA_BUDGET_MESSAGE }) }
                        : previous)
                    continue
                }
                try {
                    const { blob } = kind === 'video'
                        ? await readDesktopCardVideo(agentId, file.path, file.identity, controller.signal)
                        : await readDesktopCardImage(agentId, file.path, file.identity, controller.signal)
                    if (!active) return
                    if (total + blob.size > CARD_MAX_IMAGE_TOTAL_BYTES) {
                        overBudget = true
                        setState(previous => previous.key === mediaKey
                            ? { key: mediaKey, items: new Map(previous.items).set(index, { status: 'error' as const, message: MEDIA_BUDGET_MESSAGE }) }
                            : previous)
                        continue
                    }
                    total += blob.size
                    const src = URL.createObjectURL(blob)
                    urls.set(index, src)
                    setState(previous => previous.key === mediaKey
                        ? { key: mediaKey, items: new Map(previous.items).set(index, { status: 'ready' as const, src }) }
                        : previous)
                } catch (error) {
                    if (!active || controller.signal.aborted) return
                    setState(previous => previous.key === mediaKey
                        ? { key: mediaKey, items: new Map(previous.items).set(index, { status: 'error' as const, message: mediaMessage(error, kind) }) }
                        : previous)
                }
            }
        })()
        return () => {
            active = false
            controller.abort()
            for (const url of urls.values()) URL.revokeObjectURL(url)
            urls.clear()
        }
    }, [agentId, mediaKey])

    const visible = state.key === mediaKey ? state.items : EMPTY_MEDIA
    const loadOf = (index: number): MediaLoad => visible.get(index) ?? { status: 'loading' }
    const withLoad = (item: MediaItem): LoadedMediaItem => ({ ...item, load: loadOf(item.index) })

    const failMedia = useCallback((index: number, src: string) => {
        // The failing element may belong to a previous owner or card. Only release the exact
        // object URL still owned by this preview, and remove it so cleanup cannot release it twice.
        if (ownedUrls.current.get(index) !== src) return
        ownedUrls.current.delete(index)
        URL.revokeObjectURL(src)
        const item = media.find(candidate => candidate.index === index)
        setState(previous => {
            const load = previous.items.get(index)
            return previous.key === mediaKey && load?.status === 'ready' && load.src === src
                ? { key: mediaKey, items: new Map(previous.items).set(index, { status: 'error' as const, message: item?.kind === 'video' ? 'This video can’t be played.' : 'This image can’t be displayed.' }) }
                : previous
        })
    }, [media, mediaKey])

    const opened = openIndex === null ? null : files[openIndex]
    return <div data-file-card="true" className="min-w-0 w-full">
        {allMedia ? (
            <DesktopMediaAlbum items={media.map(withLoad)} onOpen={setOpenIndex} onError={failMedia} />
        ) : (
            <div className="flex flex-wrap gap-1.5">
                {files.map((file, index) => isDesktopCardImage(file.path) ? (
                    <DesktopMixedImageTile
                        key={`${index}:${file.path}`}
                        item={withLoad({ index, file, kind: 'image' })}
                        disabled={!agentId}
                        onOpen={() => setOpenIndex(index)}
                        onError={failMedia}
                    />
                ) : isDesktopCardVideo(file.path) ? (
                    <DesktopMixedVideoTile
                        key={`${index}:${file.path}`}
                        item={withLoad({ index, file, kind: 'video' })}
                        disabled={!agentId}
                        onOpen={() => setOpenIndex(index)}
                        onError={failMedia}
                    />
                ) : (
                    <AttachmentTile
                        key={`${index}:${file.path}`}
                        path={file.path}
                        label={file.name}
                        openable={!!agentId}
                        standalone={files.length === 1}
                        onOpen={() => setOpenIndex(index)}
                    />
                ))}
            </div>
        )}
        {opened && openIndex !== null && agentId && (
            <DesktopFileLightbox
                agentId={agentId}
                files={files}
                index={openIndex}
                onIndexChange={setOpenIndex}
                onClose={() => setOpenIndex(null)}
            />
        )}
    </div>
}
