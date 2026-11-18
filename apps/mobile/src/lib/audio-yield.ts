// The voice messages the app plays and records (expo-audio) give way to a voice conversation, which
// runs its own audio session: before it opens the microphone, every player still going is paused and a
// recording under way is stopped. Each player and recorder signs up here while it is mounted.
type Stop = () => Promise<void> | void

const holders = new Set<Stop>()

export function holdAudio(stop: Stop): () => void {
    holders.add(stop)
    return () => void holders.delete(stop)
}

export async function yieldAudio(): Promise<void> {
    await Promise.allSettled([...holders].map(async stop => stop()))
}
