import { describe, expect, it } from 'vitest'
import { desktopBrowserKeyTrigger, desktopBrowserLabelKind, desktopBrowserMessageField, desktopBrowserPress, type DesktopBrowserProbe } from './desktop-browser-approvals.js'
import { DESKTOP_ALREADY_WAITING, DESKTOP_DECLINED_BY_PERSON, DESKTOP_PRESS_CHANGED, desktopDeclinedByPerson, desktopOutcomeForPerson } from './desktop-approval-outcomes.js'

const probe = (overrides: Partial<DesktopBrowserProbe> = {}): DesktopBrowserProbe => ({
    readable: true, page: true, role: 'button', label: '', host: 'shop.example.test', submits: false, form: '', field: '', fieldLabel: '', ...overrides,
})

describe('which button labels ask first', () => {
    it.each([
        // send
        ['Send', 'send'], ['Send email', 'send'], ['Send →', 'send'], ['Reply', 'send'], ['Reply all', 'send'], ['Submit', 'send'], ['Post comment', 'send'], ['Comment', 'send'],
        ['Invite', 'send'], ['Send invite', 'send'], ['Yes, send', 'send'], ['Confirm and send', 'send'], ['Send feedback', 'send'], ['Send later', 'send'], ['Forward', 'send'],
        // post
        ['Publish', 'post'], ['Post', 'post'], ['Tweet', 'post'], ['Publish changes', 'post'], ['Repost', 'post'], ['Go live', 'post'],
        // pay
        ['Pay', 'pay'], ['Pay now', 'pay'], ['Pay $12.00', 'pay'], ['Buy', 'pay'], ['Buy now', 'pay'], ['Place order', 'pay'], ['Place your order', 'pay'], ['Checkout', 'pay'],
        ['Proceed to checkout', 'pay'], ['Subscribe', 'pay'], ['Confirm purchase', 'pay'], ['Complete purchase', 'pay'], ['Submit order', 'pay'], ['Send $20', 'pay'], ['Donate', 'pay'],
        // delete
        ['Delete', 'delete'], ['Delete account', 'delete'], ['Yes, delete', 'delete'], ['Permanently delete', 'delete'], ['Remove', 'delete'], ['Yes, remove', 'delete'],
        ['Remove permanently', 'delete'], ['Trash', 'delete'], ['Move to trash', 'delete'], ['Empty trash', 'delete'], ['Discard', 'delete'], ['Discard permanently', 'delete'], ['Discard draft', 'delete'],
        // credential
        ['Change password', 'credential'], ['Reset password', 'credential'], ['Update password', 'credential'], ['Reset key', 'credential'], ['Reset API key', 'credential'],
        ['Regenerate token', 'credential'], ['Revoke access token', 'credential'], ['Disable two-factor', 'credential'], ['Delete API key', 'credential'],
    ])('holds “%s” as %s', (label, kind) => {
        expect(desktopBrowserLabelKind(label)).toBe(kind)
    })

    it.each([
        'Save draft', 'Save', 'Next', 'Continue', 'Search', 'Cancel', 'Close', 'Edit', 'Sign in', 'Log in', 'Confirm', 'Done', 'OK', 'Back', 'Add to cart', 'Apply',
        // The label does not start with the action, or is not the action word itself.
        'Don’t send', 'Undo send', 'Cancel order', 'Posts', 'Sent', 'Deleted items', 'Payments', 'Sender', 'Postpone', 'Paywall settings', 'Buyer profile',
        // Editors and filters say these for ordinary changes.
        'Remove filter', 'Remove formatting', 'Discard changes', 'Reply to Pat about the invoice', 'Comment settings',
        // A question is a prompt or a link to a form, not a button that acts.
        'Send feedback?', 'Forgot password?', 'Delete this file?',
        // Looking at a credential is not changing it.
        'Show password', 'Copy API key', 'Password', 'Key', 'Share',
        // A sentence or a card is not a button.
        'Send us a note if you ever want to delete your account or pay later', '',
    ])('does not hold “%s”', label => {
        expect(desktopBrowserLabelKind(label)).toBeNull()
    })

    it('covers the commonest words in French, Spanish, Portuguese and German', () => {
        const cases: [string, string][] = [
            ['Envoyer', 'send'], ['Envoyer le message', 'send'], ['Publier', 'post'], ['Payer', 'pay'], ['Acheter maintenant', 'pay'], ['Passer la commande', 'pay'], ['Supprimer', 'delete'], ['Réinitialiser le mot de passe', 'credential'],
            ['Enviar', 'send'], ['Publicar', 'post'], ['Pagar', 'pay'], ['Comprar ahora', 'pay'], ['Finalizar compra', 'pay'], ['Eliminar', 'delete'], ['Cambiar contraseña', 'credential'],
            ['Excluir', 'delete'], ['Fazer pedido', 'pay'], ['Redefinir senha', 'credential'],
            ['Senden', 'send'], ['Nachricht senden', 'send'], ['Veröffentlichen', 'post'], ['Jetzt kaufen', 'pay'], ['Zahlungspflichtig bestellen', 'pay'], ['Löschen', 'delete'], ['Endgültig löschen', 'delete'], ['Passwort ändern', 'credential'],
        ]
        for (const [label, kind] of cases) expect(desktopBrowserLabelKind(label), label).toBe(kind)
        for (const label of ['Enregistrer', 'Guardar borrador', 'Weiter', 'Suivant', 'Abbrechen', 'Salvar rascunho']) expect(desktopBrowserLabelKind(label), label).toBeNull()
    })

    it('treats a one-word link as a place to go', () => {
        expect(desktopBrowserLabelKind('Trash', 'link')).toBeNull()
        expect(desktopBrowserLabelKind('Post', 'link')).toBeNull()
        expect(desktopBrowserLabelKind('Trash', 'button')).toBe('delete')
        // A link that names the action in full still asks: many sites draw their buttons as links.
        expect(desktopBrowserLabelKind('Delete account', 'link')).toBe('delete')
        expect(desktopBrowserLabelKind('Checkout', 'link')).toBe('pay')
    })
})

describe('which presses are held', () => {
    it('holds a click on a recognised button and lets ordinary clicks through', () => {
        expect(desktopBrowserPress(probe({ label: 'Pay now' }), 'click', false)).toEqual({ kind: 'pay', label: 'Pay now', host: 'shop.example.test', via: 'click' })
        expect(desktopBrowserPress(probe({ label: 'Save draft' }), 'click', false)).toBeNull()
        expect(desktopBrowserPress(probe({ role: 'link', label: 'Next' }), 'click', false)).toBeNull()
        expect(desktopBrowserPress(probe({ role: 'field', field: 'text', fieldLabel: 'Search', submits: true, form: 'Pay now' }), 'click', false)).toBeNull()
        // A clickable element that is not a button is still read by its own words.
        expect(desktopBrowserPress(probe({ role: 'other', label: 'Delete' }), 'click', false)?.kind).toBe('delete')
    })

    it('reads nothing off the browser’s own toolbar', () => {
        expect(desktopBrowserPress(probe({ page: false, label: 'Delete' }), 'click', true)).toBeNull()
    })

    it('with Extra vigilant off, lets a control that cannot be read through', () => {
        expect(desktopBrowserPress(probe({ readable: false }), 'click', false)).toBeNull()
        // An icon button with no accessible name: there is nothing to read.
        expect(desktopBrowserPress(probe({ label: '' }), 'click', false)).toBeNull()
    })

    it('with Extra vigilant on, holds every button and form submit and anything that cannot be read', () => {
        expect(desktopBrowserPress(probe({ label: 'Next' }), 'click', true)).toEqual({ kind: 'press', label: 'Next', host: 'shop.example.test', via: 'click' })
        expect(desktopBrowserPress(probe({ readable: false }), 'click', true)).toEqual({ kind: 'press', label: '', host: 'shop.example.test', via: 'click' })
        expect(desktopBrowserPress(probe({ label: '' }), 'click', true)).toMatchObject({ kind: 'press', label: '' })
        expect(desktopBrowserPress(probe({ label: 'Pay now' }), 'click', true)?.kind).toBe('pay')
        // Plain links and text fields do not ask.
        expect(desktopBrowserPress(probe({ role: 'link', label: 'Pricing' }), 'click', true)).toBeNull()
        expect(desktopBrowserPress(probe({ role: 'field', field: 'text', fieldLabel: 'Name', submits: true }), 'click', true)).toBeNull()
        expect(desktopBrowserPress(probe({ role: 'other', label: 'Some text' }), 'click', true)).toBeNull()
        // Enter in a form field submits the form.
        expect(desktopBrowserPress(probe({ role: 'field', field: 'text', fieldLabel: 'Name', submits: true, form: 'Continue' }), 'enter', true)).toMatchObject({ kind: 'press', label: 'Continue', via: 'key' })
    })

    it('holds Enter by what it would submit', () => {
        const field = probe({ role: 'field', field: 'text', fieldLabel: 'Card number', submits: true, form: 'Pay now' })
        expect(desktopBrowserPress(field, 'enter', false)).toEqual({ kind: 'pay', label: 'Pay now', host: 'shop.example.test', via: 'key' })
        expect(desktopBrowserPress(probe({ role: 'field', field: 'text', fieldLabel: 'Search', submits: true, form: 'Search' }), 'enter', false)).toBeNull()
        // Enter in a box for writing a message sends it; in any other text box it is a line break.
        expect(desktopBrowserPress(probe({ role: 'field', field: 'multiline', fieldLabel: 'Write a reply' }), 'enter', false)).toMatchObject({ kind: 'send', label: 'Write a reply' })
        expect(desktopBrowserPress(probe({ role: 'field', field: 'multiline', fieldLabel: 'Notes' }), 'enter', false)).toBeNull()
        // Enter on a focused button presses it.
        expect(desktopBrowserPress(probe({ label: 'Delete' }), 'enter', false)?.kind).toBe('delete')
        expect(desktopBrowserPress(probe({ label: 'Delete' }), 'space', false)?.kind).toBe('delete')
        expect(desktopBrowserPress(probe({ role: 'link', label: 'Delete account' }), 'space', false)).toBeNull()
        expect(desktopBrowserPress(probe({ role: 'field', field: 'text', fieldLabel: 'Message' }), 'space', false)).toBeNull()
    })

    it('holds Ctrl+Enter and Cmd+Enter in any box as sending', () => {
        expect(desktopBrowserPress(probe({ role: 'field', field: 'multiline', fieldLabel: 'Notes' }), 'modEnter', false)).toMatchObject({ kind: 'send', via: 'key' })
        expect(desktopBrowserPress(probe({ role: 'field', field: 'multiline', fieldLabel: 'Notes', submits: true, form: 'Publish' }), 'modEnter', false)).toMatchObject({ kind: 'post', label: 'Publish' })
    })

    it('never carries more than the control’s own short label', () => {
        expect(desktopBrowserPress(probe({ label: `Delete ${'x'.repeat(200)}` }), 'click', false)?.label.length).toBe(80)
    })

    it('reads which keys activate', () => {
        expect(desktopBrowserKeyTrigger('Return')).toBe('enter')
        expect(desktopBrowserKeyTrigger('KP_Enter')).toBe('enter')
        expect(desktopBrowserKeyTrigger('ctrl+Return')).toBe('modEnter')
        expect(desktopBrowserKeyTrigger('super+Return')).toBe('modEnter')
        expect(desktopBrowserKeyTrigger('shift+Return')).toBeNull()
        expect(desktopBrowserKeyTrigger('space')).toBe('space')
        expect(desktopBrowserKeyTrigger('ctrl+a')).toBeNull()
        expect(desktopBrowserKeyTrigger('Tab')).toBeNull()
        expect(desktopBrowserMessageField('Message Pat')).toBe(true)
        expect(desktopBrowserMessageField('Search')).toBe(false)
    })
})

describe('what is said when a step was not done', () => {
    it('tells the coworker not to look for another way, and the person the plain version', () => {
        expect(DESKTOP_DECLINED_BY_PERSON).toContain('Do not try this action, or anything equivalent, again')
        expect(desktopOutcomeForPerson(DESKTOP_DECLINED_BY_PERSON)).toBe('You declined it.')
        expect(desktopOutcomeForPerson(DESKTOP_ALREADY_WAITING)).toBe('It’s already waiting for your answer.')
        expect(desktopOutcomeForPerson(DESKTOP_PRESS_CHANGED)).toBe('Not done: the page changed after the person allowed this press, so their answer no longer applies and nothing was pressed.')
        expect(desktopOutcomeForPerson('Saved 3 rows.')).toBe('Saved 3 rows.')
        expect(desktopDeclinedByPerson(` ${DESKTOP_DECLINED_BY_PERSON} `)).toBe(true)
        expect(desktopDeclinedByPerson('Declined.')).toBe(false)
    })
})
