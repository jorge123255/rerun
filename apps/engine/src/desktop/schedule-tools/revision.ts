import { createHash } from 'node:crypto'
import type { DesktopScheduleDefinition } from './types.js'

/** Identity of the editable routine. lastRunAt is a scheduler stamp and is not part of the definition. */
export function desktopScheduleDefinitionRevision(record: DesktopScheduleDefinition | null): string {
    if (!record) return 'absent'
    const { slug, name, description, enabled, cron, runAt, timezone, connectionId, provider, model, body, createdAt } = record
    return createHash('sha256').update(JSON.stringify({ slug, name, description, enabled, cron, runAt, timezone, connectionId, provider, model, body, createdAt })).digest('hex')
}
