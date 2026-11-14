const PREFIX = 'question:'
export { QUESTION_DOCUMENT_POSITIONS, questionDocumentIndex } from '@rerun/contracts'

export function questionDocumentTabUid(questionId: string): string {
    return PREFIX + questionId
}

export function questionDocumentId(tabUid: string): string | null {
    return /^question:([a-f0-9]{64})$/.exec(tabUid)?.[1] ?? null
}
