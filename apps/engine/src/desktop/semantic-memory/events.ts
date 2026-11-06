type MemoryChange = { agentId: string; phase: 'before' | 'after'; mode: 'create' | 'update' | 'delete' }
let observer: ((change: MemoryChange) => void) | null = null
export function observeDesktopMemoryChanges(next: (change: MemoryChange) => void) { observer = next }
export function desktopMemoryChanged(change: MemoryChange) { observer?.(change) }
