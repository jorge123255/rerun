import type { Locale } from '@rerun/i18n'
import type chat from '@rerun/i18n/messages/en/chat.json'
import type foreman from '@rerun/i18n/messages/en/foreman.json'
import type kit from '@rerun/i18n/messages/en/kit.json'

const en = {
    conversation: 'Foreman conversation',
    message: 'Message the Foreman',
    opening: 'Opening Foreman…',
    working: 'Working…',
    confirming: 'Confirming…',
    decisionUncertain: 'Decision acknowledgement is uncertain.',
}

const mac = {
    en,
    fr: {
        conversation: 'Conversation avec le Foreman',
        message: 'Écrire au Foreman',
        opening: 'Ouverture du Foreman…',
        working: 'En cours…',
        confirming: 'Confirmation en cours…',
        decisionUncertain: 'La réception de votre décision n’a pas pu être confirmée.',
    },
    es: {
        conversation: 'Conversación con el Foreman',
        message: 'Escribe al Foreman',
        opening: 'Abriendo el Foreman…',
        working: 'En curso…',
        confirming: 'Confirmando…',
        decisionUncertain: 'No se pudo confirmar la recepción de tu decisión.',
    },
    pt: {
        conversation: 'Conversa com o Foreman',
        message: 'Escreva para o Foreman',
        opening: 'Abrindo o Foreman…',
        working: 'Em andamento…',
        confirming: 'Confirmando…',
        decisionUncertain: 'Não foi possível confirmar o recebimento da sua decisão.',
    },
    de: {
        conversation: 'Unterhaltung mit dem Foreman',
        message: 'Nachricht an den Foreman schreiben',
        opening: 'Foreman wird geöffnet…',
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
        placeholder: locale === 'en' ? 'Ask the Foreman…' : `${source.foreman.pill.ask}…`,
        tabs: source.kit.foreman.tabs,
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
