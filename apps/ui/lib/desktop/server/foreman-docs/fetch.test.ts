import { expect, it } from 'vitest'
import { RERUN_PUBLIC_DOCS_CORPUS } from '@rerun/contracts'
import { assertDesktopForemanDocsUrl } from './fetch'

it('allows only the approved public Mintlify export, including redirect targets', () => {
    expect(assertDesktopForemanDocsUrl(RERUN_PUBLIC_DOCS_CORPUS.exportUrl).href).toBe(RERUN_PUBLIC_DOCS_CORPUS.exportUrl)
    for (const value of [
        'http://docs.rerun.build/llms-full.txt',
        'https://docs.rerun.build.evil.example/llms-full.txt',
        'https://docs.rerun.build/private',
        'https://user:pass@docs.rerun.build/llms-full.txt',
        'https://127.0.0.1/llms-full.txt',
    ]) expect(() => assertDesktopForemanDocsUrl(value)).toThrow()
})
