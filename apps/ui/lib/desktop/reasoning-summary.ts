// Older Codex adapters could combine raw deltas and summary deltas in one reasoning part.
// Only the desktop adapter that excludes raw content sets this marker.
export const desktopSummaryMetadata = { 'codex-app-server': { isPublicSummary: true } } as const

export function isDesktopSummaryMetadata(metadata: unknown) {
    if (!metadata || typeof metadata !== 'object' || !('codex-app-server' in metadata)) return false
    const codex = metadata['codex-app-server']
    return !!codex && typeof codex === 'object' && 'isPublicSummary' in codex && codex.isPublicSummary === true
}
