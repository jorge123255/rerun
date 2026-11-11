import type { Locale } from '@rerun/i18n'
import type chat from '@rerun/i18n/messages/en/chat.json'
import type foreman from '@rerun/i18n/messages/en/foreman.json'
import type kit from '@rerun/i18n/messages/en/kit.json'

const en = {
    conversation: 'Chief of Staff conversation',
    message: 'Message your Chief of Staff',
    opening: 'Opening your Chief of Staff…',
    working: 'Working…',
    confirming: 'Confirming…',
    decisionUncertain: 'Decision acknowledgement is uncertain.',
}

const mac = {
    en,
    fr: {
        conversation: 'Conversation avec le Chief of Staff',
        message: 'Écrire au Chief of Staff',
        opening: 'Ouverture du Chief of Staff…',
        working: 'En cours…',
        confirming: 'Confirmation en cours…',
        decisionUncertain: 'La réception de votre décision n’a pas pu être confirmée.',
    },
    es: {
        conversation: 'Conversación con el Chief of Staff',
        message: 'Escribe al Chief of Staff',
        opening: 'Abriendo el Chief of Staff…',
        working: 'En curso…',
        confirming: 'Confirmando…',
        decisionUncertain: 'No se pudo confirmar la recepción de tu decisión.',
    },
    pt: {
        conversation: 'Conversa com o Chief of Staff',
        message: 'Escreva para o Chief of Staff',
        opening: 'Abrindo o Chief of Staff…',
        working: 'Em andamento…',
        confirming: 'Confirmando…',
        decisionUncertain: 'Não foi possível confirmar o recebimento da sua decisão.',
    },
    de: {
        conversation: 'Unterhaltung mit dem Chief of Staff',
        message: 'Nachricht an den Chief of Staff schreiben',
        opening: 'Chief of Staff wird geöffnet…',
        working: 'In Arbeit…',
        confirming: 'Wird bestätigt…',
        decisionUncertain: 'Der Eingang deiner Entscheidung konnte nicht bestätigt werden.',
    },
} satisfies Record<Locale, typeof en>

type Source = { chat: typeof chat; foreman: typeof foreman; kit: typeof kit }

export function desktopForemanMessages(locale: Locale, source: Source) {
    const { welcome, plan, dock } = source.foreman
    return {
        ...mac[locale],
        ask: source.kit.foreman.orbLabel,
        placeholder: `${source.foreman.pill.ask}…`,
        name: source.kit.foreman.tabsLabel,
        tabs: { ...source.kit.foreman.tabs, assistant: source.kit.foreman.tabsLabel },
        close: source.kit.close,
        closeChat: source.kit.foreman.header.closeChat,
        resize: source.foreman.resize,
        send: source.foreman.pill.send,
        stop: source.chat.promptInput.stop,
        retry: source.kit.chat.skillProposal.retry,
        welcome: { title: welcome.title, preparing: welcome.preparing },
        failedReply: dock.failedReply,
        plan: {
            skipped: plan.skipped, confirmed: plan.confirmed, askedChanges: plan.askedChanges,
            goesAfter: plan.goesAfter, thisWeek: plan.thisWeek, previousBox: plan.previousBox, nextBox: plan.nextBox,
            build: plan.build, change: plan.change, standingBy: plan.standingBy,
        },
    }
}
