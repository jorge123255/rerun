import { useEffect } from 'react'
import { View } from 'react-native'
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated'

import { ForemanOrb, type OrbState } from '@/components/orb/ForemanOrb'
import { brand } from '@/theme/tokens'

const SAMPLE_MS = 60
// How much the ball swells with the loudest sound, and how far its halo reaches.
const SWELL = 0.08
const HALO = 0.32

// The Chief of Staff's own orb, in the Mac's four states, breathing with the voice in the room: the
// person's while it listens, its own while it speaks. The level is read on a timer, never through a
// render.
export function VoiceOrb({ size, state, level }: { size: number; state: OrbState; level: () => number }) {
    const reducedMotion = useReducedMotion()
    const loudness = useSharedValue(0)
    const reacts = !reducedMotion && (state === 'listening' || state === 'speaking')

    useEffect(() => {
        if (!reacts) {
            loudness.value = withTiming(0, { duration: 200 })
            return
        }
        const timer = setInterval(() => {
            const next = Math.min(1, Math.max(0, level()))
            loudness.value = withTiming(next, { duration: SAMPLE_MS * 1.5 })
        }, SAMPLE_MS)
        return () => clearInterval(timer)
    }, [reacts, level, loudness])

    const swell = useAnimatedStyle(() => ({ transform: [{ scale: 1 + loudness.value * SWELL }] }))
    const halo = useAnimatedStyle(() => ({ opacity: 0.08 + loudness.value * 0.22, transform: [{ scale: 1 + HALO * (0.4 + loudness.value * 0.6) }] }))

    return (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
            {state === 'listening' || state === 'speaking' ? <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: brand.base }, halo]} /> : null}
            <Animated.View style={swell}>
                <ForemanOrb size={size} state={state} facing="right" />
            </Animated.View>
        </View>
    )
}
