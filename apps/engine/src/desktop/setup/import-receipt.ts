import { createHash } from 'node:crypto'
import { z } from 'zod'

export const SETUP_IMPORT_RECEIPT = '.rerun-setup-import.json'
export const setupImportReceiptSchema = z.object({
    version: z.literal(1), agentId: z.string(), engineAgentId: z.string(), importReceiptId: z.string(),
    fingerprint: z.string(), state: z.enum(['pending', 'complete']), revision: z.string().optional(),
})
export const setupDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
