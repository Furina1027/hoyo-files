import type { FileRecord } from '@/types'
import { useQuery } from '@tanstack/vue-query'
import { API_BASE } from '@/constants/core'

export function useUsmHistory(gameId: ComputedRef<string>) {
  return useQuery({
    queryKey: computed(() => ['usm-history', gameId.value]),
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/usm/${gameId.value}_history.json`)
      if (!res.ok)
        throw new Error(`Failed to fetch history: ${res.status}`)
      return res.json() as Promise<Record<string, FileRecord>>
    },
    staleTime: 5 * 60 * 1000,
  })
}
