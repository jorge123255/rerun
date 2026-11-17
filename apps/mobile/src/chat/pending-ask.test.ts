import { setPendingAsk, takePendingAsk } from './pending-ask'

describe('pending ask', () => {
    it('is read once by the page that opens next, and never again', () => {
        setPendingAsk('hello')
        expect(takePendingAsk()).toBe('hello')
        expect(takePendingAsk()).toBeUndefined()
    })
})
