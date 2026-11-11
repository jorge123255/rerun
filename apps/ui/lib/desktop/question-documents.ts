const PREFIX = 'question:'
export const QUESTION_DOCUMENT_POSITIONS = 1_000

export function questionDocumentTabUid(questionId: string): string {
    return PREFIX + questionId
}

export function questionDocumentId(tabUid: string): string | null {
    return /^question:([a-f0-9]{64})$/.exec(tabUid)?.[1] ?? null
}

export function questionDocumentIndex(position: number): number {
    return Math.floor(position / QUESTION_DOCUMENT_POSITIONS)
}
