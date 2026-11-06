'use client'

import { z } from 'zod'
import {
    desktopVoiceDraftSchema,
    desktopVoiceDraftViewSchema,
    desktopVoiceSendReceiptSchema,
    DESKTOP_VOICE_MAX_BYTES,
    type DesktopVoiceDraft,
    type DesktopVoiceScope,
    type DesktopVoiceSendReceipt,
    type DesktopVoiceRevisionAction,
} from '@rerun/contracts'
import type { DesktopVoiceRecordingTake } from './useDesktopVoiceRecorder'

function endpoint(agentId: string): string {
    return `/api/desktop/coworkers/${encodeURIComponent(agentId)}/voice`
}

function ownedDraft(scope: DesktopVoiceScope, draft: DesktopVoiceDraft, attemptId?: string, allowFirstTurnAlias = false): DesktopVoiceDraft {
    // Only authenticated reads can return a draft recorded before this tab's first
    // session existed. Mutations always keep the immutable scope returned by that read.
    const sessionMatches = draft.scope.sessionId === scope.sessionId || allowFirstTurnAlias && scope.sessionId !== undefined && draft.scope.sessionId === undefined
    if (draft.scope.agentId !== scope.agentId || draft.scope.tabUid !== scope.tabUid || !sessionMatches || attemptId !== undefined && draft.attemptId !== attemptId || draft.recording.attemptId !== draft.attemptId) {
        throw new Error('Voice recording belongs to another conversation or attempt.')
    }
    return draft
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
    signal?.throwIfAborted()
    if (recording.blob.size < 1 || recording.blob.size > DESKTOP_VOICE_MAX_BYTES) throw new Error('This recording exceeds the 2 MB limit.')
    const bytes = new Uint8Array(await recording.blob.arrayBuffer())
    signal?.throwIfAborted()
    return ownedDraft(scope, z.object({ draft: desktopVoiceDraftSchema }).parse(await request(scope.agentId, {
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
    })).draft, attemptId)
}

export async function readDesktopVoiceDraft(scope: DesktopVoiceScope, attemptId: string, signal?: AbortSignal): Promise<DesktopVoiceDraft | null> {
    const query = new URLSearchParams({ tabUid: scope.tabUid, attemptId, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}) })
    const result = desktopVoiceDraftViewSchema.parse(await request(scope.agentId, { signal }, query))
    return result.draft ? ownedDraft(scope, result.draft, attemptId, true) : null
}

export async function listDesktopVoiceDrafts(scope: DesktopVoiceScope, signal?: AbortSignal): Promise<DesktopVoiceDraft[]> {
    const query = new URLSearchParams({ tabUid: scope.tabUid, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}) })
    return z.object({ drafts: z.array(desktopVoiceDraftSchema) }).parse(await request(scope.agentId, { signal }, query)).drafts.map(draft => ownedDraft(scope, draft, undefined, true))
}

export async function transcribeDesktopVoice(scope: DesktopVoiceScope, attemptId: string, expectedRevision: string, signal?: AbortSignal): Promise<DesktopVoiceDraft> {
    return ownedDraft(scope, z.object({ draft: desktopVoiceDraftSchema }).parse(await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'transcribe', ...scope, attemptId, expectedRevision }),
    })).draft, attemptId)
}

export async function sendDesktopVoice(scope: DesktopVoiceScope, attemptId: string, expectedRevision: string, signal?: AbortSignal, modelChoice?: DesktopVoiceRevisionAction['modelChoice']): Promise<DesktopVoiceSendReceipt> {
    const result = desktopVoiceSendReceiptSchema.parse(await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'send', ...scope, attemptId, expectedRevision, ...(modelChoice ? { modelChoice } : {}) }),
    }))
    ownedDraft(scope, result.draft, attemptId)
    return result
}

export async function discardDesktopVoice(scope: DesktopVoiceScope, attemptId: string, expectedRevision: string, signal?: AbortSignal): Promise<void> {
    await request(scope.agentId, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'discard', ...scope, attemptId, expectedRevision }),
    })
}
