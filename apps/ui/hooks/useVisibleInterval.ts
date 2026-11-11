'use client'

import { useEffect } from 'react'

// A background tab has nobody reading the result, so polling stops there and catches up the moment
// the tab is shown again. A poll that fails, the network not back yet, is retried at the next tick.
export function useVisibleInterval(callback: () => void | Promise<void>, ms: number, { enabled = true, immediate = true } = {}) {
    useEffect(() => {
        if (!enabled) return
        let interval: ReturnType<typeof setInterval> | undefined

        const run = () => {
            Promise.resolve(callback()).catch(() => {})
        }
        const start = (runFirst = true) => {
            if (runFirst) run()
            interval = setInterval(run, ms)
        }
        const stop = () => {
            clearInterval(interval)
            interval = undefined
        }
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') stop()
            else if (!interval) start()
        }

        if (document.visibilityState !== 'hidden') start(immediate)
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
            stop()
            document.removeEventListener('visibilitychange', onVisibility)
        }
    }, [callback, ms, enabled, immediate])
}
