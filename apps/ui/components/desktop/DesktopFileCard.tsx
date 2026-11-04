'use client'

import { AttachmentTile } from '@/components/chat/AttachmentTile'
import { MEDIA_CELL_ASPECT } from '@/components/chat/ChatVideoTile'
import { CARD_MAX_IMAGE_TOTAL_BYTES, type FileCard, type FileCardEntry } from '@rerun/contracts'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DesktopFileLightbox } from './DesktopFileLightbox'
import { DesktopCardError, isDesktopCardImage, readDesktopCardImage } from '@/lib/desktop/file-card'

type ImageLoad = { status: 'loading' } | { status: 'ready'; src: string } | { status: 'error'; message: string }
type ImageState = { key: string; items: ReadonlyMap<number, ImageLoad> }
type ImageItem = { index: number; file: FileCardEntry }
type LoadedImageItem = ImageItem & { load: ImageLoad }

const EMPTY_IMAGES: ReadonlyMap<number, ImageLoad> = new Map()
const MAX_ALBUM_TILES = 4

function imageItems(files: readonly FileCardEntry[]): ImageItem[] {
    return files.flatMap((file, index) => isDesktopCardImage(file.path) ? [{ index, file }] : [])
}

function imageMessage(error: unknown): string {
    return error instanceof DesktopCardError ? error.message : 'This image can’t be displayed.'
}

function ImagePlaceholder({ shape = 'cell', status, message }: { shape?: 'cell' | 'wide' | 'natural'; status: 'loading' | 'error'; message?: string }) {
    return (
        <span className={cn(
            'grid place-items-center overflow-hidden rounded-2xl bg-muted px-2 text-center text-xs',
            shape === 'natural' ? 'h-60 w-64 max-w-full' : cn('w-full', MEDIA_CELL_ASPECT[shape]),
            status === 'error' ? 'text-destructive' : 'text-muted-foreground',
        )}>
            {status === 'error' ? message ?? 'This image can’t be displayed' : 'Loading image…'}
        </span>
    )
}

function DesktopMediaTile({ item, shape, onOpen, onError }: {
    item: LoadedImageItem
    shape: 'natural' | 'cell' | 'wide'
    onOpen: () => void
    onError: (index: number, src: string) => void
}) {
    const { file, index } = item
    const load = item.load
    if (load.status === 'ready') {
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
            <ImagePlaceholder shape={shape === 'natural' ? 'natural' : shape} status={load.status} message={load.status === 'error' ? load.message : undefined} />
        </button>
    )
}

function DesktopImageTile({ item, disabled, onOpen, onError }: {
    item: LoadedImageItem
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

function DesktopMediaAlbum({ items, onOpen, onError }: {
    items: readonly LoadedImageItem[]
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
 * A recorded card_file result on the Mac. Text keeps the original tile and text preview. Images
 * use the original single-image album, multi-image grid and captions; mixed cards keep the original
 * flex row of square tiles. Image bytes come only from this conversation's authenticated image
 * route, one released object URL per tile, with replaced, deleted and invalid images shown explicitly.
 */
export function DesktopFileCard({ agentId, card }: { agentId?: string; card: FileCard }) {
    const [openIndex, setOpenIndex] = useState<number | null>(null)
    const files = card.files
    const images = imageItems(files)
    const allImages = files.length > 0 && images.length === files.length
    // The album shows at most four tiles; the hidden ones are fetched by the paged lightbox when
    // the user reaches them. Mixed cards show every image, so they all get thumbnails.
    const thumbnails = allImages ? images.slice(0, MAX_ALBUM_TILES) : images
    const imageKey = `${agentId ?? ''}\u0000${thumbnails.map(({ index, file }) => `${index}:${file.path}:${file.identity ?? ''}`).join('\u0000')}`
    const imagesRef = useRef(thumbnails)
    imagesRef.current = thumbnails
    const [state, setState] = useState<ImageState>({ key: '', items: EMPTY_IMAGES })

    useEffect(() => {
        const current = imagesRef.current
        if (!current.length) {
            setState({ key: imageKey, items: EMPTY_IMAGES })
            return
        }
        const controller = new AbortController()
        let active = true
        const urls = new Map<number, string>()
        const loadingItems = new Map<number, ImageLoad>()
        for (const { index } of current) loadingItems.set(index, { status: 'loading' })
        setState({ key: imageKey, items: loadingItems })
        if (!agentId) {
            const unavailableItems = new Map<number, ImageLoad>()
            for (const { index } of current) unavailableItems.set(index, { status: 'error', message: 'This conversation has no workspace.' })
            setState({ key: imageKey, items: unavailableItems })
            return () => controller.abort()
        }
        void (async () => {
            let total = 0
            let overBudget = false
            for (const { index, file } of current) {
                if (!active) return
                if (overBudget) {
                    setState(previous => previous.key === imageKey
                        ? { key: imageKey, items: new Map(previous.items).set(index, { status: 'error' as const, message: 'This card’s images exceed the 24 MB preview budget.' }) }
                        : previous)
                    continue
                }
                try {
                    const { blob } = await readDesktopCardImage(agentId, file.path, file.identity, controller.signal)
                    if (!active) return
                    if (total + blob.size > CARD_MAX_IMAGE_TOTAL_BYTES) {
                        overBudget = true
                        setState(previous => previous.key === imageKey
                            ? { key: imageKey, items: new Map(previous.items).set(index, { status: 'error' as const, message: 'This card’s images exceed the 24 MB preview budget.' }) }
                            : previous)
                        continue
                    }
                    total += blob.size
                    const src = URL.createObjectURL(blob)
                    urls.set(index, src)
                    setState(previous => previous.key === imageKey
                        ? { key: imageKey, items: new Map(previous.items).set(index, { status: 'ready' as const, src }) }
                        : previous)
                } catch (error) {
                    if (!active || controller.signal.aborted) return
                    setState(previous => previous.key === imageKey
                        ? { key: imageKey, items: new Map(previous.items).set(index, { status: 'error' as const, message: imageMessage(error) }) }
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
    }, [agentId, imageKey])

    const visible = state.key === imageKey ? state.items : EMPTY_IMAGES
    const loadOf = (index: number): ImageLoad => visible.get(index) ?? { status: 'loading' }
    const withLoad = (item: ImageItem): LoadedImageItem => ({ ...item, load: loadOf(item.index) })

    const failImage = useCallback((index: number, src: string) => {
        URL.revokeObjectURL(src)
        setState(previous => previous.key === imageKey
            ? { key: imageKey, items: new Map(previous.items).set(index, { status: 'error' as const, message: 'This image can’t be displayed.' }) }
            : previous)
    }, [imageKey])

    const opened = openIndex === null ? null : files[openIndex]
    return <div data-file-card="true">
        {allImages ? (
            <DesktopMediaAlbum items={images.map(withLoad)} onOpen={setOpenIndex} onError={failImage} />
        ) : (
            <div className="flex flex-wrap gap-1.5">
                {files.map((file, index) => isDesktopCardImage(file.path) ? (
                    <DesktopImageTile
                        key={`${index}:${file.path}`}
                        item={withLoad({ index, file })}
                        disabled={!agentId}
                        onOpen={() => setOpenIndex(index)}
                        onError={failImage}
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
