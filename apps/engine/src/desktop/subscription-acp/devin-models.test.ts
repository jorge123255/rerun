import { expect, test } from 'vitest'
import { desktopDevinModelId, desktopDevinModels } from './runtime.js'

test('Devin’s per-effort model ids fold into one model with its efforts as levels', () => {
    const models = desktopDevinModels([
        { value: 'adaptive', name: 'Adaptive' },
        { value: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5' },
        { value: 'claude-opus-5-5-low', name: 'Claude Opus 5.5' },
        { value: 'claude-opus-5-5-max', name: 'Claude Opus 5.5' },
        { value: 'claude-opus-5-5-high-fast', name: 'Claude Opus 5.5' },
        { value: 'claude-opus-5-5-low-fast', name: 'Claude Opus 5.5' },
        { value: 'swe-2-high', name: 'SWE-2' },
        { value: 'swe-2-max-lightning', name: 'SWE-2' },
    ])
    expect(models).toEqual([
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoning: { supported: ['low', 'medium', 'max'], default: 'medium' } },
        { id: 'claude-opus-5-5-fast', label: 'Claude Opus 5.5 Fast', reasoning: { supported: ['low', 'high'], default: 'low' } },
        { id: 'swe-2', label: 'SWE-2', reasoning: { supported: ['high'], default: 'high' } },
        { id: 'swe-2-lightning', label: 'SWE-2 Lightning', reasoning: { supported: ['max'], default: 'max' } },
        { id: 'adaptive', label: 'Adaptive' },
    ])
})

test('a model and its effort give back the id Devin’s selector uses', () => {
    expect(desktopDevinModelId('claude-opus-5-5', 'high')).toBe('claude-opus-5-5-high')
    expect(desktopDevinModelId('claude-opus-5-5-fast', 'low')).toBe('claude-opus-5-5-low-fast')
    expect(desktopDevinModelId('swe-2-lightning', 'max')).toBe('swe-2-max-lightning')
    expect(desktopDevinModelId('adaptive', undefined)).toBe('adaptive')
})
