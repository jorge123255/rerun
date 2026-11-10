import {
    FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT,
    FOREMAN_WORKSPACE_READ_MESSAGES as M,
    FOREMAN_WORKSPACE_READ_ROW_LIMIT,
    type ForemanWorkspaceSnapshot,
} from '@rerun/contracts'
import { z } from 'zod'
import { DESKTOP_TEAM_READ_FIELD_LIMIT, desktopTeamReadTooLarge } from '@rerun/contracts'
import { desktopTeamPayload, desktopTeamScheduleView, desktopTeamScrub, desktopTeamTriggerView, desktopTeamTruncateField } from '../team-reads/project.js'
import type { ForemanWorkspaceScheduleRow, ForemanWorkspaceTriggerRow } from './ports.js'

const id = z.string().trim().min(1).max(128)
const catalogId = z.string().regex(/^[1-9][0-9]{0,6}$/)
const text = (max: number) => z.string().max(max)
const rosterRow = z.strictObject({
    id,
    workspaceId: z.string().min(1).max(128),
    name: text(500),
    handle: z.string().max(200).nullable(),
    description: text(8_000),
    spaceId: z.string().max(128).nullable(),
    enabled: z.boolean(),
    deleting: z.boolean(),
})
const ready = z.strictObject({
    kind: z.literal('ready'),
    workspaceId: z.string().min(1).max(128),
    catalogWorkspaceId: catalogId,
    revision: z.number().int().nonnegative(),
    boxes: z.array(z.strictObject({ id, name: text(500) })).max(200),
    roster: z.array(rosterRow).max(200),
    foreignIds: z.array(id).max(200),
})
const snapshotSchema = z.discriminatedUnion('kind', [
    ready,
    z.strictObject({ kind: z.literal('missing') }),
    z.strictObject({ kind: z.literal('other-workspace') }),
    z.strictObject({ kind: z.literal('uncertain') }),
    z.strictObject({ kind: z.literal('revoked') }),
])

const PATH = /(?:\/(?:Users|home|private|var|tmp|opt)\/|[A-Za-z]:\\)[^\s"'\\]*/g

export type ReadySnapshot = z.infer<typeof ready>

export function parseForemanWorkspaceSnapshot(value: unknown): ForemanWorkspaceSnapshot {
    const parsed = snapshotSchema.safeParse(value)
    if (!parsed.success) throw new Error(M.unavailable)
    return parsed.data
}

export function foremanWorkspaceText(value: string, limit: number): string {
    const scrubbed = desktopTeamScrub(value.replace(PATH, '[omitted]'))
    const textValue = typeof scrubbed === 'string' ? scrubbed : ''
    return desktopTeamTruncateField(textValue, limit) ?? ''
}

export function foremanWorkspaceFingerprint(snapshot: ReadySnapshot): string {
    return JSON.stringify({
        revision: snapshot.revision,
        workspaceId: snapshot.workspaceId,
        catalogWorkspaceId: snapshot.catalogWorkspaceId,
        boxes: snapshot.boxes.map(box => box.id),
        roster: snapshot.roster.map(row => row.id),
        foreignIds: [...snapshot.foreignIds].sort(),
    })
}

export function assertForemanWorkspaceRowCount(count: number): void {
    if (count > FOREMAN_WORKSPACE_READ_ROW_LIMIT) throw new Error(M.limit)
}

export function foremanWorkspaceScheduleRows(rows: ForemanWorkspaceScheduleRow[]) {
    assertForemanWorkspaceRowCount(rows.length)
    return rows.map(row => {
        const view = desktopTeamScheduleView(row)
        return {
            slug: foremanWorkspaceText(view.slug, 128),
            name: foremanWorkspaceText(view.name, FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT),
            description: foremanWorkspaceText(view.description, FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT),
            body: foremanWorkspaceText(view.body, DESKTOP_TEAM_READ_FIELD_LIMIT),
            cron: view.cron === null ? null : foremanWorkspaceText(view.cron, 128),
            runAt: view.runAt === null ? null : foremanWorkspaceText(view.runAt, 80),
            timezone: view.timezone === null ? null : foremanWorkspaceText(view.timezone, 80),
            enabled: view.enabled,
            lastRunAt: view.lastRunAt === null ? null : foremanWorkspaceText(view.lastRunAt, 80),
        }
    })
}

export function foremanWorkspaceTriggerRows(rows: ForemanWorkspaceTriggerRow[]) {
    assertForemanWorkspaceRowCount(rows.length)
    return rows.map(row => {
        const view = desktopTeamTriggerView(row)
        return {
            slug: foremanWorkspaceText(view.slug, 128),
            name: foremanWorkspaceText(view.name, FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT),
            description: foremanWorkspaceText(view.description, FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT),
            body: foremanWorkspaceText(view.body, DESKTOP_TEAM_READ_FIELD_LIMIT),
            methods: view.methods.map(method => foremanWorkspaceText(method, 16)),
            enabled: view.enabled,
            fireCount: view.fireCount,
            lastFiredAt: view.lastFiredAt === null ? null : foremanWorkspaceText(view.lastFiredAt, 80),
        }
    })
}

export function foremanWorkspaceResult(name: string, value: unknown): unknown {
    try {
        return desktopTeamPayload(name, value)
    } catch (error) {
        if (error instanceof Error && error.message === desktopTeamReadTooLarge(name, JSON.stringify(desktopTeamScrub(value)).length)) throw new Error(M.limit)
        throw new Error(M.unavailable)
    }
}
