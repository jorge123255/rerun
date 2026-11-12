export interface Storage {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
    removeItem(key: string): Promise<void>
}

export interface MacOffer {
    kind: 'rerun-mac-phone-pairing'
    version: 1
    macId: string
    fingerprint: string
    certificateFingerprint?: string
    offerId: string
    workspaceId: number
    origin: string
    secret: string
    expiresAt?: string
}

type Device = Pick<MacOffer, 'kind' | 'macId' | 'fingerprint' | 'certificateFingerprint' | 'workspaceId' | 'origin'> & {
    deviceId: string
    savedAt: string
}
export type MacSession = Device & ({ status: 'approved'; credential: string } | { status: 'pending'; requestToken: string })
type Pending = { status: 'pending'; deviceId: string; workspaceId: number; requestToken: string }
type Approval = { status: 'pending' | 'approved' | 'revoked' }
export type MacCoworker = { id: string; name: string; status: string }
export type MacChat = { id: string; title: string; kind: string; updatedAt: string }
export type MacMessage = { id: string; role: 'user' | 'assistant'; content: { type: 'text'; text: string }; authorName?: string | null }
export type MacOutgoingMessage = { requestId: string; text: string }
export type MacReplyFrame = { reset: true } | { delta: string }
export type PinnedStream = (url: string, pin: string, authorization: string, onFrame: (frame: MacReplyFrame) => void, signal?: AbortSignal) => Promise<void>

type Request = {
    method: string
    headers: Record<string, string>
    redirect: 'error'
    signal: AbortSignal
    body?: string
}
type Reply = { ok: boolean; status: number; json(): Promise<unknown> }
export type PinnedFetch = (url: string, fingerprint: string, options: Request) => Promise<Reply>

export function createMacPairingClient(options: {
    storage: Storage
    fetch?: (url: string, options: Request) => Promise<Reply>
    pinnedFetch?: PinnedFetch
    pinnedStream?: PinnedStream
    deviceName?: string
    now?: () => number
}): {
    parseOffer(input: string | MacOffer): MacOffer
    encodeOfferLink(offer: MacOffer): string
    connectToThisMac(input: string | MacOffer, signal?: AbortSignal): Promise<Pending>
    waitForApproval(signal?: AbortSignal): Promise<Approval>
    listCoworkers(signal?: AbortSignal): Promise<{ coworkers: MacCoworker[] }>
    listSavedChats(coworkerId: string, signal?: AbortSignal): Promise<{ chats: MacChat[] }>
    openSavedChat(coworkerId: string, chatId: string, signal?: AbortSignal): Promise<{ chat: MacChat; messages: MacMessage[]; permissions?: { sendMessages: boolean } }>
    sendMessage(coworkerId: string, chatId: string, message: MacOutgoingMessage, signal?: AbortSignal): Promise<{ requestId: string }>
    readSentTurn(coworkerId: string, chatId: string, requestId: string, signal?: AbortSignal): Promise<{ status: 'running' | 'done' | 'error' | 'cancelled' }>
    streamSentTurn(coworkerId: string, chatId: string, requestId: string, onFrame: (frame: MacReplyFrame) => void, signal?: AbortSignal): Promise<void>
    readMacSession(): Promise<MacSession | null>
    clearMacSession(): Promise<void>
}

export function createMemoryStorage(initial?: Record<string, string>): Storage & { snapshot(): Record<string, string> }
export function encodeOfferLink(offer: MacOffer): string
export function createMacSessionStore(storage: Storage): { read(): Promise<MacSession | null>; write(session: MacSession): Promise<void>; clear(): Promise<void> }
export const PHONE_SESSION_KEY: 'rerun.mac-pairing.session'
export const CUSTOM_SERVER_KEY: 'rerun.server'
export const API_PREFIX: '/api/mac-pairing/v1'
export const SERVICE_NAME: 'rerun-mac-phone-pairing'
type Entry = { id: 'cloud' | 'own-server' | 'this-mac'; kind: string; label?: string }
export const START_ENTRIES: readonly Entry[]
export function startSignInEntries(): Entry[]
