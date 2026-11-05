import {
    DESKTOP_SEMANTIC_NOTE_MAX,
    type DesktopSemanticCanonicalNote,
    type DesktopSemanticRecallNote,
} from '@rerun/contracts'
import { keywordCoverage, queryTerms } from '../../db/repos/memories.js'
import { memoryStatus } from '../../memory/decay.js'
import { AUTO_RECALL_MIN_SIMILARITY, rankRecallHits } from '../../memory/store.js'
import { desktopSemanticLocalId } from './identity.js'

// Merge rule matches fuse() in apps/engine/src/memory/store.ts at a6d63a4b: a keyword hit keeps
// the semantic cosine when both exist, and a hit with no cosine stays null. rankRecallHits applies
// the 0.25 floor, the 0.15 keyword coverage bonus, strength, and dormant filtering.
export function rankDesktopSemanticNotes(
    notes: readonly DesktopSemanticCanonicalNote[],
    similarities: ReadonlyMap<string, number>,
    query: string,
    limit: number,
    includeDormant: boolean,
): DesktopSemanticRecallNote[] {
    const terms = queryTerms(query)
    const hits = notes.flatMap(note => {
        const coverage = terms.length ? keywordCoverage(terms, note.content) : 0
        const similarity = similarities.has(note.id) ? similarities.get(note.id) ?? null : null
        if (coverage <= 0 && similarity === null) return []
        return [{
            id: note.id,
            content: note.content,
            kind: note.kind,
            tags: note.tags,
            createdAt: note.createdAt,
            lastAccessedAt: note.lastAccessedAt,
            accessCount: note.accessCount,
            similarity,
            coverage,
        }]
    })
    hits.sort((left, right) => left.id.localeCompare(right.id))
    return rankRecallHits(hits, limit, { includeDormant, minSimilarity: AUTO_RECALL_MIN_SIMILARITY }).flatMap(hit => {
        if (!desktopSemanticLocalId(hit.id) || hit.content.length > DESKTOP_SEMANTIC_NOTE_MAX) return []
        return [{
            id: hit.id,
            content: hit.content,
            kind: hit.kind,
            tags: [...hit.tags],
            createdAt: hit.createdAt,
            strength: hit.strength,
            status: memoryStatus(hit.strength),
        }]
    })
}
