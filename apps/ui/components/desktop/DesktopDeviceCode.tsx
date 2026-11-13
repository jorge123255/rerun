import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { CheckIcon, CopyIcon } from '@/lib/icons'
import { useDesktopLocale } from './DesktopLocale'

export function DesktopDeviceCode({ code, label }: { code: string; label: string }) {
    const { t } = useDesktopLocale()
    const [result, setResult] = useState<'copied' | 'failed' | null>(null)

    async function copy() {
        try {
            await navigator.clipboard.writeText(code)
            setResult('copied')
        } catch {
            setResult('failed')
        }
    }

    return <>
        <div className="flex items-center gap-2 rounded-lg bg-muted/60 p-1.5 pl-4">
            <output aria-label={label} className="min-w-0 flex-1 select-all break-all font-mono text-lg font-medium tracking-widest">{code}</output>
            <Button type="button" size="icon" variant="ghost" className="shrink-0" aria-label={t('deviceCode.copy')} onClick={() => void copy()}>
                {result === 'copied' ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
            </Button>
        </div>
        {result === 'copied' && <p role="status" className="text-xs text-muted-foreground">{t('deviceCode.copied')}</p>}
        {result === 'failed' && <p role="alert" className="text-xs text-destructive">{t('deviceCode.copyFailed')}</p>}
    </>
}
