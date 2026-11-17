import { useEffect, useState } from 'react'

export function useSecondsSince(start: number): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [start])
    return Math.max(0, Math.floor((now - start) / 1000))
}
