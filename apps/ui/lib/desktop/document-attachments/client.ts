'use client'

import { z } from 'zod'
import {
    desktopDocumentAdmissionSchema,
    desktopDocumentAttachmentSchema,
    type DesktopDocumentAdmission,
    type DesktopDocumentAttachment,
    type DesktopDocumentScope,
} from '../../../../../packages/contracts/src/desktop-document-attachments.ts'

function endpoint(agentId: string): string {
    return `/api/desktop/coworkers/${encodeURIComponent(agentId)}/document-attachments`
}

async function request<T>(agentId: string, init: RequestInit, query?: URLSearchParams): Promise<T> {
    const response = await fetch(`${endpoint(agentId)}${query ? `?${query}` : ''}`, { cache: 'no-store', ...init })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Document request failed. Retry the same attempt.')
    return body as T
}

function base64Of(bytes: Uint8Array): string {
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    return btoa(binary)
}

export async function uploadDesktopDocument(scope: DesktopDocumentScope, attachmentId: string, file: File, signal?: AbortSignal): Promise<DesktopDocumentAttachment> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    return desktopDocumentAttachmentSchema.parse(await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'upload', ...scope, attachmentId, name: file.name, mimeType: file.type || 'application/octet-stream', audioBase64: base64Of(bytes) }),
    }))
}

export async function listDesktopDocuments(scope: DesktopDocumentScope, signal?: AbortSignal): Promise<DesktopDocumentAttachment[]> {
    return z.object({ attachments: z.array(desktopDocumentAttachmentSchema) }).parse(await request(scope.agentId, { signal }, new URLSearchParams({ tabUid: scope.tabUid })).attachments
}

export async function convertDesktopDocument(scope: DesktopDocumentScope, attachmentId: string, expectedRevision: string, signal?: AbortSignal): Promise<DesktopDocumentAttachment> {
    return desktopDocumentAttachmentSchema.parse(await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'convert', tabUid: scope.tabUid, sessionId: scope.sessionId, attachmentId, expectedRevision }),
    }))
}

export async function admitDesktopDocuments(scope: DesktopDocumentScope, signal?: AbortSignal): Promise<DesktopDocumentAdmission> {
    return desktopDocumentAdmissionSchema.parse(await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'admission', tabUid: scope.tabUid, sessionId: scope.sessionId }),
    }))
}

export async function discardDesktopDocument(scope: DesktopDocumentScope, attachmentId: string, expectedRevision: string, signal?: AbortSignal): Promise<void> {
    await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'discard', tabUid: scope.tabUid, sessionId: scope.sessionId, attachmentId, expectedRevision }),
    })
}

export function desktopDocumentReadUrl(scope: DesktopDocumentScope, attachmentId: string): string {
    const query = new URLSearchParams({ tabUid: scope.tabUid, attachmentId, view: 'read' })
    return `${endpoint(scope.agentId)}?${query}`
}
