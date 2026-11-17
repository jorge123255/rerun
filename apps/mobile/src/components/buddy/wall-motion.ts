import type { Matrix } from '@/components/orb/orb-motion'

// Animated groups only take a `matrix`: react-native-svg turns the shorthands (scaleY, originY,
// translateY) into one in JS, which a prop driven by Reanimated never goes through.

// Stretched vertically by `scale`, the line `y` staying where it is.
export function stretchedFrom(y: number, scale: number): Matrix {
    'worklet'
    return [1, 0, 0, scale, 0, y * (1 - scale)]
}

export function liftedBy(dy: number): Matrix {
    'worklet'
    return [1, 0, 0, 1, 0, dy]
}
