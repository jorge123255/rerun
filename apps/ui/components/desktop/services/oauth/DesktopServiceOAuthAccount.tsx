'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { DesktopServiceAccountView, DesktopServiceOAuthSnapshot } from '@rerun/contracts'
import type { ServiceOAuthDriver } from '@/lib/desktop/service-oauth-client'
import { DesktopServiceOAuthSetup } from './DesktopServiceOAuthSetup'
import { DesktopServiceOAuthConnect } from './DesktopServiceOAuthConnect'
type Props = { coworkerId: string; account: DesktopServiceAccountView; driver: ServiceOAuthDriver; onChanged?: () => void }
export function DesktopServiceOAuthAccount(props: Props) {
    return <Account key={JSON.stringify([props.coworkerId, props.account.installationId, props.account.revision])} {...props} />
}
function Account({ coworkerId, account, driver, onChanged }: Props) {
    const [snapshot, setSnapshot] = useState<DesktopServiceOAuthSnapshot | null>(null), [loaded, setLoaded] = useState(false), [attempt, setAttempt] = useState(0)
    useEffect(() => {
        const controller = new AbortController()
        setLoaded(false)
        void driver.action(coworkerId, { action: 'current', accountKey: account.key }, controller.signal).then(value => {
            if (controller.signal.aborted) return
            if (value.coworkerId !== coworkerId || value.accountKey !== account.key || value.installationId !== account.installationId || value.configGeneration !== account.revision) throw new Error('OAuth account changed.')
            setSnapshot(value)
        }).catch(() => { if (!controller.signal.aborted) setSnapshot(null) }).finally(() => { if (!controller.signal.aborted) setLoaded(true) })
        return () => controller.abort()
    }, [coworkerId, account.key, account.installationId, account.revision, driver, attempt])
    const changed = (value: DesktopServiceOAuthSnapshot) => {
        if (value.coworkerId !== coworkerId || value.accountKey !== account.key || value.installationId !== account.installationId || value.configGeneration !== account.revision) return
        setSnapshot(value); onChanged?.()
    }
    if (!loaded) return <p role="status" className="text-sm text-muted-foreground">Reading saved sign-in…</p>
    return <div className="space-y-2">
        {!account.authMethodId ? <p role="alert" className="text-xs text-destructive">This saved account has no sign-in method. Configure the account before connecting.</p> : snapshot ? <DesktopServiceOAuthConnect snapshot={snapshot} driver={driver} onChanged={changed} /> : <>
            <p className="text-xs text-muted-foreground">No saved sign-in could be read. Connect prepares this exact account; authorization starts only when you choose to sign in.</p>
            <DesktopServiceOAuthSetup coworkerId={coworkerId} slug={account.slug} name={account.label || account.name} methodId={account.authMethodId} intent={{ kind: 'existing', accountKey: account.key, expectedRevision: account.revision }} driver={driver} onChanged={changed} />
            <Button type="button" size="sm" variant="ghost" onClick={() => setAttempt(value => value + 1)}>Refresh sign-in</Button>
        </>}
    </div>
}
