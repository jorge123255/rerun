import { describe, expect, it } from 'vitest'
import { buildCustomProviderConfig, desktopPresets, endpointReady, keyRequiredFor, policyFor, probeProblemMessage, uniqueName, parseWindow } from './messages'

describe('desktop custom provider copy', () => {
    it('keeps local servers on the desktop and hosted ones behind a key', () => {
        expect(desktopPresets().map(preset => preset.id)).toEqual(['ollama', 'lmstudio', 'vllm', 'litellm', 'groq', 'together', 'mistral', 'deepseek'])
        expect(keyRequiredFor(desktopPresets().find(preset => preset.id === 'ollama') ?? null)).toBe(false)
        expect(keyRequiredFor(desktopPresets().find(preset => preset.id === 'groq') ?? null)).toBe(true)
        expect(uniqueName('Ollama', ['Ollama'])).toBe('Ollama 2')
    })

    it('uses the local unreachable sentence and refuses a key hidden in the address', () => {
        expect(probeProblemMessage('unreachable', 'http://localhost:11434/v1')).toBe('Could not reach localhost:11434. Check the server is running and reachable from the engine.')
        expect(probeProblemMessage('unauthorized', 'http://localhost:11434/v1')).toBe('The server turned this key down. Check it was copied in full.')
        expect(probeProblemMessage('not_listed', 'http://localhost:11434/v1')).toBe('This server does not list its models. Type the id of the one to run.')
        expect(probeProblemMessage('model_refused', 'http://localhost:11434/v1', 'llama3.3:70b')).toBe('The server refused llama3.3:70b.')
        expect(probeProblemMessage(null, 'http://localhost:11434/v1')).toBeNull()
        expect(endpointReady(' http://localhost:11434/v1 ')).toBe(true)
        expect(endpointReady('https://api.groq.com/openai/v1')).toBe(true)
        expect(endpointReady('http://user:secret@localhost:11434/v1')).toBe(false)
        expect(endpointReady('ftp://localhost/v1')).toBe(false)
        expect(parseWindow('')).toBeNull()
        expect(parseWindow('128,000')).toBe(128000)
        expect(parseWindow('10')).toBeUndefined()
    })

    it('marks a loopback http preset private and a hosted https preset public', () => {
        expect(policyFor('http://localhost:11434/v1')).toEqual({ reviewedOrigin: 'http://localhost:11434', allowHttp: true, allowPrivate: true })
        expect(policyFor('http://192.168.1.5:11434/v1')).toMatchObject({ allowHttp: true, allowPrivate: true })
        expect(policyFor('https://api.groq.com/openai/v1')).toEqual({ reviewedOrigin: 'https://api.groq.com', allowHttp: false, allowPrivate: false })
        expect(() => buildCustomProviderConfig({ name: 'Ollama', baseUrl: 'http://user:secret@localhost/v1', models: [{ id: 'llama3.3:70b', contextWindow: null, vision: false, source: 'manual' }], contextText: '', vision: false })).toThrow(/address/)
    })
})
