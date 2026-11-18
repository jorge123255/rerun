import { requireOptionalNativeModule } from 'expo'

type Subscription = { remove(): void }

type AudioInterruptionModule = {
    addListener(event: 'onInterruption', listener: (event: { kind: string }) => void): Subscription
}

// modules/audio-interruption: a phone call, an alarm or Siri taking the audio away. The module watches
// only while someone listens. Null in the tests and in a build without it, where only leaving the app
// ends the conversation.
const Native = requireOptionalNativeModule<AudioInterruptionModule>('AudioInterruption')

export function watchInterruptions(onInterrupted: () => void, native: AudioInterruptionModule | null = Native): () => void {
    if (!native) return () => {}
    const subscription = native.addListener('onInterruption', () => onInterrupted())
    return () => subscription.remove()
}
