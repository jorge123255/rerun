import type { Locale } from '@rerun/i18n'

const en = {
    title: 'Company Brain',
    description: 'What every coworker of this workspace reads about the company. Pages save as you type; version history keeps every change.',
    restoring: 'Restoring saved Brain drafts…',
    restoreFailed: 'Could not restore Brain drafts.',
    closeFailed: 'Some edits could not be saved. The Brain stays open so nothing is lost.',
    engineUnavailable: 'The local engine did not answer. It may still be starting.',
    emptyDescription: 'It is what every coworker reads about your company before it works: what you sell, to whom, your team, your voice and your tools.',
    pageUnavailable: 'Could not read this page',
}

export const desktopBrainCopy = {
    en,
    fr: {
        title: 'Brain de l’entreprise',
        description: 'Ce que chaque collègue de cet espace lit sur l’entreprise. Les pages s’enregistrent pendant la saisie et l’historique conserve chaque modification.',
        restoring: 'Restauration des brouillons du Brain…',
        restoreFailed: 'Impossible de restaurer les brouillons du Brain.',
        closeFailed: 'Certaines modifications n’ont pas été enregistrées. Le Brain reste ouvert pour éviter de les perdre.',
        engineUnavailable: 'Le moteur local n’a pas répondu. Il est peut-être encore en cours de démarrage.',
        emptyDescription: 'Chaque collègue y découvre votre entreprise avant de travailler : votre offre, vos clients, votre équipe, votre ton et vos outils.',
        pageUnavailable: 'Impossible de lire cette page',
    },
    es: {
        title: 'Brain de la empresa',
        description: 'Lo que cada compañero de este espacio lee sobre la empresa. Las páginas se guardan al escribir y el historial conserva cada cambio.',
        restoring: 'Restaurando los borradores del Brain…',
        restoreFailed: 'No se pudieron restaurar los borradores del Brain.',
        closeFailed: 'No se pudieron guardar algunos cambios. El Brain sigue abierto para que no se pierdan.',
        engineUnavailable: 'El motor local no respondió. Puede que todavía se esté iniciando.',
        emptyDescription: 'Cada compañero consulta aquí la información de tu empresa antes de trabajar: qué vendes, a quién, tu equipo, tu tono y tus herramientas.',
        pageUnavailable: 'No se pudo leer esta página',
    },
    pt: {
        title: 'Brain da empresa',
        description: 'O que cada colega deste espaço de trabalho lê sobre a empresa. As páginas são salvas enquanto você digita e o histórico guarda cada alteração.',
        restoring: 'Restaurando rascunhos do Brain…',
        restoreFailed: 'Não foi possível restaurar os rascunhos do Brain.',
        closeFailed: 'Algumas alterações não foram salvas. O Brain continua aberto para evitar perdas.',
        engineUnavailable: 'O mecanismo local não respondeu. Talvez ainda esteja iniciando.',
        emptyDescription: 'Cada colega consulta aqui as informações da empresa antes de trabalhar: o que você vende, para quem, sua equipe, seu tom e suas ferramentas.',
        pageUnavailable: 'Não foi possível ler esta página',
    },
    de: {
        title: 'Unternehmens-Brain',
        description: 'Hier lesen alle Kollegen dieses Arbeitsbereichs über das Unternehmen. Seiten werden beim Schreiben gespeichert und der Versionsverlauf hält jede Änderung fest.',
        restoring: 'Gespeicherte Brain-Entwürfe werden wiederhergestellt…',
        restoreFailed: 'Brain-Entwürfe konnten nicht wiederhergestellt werden.',
        closeFailed: 'Einige Änderungen konnten nicht gespeichert werden. Das Brain bleibt geöffnet, damit nichts verloren geht.',
        engineUnavailable: 'Die lokale Engine hat nicht geantwortet. Sie wird möglicherweise noch gestartet.',
        emptyDescription: 'Hier erfahren Kollegen vor der Arbeit, was du verkaufst, wer deine Kunden sind und wie dein Team, dein Ton und deine Werkzeuge aussehen.',
        pageUnavailable: 'Diese Seite konnte nicht gelesen werden',
    },
} satisfies Record<Locale, typeof en>
