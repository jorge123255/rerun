import { describe, expect, it } from 'vitest'
import { desktopGuestShellInputSchema } from '@rerun/contracts'

describe('desktop guest shell input contract', () => {
    it('accepts bounded commands, cwd and exact reviewed package targets', () => {
        expect(desktopGuestShellInputSchema.parse({ command: 'node -e "console.log(42)"', cwd: 'scripts', packages: ['is-number@7.0.0'] })).toMatchObject({ timeoutMs: 120_000, cwd: 'scripts', packages: ['is-number@7.0.0'] })
    })

    it.each(['/etc', '../outside', 'a/../../outside', 'a\\outside'])('rejects cwd escape %s', cwd => {
        expect(() => desktopGuestShellInputSchema.parse({ command: 'pwd', cwd })).toThrow()
    })

    it.each(['latest', 'is-number', 'is-number@latest', 'is-number@^7.0.0', 'https://example.com/pkg.tgz'])('rejects ambiguous package target %s', value => {
        expect(() => desktopGuestShellInputSchema.parse({ command: 'node -e "1"', packages: [value] })).toThrow()
    })

    it('rejects null bytes and over-limit timeout', () => {
        expect(() => desktopGuestShellInputSchema.parse({ command: 'printf "a\\0b"' })).toThrow()
        expect(() => desktopGuestShellInputSchema.parse({ command: 'pwd', timeoutMs: 600_001 })).toThrow()
    })
})
