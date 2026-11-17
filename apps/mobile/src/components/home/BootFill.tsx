import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { Easing, FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming, type SharedValue } from 'react-native-reanimated'

import { SKELETON_ROWS, SkeletonRow } from '@/components/home/HomeSkeleton'
import { EASE_OUT } from '@/theme/motion'

// The launch screen is the Home's skeleton. Once the coworkers are read, each grey row turns into
// its coworker where it stands, one after the other, and the floating buttons come in. It plays once
// per cold start; later loads keep the plain fade.

const FILL = 560
// The share of the fill each row takes to turn; the next one starts before it is done.
const ROW_SHARE = 0.45
const REDUCED_FADE = 200
const CHROME_DELAY = 120
const CHROME_DURATION = 280
const ROW_EASING = Easing.inOut(Easing.quad)

let played = false

function rowStart(index: number, staggered: boolean) {
    'worklet'
    if (!staggered) return 0
    return (Math.min(index, SKELETON_ROWS - 1) / (SKELETON_ROWS - 1)) * (1 - ROW_SHARE)
}

type BootFillOptions = {
    // Plays again on every mount, for the lab.
    replay?: boolean
    // Stretches every duration, to judge the motion slowed down.
    pace?: number
}

export function useBootFill(ready: boolean, { replay = false, pace = 1 }: BootFillOptions = {}) {
    const reducedMotion = useReducedMotion()
    const [armed] = useState(() => replay || !played)
    const [done, setDone] = useState(false)
    const playing = armed && ready && !done
    const staggered = !reducedMotion
    const duration = (staggered ? FILL : REDUCED_FADE) * pace
    const reveal = useSharedValue(0)

    useEffect(() => {
        if (!playing) return
        played = true
        reveal.value = withTiming(1, { duration, easing: ROW_EASING })
        const timer = setTimeout(() => setDone(true), duration)
        return () => clearTimeout(timer)
    }, [playing, duration, reveal])

    const rowEntering = (index: number) => {
        if (!playing) return FadeIn.duration(180)
        if (!staggered) return FadeIn.duration(duration)
        return FadeIn.delay(rowStart(index, true) * duration)
            .duration(ROW_SHARE * duration)
            .easing(ROW_EASING)
    }

    const chromeDuration = (staggered ? CHROME_DURATION : REDUCED_FADE) * pace
    const chromeDelay = staggered ? CHROME_DELAY * pace : 0
    const chromeEntering = () => {
        'worklet'
        const timing = { duration: chromeDuration, easing: EASE_OUT }
        return {
            initialValues: { opacity: 0, transform: [{ scale: staggered ? 0.92 : 1 }] },
            animations: { opacity: withDelay(chromeDelay, withTiming(1, timing)), transform: [{ scale: withDelay(chromeDelay, withTiming(1, timing)) }] },
        }
    }

    return { playing, armed, staggered, reveal, rowEntering, chromeEntering: armed ? chromeEntering : undefined }
}

// The skeleton laid over the rows that just arrived, each grey row fading where its coworker fades in.
export function SkeletonFade({ reveal, staggered }: { reveal: SharedValue<number>; staggered: boolean }) {
    return (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                <FadingRow key={index} index={index} reveal={reveal} staggered={staggered} />
            ))}
        </View>
    )
}

function FadingRow({ index, reveal, staggered }: { index: number; reveal: SharedValue<number>; staggered: boolean }) {
    const style = useAnimatedStyle(() => {
        const share = staggered ? ROW_SHARE : 1
        return { opacity: 1 - Math.min(1, Math.max(0, (reveal.value - rowStart(index, staggered)) / share)) }
    })
    return (
        <Animated.View style={style}>
            <SkeletonRow index={index} opaque />
        </Animated.View>
    )
}
