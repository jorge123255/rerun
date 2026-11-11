import type { Locale } from '@rerun/i18n'
import type enForeman from '@rerun/i18n/messages/en/foreman.json'

const local = {
    en: {
        coworker: 'A teammate on this workspace board.',
        model: 'Connect a model',
        modelDescription: 'This workspace has a connected model, or a coworker chat has one saved.',
        routine: 'Put one of your coworkers on a saved routine.',
        routineUnavailable: 'Routines could not be read. This step stays open.',
    },
    fr: {
        coworker: 'Un collègue sur le tableau de cet espace de travail.',
        model: 'Connecter un modèle',
        modelDescription: 'Connectez un modèle à cet espace de travail ou enregistrez-en un dans une conversation avec un collègue.',
        routine: 'Enregistrez une routine pour l’un de vos collègues.',
        routineUnavailable: 'Impossible de lire les routines. Cette étape reste à terminer.',
    },
    es: {
        coworker: 'Un compañero en el tablero de este espacio de trabajo.',
        model: 'Conectar un modelo',
        modelDescription: 'Conecta un modelo a este espacio de trabajo o guarda uno en el chat de un compañero.',
        routine: 'Guarda una rutina para uno de tus compañeros.',
        routineUnavailable: 'No se pudieron leer las rutinas. Este paso sigue pendiente.',
    },
    pt: {
        coworker: 'Um colega no quadro deste espaço de trabalho.',
        model: 'Conectar um modelo',
        modelDescription: 'Conecte um modelo a este espaço de trabalho ou salve um no chat de um colega.',
        routine: 'Salve uma rotina para um dos seus colegas.',
        routineUnavailable: 'Não foi possível ler as rotinas. Esta etapa continua pendente.',
    },
    de: {
        coworker: 'Ein Coworker auf dem Board dieses Arbeitsbereichs.',
        model: 'Ein Modell verbinden',
        modelDescription: 'Verbinde ein Modell mit diesem Arbeitsbereich oder speichere eines in einem Coworker-Chat.',
        routine: 'Speichere eine Routine für einen deiner Coworker.',
        routineUnavailable: 'Die Routinen konnten nicht gelesen werden. Dieser Schritt bleibt offen.',
    },
} satisfies Record<Locale, Record<string, string>>

export function desktopGettingStartedMessages(locale: Locale, source: typeof enForeman.gettingStarted) {
    const copy = local[locale]
    return {
        title: source.title,
        hide: source.hide,
        pillLabel: source.pillLabel,
        doneTitle: source.reward.doneTitle,
        doneDescription: source.reward.doneDescription,
        routineUnavailable: copy.routineUnavailable,
        steps: {
            first_coworker: { title: source.steps.first_agent.title, description: copy.coworker },
            model: { title: copy.model, description: copy.modelDescription },
            schedule: { title: source.steps.schedule.title, description: copy.routine },
        },
    }
}
