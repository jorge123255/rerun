import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopValidationFlagValue, validateDesktopValidationProfile } from './contract.mjs'

test('only an explicit validation flag opts in; missing, empty and repeated flags refuse', () => {
    assert.equal(desktopValidationFlagValue(['node', 'app']), null)
    assert.equal(desktopValidationFlagValue(['--rerun-validation-profile=/tmp/rerun-validation-a']), '/tmp/rerun-validation-a')
    assert.throws(() => desktopValidationFlagValue(['--rerun-validation-profile=']), /requires an absolute path/)
    assert.throws(() => desktopValidationFlagValue(['--rerun-validation-profile=/tmp/a', '--rerun-validation-profile=/tmp/b']), /only once/)
    assert.throws(() => desktopValidationFlagValue(['--rerun-validation-profile=relative/path']), /absolute path/)
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
    assert.equal(profile.externalNetwork, 'waiting-for-launch-enforcement')
    assert.equal(profile.providers, 'empty-by-fresh-profile')
})

test('production and non-temporary roots are refused', () => {
    for (const profileRoot of ['/', process.env.HOME ?? '/Users/test', `${process.env.HOME ?? '/Users/test'}/.rerun`, '/Users/test/Library/Application Support/Rerun Desktop Preview', '/var/tmp/not-the-system-temp-root']) {
        assert.throws(() => validateDesktopValidationProfile({ profileRoot }))
    }
})
