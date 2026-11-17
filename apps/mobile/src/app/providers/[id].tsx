import { useLocalSearchParams } from 'expo-router'

import { ConnectionDetailScreen } from '@/components/providers/screens'

export default function ConnectionSheet() {
    const { id } = useLocalSearchParams<{ id: string }>()
    return <ConnectionDetailScreen connectionId={id} />
}
