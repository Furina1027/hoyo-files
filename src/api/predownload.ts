import type { PredownloadDiffEntry, PredownloadTagDiff } from '@/types'
import { useQuery } from '@tanstack/vue-query'
import { API_BASE } from '@/constants/core'

export interface PredownloadSummary {
  game: string
  current_version: string
  predownload_version: string
  build_id: string
  generated_at: string
  tags: string[]
  stats: Record<string, PredownloadTagDiff['stats']>
}

export interface PredownloadDirData {
  dirs: { name: string, added: number, modified: number, deleted: number, size: number }[]
  files: (PredownloadDiffEntry & { type: 'added' | 'modified' | 'deleted' })[]
  truncated?: boolean
}

const FETCH_TIMEOUT = 30_000

/** IAB 沙箱的 fetch 在响应体较大时(实测 >~200KB)会挂起; 这里只请求小响应, 无需 XHR */
async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (res.status === 404)
      return null
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`)
    return await res.json()
  }
  finally {
    clearTimeout(timer)
  }
}

export function usePredownloadSummary(gameId: ComputedRef<string>) {
  return useQuery({
    queryKey: computed(() => ['predownload-summary', gameId.value]),
    queryFn: async () => fetchJson(`${API_BASE}/api/predownload-summary/${gameId.value}`) as Promise<PredownloadSummary | null>,
    staleTime: 60 * 1000,
  })
}

export function usePredownloadDir(gameId: ComputedRef<string>, tag: Ref<string | null>, dir: Ref<string[]>, query: Ref<string>) {
  return useQuery({
    queryKey: computed(() => ['predownload-dir', gameId.value, tag.value, dir.value.join('/'), query.value]),
    queryFn: async () => {
      const params = new URLSearchParams()
      if (tag.value)
        params.set('tag', tag.value)
      if (dir.value.length)
        params.set('dir', dir.value.join('/'))
      if (query.value.trim())
        params.set('q', query.value.trim())
      return fetchJson(`${API_BASE}/api/predownload/${gameId.value}?${params}`) as Promise<PredownloadDirData | null>
    },
    staleTime: 60 * 1000,
  })
}
