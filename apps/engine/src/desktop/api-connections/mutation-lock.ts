import { dataDir } from '../../config/paths.js'
import { withKeyedLock } from '../../lib/lock.js'

// Run capture and named-connection edits share one linearization boundary.
// Keep this separate from the narrower connection-file lock: callers may read
// the receipt revision after a file effect has released that narrower lock.
export function withDesktopApiConnectionMutationLock<T>(workspaceId: number, effect: () => Promise<T>): Promise<T> {
    return withKeyedLock(`desktop-api-mutation:${dataDir()}\0${workspaceId}`, effect)
}
