import { initialsOf } from '@/components/home/account-actions'

describe('initialsOf', () => {
    it('takes the first letters of the first two words of the name', () => {
        expect(initialsOf({ id: 'u', email: null, name: 'ada lovelace byron', avatarUrl: null })).toBe('AL')
    })

    it('falls back on the email, and on nothing for an account born from a phone number', () => {
        expect(initialsOf({ id: 'u', email: 'grace@example.com', name: null, avatarUrl: null })).toBe('G')
        expect(initialsOf({ id: 'u', email: null, name: null, avatarUrl: null })).toBeNull()
    })
})
