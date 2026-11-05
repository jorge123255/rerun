'use client'

import { z } from 'zod'
import {
    desktopVoiceDraftSchema,
    desktopVoiceDraftViewSchema,
    type DesktopVoiceDraft,
    type DesktopVoiceScope,
} from '../../../../../packages/contracts/src/desktop-voice.ts'
import type { DesktopVoiceRecordingTake } from './useDesktopVoiceRecorder'

function endpoint(agentId: string): string {
    return `/api/desktop/coworkers/${encodeURIComponent(agentId)}/voice`
}

async function request<T>(agentId: string, init: RequestInit, query?: URLSearchParams): Promise<T> {
    const response = await fetch(`${endpoint(agentId)}${query ? `?${query}` : ''}`, { cache: 'no-store', ...init })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Voice request failed. Retry the same attempt.')
    return body as T
}

function base64Of(bytes: Uint8Array): string {
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
}

export async function uploadDesktopVoice(scope: DesktopVoiceScope, attemptId: string, recording: DesktopVoiceRecordingTake, signal?: AbortSignal): Promise<DesktopVoiceDraft> {
    const bytes = new Uint8Array(await recording.blob.arrayBuffer())
    return desktopVoiceDraftSchema.parse(await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            operation: 'upload',
            ...scope,
            attemptId,
            format: recording.format,
            durationMs: recording.durationMs,
            levels: recording.levels,
            audioBase64: base64Of(bytes),
        }),
    }))
}

export async function readDesktopVoiceDraft(scope: DesktopVoiceScope, attemptId: string, signal?: AbortSignal): Promise<DesktopVoiceDraft | null> {
    const query = new URLSearchParams({ tabUid: scope.tabUid, attemptId })
    const result = desktopVoiceDraftViewSchema.parse(await request(scope.agentId, { signal }, query))
    return result.draft
}

export async function listDesktopVoiceDrafts(scope: DesktopVoiceScope, signal?: AbortSignal): Promise<DesktopVoiceDraft[]> {
    const query = new URLSearchParams({ tabUid: scope.tabUid })
    return z.object({ drafts: z.array(desktopVoiceDraftSchema) }).parse(await request(scope.agentId, { signal }, query)).drafts
}

export async function transcribeDesktopVoice(scope: DesktopVoiceScope, attemptId: string, expectedRevision: string, signal?: AbortSignal): Promise<DesktopVoiceDraft> {
    return desktopVoiceDraftSchema.parse(await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'transcribe', ...scope, attemptId, expectedRevision }),
    }))
}

export async function sendDesktopVoice(scope: DesktopVoiceScope, attemptId: string, expectedRevision: string, signal?: AbortSignal): Promise<{ draft: DesktopVoiceDraft; text: string | null }> {
    return z.object({ draft: desktopVoiceDraftSchema, text: z.string().nullable() }).parse(await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'send', ...scope, attemptId, expectedRevision }),
    }))
}

export async function discardDesktopVoice(scope: DesktopVoiceScope, attemptId: string, expectedRevision: string, signal?: AbortSignal): Promise<void> {
    await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'discard', ...scope, attemptId, expectedRevision }),
    })
}
