// Finite vectors only. A NaN, an infinite component, or a different length is not a usable embedding.
export function desktopSemanticVector(value: unknown, dimensions: number): number[] | null {
    if (!Array.isArray(value) || value.length !== dimensions || dimensions < 1) return null
    const vector: number[] = []
    for (const item of value) {
        if (typeof item !== 'number' || !Number.isFinite(item)) return null
        vector.push(item)
    }
    return vector
}

export function desktopSemanticCosine(left: readonly number[], right: readonly number[]): number | null {
    if (left.length !== right.length || left.length === 0) return null
    let dot = 0
    let leftNorm = 0
    let rightNorm = 0
    for (let index = 0; index < left.length; index += 1) {
        const a = left[index]
        const b = right[index]
        if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return null
        dot += a * b
        leftNorm += a * a
        rightNorm += b * b
    }
    if (leftNorm === 0 || rightNorm === 0) return null
    const similarity = dot / Math.sqrt(leftNorm * rightNorm)
    if (!Number.isFinite(similarity)) return null
    return Math.min(1, Math.max(-1, similarity))
}
