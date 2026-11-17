import { useSyncExternalStore } from 'react'

// One file the viewer pages through. `url` is a hub file URL (read with the person's headers), a web
// address or a file on the phone; `name` is the title, and gives the kind of file unless `image` says.
export type ViewerItem = { url: string; name: string; image?: boolean }

type ViewerState = { items: ViewerItem[]; index: number } | null

let state: ViewerState = null
const listeners = new Set<() => void>()

function emit() {
    for (const listener of listeners) listener()
}

// The web's `AttachmentLightbox`, opened from anywhere in the thread: a bubble's photos, a file card,
// an image or a file link in an answer.
export function openViewer(items: ViewerItem[], index = 0) {
    if (items.length === 0) return
    state = { items, index: Math.max(0, Math.min(index, items.length - 1)) }
    emit()
}

export function closeViewer() {
    state = null
    emit()
}

export function useViewerState(): ViewerState {
    return useSyncExternalStore(
        listener => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        () => state
    )
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/i

export const isImageItem = (item: ViewerItem) => item.image ?? IMAGE.test(item.name.split(/[?#]/)[0])
