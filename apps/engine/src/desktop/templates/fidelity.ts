import type { DesktopTemplateRequirement } from '@rerun/contracts'
import { TemplateRequestError } from './errors.ts'
export function templateMediaType(path: string, bytes: Buffer, binary: boolean): string {
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
    if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
    if (bytes.subarray(0, 2).equals(Buffer.from([80,75]))) return 'application/zip'
    if (binary) return 'application/octet-stream'
    const ext = path.split('.').pop()?.toLowerCase()
    return ext === 'md' ? 'text/markdown' : ext === 'json' ? 'application/json' : ext === 'html' || ext === 'htm' ? 'text/html' : ext === 'svg' ? 'image/svg+xml' : 'text/plain'
}
export function normalizeTemplateRequirements(raw: DesktopTemplateRequirement[]): DesktopTemplateRequirement[] {
    if (raw.length > 200) throw new TemplateRequestError(413, 'Template has too many setup requirements')
    const result = new Map<string, DesktopTemplateRequirement>()
    for (const r of raw) {
        // Requirement names are identifiers, never endpoint URLs, account IDs or resolved values.
        const pattern = r.kind === 'environment-key' || r.kind === 'credential-name' ? /^[A-Z_][A-Z0-9_]{0,127}$/ : /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
        if (!pattern.test(r.name)) throw new TemplateRequestError(400, 'Template requirement name is not supported')
        const detail = r.kind === 'environment-key' || r.kind === 'credential-name' ? 'Provide this value locally after installation.'
            : r.kind === 'service-reconnect' || r.kind === 'mcp-reconnect' ? 'Connect this app locally after installation.'
            : r.kind === 'schedule-inactive' || r.kind === 'trigger-inactive' ? 'Review and configure locally; no automation is activated.' : 'Choose an available local connection or model.'
        result.set(`${r.kind}:${r.name}`, { kind: r.kind, name: r.name, detail })
    }
    return [...result.values()].sort((a,b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`, 'en'))
}
