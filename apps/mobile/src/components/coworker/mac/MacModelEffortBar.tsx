import { useEffect, useRef, useState } from 'react'
import { Pressable, View, type GestureResponderEvent } from 'react-native'
import { useTranslations } from 'use-intl'

import { AppText } from '@/components/ui/AppText'
import { Icon } from '@/components/ui/Icon'
import { useTheme } from '@/theme/theme'
import { fonts, radius, withAlpha } from '@/theme/tokens'

const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const TRACK = 36
const THUMB = 32
const SCROLL_SLOP = 8

type Props = {
    model: string
    options: readonly string[]
    chosen?: string
    inherited?: string
    disabled: boolean
    onChoose: (level: string | null) => void
}

// Native counterpart of DesktopModelEffort. The model owns its effort across coworkers.
export function MacModelEffortBar({ model, options, chosen, inherited, disabled, onChoose }: Props) {
    const t = useTranslations('mobileCoworker.mac.effortBar')
    const theme = useTheme()
    const [width, setWidth] = useState(0)
    const [preview, setPreview] = useState<number | null>(null)
    const touch = useRef<{ pageX: number; pageY: number; horizontal: boolean } | null>(null)
    const last = options.length - 1
    const saved = chosen === undefined ? -1 : options.indexOf(chosen)
    const fallback = inherited === undefined ? -1 : options.indexOf(inherited)
    const resting = saved >= 0 ? saved : fallback >= 0 ? fallback : Math.floor(last / 2)
    const index = preview ?? resting
    const picked = preview !== null || saved >= 0
    const span = Math.max(0, width - TRACK)
    const centre = (stop: number) => TRACK / 2 + span * stop / Math.max(last, 1)
    const nearest = (x: number) => Math.max(0, Math.min(last, Math.round((x - TRACK / 2) * last / Math.max(span, 1))))
    const label = (level: string) => {
        const key = LEVELS.find(item => item === level)
        return key ? t(key) : level
    }

    useEffect(() => {
        touch.current = null
        setPreview(null)
    }, [disabled, model, options, chosen, inherited])

    if (last < 0) return null
    const title = picked ? label(options[index]) : inherited ? t('inherited', { level: label(inherited) }) : t('defaultEffort')
    function choose(stop: number) {
        const next = options[stop]
        if (!disabled && next !== undefined && next !== chosen) onChoose(next)
    }
    function cancel() {
        touch.current = null
        setPreview(null)
    }
    function track(event: GestureResponderEvent, release: boolean) {
        const gesture = touch.current
        if (!gesture) return
        const { pageX, pageY, locationX, touches } = event.nativeEvent
        const dx = Math.abs(pageX - gesture.pageX)
        const dy = Math.abs(pageY - gesture.pageY)
        if (disabled || touches?.length > 1 || (!gesture.horizontal && dy >= SCROLL_SLOP && dy > dx)) {
            cancel()
            return
        }
        if (dx >= SCROLL_SLOP && dx > dy) gesture.horizontal = true
        const stop = nearest(locationX)
        if (release) {
            cancel()
            choose(stop)
        } else {
            setPreview(stop)
        }
    }

    return <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: radius.md, backgroundColor: withAlpha(theme.muted, 0.3), paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ width: 24, paddingTop: 4 }}><Icon name="zap" size={16} color={theme.mutedForeground} /></View>
            <View style={{ flex: 1, alignItems: 'center' }}>
                <AppText variant="footnote" numberOfLines={1} style={{ fontFamily: fonts.semibold, color: picked ? theme.primary : theme.mutedForeground }}>{title}</AppText>
                <AppText variant="caption" tone="muted" numberOfLines={1}>{model}</AppText>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={t('reset')} accessibilityState={{ disabled: disabled || !chosen }}
                disabled={disabled || !chosen} hitSlop={8} onPress={() => { cancel(); onChoose(null) }}
                style={{ padding: 4, opacity: disabled || !chosen ? 0.4 : 1 }}>
                <Icon name="refresh-cw" size={16} color={theme.mutedForeground} style={{ transform: [{ scaleX: -1 }] }} />
            </Pressable>
        </View>
        {/* Only the track receives touches, so locationX stays relative to it even above the thumb. */}
        <View testID="mac-model-effort-slider" accessible accessibilityRole="adjustable" accessibilityLabel={t('name')}
            accessibilityState={{ disabled }} accessibilityValue={{ min: 0, max: last, now: index, text: title }}
            accessibilityActions={disabled ? [] : [{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={({ nativeEvent: { actionName } }) => {
                if (actionName === 'increment' && resting < last) choose(resting + 1)
                if (actionName === 'decrement' && resting > 0) choose(resting - 1)
            }}
            onLayout={event => setWidth(event.nativeEvent.layout.width)} pointerEvents="box-only"
            onStartShouldSetResponder={() => !disabled && width >= TRACK}
            onResponderGrant={event => {
                if (disabled || width < TRACK) return
                const { pageX, pageY, locationX } = event.nativeEvent
                touch.current = { pageX, pageY, horizontal: false }
                setPreview(nearest(locationX))
            }}
            onResponderMove={event => track(event, false)} onResponderRelease={event => track(event, true)}
            onResponderTerminationRequest={() => !touch.current?.horizontal} onResponderTerminate={cancel}
            style={{ marginTop: 6, height: 44, justifyContent: 'center', opacity: disabled ? 0.6 : 1 }}>
            <View style={{ height: TRACK, borderRadius: radius.pill, backgroundColor: theme.muted, justifyContent: 'center' }}>
                {width >= TRACK && <>
                    <View style={{ position: 'absolute', left: 0, height: TRACK, width: centre(index) + TRACK / 2, borderRadius: radius.pill, backgroundColor: picked ? theme.primary : withAlpha(theme.mutedForeground, 0.25) }} />
                    {options.map((option, stop) => <View key={option} style={{ position: 'absolute', left: centre(stop) - 2, width: 4, height: 4, borderRadius: 2, backgroundColor: withAlpha(stop <= index ? theme.background : theme.mutedForeground, stop <= index ? 0.7 : 0.5) }} />)}
                    <View style={{ position: 'absolute', left: centre(index) - THUMB / 2, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: '#fff', boxShadow: '0 2px 5px rgba(0,0,0,0.22)' }} />
                </>}
            </View>
        </View>
    </View>
}
