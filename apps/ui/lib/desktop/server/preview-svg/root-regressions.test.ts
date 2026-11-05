import { expect, it } from 'vitest'
import { inspectDesktopSvg } from './index'
import { validateSvg } from './svg-subset'
import { xmlTokens } from './xml-tokens'
const bytes = (body: string, size = 'width="100" height="100"') => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" ${size}>${body}</svg>`)

it('rejects CSS resource spellings before rasterization', () => {
    for (const value of ['URL(file:///tmp/test.svg#x)', 'url (https://example.com/x)', 'u\\72l(file:///tmp/x)', 'u/**/rl(file:///tmp/x)']) {
        expect(() => inspectDesktopSvg(bytes(`<rect fill="${value}"/>`))).toThrow()
    }
})
it('preserves an implicit source viewport and stays inside the aggregate ceiling', () => {
    const parsed = validateSvg(xmlTokens(bytes('<circle cx="2500" cy="2000" r="100"/>', 'width="5000" height="4000"')))
    expect(parsed.width * parsed.height).toBeLessThanOrEqual(16_777_216)
    expect(parsed.render(500, 400)).toContain('viewBox="0 0 5000 4000"')
})
it('accepts astral text and refuses recursive or exponential use graphs', () => {
    expect(() => inspectDesktopSvg(bytes('<text x="1" y="15">Hello 🌍</text>'))).not.toThrow()
    expect(() => inspectDesktopSvg(bytes('<path d="M0 0\n L10 10\t L20 0"/>'))).not.toThrow()
    expect(() => inspectDesktopSvg(bytes('<defs><g id="x"><use href="#x"/></g></defs><use href="#x"/>'))).toThrow()
    const defs = ['<g id="a0"><rect width="1" height="1"/></g>']
    for (let i = 1; i < 16; i++) defs.push(`<g id="a${i}"><use href="#a${i-1}"/><use href="#a${i-1}"/></g>`)
    expect(() => inspectDesktopSvg(bytes(`<defs>${defs.join('')}</defs><use href="#a15"/>`))).toThrow()
})
