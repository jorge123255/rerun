export function productionMainModule(relativePath) {
    const normalized = relativePath.replaceAll('\\', '/')
    return !/(?:^|\/)(?:[^/]+\.test\.mjs|fixtures\.mjs)$/.test(normalized)
}
