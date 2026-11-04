'use client'

import { AttachmentTile } from '@/components/chat/AttachmentTile'
import { DesktopFileLightbox } from './DesktopFileLightbox'
import type { FileCard } from '@rerun/contracts'
import { useCallback, useState } from 'react'
import { readDesktopCardFile } from '@/lib/desktop/file-card'

/**
 * A recorded card_file result on the Mac. It reuses Rerun's file tile and preview dialog, but
 * without raw URLs or a download: this slice only opens this coworker's existing .txt/.md files
 * through the authenticated desktop Files route. A card is a path snapshot, not frozen bytes.
 */
export function DesktopFileCard({ agentId, card }: { agentId?: string; card: FileCard }) {
    const [openIndex, setOpenIndex] = useState<number | null>(null)
    const read = useCallback(async (path: string) => {
        if (!agentId) throw new Error('This conversation has no workspace.')
        return readDesktopCardFile(agentId, path)
    }, [agentId])
    const { files } = card
    const opened = openIndex === null ? null : files[openIndex]

    return <>
        <div data-file-card="true" className="flex flex-wrap gap-1.5">
            {files.map((file, index) => (
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
        {opened && openIndex !== null && agentId && (
            <DesktopFileLightbox
                paths={files.map(file => file.path)}
                names={files.map(file => file.name)}
                index={openIndex}
                readFile={read}
                onIndexChange={setOpenIndex}
                onClose={() => setOpenIndex(null)}
            />
        )}
    </>
}
