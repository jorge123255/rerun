import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderIcon } from './provider-icons'

describe('ProviderIcon', () => {
    const generic = renderToStaticMarkup(<ProviderIcon provider="someone-elses-router" />)

    it.each(['grok-build', 'kimi-code', 'devin', 'claude', 'codex'])('draws its own mark for %s', provider => {
        const mark = renderToStaticMarkup(<ProviderIcon provider={provider} className="size-4" />)
        expect(mark).toContain('<svg')
        expect(mark).toContain('class="size-4"')
        expect(mark).not.toBe(renderToStaticMarkup(<ProviderIcon provider="someone-elses-router" className="size-4" />))
    })

    it('keeps the Kimi mark readable on a light background', () => {
        expect(renderToStaticMarkup(<ProviderIcon provider="kimi-code" />)).not.toMatch(/fill="#fff"/i)
    })

    it('falls back to the generic server mark, and draws nothing without a provider', () => {
        expect(generic).toContain('<svg')
        expect(renderToStaticMarkup(<ProviderIcon provider={null} />)).toBe('')
    })
})
