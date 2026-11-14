import { STATS_METRIC_META, type StatsMetric } from '@rerun/contracts'

export function chartNumber(locale?: string) {
    return new Intl.NumberFormat(locale ?? 'en-US', { notation: 'compact', maximumFractionDigits: 1 })
}

export function chartPercent(ratio: number, digits: number, locale?: string) {
    if (!locale) return `${(ratio * 100).toFixed(digits)}%`
    return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(ratio)
}

export function chartCost(dollars: number, locale?: string, exact = false) {
    const digits = dollars >= 1 ? 2 : 4
    if (!locale) return `$${dollars.toFixed(digits)}`
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD',
        minimumFractionDigits: exact ? 2 : digits, maximumFractionDigits: exact ? 6 : digits }).format(dollars)
}

function chartDuration(ms: number, locale?: string) {
    const unit = (value: number, name: 'millisecond' | 'second' | 'minute', digits = 0) => {
        if (!locale) return `${value.toFixed(digits)}${name === 'millisecond' ? 'ms' : name === 'second' ? 's' : 'm'}`
        return new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow',
            minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
    }
    if (ms < 1000) return unit(ms, 'millisecond')
    if (ms < 60_000) return unit(ms / 1000, 'second', 1)
    const seconds = Math.round(ms / 1000)
    return `${unit(Math.floor(seconds / 60), 'minute')} ${unit(seconds % 60, 'second')}`
}

export function statsValueFormatter(metric: StatsMetric, locale?: string, exact = false): (value: number) => string {
    const unit = STATS_METRIC_META[metric].unit
    if (unit === 'costMicros') return value => chartCost(value / 1_000_000, locale, exact)
    if (unit === 'ms') return value => chartDuration(value, locale)
    if (unit === 'ratio') return value => chartPercent(value, 1, locale)
    return (exact ? new Intl.NumberFormat(locale) : chartNumber(locale)).format
}

export function chartBucketLabel(bucket: string, locale = 'en-US') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}(?::\d{2})?$/.test(bucket)) {
        const date = new Date(`${bucket.length === 13 ? bucket + ':00' : bucket}:00Z`)
        return Number.isNaN(date.getTime()) ? bucket : date.toLocaleTimeString(locale, { hour: 'numeric' })
    }
    const date = new Date(`${bucket}T00:00:00`)
    return Number.isNaN(date.getTime()) ? bucket : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}
