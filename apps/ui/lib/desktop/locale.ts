import { desktopCreationMessages } from './i18n/creation-messages'
import { desktopCoworkerMessages } from './i18n/coworker-messages'
import { desktopForemanMessages } from './i18n/foreman-messages'
import { desktopRoutineMessages } from './i18n/routine-messages'
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
import mobileSettings from '@rerun/i18n/messages/en/mobileSettings.json'
import workspace from '@rerun/i18n/messages/en/workspace.json'

const englishSource = { account, agent, chat, common, connections, dialogs, foreman, kit, layout, mobileSettings, workspace }
type DesktopMessageSource = typeof englishSource

// The shared packs already contain the standard controls. These labels are specific to the Mac shell.
const mac = {
    en: {
        board: 'Team board',
        boardActions: 'Board actions',
        addBox: 'Add Box',
        openCoworker: 'Open chat with {name}',
        coworkerChat: 'Coworker chat',
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
        board: 'Tableau d’équipe',
        boardActions: 'Actions du tableau',
        addBox: 'Ajouter une Box',
        openCoworker: 'Ouvrir la conversation avec {name}',
        coworkerChat: 'Conversation avec le collègue',
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
        board: 'Tablero del equipo',
        boardActions: 'Acciones del tablero',
        addBox: 'Añadir una Box',
        openCoworker: 'Abrir el chat con {name}',
        coworkerChat: 'Chat con el compañero',
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
        board: 'Quadro da equipe',
        boardActions: 'Ações do quadro',
        addBox: 'Adicionar uma Box',
        openCoworker: 'Abrir conversa com {name}',
        coworkerChat: 'Conversa com o colega',
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
        board: 'Team-Board',
        boardActions: 'Board-Aktionen',
        addBox: 'Box hinzufügen',
        openCoworker: 'Chat mit {name} öffnen',
        coworkerChat: 'Chat mit dem Kollegen',
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

export function desktopMessages(locale: Locale, source: DesktopMessageSource) {
    return {
        ...mac[locale],
        coworker: desktopCoworkerMessages(locale, source),
        creation: desktopCreationMessages(locale, source),
        foreman: desktopForemanMessages(locale, source),
        routines: desktopRoutineMessages(locale, source),
        language: source.account.language.field,
        automatic: source.account.language.automatic,
        languageFailed: source.account.language.failed,
        settings: source.layout.workspaceMenu.settings,
        help: source.layout.help.label,
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
