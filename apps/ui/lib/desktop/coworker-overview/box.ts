import { UNNAMED_BOX_LABEL } from '@/lib/board/types'

export type DesktopOverviewBox = { id: string; name: string }

export type DesktopOverviewBoxLabel =
    | { status: 'named'; name: string }
    | { status: 'unnamed'; name: typeof UNNAMED_BOX_LABEL }
    | { status: 'unavailable'; name: 'Box unavailable' }

export function resolveDesktopOverviewBox(spaceId: string | undefined, boxes: readonly DesktopOverviewBox[] | null): DesktopOverviewBoxLabel {
    if (!boxes) return { status: 'unavailable', name: 'Box unavailable' }
    if (!spaceId) return { status: 'unavailable', name: 'Box unavailable' }
    const box = boxes.find(item => item.id === spaceId)
    if (!box) return { status: 'unavailable', name: 'Box unavailable' }
    const name = box.name.trim()
    if (!name) return { status: 'unnamed', name: UNNAMED_BOX_LABEL }
    return { status: 'named', name }
}
