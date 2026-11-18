import { isRecord } from '@rerun/contracts'

type Management = { actions: Set<string>; slugs: boolean; canRenew: boolean }
const annotations = ['description', 'title', 'default', 'examples']

/** Connect has advertised both an action per toolkit and a list of slugs. Only the former supports a passive list or removal. */
export function connectionCapabilities(schema: unknown): Management {
    const capability: Management = { actions: new Set(), slugs: false, canRenew: false }
    if (!isRecord(schema) || !isRecord(schema.properties) || !isRecord(schema.properties.toolkits) || schema.properties.toolkits.type !== 'array') return capability
    // Only act on literal values the advertised field admits. An unknown restriction must not
    // silently turn an add-only tool into a passive list or account-removal operation.
    function allows(field: unknown, value: string | boolean, depth = 0): boolean | undefined {
        if (!isRecord(field) || depth > 6) return undefined
        const supported = ['type', 'enum', 'const', '$ref', 'anyOf', 'oneOf', ...annotations]
        if (Object.keys(field).some(key => !supported.includes(key))) return undefined
        if (field.type !== undefined && field.type !== typeof value) return false
        if (Object.hasOwn(field, 'const') && field.const !== value) return false
        if (Object.hasOwn(field, 'enum') && (!Array.isArray(field.enum) || !field.enum.includes(value))) return false
        if (field.$ref !== undefined) {
            if (typeof field.$ref !== 'string' || !/^#\/(\$defs|definitions)\/[\w-]+$/.test(field.$ref)) return undefined
            const [, group, name] = field.$ref.split('/')
            const defs = (schema as Record<string, unknown>)[group!]
            if (!isRecord(defs) || !Object.hasOwn(defs, name!)) return undefined
            const referred = allows(defs[name!], value, depth + 1)
            if (referred !== true) return referred
        }
        if (field.anyOf !== undefined) {
            if (!Array.isArray(field.anyOf)) return undefined
            const matches = field.anyOf.map(option => allows(option, value, depth + 1))
            if (!matches.includes(true)) return matches.includes(undefined) ? undefined : false
        }
        if (field.oneOf !== undefined) {
            if (!Array.isArray(field.oneOf)) return undefined
            const matches = field.oneOf.map(option => allows(option, value, depth + 1))
            if (matches.includes(undefined)) return undefined
            if (matches.filter(Boolean).length !== 1) return false
        }
        if (field.type === typeof value || ['const', 'enum', '$ref', 'oneOf', 'anyOf'].some(key => Object.hasOwn(field, key))) return true
        return undefined
    }
    capability.canRenew = allows(schema.properties.reinitiate_all, true) === true
    function inspect(item: unknown, depth: number) {
        if (!isRecord(item) || depth > 6) return
        // A reference/alternative with sibling constraints is not an unconditional capability.
        const wrappers = ['$ref', 'oneOf', 'anyOf'].filter(key => Object.hasOwn(item, key))
        if (wrappers.length && (wrappers.length !== 1 || Object.keys(item).some(key => ![...wrappers, ...annotations].includes(key)))) return
        if (typeof item.$ref === 'string' && /^#\/(\$defs|definitions)\/[\w-]+$/.test(item.$ref)) {
            const [, group, name] = item.$ref.split('/')
            const defs = (schema as Record<string, unknown>)[group!]
            if (isRecord(defs) && Object.hasOwn(defs, name!)) inspect(defs[name!], depth + 1)
        }
        for (const group of [item.oneOf, item.anyOf]) {
            if (Array.isArray(group)) for (const child of group) inspect(child, depth + 1)
        }
        if (item.type === 'string') capability.slugs = true
        if (item.type !== 'object' || !isRecord(item.properties) || !isRecord(item.properties.name) || !isRecord(item.properties.action)) return
        if (Object.keys(item).some(key => !['type', 'properties', 'required', 'additionalProperties', ...annotations].includes(key))) return
        if (item.properties.name.type !== 'string' || Object.keys(item.properties.name).some(key => !['type', ...annotations].includes(key))) return
        if (item.required !== undefined && (!Array.isArray(item.required) || item.required.some(key => key !== 'name' && key !== 'action'))) return
        // The public Connect plugin documents these verbs for the {name, action} variant.
        // A plain action string admits the documented verbs only for this specific tool.
        for (const verb of ['add', 'list', 'remove']) {
            if (allows(item.properties.action, verb)) capability.actions.add(verb)
        }
    }
    inspect(schema.properties.toolkits.items, 0)
    return capability
}

export function toolkitIsConnected(data: unknown, toolkit: string): boolean | undefined {
    if (!isRecord(data) || !Array.isArray(data.toolkit_connection_statuses)) return
    const row: unknown = data.toolkit_connection_statuses.find(entry => isRecord(entry) && entry.toolkit === toolkit)
    if (isRecord(row) && typeof row.has_active_connection === 'boolean') return row.has_active_connection
}
