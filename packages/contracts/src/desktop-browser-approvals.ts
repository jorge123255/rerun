import { z } from 'zod'
import { DESKTOP_CONNECTOR_ACTION_KINDS, type DesktopConnectorActionKind } from './desktop-connector-approvals.js'

// Presses a coworker asks the person about before it makes them in its own browser: a button that
// sends, posts, pays, deletes or changes a credential. The idea, the kinds and the rule that a
// button counts by its own label follow CopilotKit/OpenBot's docs/approvals.md (MIT). The word
// lists and the code are Rerun's own.
//
// WHAT IS READ. Only the label of the control under the pointer (or the one with the keyboard
// focus), the label of its form's submit button, and the page's host. Never the text around it.
// The label is whatever the page says: a page that calls its Pay button "Next" is not caught.

/** The record the card and the request are kept under. A press is never a connector tool. */
export const DESKTOP_BROWSER_PRESS_TOOL = 'browser_press'

/** `press` is a button held only because Extra vigilant is on: its label names none of the kinds. */
export const DESKTOP_APPROVAL_KINDS = [...DESKTOP_CONNECTOR_ACTION_KINDS, 'press'] as const
export type DesktopApprovalKind = (typeof DESKTOP_APPROVAL_KINDS)[number]
export type DesktopBrowserPressKind = Exclude<DesktopApprovalKind, 'share'>

export const DESKTOP_BROWSER_LABEL_MAX = 80

/** What the guest can say about the control a press would land on. All of it is page content. */
export const desktopBrowserProbeSchema = z.object({
    /** False when a visible page was found but the control cannot be read: a canvas, a frame from another site. */
    readable: z.boolean(),
    /** False when the pointer or the focus is not on a web page (the browser's own toolbar, tabs, dialogs). */
    page: z.boolean(),
    role: z.enum(['button', 'link', 'field', 'other']),
    label: z.string().max(160),
    host: z.string().max(260),
    /** A submit button inside a form, or a field inside one. */
    submits: z.boolean(),
    /** The label of the submit button of the form the control belongs to. */
    form: z.string().max(160),
    field: z.enum(['', 'text', 'multiline']),
    fieldLabel: z.string().max(160),
}).strict()
export type DesktopBrowserProbe = z.infer<typeof desktopBrowserProbeSchema>

/** How the press would be made. `modEnter` is Ctrl+Enter or Cmd+Enter. */
export type DesktopBrowserTrigger = 'click' | 'enter' | 'modEnter' | 'space'

export const desktopBrowserPressSchema = z.object({
    kind: z.enum(DESKTOP_APPROVAL_KINDS).exclude(['share']),
    /** Empty for a control with no label that could be read. */
    label: z.string().max(DESKTOP_BROWSER_LABEL_MAX),
    host: z.string().max(260),
    via: z.enum(['click', 'key']),
}).strict()
export type DesktopBrowserPress = z.infer<typeof desktopBrowserPressSchema>

// ---------------------------------------------------------------------------------------------
// Word lists. English first; French, Spanish, Portuguese and German carry the commonest words
// only. Every word is written without accents: a label is stripped of them before it is compared.
// ---------------------------------------------------------------------------------------------

type Kind = Exclude<DesktopConnectorActionKind, 'share'>

// English: the label STARTS with the action ("Delete", "Delete account", "Yes, delete").
const FIRST_WORD: Record<string, Kind> = {
    send: 'send', submit: 'send', invite: 'send', forward: 'send',
    publish: 'post', post: 'post', tweet: 'post', repost: 'post',
    pay: 'pay', buy: 'pay', purchase: 'pay', checkout: 'pay', subscribe: 'pay', donate: 'pay', transfer: 'pay', withdraw: 'pay',
    delete: 'delete', trash: 'delete', erase: 'delete', destroy: 'delete',
}
// Counted only when the label is exactly this (after "Yes,"), or this with one of the tails.
// Editors and filters say "Remove filter", "Discard changes", "Reply to all…" for ordinary things.
const EXACT: Record<string, { kind: Kind; tails: string[] }> = {
    remove: { kind: 'delete', tails: ['permanently', 'forever', 'account'] },
    discard: { kind: 'delete', tails: ['permanently', 'forever', 'draft'] },
    reply: { kind: 'send', tails: ['all', 'to all'] },
    comment: { kind: 'send', tails: [] },
}
// Phrases, found anywhere in a short label. Checked before the first word, so "Post comment" is
// sending and "Submit order" is paying.
const PHRASES: Array<[string, Kind]> = [
    ['post comment', 'send'], ['post reply', 'send'], ['add comment', 'send'], ['send invite', 'send'], ['send invitation', 'send'],
    ['place order', 'pay'], ['place your order', 'pay'], ['place my order', 'pay'], ['complete purchase', 'pay'], ['confirm purchase', 'pay'],
    ['complete order', 'pay'], ['confirm order', 'pay'], ['submit order', 'pay'], ['submit payment', 'pay'], ['confirm payment', 'pay'],
    ['confirm and pay', 'pay'], ['check out', 'pay'], ['proceed to checkout', 'pay'], ['order now', 'pay'], ['send money', 'pay'],
    ['go live', 'post'],
    ['move to trash', 'delete'], ['empty trash', 'delete'], ['move to bin', 'delete'], ['empty bin', 'delete'],
    // French
    ['passer la commande', 'pay'], ['valider la commande', 'pay'], ['passer commande', 'pay'], ['mettre a la corbeille', 'delete'],
    // Spanish
    ['realizar pedido', 'pay'], ['finalizar compra', 'pay'], ['mover a la papelera', 'delete'],
    // Portuguese
    ['fazer pedido', 'pay'], ['finalizar pedido', 'pay'], ['mover para a lixeira', 'delete'],
    // German
    ['zahlungspflichtig bestellen', 'pay'], ['kostenpflichtig bestellen', 'pay'], ['in den papierkorb', 'delete'],
]
// Other languages: the word is the FIRST or the LAST word of the label ("Jetzt kaufen", "Envoyer le message").
const EDGE_WORD: Record<string, Kind> = {
    // French
    envoyer: 'send', repondre: 'send', soumettre: 'send', inviter: 'send', publier: 'post', poster: 'post', tweeter: 'post',
    payer: 'pay', acheter: 'pay', commander: 'pay', supprimer: 'delete', effacer: 'delete',
    // Spanish and Portuguese
    enviar: 'send', responder: 'send', invitar: 'send', convidar: 'send', publicar: 'post', postar: 'post', twittear: 'post',
    pagar: 'pay', comprar: 'pay', suscribirse: 'pay', eliminar: 'delete', borrar: 'delete', excluir: 'delete', apagar: 'delete', deletar: 'delete',
    // German
    senden: 'send', absenden: 'send', abschicken: 'send', antworten: 'send', einladen: 'send', veroffentlichen: 'post', posten: 'post', twittern: 'post',
    bezahlen: 'pay', zahlen: 'pay', kaufen: 'pay', bestellen: 'pay', abonnieren: 'pay', loschen: 'delete',
}
// A credential change is a changing word and a credential word, in either order ("Passwort ändern").
const CREDENTIAL_PHRASES = [
    'password', 'passcode', 'passkey', 'api key', 'access key', 'secret key', 'access token', 'api token', 'two factor', '2fa', 'two step verification', 'recovery codes',
    'mot de passe', 'contrasena', 'senha', 'passwort', 'kennwort',
]
const CREDENTIAL_WORDS = new Set(['key', 'token', 'secret'])
const CHANGING = new Set([
    'change', 'reset', 'update', 'set', 'save', 'regenerate', 'rotate', 'revoke', 'generate', 'create', 'disable', 'enable', 'remove', 'delete', 'turn',
    'changer', 'modifier', 'reinitialiser', 'cambiar', 'restablecer', 'alterar', 'redefinir', 'mudar', 'andern', 'zurucksetzen',
])
// Said before the action, and not part of it: "Yes, delete", "Confirm and send", "Permanently delete".
const LEAD = new Set(['yes', 'ok', 'okay', 'confirm', 'and', 'permanently', 'oui', 'si', 'sim', 'ja'])
// A link whose whole label is one of these is a place to go (the Trash folder, the Post tab), not an action.
const LINK_NOUNS = new Set(['trash', 'post', 'comment', 'reply', 'transfer', 'purchase'])
// A box for writing to other people: Enter in one sends.
const MESSAGE_FIELD = new Set([
    'message', 'reply', 'comment', 'tweet', 'chat', 'reponse', 'commentaire', 'mensaje', 'respuesta', 'comentario', 'mensagem', 'resposta', 'nachricht', 'antwort', 'kommentar',
])
const MAX_WORDS = 6
const AMOUNT = /(?:[$€£¥]\s?\d)|(?:\d[\d.,]*\s?(?:[$€£¥]|usd|eur|gbp|dollars?|euros?)\b)/i

function wordsOf(label: string): string[] {
    return label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss').split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * The kind of action a control's own label names, or null for an ordinary control.
 *
 * Decided either way, on purpose:
 * - "Save draft", "Next", "Continue", "Search", "Cancel", "Sign in", "Confirm" and "Done" alone: ordinary.
 * - "Send feedback" and "Send later": held (they send). "Send feedback?" is not: a label that ends in a
 *   question mark is a prompt or a link to a form ("Forgot password?"), not a button that acts.
 * - "Don't send", "Undo send", "Cancel order": ordinary, the label does not start with the action.
 * - "Posts", "Sent", "Deleted items", "Payments": ordinary, they are not the action word itself.
 * - "Remove" alone asks; "Remove filter" does not. "Discard" alone asks; "Discard changes" does not.
 * - "Subscribe" and "Checkout" ask even where no money moves (a free newsletter, a cart page):
 *   the label alone cannot tell, and asking once too often is the safer mistake.
 * - "Share" is not held: on a page it opens a dialog, and the button that does the sharing says Send or Invite.
 * - A label longer than six words is a sentence or a card, not a button, and is never matched.
 */
export function desktopBrowserLabelKind(label: string, role: DesktopBrowserProbe['role'] = 'button'): Kind | null {
    const raw = label.replace(/\s+/g, ' ').trim()
    if (!raw || /[?？]\s*$/.test(raw)) return null
    const all = wordsOf(raw)
    if (!all.length || all.length > MAX_WORDS) return null
    const text = ` ${all.join(' ')} `
    if (CREDENTIAL_PHRASES.some(phrase => text.includes(` ${phrase} `)) || all.some(word => CREDENTIAL_WORDS.has(word))) {
        if (all.some(word => CHANGING.has(word))) return 'credential'
    }
    for (const [phrase, kind] of PHRASES) if (text.includes(` ${phrase} `)) return kind
    let start = 0
    while (start < all.length - 1 && LEAD.has(all[start]!)) start++
    const words = all.slice(start), first = words[0]!, rest = words.slice(1).join(' ')
    if (role === 'link' && all.length === 1 && LINK_NOUNS.has(first)) return null
    const exact = EXACT[first]
    if (exact) return rest === '' || exact.tails.includes(rest) ? exact.kind : null
    const kind = FIRST_WORD[first]
    // "Send $20" moves money.
    if (kind === 'send' && AMOUNT.test(raw)) return 'pay'
    if (kind) return kind
    return EDGE_WORD[first] ?? EDGE_WORD[words[words.length - 1]!] ?? null
}

/** Whether a field's own label says it is for writing a message, a reply or a comment. */
export function desktopBrowserMessageField(fieldLabel: string): boolean {
    const words = wordsOf(fieldLabel)
    return words.length > 0 && words.length <= 12 && words.some(word => MESSAGE_FIELD.has(word))
}

const clip = (label: string) => label.replace(/\s+/g, ' ').trim().slice(0, DESKTOP_BROWSER_LABEL_MAX)

/**
 * What a press is held as, or null when it goes ahead without asking.
 *
 * `vigilant` is the coworker's Extra vigilant switch: with it on, every button and every form
 * submit on a page is held whatever it says, and a control that cannot be read is held as an
 * unlabelled one. With it off a control that cannot be read is NOT held: there is nothing to go on.
 */
export function desktopBrowserPress(probe: DesktopBrowserProbe, trigger: DesktopBrowserTrigger, vigilant: boolean): DesktopBrowserPress | null {
    // The browser's own toolbar, tabs and dialogs are not a page and are not read.
    if (!probe.page) return null
    const via = trigger === 'click' ? 'click' as const : 'key' as const
    const host = probe.host
    if (!probe.readable) return vigilant ? { kind: 'press', label: '', host, via } : null
    if (probe.role === 'field') {
        if (trigger === 'click' || trigger === 'space') return null
        const formKind = probe.form ? desktopBrowserLabelKind(probe.form) : null
        const label = clip(probe.form || probe.fieldLabel)
        // Ctrl+Enter or Cmd+Enter in a box sends what was written in it.
        if (trigger === 'modEnter') return { kind: formKind ?? 'send', label, host, via }
        // Enter in a one-line field submits its form; in any box for writing to people it sends.
        if (probe.field === 'text' && probe.submits && formKind) return { kind: formKind, label, host, via }
        if (desktopBrowserMessageField(probe.fieldLabel)) return { kind: 'send', label, host, via }
        if (vigilant && probe.field === 'text' && probe.submits) return { kind: 'press', label, host, via }
        return null
    }
    // Space presses a button and nothing else.
    if (trigger === 'space' && probe.role !== 'button') return null
    const kind = desktopBrowserLabelKind(probe.label, probe.role)
    if (kind) return { kind, label: clip(probe.label), host, via }
    if (vigilant && (probe.role === 'button' || probe.submits)) return { kind: 'press', label: clip(probe.label), host, via }
    return null
}

/** The trigger a key press is, or null for a key that activates nothing. Takes one combo as xdotool names it. */
export function desktopBrowserKeyTrigger(combo: string): Exclude<DesktopBrowserTrigger, 'click'> | null {
    const parts = combo.toLowerCase().split('+'), key = parts.pop()
    const mods = new Set(parts)
    if (key === 'return' || key === 'enter' || key === 'kp_enter') {
        if (mods.has('ctrl') || mods.has('control') || mods.has('super') || mods.has('cmd') || mods.has('command') || mods.has('meta')) return 'modEnter'
        // Shift+Enter and Alt+Enter write a line break.
        return mods.size ? null : 'enter'
    }
    if (key === 'space') return mods.size ? null : 'space'
    return null
}
