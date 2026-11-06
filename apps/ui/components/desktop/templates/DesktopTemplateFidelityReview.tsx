'use client'
import type { DesktopTemplateRequirement } from '@rerun/contracts'
import { formatBytes } from '@/lib/files/format'
import type { DesktopTemplateDetail } from './types'
export function DesktopTemplateRequirements({ requirements }: { requirements: DesktopTemplateRequirement[] }) {
    if (!requirements.length) return null
    return <section className="min-w-0 space-y-2 rounded-lg border border-amber-500/20 bg-card p-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To provide again on a copy</h4>
        <ul className="space-y-1">{requirements.map(r => <li className="break-words text-xs" key={`${r.kind}:${r.name}`}><span className="font-mono">{r.name}</span><span className="text-muted-foreground"> · {r.kind}</span></li>)}</ul>
        <p className="text-[11px] text-muted-foreground">Apps arrive disconnected. Values and permissions must be provided locally.</p>
    </section>
}
export function DesktopTemplateFidelityReview({ coworkers }: { coworkers: NonNullable<DesktopTemplateDetail['fidelityCoworkers']> }) {
    return <div className="min-w-0 space-y-3">{coworkers.map(c => <section key={c.agentKey} className="min-w-0 space-y-3">
        <h4 className="text-sm font-medium">{c.name}</h4>
        <DesktopTemplateRequirements requirements={c.requirements} />
        <details className="min-w-0 rounded-lg border border-border/60 p-3"><summary className="cursor-pointer text-xs">Files · {c.files.length}</summary>
            <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">{c.files.map(f => <li className="min-w-0 border-t border-border/40 pt-2" key={f.path}>
                <code className="block break-all text-xs">{f.path}</code><p className="break-words text-[11px] text-muted-foreground">{formatBytes(f.bytes)} · {f.mediaType ?? 'application/octet-stream'}</p>
                <p className="text-[11px] text-muted-foreground">No preview</p>
                <code className="block break-all text-[10px] text-muted-foreground">SHA-256 {f.sourceRevision}</code>
            </li>)}</ul>
        </details>
    </section>)}</div>
}
