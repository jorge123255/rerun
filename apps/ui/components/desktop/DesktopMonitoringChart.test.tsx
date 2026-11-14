// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { StatsChart } from '@rerun/ui/monitoring'
import type { StatsPoint } from '@rerun/contracts'

vi.mock('recharts', async importOriginal => {
    const original = await importOriginal<typeof import('recharts')>()
    return {
        ...original,
        ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
        PieChart: ({ children }: { children: ReactNode }) => children,
        Pie: ({ data }: { data: unknown }) => <output data-slices={JSON.stringify(data)} />,
        Tooltip: () => null,
    }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('a translated Other label never combines a real model with folded chart values', async () => {
    const models = ['Autre', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const points: StatsPoint[] = models.map((group, index) => ({ bucket: '2026-11-03', group, value: 10 - index, count: 10 - index }))
    const labels = {
        metrics: { count: 'Nombre' }, status: {}, rowCount: (_dataset: string, count: string) => count,
        other: 'Autre', unknown: 'Inconnu', loading: 'Chargement…', noData: 'Aucune donnée',
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<StatsChart dataset="runs" metric="count" groupBy="model" chartType="donut" points={points} locale="fr" labels={labels} />) })
        const slices = JSON.parse(container.querySelector('output')!.dataset.slices!) as { key: string; name: string; value: number }[]
        expect(slices).toHaveLength(9)
        expect(slices.filter(slice => slice.name === 'Autre')).toEqual([
            expect.objectContaining({ key: 'g_0', value: 10 }),
            expect.objectContaining({ key: 'g_other', value: 3 }),
        ])
        expect(slices.reduce((total, slice) => total + slice.value, 0)).toBe(55)
    } finally { await act(async () => { root.unmount() }) }
})
