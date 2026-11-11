import { desktopNotificationMessages } from './i18n/notification-messages'
import { desktopActionMessages } from './i18n/action-messages'
import { desktopCreationMessages } from './i18n/creation-messages'
import { desktopCoworkerMessages } from './i18n/coworker-messages'
import { desktopForemanMessages } from './i18n/foreman-messages'
import { desktopGettingStartedMessages } from './i18n/getting-started-messages'
import { desktopRoutineMessages } from './i18n/routine-messages'
import { desktopQuestionMessages } from './i18n/question-messages'
import { desktopThreadHistoryCopy } from './i18n/thread-history-messages'
import { desktopControlCenterDetails } from './i18n/control-center-messages'
import dialogs from '@rerun/i18n/messages/en/dialogs.json'
import type { Locale } from '@rerun/i18n'
import { createTranslator } from 'use-intl/core'
import account from '@rerun/i18n/messages/en/account.json'
import agent from '@rerun/i18n/messages/en/agent.json'
import chat from '@rerun/i18n/messages/en/chat.json'
import common from '@rerun/i18n/messages/en/common.json'
import connections from '@rerun/i18n/messages/en/connections.json'
import foreman from '@rerun/i18n/messages/en/foreman.json'
import kit from '@rerun/i18n/messages/en/kit.json'
import layout from '@rerun/i18n/messages/en/layout.json'
import notifications from '@rerun/i18n/messages/en/notifications.json'
import mobileSettings from '@rerun/i18n/messages/en/mobileSettings.json'
import workspace from '@rerun/i18n/messages/en/workspace.json'

const englishSource = { account, agent, chat, common, connections, dialogs, foreman, kit, layout, mobileSettings, notifications, workspace }
type DesktopMessageSource = typeof englishSource

const aiProviderTool = {
    en: { label: 'See its AI providers', description: 'Read the model in use, workspace provider availability, and reported subscription limits.' },
    fr: { label: "Voir ses fournisseurs d'IA", description: 'Consulter le modèle utilisé, les fournisseurs de l’espace de travail et les limites d’abonnement connues.' },
    es: { label: 'Ver sus proveedores de IA', description: 'Consulta el modelo en uso, los proveedores del espacio de trabajo y los límites conocidos de la suscripción.' },
    pt: { label: 'Ver seus provedores de IA', description: 'Consulta o modelo em uso, os provedores do espaço de trabalho e os limites conhecidos da assinatura.' },
    de: { label: 'Eigene KI-Anbieter sehen', description: 'Liest das verwendete Modell, die Anbieter des Arbeitsbereichs und gemeldete Abolimits.' },
} satisfies Record<Locale, { label: string; description: string }>

// The shared packs already contain the standard controls. These labels are specific to the Mac shell.
const mac = {
    en: {
        helpDescription: 'Docs and shortcuts for this Mac. Getting started stays here after you hide the checklist.',
        controlCenterOutsideInput: 'Open the control center, outside a chat or text field',
        closeTabOutsideInput: 'Close active tab, outside a text field',
        board: 'Team board',
        boardActions: 'Board actions',
        addBox: 'Add Box',
        openCoworker: 'Open chat with {name}',
        coworkerChat: 'Coworker chat',
        openingCoworkerChat: 'Opening {name}…',
        openingSavedChat: 'Opening conversation…',
        savedChatUnavailable: 'This conversation is no longer available for this coworker.',
        retryConversations: 'Retry conversations',
        backToChat: 'Back to chat',
        toolServices: 'Tool services',
        settingsSections: 'Settings sections',
        workspaceName: 'Workspace name',
        saveName: 'Save name',
        appearance: 'Appearance',
        searchChats: 'Search conversations',
        chatMessages: 'Chat messages',
        savedLanguage: 'Language saved.',
        systemLanguage: 'Follows your system: {language}.',
    },
    fr: {
        helpDescription: 'Documentation et raccourcis pour ce Mac. Les premiers pas restent accessibles ici après avoir masqué la liste.',
        controlCenterOutsideInput: 'Ouvrir le centre de contrôle en dehors d’une conversation ou d’un champ de texte',
        closeTabOutsideInput: 'Fermer l’onglet actif en dehors d’un champ de texte',
        board: 'Tableau d’équipe',
        boardActions: 'Actions du tableau',
        addBox: 'Ajouter une Box',
        openCoworker: 'Ouvrir la conversation avec {name}',
        coworkerChat: 'Conversation avec le collègue',
        openingCoworkerChat: 'Ouverture de la conversation avec {name}…',
        openingSavedChat: 'Ouverture de la conversation…',
        savedChatUnavailable: 'Cette conversation n’est plus disponible pour ce collègue.',
        retryConversations: 'Recharger les conversations',
        backToChat: 'Retour à la conversation',
        toolServices: 'Services d’outils',
        settingsSections: 'Sections des paramètres',
        workspaceName: 'Nom de l’espace de travail',
        saveName: 'Enregistrer le nom',
        appearance: 'Apparence',
        searchChats: 'Rechercher des conversations',
        chatMessages: 'Messages de la conversation',
        savedLanguage: 'Langue enregistrée.',
        systemLanguage: 'Suit la langue du système : {language}.',
    },
    es: {
        helpDescription: 'Documentación y atajos para este Mac. Puedes volver a Primeros pasos aquí aunque ocultes la lista.',
        controlCenterOutsideInput: 'Abrir el centro de control fuera de un chat o campo de texto',
        closeTabOutsideInput: 'Cerrar la pestaña activa fuera de un campo de texto',
        board: 'Tablero del equipo',
        boardActions: 'Acciones del tablero',
        addBox: 'Añadir una Box',
        openCoworker: 'Abrir el chat con {name}',
        coworkerChat: 'Chat con el compañero',
        openingCoworkerChat: 'Abriendo el chat con {name}…',
        openingSavedChat: 'Abriendo la conversación…',
        savedChatUnavailable: 'Esta conversación ya no está disponible para este compañero.',
        retryConversations: 'Volver a cargar las conversaciones',
        backToChat: 'Volver al chat',
        toolServices: 'Servicios de herramientas',
        settingsSections: 'Secciones de configuración',
        workspaceName: 'Nombre del espacio de trabajo',
        saveName: 'Guardar nombre',
        appearance: 'Apariencia',
        searchChats: 'Buscar conversaciones',
        chatMessages: 'Mensajes del chat',
        savedLanguage: 'Idioma guardado.',
        systemLanguage: 'Sigue el idioma del sistema: {language}.',
    },
    pt: {
        helpDescription: 'Documentação e atalhos para este Mac. Você pode voltar a Primeiros passos aqui mesmo depois de ocultar a lista.',
        controlCenterOutsideInput: 'Abrir a central de controle fora de uma conversa ou de um campo de texto',
        closeTabOutsideInput: 'Fechar a aba ativa fora de um campo de texto',
        board: 'Quadro da equipe',
        boardActions: 'Ações do quadro',
        addBox: 'Adicionar uma Box',
        openCoworker: 'Abrir conversa com {name}',
        coworkerChat: 'Conversa com o colega',
        openingCoworkerChat: 'Abrindo a conversa com {name}…',
        openingSavedChat: 'Abrindo a conversa…',
        savedChatUnavailable: 'Esta conversa não está mais disponível para este colega.',
        retryConversations: 'Recarregar conversas',
        backToChat: 'Voltar para a conversa',
        toolServices: 'Serviços de ferramentas',
        settingsSections: 'Seções das configurações',
        workspaceName: 'Nome do espaço de trabalho',
        saveName: 'Salvar nome',
        appearance: 'Aparência',
        searchChats: 'Pesquisar conversas',
        chatMessages: 'Mensagens da conversa',
        savedLanguage: 'Idioma salvo.',
        systemLanguage: 'Segue o idioma do sistema: {language}.',
    },
    de: {
        helpDescription: 'Dokumentation und Tastenkürzel für diesen Mac. Erste Schritte bleiben hier verfügbar, wenn du die Checkliste ausblendest.',
        controlCenterOutsideInput: 'Kontrollzentrum außerhalb eines Chats oder Textfelds öffnen',
        closeTabOutsideInput: 'Aktiven Tab außerhalb eines Textfelds schließen',
        board: 'Team-Board',
        boardActions: 'Board-Aktionen',
        addBox: 'Box hinzufügen',
        openCoworker: 'Chat mit {name} öffnen',
        coworkerChat: 'Chat mit dem Kollegen',
        openingCoworkerChat: 'Chat mit {name} wird geöffnet…',
        openingSavedChat: 'Unterhaltung wird geöffnet…',
        savedChatUnavailable: 'Diese Unterhaltung ist für diesen Kollegen nicht mehr verfügbar.',
        retryConversations: 'Unterhaltungen erneut laden',
        backToChat: 'Zurück zum Chat',
        toolServices: 'Werkzeugdienste',
        settingsSections: 'Einstellungsbereiche',
        workspaceName: 'Name des Arbeitsbereichs',
        saveName: 'Namen speichern',
        appearance: 'Erscheinungsbild',
        searchChats: 'Unterhaltungen suchen',
        chatMessages: 'Chatnachrichten',
        savedLanguage: 'Sprache gespeichert.',
        systemLanguage: 'Verwendet die Systemsprache: {language}.',
    },
} satisfies Record<Locale, Record<string, string>>

const desktopControlCenterCopy = {
    en: {
        desktopDescription: 'Jump to a coworker, model settings or a saved conversation.',
        search: 'Search coworkers, settings, conversations…',
        closeHint: 'to close',
    },
    fr: {
        desktopDescription: 'Accédez à un coworker, aux paramètres des modèles ou à une conversation enregistrée.',
        search: 'Rechercher des coworkers, des paramètres ou des conversations…',
        closeHint: 'pour fermer',
    },
    es: {
        desktopDescription: 'Abre un compañero, la configuración de modelos o una conversación guardada.',
        search: 'Busca compañeros, ajustes o conversaciones…',
        closeHint: 'para cerrar',
    },
    pt: {
        desktopDescription: 'Abra um colega, as configurações de modelos ou uma conversa salva.',
        search: 'Busque colegas, configurações ou conversas…',
        closeHint: 'para fechar',
    },
    de: {
        desktopDescription: 'Öffne einen Kollegen, die Modelleinstellungen oder eine gespeicherte Unterhaltung.',
        search: 'Kollegen, Einstellungen oder Unterhaltungen suchen…',
        closeHint: 'zum Schließen',
    },
} satisfies Record<Locale, { desktopDescription: string; search: string; closeHint: string }>

export function desktopMessages(locale: Locale, source: DesktopMessageSource) {
    return {
        ...mac[locale],
        aiProviderTool: aiProviderTool[locale],
        actions: desktopActionMessages(locale, source.kit),
        notificationSettings: source.notifications.settings,
        notificationUI: desktopNotificationMessages(locale),
        questionForm: source.kit.chat.question,
        question: desktopQuestionMessages(locale),
        threadHistory: {
            ...desktopThreadHistoryCopy[locale],
            markAllRead: source.agent.agentChatsList.markAllRead,
            markRead: source.kit.inbox.markRead,
            status: source.kit.inbox.sentences,
            retry: source.kit.chat.skillProposal.retry,
        },
        controlCenter: {
            ...source.layout.controlCenter,
            ...desktopControlCenterCopy[locale],
            details: desktopControlCenterDetails[locale],
            coworkerTabs: source.agent.agentTabs,
            localCommands: {
                team_board: mac[locale].board,
                getting_started: source.layout.menu.gettingStarted,
                help: source.layout.help.label,
                servers: source.layout.workspaceMenu.servers,
            },
        },
        coworker: desktopCoworkerMessages(locale, source),
        creation: desktopCreationMessages(locale, source),
        foreman: desktopForemanMessages(locale, source),
        gettingStarted: desktopGettingStartedMessages(locale, source.foreman.gettingStarted),
        routines: desktopRoutineMessages(locale, source),
        language: source.account.language.field,
        automatic: source.account.language.automatic,
        languageFailed: source.account.language.failed,
        settings: source.layout.workspaceMenu.settings,
        help: source.layout.help.label,
        helpItems: {
            getting_started: source.layout.menu.gettingStarted,
            docs: source.layout.menu.docs,
            community: source.layout.menu.community,
            shortcuts: source.layout.menu.shortcuts,
            experts: source.layout.menu.hireExpert,
        },
        shortcutDialog: source.dialogs.shortcuts,
        closeDialog: source.kit.close,
        workspaceSettings: source.workspace.settings.title,
        providers: source.layout.workspaceMenu.aiProviders,
        defaultModel: source.connections.models.defaultModel,
        workspace: source.workspace.settings.fallbackName,
        notifications: source.layout.workspaceMenu.notifications,
        shortcuts: source.layout.menu.shortcuts,
        templates: source.layout.workspaceMenu.templates,
        addCoworker: source.mobileSettings.notifications.perCoworker.add,
        general: source.agent.openChatsTabs.general,
        threads: source.agent.agentChatsList.title,
        all: source.agent.agentChatsList.filters.all,
        chats: locale === 'en' ? 'Threads' : source.agent.agentChatsList.filters.chats,
        automations: source.agent.agentChatsList.filters.automations,
        emptyThreads: source.agent.agentChatsList.emptyThreads,
        emptyAutomations: source.agent.agentChatsList.emptyAutomations,
        emptyNeeds: source.agent.agentChatsList.emptyNeeds,
        newThread: source.agent.openChatsTabs.newThread,
        closeTab: source.agent.openChatsTabs.closeTab,
        closePanel: source.layout.sidePanel.close,
        needs: source.agent.threadBranch.needs,
        error: source.agent.threadBranch.error,
        running: source.agent.agentChatsList.running,
        schedule: source.agent.threadBranch.opener.schedule,
        trigger: source.agent.threadBranch.opener.trigger,
        askedBy: source.agent.threadBranch.opener.askedBy,
        askedByUnknown: source.agent.threadBranch.opener.askedByUnknown,
        started: source.agent.threadBranch.opener.started,
        message: source.agent.agentSheetChat.messagePlaceholder,
        reply: source.agent.agentSheetChat.replyPlaceholder,
        sendMessage: locale === 'en' ? 'Send a message…' : source.chat.composer.placeholder,
        send: source.chat.composer.editor.send,
        stop: source.chat.promptInput.stop,
        cancel: source.common.cancel,
    }
}

export type DesktopMessages = ReturnType<typeof desktopMessages>
export type DesktopLanguage = { preference: Locale | null; locale: Locale; messages: DesktopMessages }
export const englishDesktopLanguage: DesktopLanguage = { preference: null, locale: 'en', messages: desktopMessages('en', englishSource) }
export const desktopLocaleTag = (locale: Locale) => locale === 'pt' ? 'pt-BR' : locale

export function desktopTranslator(language: DesktopLanguage) {
    return createTranslator({ locale: desktopLocaleTag(language.locale), messages: language.messages })
}
