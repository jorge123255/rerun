import { z } from 'zod'

export const TEXT_FILE_PAGE_CHARS = 100_000

export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024

// The JSON write path holds the whole body in memory on a 512 MB Box, so it gets a bound of its own
// far below the upload cap. Past this size a file is downloaded and edited elsewhere.
export const MAX_TEXT_WRITE_CHARS = 1_000_000

// What the multipart path can still carry on a Box whose engine predates streamed uploads: it holds
// the whole file in memory twice, and these Boxes run on 512 MB.
export const LEGACY_UPLOAD_MAX_BYTES = 25 * 1024 * 1024

export const fileEntrySchema = z.object({
    name: z.string(),
    type: z.enum(['file', 'dir']),
    size: z.number(),
    modifiedAt: z.string().optional(),
})
export type FileEntry = z.infer<typeof fileEntrySchema>

// A coworker's files as one list, newest first, the way a chat app shows what a contact sent: images
// apart, everything else as documents. `truncated` says the folder holds more than was walked.
export const coworkerFileKindSchema = z.enum(['media', 'doc'])
export type CoworkerFileKind = z.infer<typeof coworkerFileKindSchema>

export const coworkerFileSchema = z.object({
    path: z.string(),
    name: z.string(),
    size: z.number(),
    modifiedAt: z.string().nullable(),
    kind: coworkerFileKindSchema,
})
export type CoworkerFile = z.infer<typeof coworkerFileSchema>

export const coworkerFilesSchema = z.object({ files: z.array(coworkerFileSchema), truncated: z.boolean() })
export type CoworkerFiles = z.infer<typeof coworkerFilesSchema>

export const fileEntriesListSchema = z.object({ entries: z.array(fileEntrySchema) })

// Pagination metadata stays optional while older Boxes are still in circulation. New engines
// always return it; keeping the parser tolerant lets the first page remain backwards compatible.
export const fileContentSchema = z.object({
    path: z.string(),
    content: z.string(),
    offset: z.number().int().nonnegative().optional(),
    nextOffset: z.number().int().nonnegative().nullable().optional(),
    totalChars: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
})
export type FileContent = z.infer<typeof fileContentSchema>

export const writeFileSchema = z.object({ path: z.string().min(1), content: z.string().max(MAX_TEXT_WRITE_CHARS) })
