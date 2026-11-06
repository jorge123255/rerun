const owners = new Set<() => Promise<boolean>>()
export function registerForemanVoiceQuit(flush: () => Promise<boolean>) { owners.add(flush); return () => { owners.delete(flush) } }
export async function flushForemanVoicesForQuit() {
    const values = await Promise.allSettled([...owners].map(flush => flush()))
    return values.every(value => value.status === 'fulfilled' && value.value)
}
