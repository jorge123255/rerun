import type { Locale } from '@rerun/i18n'

export const desktopConversationFindCopy = {
    en: { field: 'Find in conversation', count: '{current, number} of {total, number}', noMatches: 'No matches', previous: 'Previous', next: 'Next', close: 'Close find' },
    fr: { field: 'Rechercher dans la conversation', count: '{current, number} sur {total, number}', noMatches: 'Aucun résultat', previous: 'Précédent', next: 'Suivant', close: 'Fermer la recherche' },
    es: { field: 'Buscar en la conversación', count: '{current, number} de {total, number}', noMatches: 'Sin resultados', previous: 'Anterior', next: 'Siguiente', close: 'Cerrar la búsqueda' },
    pt: { field: 'Buscar na conversa', count: '{current, number} de {total, number}', noMatches: 'Nenhum resultado', previous: 'Anterior', next: 'Próximo', close: 'Fechar a busca' },
    de: { field: 'In der Unterhaltung suchen', count: '{current, number} von {total, number}', noMatches: 'Keine Treffer', previous: 'Zurück', next: 'Weiter', close: 'Suche schließen' },
} satisfies Record<Locale, Record<'field' | 'count' | 'noMatches' | 'previous' | 'next' | 'close', string>>
