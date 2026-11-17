import { useLocalSearchParams } from 'expo-router'

import { AddProviderScreen } from '@/components/providers/screens'

export default function AddProviderSheet() {
    const { only } = useLocalSearchParams<{ only?: 'plan' | 'key' }>()
    return <AddProviderScreen only={only === 'plan' || only === 'key' ? only : undefined} />
}
