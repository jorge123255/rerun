import { describe, expect, it } from 'vitest'
import { firstNameFromLocalProfile } from './actor'

describe('trusted local actor first name', () => {
    it('uses only an explicitly stored local profile name', () => {
        expect(firstNameFromLocalProfile('  Ada Lovelace ')).toBe('Ada')
        expect(firstNameFromLocalProfile('Grace')).toBe('Grace')
    })

    it('does not infer a name from generic accounts or email-shaped values', () => {
        expect(firstNameFromLocalProfile('Local User')).toBeNull()
        expect(firstNameFromLocalProfile('local-user')).toBeNull()
        expect(firstNameFromLocalProfile('User')).toBeNull()
        expect(firstNameFromLocalProfile('ada@example.com')).toBeNull()
        expect(firstNameFromLocalProfile('')).toBeNull()
    })
})
