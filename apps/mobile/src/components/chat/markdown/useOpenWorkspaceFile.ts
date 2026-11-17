import { useCallback } from 'react'

import { rawFileUrl } from '@/api/files'
import { openViewer } from '@/components/viewer/viewer-store'

// A file of the coworker's workspace an answer links to, opened in the full-screen viewer.
export function useOpenWorkspaceFile() {
    return useCallback((agentId: string, path: string) => openViewer([{ url: rawFileUrl({ agentId, path }), name: path.split('/').at(-1) ?? path }]), [])
}
