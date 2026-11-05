import type {
    DesktopVoiceDraft,
    DesktopVoiceRecording,
    DesktopVoiceScope,
    DesktopVoiceSendInput,
} from '../../../../../../packages/contracts/src/desktop-voice.ts'

export type DesktopVoiceAttemptRecord = {
    draft: DesktopVoiceDraft
    fingerprint: string
}

export interface DesktopVoiceStore {
    reserve(record: DesktopVoiceAttemptRecord): Promise<{ record: DesktopVoiceAttemptRecord; created: boolean }>
    read(scope: DesktopVoiceScope, attemptId: string): Promise<DesktopVoiceAttemptRecord | null>
    list(scope: DesktopVoiceScope): Promise<DesktopVoiceAttemptRecord[]>
    save(record: DesktopVoiceAttemptRecord, expectedRevision: string): Promise<void>
    discard(scope: DesktopVoiceScope, attemptId: string): Promise<void>
}

export interface DesktopVoiceBlobStore {
    put(scope: DesktopVoiceScope, recording: DesktopVoiceRecording, bytes: Uint8Array, signal: AbortSignal): Promise<void>
    read(scope: DesktopVoiceScope, recording: DesktopVoiceRecording, signal: AbortSignal): Promise<Uint8Array>
    delete(scope: DesktopVoiceScope, recording: DesktopVoiceRecording, signal: AbortSignal): Promise<void>
}

export type DesktopVoiceOwnerAuthority = (scope: DesktopVoiceScope, signal: AbortSignal) => Promise<void>
export type DesktopVoiceTranscriptionPort = (input: { bytes: Uint8Array; format: string; signal: AbortSignal }) => Promise<string>
export type DesktopVoiceSendPort = (input: DesktopVoiceSendInput & { signal: AbortSignal }) => Promise<{ messageId: string | null }>
export type DesktopVoiceReferenceAuthority = (scope: DesktopVoiceScope, attemptId: string) => Promise<boolean>

export type DesktopVoiceAuthorities = {
    store: DesktopVoiceStore
    blobs: DesktopVoiceBlobStore
    owner: DesktopVoiceOwnerAuthority
    transcribe?: DesktopVoiceTranscriptionPort
    send: DesktopVoiceSendPort
    references: DesktopVoiceReferenceAuthority
}
