import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DESKTOP_TEMPLATE_LIMITS, desktopTemplateIdSchema, desktopTemplateRevisionSchema } from '@rerun/contracts'
import { z } from 'zod'
import { TemplateRequestError } from './errors.ts'
import { readConfined, replaceOwnFile, writeExclusiveFile, ensurePrivateDir } from './files.ts'

const jsonLimit = 48 * 1024 * 1024

export function templateHome(dataRoot: string, templateId: string): string {
    if (!desktopTemplateIdSchema.safeParse(templateId).success) throw new TemplateRequestError(400, 'Invalid template')
    return join(dataRoot, 'desktop-templates', templateId)
}

export function requestHome(dataRoot: string): string {
    return join(dataRoot, 'desktop-templates', 'requests')
}

export async function readOwnJson(directory: string, relativeName: string, canonicalRoot?: string): Promise<unknown | null> {
    const read = await readConfined(directory, relativeName, jsonLimit, canonicalRoot)
    if (!read.ok) {
        if (read.reason === 'unsupported') {
            const missing = await lstat(join(directory, relativeName)).then(() => false, (error:NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return true; throw error })
            if (missing) return null
        }
        throw new TemplateRequestError(409, 'A template record is not a plain file')
    }
    try { return JSON.parse(read.text) as unknown }
    catch { throw new TemplateRequestError(409, 'A template record is not JSON') }
}

function jsonBytes(value: unknown): Buffer {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    if (bytes.length > jsonLimit) throw new TemplateRequestError(413, 'Template record is too large')
    return bytes
}

export async function writeOwnJson(directory: string, relativeName: string, value: unknown, canonicalRoot?: string): Promise<void> {
    await ensurePrivateDir(directory)
    await writeExclusiveFile(directory, relativeName, jsonBytes(value), canonicalRoot)
}

export async function replaceOwnJson(directory: string, name: string, value: unknown): Promise<void> {
    await replaceOwnFile(directory, name, jsonBytes(value))
}

export const draftSchema = z.strictObject({
    version: z.literal(1),
    requestId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    title: z.string().min(1).max(DESKTOP_TEMPLATE_LIMITS.maxTitleLength),
    revision: desktopTemplateRevisionSchema,
})
export type TemplateDraft = z.infer<typeof draftSchema>

export async function listTemplateIds(dataRoot: string): Promise<string[]> {
    const root = join(dataRoot, 'desktop-templates')
    const info = await lstat(root).catch((error:NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw new TemplateRequestError(503, 'Local template storage is unavailable') })
    if (!info) return []
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TemplateRequestError(409, 'Template storage is not a directory')
    const entries = await readdir(root, { withFileTypes: true })
    return entries
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && desktopTemplateIdSchema.safeParse(entry.name).success)
        .map(entry => entry.name)
        .sort()
}
