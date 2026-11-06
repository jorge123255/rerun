import type {
    DesktopVoiceDraft,
    DesktopVoiceRecording,
    DesktopVoiceScope,
    DesktopVoiceSendInput,
    DesktopVoiceDispatch,
} from '@rerun/contracts'

export type DesktopVoiceAttemptRecord = {
    draft: DesktopVoiceDraft
    fingerprint: string
    deletion?: 'pending' | 'complete'
    sendChoice?: NonNullable<DesktopVoiceSendInput['modelChoice']> | null
}

export interface DesktopVoiceStore {
    reserve(record: DesktopVoiceAttemptRecord): Promise<{ record: DesktopVoiceAttemptRecord; created: boolean }>
    read(scope: DesktopVoiceScope, attemptId: string): Promise<DesktopVoiceAttemptRecord | null>
    list(scope: DesktopVoiceScope): Promise<DesktopVoiceAttemptRecord[]>
    save(record: DesktopVoiceAttemptRecord, expectedRevision: string): Promise<void>
    reserveDiscard(scope: DesktopVoiceScope, attemptId: string, expectedRevision: string): Promise<void>
    discard(scope: DesktopVoiceScope, attemptId: string, expectedRevision: string): Promise<void>
}

export interface DesktopVoiceBlobStore {
    /** Immutable identity: an existing different recording must never be replaced. */
    put(scope: DesktopVoiceScope, recording: DesktopVoiceRecording, bytes: Uint8Array, signal: AbortSignal): Promise<void>
    read(scope: DesktopVoiceScope, recording: DesktopVoiceRecording, signal: AbortSignal): Promise<Uint8Array>
    /** Missing exact bytes are already deleted; a replacement identity must be refused. */
    delete(scope: DesktopVoiceScope, recording: DesktopVoiceRecording, signal: AbortSignal): Promise<void>
}

export type DesktopVoiceOwnerAuthority = (scope: DesktopVoiceScope, signal: AbortSignal) => Promise<void>
export type DesktopVoiceTranscriptionPort = (input: { bytes: Uint8Array; format: string; signal: AbortSignal }) => Promise<string>
export type DesktopVoiceSendPort = (input: DesktopVoiceSendInput & { signal: AbortSignal }) => Promise<{ messageId: string | null; dispatch?: DesktopVoiceDispatch }>
export type DesktopVoiceReferenceAuthority = (scope: DesktopVoiceScope, attemptId: string) => Promise<boolean>

export type DesktopVoiceAuthorities = {
    store: DesktopVoiceStore
    blobs: DesktopVoiceBlobStore
    owner: DesktopVoiceOwnerAuthority
    /** Sent audio can outlive the original tab, but must still belong to its exact saved message. */
    audioOwner?: (scope: DesktopVoiceScope, attemptId: string, signal: AbortSignal) => Promise<void>
    transcriptionAvailable?: () => Promise<boolean>
    /** Original blank-tab attempts may be read only through their exact canonical first-turn mapping. */
    readScopes?: (scope: DesktopVoiceScope, signal: AbortSignal) => Promise<DesktopVoiceScope[]>
    transcribe?: DesktopVoiceTranscriptionPort
    send: DesktopVoiceSendPort
    references: DesktopVoiceReferenceAuthority
}
