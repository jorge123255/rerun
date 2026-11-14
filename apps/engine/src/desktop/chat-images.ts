import { createHash } from 'node:crypto'
import { DESKTOP_DOCUMENT_IMAGE_MAX_FILES, DESKTOP_DOCUMENT_IMAGE_TOTAL_MAX_BYTES, desktopStoredAttachmentSelections, desktopStoredDocumentReferences } from '@rerun/contracts'
import { listMessages, storedContent } from '../db/repos/messages.js'
import { HttpError } from '../lib/errors.js'
import { desktopApp } from './policy.js'

export function verifyImageBytes(images: ReadonlyArray<{ dataBase64: string; sha256: string; byteLength: number }>) {
    if (images.length > DESKTOP_DOCUMENT_IMAGE_MAX_FILES || images.reduce((sum, image) => sum + image.byteLength, 0) > DESKTOP_DOCUMENT_IMAGE_TOTAL_MAX_BYTES) {
        throw new HttpError(413, 'Choose at most four images, up to 16 MiB in total.')
    }
    for (const image of images) {
        const bytes = Buffer.from(image.dataBase64, 'base64')
        if (bytes.byteLength !== image.byteLength || bytes.toString('base64') !== image.dataBase64 ||
            createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
            throw new HttpError(400, 'The image bytes do not match the selected snapshot.')
        }
    }
}
export async function assertImageModel(provider: string, agentId: string, includesImages: boolean, sessionId?: string, throughMessageId?: string) {
    if (!desktopApp() || provider === 'codex') return
    const hasImages = includesImages || (sessionId &&
        (await listMessages(agentId, sessionId, throughMessageId)).some(row => {
            if (row.role !== 'user') return false
            const content = storedContent(row.contentJson)
            return desktopStoredAttachmentSelections(content).some(item => typeof item !== 'string') ||
                desktopStoredDocumentReferences(content).some(item => item.kind === 'image')
        }))
    if (hasImages) throw new HttpError(400, 'Image attachments need a ChatGPT / Codex model. Choose one before sending.')
}
