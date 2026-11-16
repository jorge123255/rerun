'use client'

import type { DesktopCoworkerMention, DesktopForemanConversationView, DesktopForemanModelRef } from '@rerun/contracts'
import type { DesktopForemanActionPorts, DesktopForemanMessageOptions } from './actions'
import type { DesktopForemanChatRef } from './identity'
import type { DesktopForemanPersistedUi } from './persistence'
import { createDesktopForemanConversation } from './runtime-client'

/**
 * « New task » before its first message: a conversation that exists on screen only. It has an
 * identity of its own so the column can run unchanged, and that identity is never sent to the
 * server: the conversation saved by the first message gets another one.
 */
export type DesktopForemanDraftTask = {
    /** What the column is keyed by while the draft is open. */
    chat: DesktopForemanChatRef
    /** The request that creates the saved conversation; kept so a retry never creates a second one. */
    requestId: string
}
export function createDesktopForemanDraftTask(workspaceId: string, uuid: () => string = () => crypto.randomUUID()): DesktopForemanDraftTask {
    return { chat: { workspaceId, chatId: `fmc_${uuid()}` }, requestId: uuid() }
}

/** The message that opened a task: its saved conversation's panel sends it once it is on screen. */
export type DesktopForemanFirstSend = { chatId: string; text: string; coworkerMentions?: DesktopCoworkerMention[]; model: DesktopForemanModelRef | null }
let firstSend: DesktopForemanFirstSend | null = null
/** The first message waiting for this conversation, handed over once. */
export function takeDesktopForemanFirstSend(chatId: string) {
    if (firstSend?.chatId !== chatId) return null
    const value = firstSend
    firstSend = null
    return value
}

/**
 * Sending the first message is what saves the task: create the conversation, leave the message for
 * its panel, then open it. A failure before the conversation opens leaves the draft as it was.
 */
export async function sendDesktopForemanFirstMessage(draft: DesktopForemanDraftTask, message: {
    text: string; coworkerMentions?: DesktopCoworkerMention[]; model: DesktopForemanModelRef | null
}, open: (chat: DesktopForemanChatRef) => Promise<void>, signal: AbortSignal) {
    const chat = await createDesktopForemanConversation(draft.chat.workspaceId, draft.requestId, AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
    signal.throwIfAborted()
    const pending = { chatId: chat.chatId, ...message }
    firstSend = pending
    try { await open(chat) } catch (error) {
        if (firstSend === pending) firstSend = null
        throw error
    }
    return chat
}

const unsaved = 'Send a first message to start this task.'
/** The column's ports for a draft: its interface state stays in memory, and only a send reaches the server. */
export function createDesktopForemanDraftPorts(chat: DesktopForemanChatRef,
    send: (text: string, options?: DesktopForemanMessageOptions) => Promise<boolean>): DesktopForemanActionPorts {
    let ui: DesktopForemanPersistedUi | null = null
    const view: DesktopForemanConversationView = { contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null }
    return {
        conversation: { sendMessage: (text, _signal, options) => send(text, options), stop: () => {} },
        decisions: { submit: async request => ({ ok: false, requestId: request.requestId, revisionId: request.revisionId, error: unsaved }) },
        build: { readProgress: async () => null, act: async () => ({ error: unsaved }) },
        discovery: { subscribe: () => () => {}, capabilities: () => ({ available: false }) },
        navigation: { dispatch: () => {} },
        plans: { readShownPlan: async () => null, readConversationView: async () => view },
        routines: { list: async () => ({ available: false, routines: [] }) },
        persistence: { load: async () => ui, save: async snapshot => { ui = snapshot } },
    }
}
