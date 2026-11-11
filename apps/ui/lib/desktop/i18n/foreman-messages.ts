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

const alternateCopy = {
    en: { title: 'Reply retries', original: 'Original conversation', entry: 'Retry {number}', check: 'Check retry', loading: 'Opening retry…',
        confirm: 'Draft another answer in a separate conversation using the saved chat and original model.',
        status: { prepared: 'Ready to start.', uncertain: 'Preparation is unconfirmed.', running: 'Drafting a reply…', error: 'The retry failed.', cancelled: 'Retry stopped.' } },
    fr: { title: 'Nouvelles réponses', original: 'Conversation originale', entry: 'Tentative {number}', check: 'Vérifier la tentative', loading: 'Ouverture…',
        confirm: 'Rédigez une autre réponse dans une conversation distincte avec l’historique et le modèle d’origine.',
        status: { prepared: 'Prêt à démarrer.', uncertain: 'La préparation reste à confirmer.', running: 'Rédaction de la réponse…', error: 'La tentative a échoué.', cancelled: 'Tentative arrêtée.' } },
    es: { title: 'Reintentos de respuesta', original: 'Conversación original', entry: 'Intento {number}', check: 'Comprobar intento', loading: 'Abriendo intento…',
        confirm: 'Redacta otra respuesta en una conversación aparte con el historial y el modelo original.',
        status: { prepared: 'Listo para empezar.', uncertain: 'La preparación está por confirmar.', running: 'Redactando una respuesta…', error: 'El intento falló.', cancelled: 'Intento detenido.' } },
    pt: { title: 'Novas tentativas', original: 'Conversa original', entry: 'Tentativa {number}', check: 'Verificar tentativa', loading: 'Abrindo tentativa…',
        confirm: 'Escreva outra resposta em uma conversa separada com o histórico e o modelo original.',
        status: { prepared: 'Tudo pronto para começar.', uncertain: 'A preparação ainda precisa de confirmação.', running: 'Escrevendo uma resposta…', error: 'A tentativa falhou.', cancelled: 'Tentativa interrompida.' } },
    de: { title: 'Neue Antwortversuche', original: 'Ursprüngliche Unterhaltung', entry: 'Versuch {number}', check: 'Versuch prüfen', loading: 'Versuch wird geöffnet…',
        confirm: 'Entwirf eine weitere Antwort in einer separaten Unterhaltung mit dem gespeicherten Verlauf und dem ursprünglichen Modell.',
        status: { prepared: 'Bereit zum Start.', uncertain: 'Die Vorbereitung ist noch nicht bestätigt.', running: 'Antwort wird entworfen…', error: 'Der Versuch ist fehlgeschlagen.', cancelled: 'Versuch gestoppt.' } },
} satisfies Record<Locale, { title: string; original: string; entry: string; check: string; loading: string; confirm: string; status: Record<'prepared' | 'uncertain' | 'running' | 'error' | 'cancelled', string> }>

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
        alternates: { ...alternateCopy[locale], regenerate: source.chat.message.regenerate, cancel: source.chat.composer.editor.cancel },
        welcome: { title: welcome.title, preparing: welcome.preparing },
        failedReply: dock.failedReply,
        plan: {
            skipped: plan.skipped, confirmed: plan.confirmed, askedChanges: plan.askedChanges,
            goesAfter: plan.goesAfter, thisWeek: plan.thisWeek, previousBox: plan.previousBox, nextBox: plan.nextBox,
            build: plan.build, change: plan.change, standingBy: plan.standingBy,
        },
    }
}
