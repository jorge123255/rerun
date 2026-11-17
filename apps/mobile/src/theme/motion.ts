import { Easing, LinearTransition } from 'react-native-reanimated'

export const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1)

export const MOTION = { fast: 160, base: 220 } as const

export const layoutTransition = LinearTransition.duration(MOTION.base).easing(EASE_OUT)
