export type ServiceRequestRetryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function createServiceRequestRetryJournal<T extends { requestId: string }>(
    storage: ServiceRequestRetryStorage,
    key: string,
    parse: (value: unknown) => T,
) {
    function read(): T | null {
        const raw = storage.getItem(key)
        if (raw === null) return null
        if (raw.length > 32_768) throw new Error('Saved app decisions are unavailable. Keep this request pending.')
        try {
            return parse(JSON.parse(raw))
        } catch {
            throw new Error('Saved app decisions could not be read. Keep this request pending.')
        }
    }

    return {
        read,
        save(value: T) {
            const parsed = parse(value)
            const previous = read()
            if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) {
                throw new Error('Retry the saved app decisions before making another choice.')
            }
            const raw = JSON.stringify(parsed)
            if (raw.length > 32_768) throw new Error('App decisions exceed the local retry limit.')
            storage.setItem(key, raw)
            if (storage.getItem(key) !== raw) throw new Error('App decisions could not be saved for retry.')
        },
        acknowledge(value: T) {
            const previous = read()
            if (previous && JSON.stringify(previous) === JSON.stringify(parse(value))) storage.removeItem(key)
        },
    }
}
