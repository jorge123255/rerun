import { z } from 'zod'
import { foremanChatRefSchema } from '@rerun/contracts'

export const foremanFileGrantIds = ['foremanAgentFilesRead', 'foremanAgentFilesWrite', 'delegate', 'callAgent', 'requestApproval'] as const
export const foremanFileGrantsSchema = z.strictObject({ foremanAgentFilesRead: z.boolean(), foremanAgentFilesWrite: z.boolean(), delegate: z.boolean().optional(), callAgent: z.boolean().optional(), requestApproval: z.boolean().optional() })
export const foremanFilePermissionSnapshotSchema = z.strictObject({ workspaceId: z.string().min(1).max(128), launchNonce: z.uuid(), grants: foremanFileGrantsSchema })
export const foremanFilePermissionPatchSchema = z.strictObject({
    chat: foremanChatRefSchema, launchNonce: z.uuid(), expectedGrants: foremanFileGrantsSchema,
    id: z.enum(foremanFileGrantIds), enabled: z.boolean(),
})
export type ForemanFilePermissionSnapshot = z.infer<typeof foremanFilePermissionSnapshotSchema>
