import { expect, test } from 'vitest'
import { desktopValidationFlagValue, desktopValidationProfileError, validateDesktopValidationProfile } from './contract'

test('only an explicit validation flag opts in; missing, empty and repeated flags refuse', () => {
    expect(desktopValidationFlagValue(['node', 'app'])).toBeNull()
    expect(desktopValidationFlagValue(['--rerun-validation-profile=/tmp/rerun-validation-a'])).toBe('/tmp/rerun-validation-a')
    expect(() => desktopValidationFlagValue(['--rerun-validation-profile='])).toThrow('requires an absolute path')
    expect(() => desktopValidationFlagValue(['--rerun-validation-profile=/tmp/a', '--rerun-validation-profile=/tmp/b'])).toThrow('only once')
    expect(() => desktopValidationFlagValue(['--rerun-validation-profile=relative/path'])).toThrow('absolute path')
})

test('profile contract distinguishes verified paths from unproven network enforcement', () => {
    const profile = validateDesktopValidationProfile({
        version: 1,
        validationId: '11111111-1111-4111-8111-111111111111',
        profileRoot: '/private/tmp/rerun-validation-a',
        dataRoot: '/private/tmp/rerun-validation-a/data',
        engineRoot: '/private/tmp/rerun-validation-a/data/workspaces/1/engine',
        homeRoot: '/private/tmp/rerun-validation-a/home',
        partition: 'validation-11111111-1111-4111-8111-111111111111',
        providers: 'empty-by-fresh-profile',
        externalNetwork: 'waiting-for-launch-enforcement',
        loopback: 'ephemeral-only',
    })
    expect(profile.externalNetwork).toBe('waiting-for-launch-enforcement')
    expect(profile.providers).toBe('empty-by-fresh-profile')
})

test('production and non-temporary roots are refused', () => {
    for (const profileRoot of ['/', process.env.HOME ?? '/Users/test', `${process.env.HOME ?? '/Users/test'}/.rerun`, '/Users/test/Library/Application Support/Rerun Desktop Preview', '/var/tmp/not-the-system-temp-root']) {
        expect(() => validateDesktopValidationProfile({ profileRoot }), desktopValidationProfileError).toThrow()
    }
})
