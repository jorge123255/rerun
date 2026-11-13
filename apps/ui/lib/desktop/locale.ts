import { desktopNotificationMessages } from './i18n/notification-messages'
import { desktopActionMessages } from './i18n/action-messages'
import { desktopCreationMessages } from './i18n/creation-messages'
import { desktopCoworkerMessages } from './i18n/coworker-messages'
import { desktopForemanMessages } from './i18n/foreman-messages'
import { desktopGettingStartedMessages } from './i18n/getting-started-messages'
import { desktopRoutineMessages } from './i18n/routine-messages'
import { desktopQuestionMessages } from './i18n/question-messages'
import { desktopThreadHistoryCopy } from './i18n/thread-history-messages'
import { desktopMonitoringCopy } from './i18n/monitoring-messages'
import { desktopRunHistoryCopy } from './i18n/run-history-messages'
import { desktopControlCenterDetails } from './i18n/control-center-messages'
import { desktopBrainCopy } from './i18n/brain-messages'
import { desktopSharedFilesCopy } from './i18n/shared-files-messages'
import { desktopMcpSignInCopy } from './i18n/mcp-sign-in-messages'
import { macSettingsCopy } from './i18n/mac-settings-messages'
import { desktopBoardCopy } from './i18n/board-messages'
import { desktopQueueCopy } from './i18n/queue-messages'
import dialogs from '@rerun/i18n/messages/en/dialogs.json'
import type { Locale } from '@rerun/i18n'
import { createTranslator } from 'use-intl/core'
import account from '@rerun/i18n/messages/en/account.json'
import agent from '@rerun/i18n/messages/en/agent.json'
import brain from '@rerun/i18n/messages/en/brain.json'
import builder from '@rerun/i18n/messages/en/builder.json'
import changelog from '@rerun/i18n/messages/en/changelog.json'
import chat from '@rerun/i18n/messages/en/chat.json'
import common from '@rerun/i18n/messages/en/common.json'
import connections from '@rerun/i18n/messages/en/connections.json'
import data from '@rerun/i18n/messages/en/data.json'
import files from '@rerun/i18n/messages/en/files.json'
import foreman from '@rerun/i18n/messages/en/foreman.json'
import kit from '@rerun/i18n/messages/en/kit.json'
import layout from '@rerun/i18n/messages/en/layout.json'
import notifications from '@rerun/i18n/messages/en/notifications.json'
import mobileChat from '@rerun/i18n/messages/en/mobileChat.json'
import mobileSettings from '@rerun/i18n/messages/en/mobileSettings.json'
import services from '@rerun/i18n/messages/en/services.json'
import subRuns from '@rerun/i18n/messages/en/subRuns.json'
import workspace from '@rerun/i18n/messages/en/workspace.json'
import ui from '@rerun/i18n/messages/en/ui.json'

const englishSource = { account, agent, brain, builder, changelog, chat, common, connections, data, dialogs, files, foreman, kit, layout, mobileChat, mobileSettings, notifications, services, subRuns, workspace, ui }
type DesktopMessageSource = typeof englishSource

const desktopSetupAuthorCopy = {
    en: {
        intro: 'An imported copy of this coworker starts with no credentials or tools enabled. These instructions guide its setup when you first open it.',
        answerHint: 'Answer before including this coworker in a private template.',
        discardTitle: 'Discard unsaved setup changes?',
        discardDescription: 'Your changes to the required answer and install instructions will be lost.',
    },
    fr: {
        intro: 'Une copie importée de ce coworker démarre sans identifiants ni outils activés. Ces instructions guident sa configuration à la première ouverture.',
        answerHint: 'Répondez avant d’inclure ce coworker dans un template privé.',
        discardTitle: 'Ignorer les modifications de l’installation ?',
        discardDescription: 'Votre réponse et les modifications apportées aux instructions d’installation seront perdues.',
    },
    es: {
        intro: 'Una copia importada de este coworker empieza sin credenciales ni herramientas activadas. Estas instrucciones guían su configuración al abrirla por primera vez.',
        answerHint: 'Responde antes de incluir este coworker en una plantilla privada.',
        discardTitle: '¿Descartar los cambios de instalación sin guardar?',
        discardDescription: 'Se perderán los cambios en la respuesta y en las instrucciones de instalación.',
    },
    pt: {
        intro: 'Uma cópia importada deste coworker começa sem credenciais nem ferramentas ativadas. Estas instruções orientam a configuração na primeira abertura.',
        answerHint: 'Responda antes de incluir este coworker em um template privado.',
        discardTitle: 'Descartar as alterações de instalação não salvas?',
        discardDescription: 'As alterações na resposta e nas instruções de instalação serão perdidas.',
    },
    de: {
        intro: 'Eine importierte Kopie dieses Coworkers startet ohne Zugangsdaten oder aktivierte Tools. Diese Anweisungen leiten die Einrichtung beim ersten Öffnen.',
        answerHint: 'Beantworte die Frage, bevor du diesen Coworker in eine private Vorlage aufnimmst.',
        discardTitle: 'Ungespeicherte Änderungen an der Installation verwerfen?',
        discardDescription: 'Deine Änderungen an der Antwort und den Installationsanweisungen gehen verloren.',
    },
} satisfies Record<Locale, Record<string, string>>

const desktopChangelogCopy = {
    en: { loading: 'Loading updates…', unavailable: 'Updates couldn’t load. Try again when you’re online.', empty: 'No updates have been published.', readUpdate: 'Read the full update', retry: 'Try again', saved: 'Showing saved updates.' },
    fr: { loading: 'Chargement des nouveautés…', unavailable: 'Impossible de charger les nouveautés. Réessayez lorsque vous êtes en ligne.', empty: 'Aucune nouveauté publiée.', readUpdate: 'Lire la nouveauté complète', retry: 'Réessayer', saved: 'Nouveautés enregistrées.' },
    es: { loading: 'Cargando novedades…', unavailable: 'No se pudieron cargar las novedades. Inténtalo cuando tengas conexión.', empty: 'No hay novedades publicadas.', readUpdate: 'Leer la novedad completa', retry: 'Reintentar', saved: 'Mostrando las novedades guardadas.' },
    pt: { loading: 'Carregando novidades…', unavailable: 'Não foi possível carregar as novidades. Tente novamente quando estiver online.', empty: 'Nenhuma novidade foi publicada.', readUpdate: 'Ler a novidade completa', retry: 'Tentar novamente', saved: 'Mostrando as novidades salvas.' },
    de: { loading: 'Neuigkeiten werden geladen…', unavailable: 'Neuigkeiten konnten nicht geladen werden. Versuche es erneut, sobald du online bist.', empty: 'Es wurden keine Neuigkeiten veröffentlicht.', readUpdate: 'Vollständige Neuigkeit lesen', retry: 'Erneut versuchen', saved: 'Gespeicherte Neuigkeiten werden angezeigt.' },
}

const copyDeviceCodeFailure = {
    en: 'Could not copy the code. Select it to copy it manually.',
    fr: 'Impossible de copier le code. Sélectionnez-le pour le copier manuellement.',
    es: 'No se pudo copiar el código. Selecciónalo para copiarlo manualmente.',
    pt: 'Não foi possível copiar o código. Selecione-o para copiar manualmente.',
    de: 'Der Code konnte nicht kopiert werden. Wähle ihn aus, um ihn manuell zu kopieren.',
} satisfies Record<Locale, string>

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
        setUpTranscription: 'Set up transcription',
        settingsSections: 'Settings sections',
        appStoreLocalProviders: 'Use an API key or a custom endpoint for this local workspace. Local subscription sign-in and native command tools require the direct Mac build.',
        workspaceName: 'Workspace name',
        saveName: 'Save name',
        appearance: 'Appearance',
        copyReply: 'Copy reply',
        copyReplyFailed: 'Could not copy this reply. Try again.',
        regenerateReplyHint: 'Opens a new chat and keeps the original',
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
        setUpTranscription: 'Configurer la transcription',
        settingsSections: 'Sections des paramètres',
        appStoreLocalProviders: 'Utilisez une clé API ou un point de terminaison personnalisé pour cet espace local. La connexion aux abonnements et les outils de commande natifs nécessitent la version Mac directe.',
        workspaceName: 'Nom de l’espace de travail',
        saveName: 'Enregistrer le nom',
        appearance: 'Apparence',
        copyReply: 'Copier la réponse',
        copyReplyFailed: 'Impossible de copier cette réponse. Réessayez.',
        regenerateReplyHint: 'Ouvre une nouvelle conversation et conserve l’originale',
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
        setUpTranscription: 'Configurar la transcripción',
        settingsSections: 'Secciones de configuración',
        appStoreLocalProviders: 'Usa una clave de API o un endpoint personalizado en este espacio local. El inicio de sesión con suscripciones y las herramientas de comandos nativas requieren la versión directa para Mac.',
        workspaceName: 'Nombre del espacio de trabajo',
        saveName: 'Guardar nombre',
        appearance: 'Apariencia',
        copyReply: 'Copiar la respuesta',
        copyReplyFailed: 'No se pudo copiar esta respuesta. Inténtalo de nuevo.',
        regenerateReplyHint: 'Abre una conversación nueva y conserva la original',
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
        setUpTranscription: 'Configurar a transcrição',
        settingsSections: 'Seções das configurações',
        appStoreLocalProviders: 'Use uma chave de API ou um endpoint personalizado neste espaço local. O acesso por assinatura e as ferramentas de comandos nativos exigem a versão direta para Mac.',
        workspaceName: 'Nome do espaço de trabalho',
        saveName: 'Salvar nome',
        appearance: 'Aparência',
        copyReply: 'Copiar resposta',
        copyReplyFailed: 'Não foi possível copiar esta resposta. Tente novamente.',
        regenerateReplyHint: 'Abre uma nova conversa e mantém a original',
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
        setUpTranscription: 'Transkription einrichten',
        settingsSections: 'Einstellungsbereiche',
        appStoreLocalProviders: 'Verwende für diesen lokalen Arbeitsbereich einen API-Schlüssel oder einen eigenen Endpunkt. Die Abo-Anmeldung und native Befehlswerkzeuge benötigen die direkt installierte Mac-Version.',
        workspaceName: 'Name des Arbeitsbereichs',
        saveName: 'Namen speichern',
        appearance: 'Erscheinungsbild',
        copyReply: 'Antwort kopieren',
        copyReplyFailed: 'Die Antwort konnte nicht kopiert werden. Versuche es erneut.',
        regenerateReplyHint: 'Öffnet eine neue Unterhaltung und behält das Original',
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

const localProfileCopy = {
    en: { description: 'Your display name and photo on this Mac.', photoHelp: 'Shown in the workspace menu.' },
    fr: { description: 'Votre nom et votre photo sur ce Mac.', photoHelp: 'Visible dans le menu de l’espace de travail.' },
    es: { description: 'Tu nombre y tu foto en este Mac.', photoHelp: 'Se muestra en el menú del espacio de trabajo.' },
    pt: { description: 'Seu nome e sua foto neste Mac.', photoHelp: 'Exibida no menu do espaço de trabalho.' },
    de: { description: 'Dein Name und dein Foto auf diesem Mac.', photoHelp: 'Wird im Arbeitsbereichsmenü angezeigt.' },
} satisfies Record<Locale, { description: string; photoHelp: string }>

const desktopModelPickerCopy = {
    en: {
        scope: 'Choosing a model changes only this chat. The star sets this coworker’s default.',
        conversation: 'This chat', unavailable: 'Unavailable · {model}',
        workspaceRequired: 'Choose a workspace default model in Settings before sending a message.',
        savedUnavailable: 'This saved model is no longer offered. Choose another model or use a default.',
        coworkerPin: '{model} is this coworker’s default',
    },
    fr: {
        scope: 'Le choix du modèle s’applique uniquement à cette conversation. L’étoile définit le modèle par défaut du collègue.',
        conversation: 'Cette conversation', unavailable: 'Indisponible · {model}',
        workspaceRequired: 'Choisissez un modèle par défaut pour l’espace de travail dans les paramètres avant d’envoyer un message.',
        savedUnavailable: 'Ce modèle enregistré n’est plus proposé. Choisissez un autre modèle ou utilisez un modèle par défaut.',
        coworkerPin: '{model} est le modèle par défaut de ce collègue',
    },
    es: {
        scope: 'La elección del modelo solo se aplica a este chat. La estrella fija el modelo predeterminado del compañero.',
        conversation: 'Este chat', unavailable: 'No disponible · {model}',
        workspaceRequired: 'Elige un modelo predeterminado para el espacio de trabajo en los ajustes antes de enviar un mensaje.',
        savedUnavailable: 'Este modelo guardado ya no se ofrece. Elige otro modelo o usa uno predeterminado.',
        coworkerPin: '{model} es el modelo predeterminado de este compañero',
    },
    pt: {
        scope: 'A escolha do modelo só se aplica a esta conversa. A estrela define o modelo padrão do colega.',
        conversation: 'Esta conversa', unavailable: 'Indisponível · {model}',
        workspaceRequired: 'Escolha um modelo padrão para o espaço de trabalho nas configurações antes de enviar uma mensagem.',
        savedUnavailable: 'Este modelo salvo não é mais oferecido. Escolha outro modelo ou use um modelo padrão.',
        coworkerPin: '{model} é o modelo padrão deste colega',
    },
    de: {
        scope: 'Die Modellauswahl gilt nur für diesen Chat. Der Stern legt das Standardmodell des Kollegen fest.',
        conversation: 'Dieser Chat', unavailable: 'Nicht verfügbar · {model}',
        workspaceRequired: 'Wähle vor dem Senden in den Einstellungen ein Standardmodell für den Arbeitsbereich.',
        savedUnavailable: 'Dieses gespeicherte Modell wird nicht mehr angeboten. Wähle ein anderes Modell oder verwende ein Standardmodell.',
        coworkerPin: '{model} ist das Standardmodell dieses Kollegen',
    },
}

const workspaceCreationRecovery = {
    en: { checkCreation: 'Check creation', unconfirmed: 'Could not confirm workspace creation. Check the same request to avoid creating a duplicate.' },
    fr: { checkCreation: 'Vérifier la création', unconfirmed: 'La création du workspace n’a pas pu être confirmée. Vérifiez la même demande pour éviter un doublon.' },
    es: { checkCreation: 'Comprobar la creación', unconfirmed: 'No se pudo confirmar la creación del espacio de trabajo. Comprueba la misma solicitud para evitar duplicados.' },
    pt: { checkCreation: 'Verificar criação', unconfirmed: 'Não foi possível confirmar a criação do espaço de trabalho. Verifique a mesma solicitação para evitar duplicatas.' },
    de: { checkCreation: 'Erstellung prüfen', unconfirmed: 'Die Erstellung des Arbeitsbereichs konnte nicht bestätigt werden. Prüfe dieselbe Anfrage, um ein Duplikat zu vermeiden.' },
}

export function desktopMessages(locale: Locale, source: DesktopMessageSource) {
    return {
        ...mac[locale],
        boardUI: { ...desktopBoardCopy[locale], create: source.builder.toolbar.create },
        macSettings: macSettingsCopy[locale],
        newWorkspace: {
            ...source.dialogs.createWorkspace,
            ...workspaceCreationRecovery[locale],
            menu: source.layout.workspaceMenu.newWorkspace,
        },
        workspaceForm: {
            ...source.workspace.settings,
            close: source.ui.close,
            cancel: source.common.cancel,
            save: source.common.save,
            saving: source.common.saving,
            retry: source.ui.upload.retry,
        },
        brain: source.brain,
        files: source.files,
        fileUpload: source.ui.upload,
        sharedFiles: desktopSharedFilesCopy[locale],
        mcpSignIn: {
            ...desktopMcpSignInCopy[locale],
            title: source.chat.mcpSignIn.title,
            custom: source.chat.mcpServer.custom,
            customWithHost: source.chat.mcpServer.customWithHost,
            connect: source.chat.actions.connect,
            continue: source.chat.actions.continue,
            notNow: source.chat.actions.notNow,
            cancel: source.chat.actions.cancel,
            waiting: source.services.connect.waiting,
            connected: source.chat.receipt.status.connected,
            skipped: source.chat.receipt.dismissed.mcp,
            needsAuth: source.services.customMcp.status.needsAuth,
            unreachable: source.services.customMcp.status.unreachable,
        },
        localProfile: { ...localProfileCopy[locale], title: source.account.tabs.profile.label, fields: source.account.profile },
        brainDesktop: desktopBrainCopy[locale],
        sharedData: {
            emptyTitle: source.data.shared.emptyTitle,
            emptyDescription: source.data.shared.emptyDescription,
        },
        aiProviderTool: aiProviderTool[locale],
        actions: desktopActionMessages(locale, source.kit),
        notificationToast: source.notifications.toast,
        notificationSettings: source.notifications.settings,
        notificationRowMenu: source.notifications.inbox.rowMenu,
        notificationUI: desktopNotificationMessages(locale),
        questionForm: source.kit.chat.question,
        question: desktopQuestionMessages(locale),
        monitoring: {
            ...source.agent.agentPanelMonitoring,
            ...desktopMonitoringCopy[locale],
            title: source.agent.agentTabs.monitoring.label,
            kit: source.kit.monitoring,
        },
        runHistory: {
            ...desktopRunHistoryCopy[locale],
            button: locale === 'en' ? 'Runs' : source.agent.agentTabs.logs.label,
            empty: source.agent.agentPanelLogs.empty,
            tokens: source.agent.agentPanelLogs.tokens,
            stepCount: source.agent.agentPanelLogs.stepCount,
            step: source.agent.agentPanelLogs.step,
            noSteps: source.agent.agentPanelLogs.noSteps,
            status: source.kit.monitoring.runStatus,
        },
        threadHistory: {
            ...desktopThreadHistoryCopy[locale],
            close: source.agent.agentChatsList.close,
            startedBy: source.agent.agentChatsList.startedBy,
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
        coworkerSetup: {
            author: { ...source.agent.agentPanelSetup, ...desktopSetupAuthorCopy[locale] },
            fields: source.agent.agentSetupFields,
            tab: source.agent.agentTabs.setup,
            editor: source.ui.markdown,
            gate: source.chat.installGate,
            skipped: source.agent.agentPanelChat,
            install: source.chat.agentInstall,
            loading: source.kit.primitives.loading,
            retry: source.ui.upload.retry,
        },
        creation: desktopCreationMessages(locale, source),
        foreman: desktopForemanMessages(locale, source),
        gettingStarted: desktopGettingStartedMessages(locale, source.foreman.gettingStarted),
        routines: desktopRoutineMessages(locale, source),
        language: source.account.language.field,
        automatic: source.account.language.automatic,
        languageFailed: source.account.language.failed,
        settings: source.layout.workspaceMenu.settings,
        help: source.layout.help.label,
        changelog: { ...source.changelog, ...desktopChangelogCopy[locale] },
        helpItems: {
            getting_started: source.layout.menu.gettingStarted,
            docs: source.layout.menu.docs,
            community: source.layout.menu.community,
            shortcuts: source.layout.menu.shortcuts,
            whats_new: source.layout.menu.whatsNew,
            experts: source.layout.menu.hireExpert,
        },
        shortcutDialog: source.dialogs.shortcuts,
        closeDialog: source.kit.close,
        workspaceSettings: source.workspace.settings.title,
        providers: source.layout.workspaceMenu.aiProviders,
        deviceCode: {
            copy: source.connections.chatgpt.copyCode,
            copied: source.connections.chatgpt.copied,
            copyFailed: copyDeviceCodeFailure[locale],
        },
        defaultModel: source.connections.models.defaultModel,
        modelPicker: {
            ...source.agent.modelSelector,
            ...desktopModelPickerCopy[locale],
            manage: source.agent.modelPickerProviders.manage,
        },
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
        sessionRename: source.agent.sessionRename,
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
        showMore: source.chat.message.showMore,
        showLess: source.chat.message.showLess,
        voiceTranscript: source.chat.voice.transcript,
        voicePlay: source.chat.voice.play,
        voicePause: source.chat.voice.pause,
        voiceSeek: source.chat.voice.seek,
        voiceHideTranscript: source.chat.voice.hideTranscript,
        voiceCopyTranscript: source.chat.voice.copyTranscript,
        voiceTranscriptCopied: source.chat.actions.copiedExclaim,
        reply: source.agent.agentSheetChat.replyPlaceholder,
        sendMessage: locale === 'en' ? 'Send a message…' : source.chat.composer.placeholder,
        composerLink: source.chat.composer.link,
        linkedFileNotFound: source.agent.agentFileNavigation.notFound,
        send: source.chat.composer.editor.send,
        stop: source.chat.promptInput.stop,
        stoppingRun: source.chat.queued.stopping,
        queuedMessage: source.chat.queued,
        queue: desktopQueueCopy[locale],
        chatStart: source.mobileChat.empty,
        composerEditor: { ...source.chat.composer.editor, open: source.chat.composer.openEditor },
        chatActivity: source.chat.activity,
        chatSteps: source.chat.steps,
        replyActions: {
            copy: source.chat.actions.copy,
            copied: source.chat.actions.copiedExclaim,
            regenerate: source.chat.message.regenerate,
            goodResponse: source.chat.message.goodResponse,
            badResponse: source.chat.message.badResponse,
        },
        chatRequestCue: source.chat.hitlCue,
        chatReceipt: source.chat.receipt,
        jumpToChatRequest: source.chat.pendingHitl.goTo,
        scrollToLatestMessage: source.chat.conversation.scrollToLatest,
        subRunTrouble: source.subRuns.trouble,
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
