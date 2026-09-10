import type { ChunkManifest, GameFileRecord, VersionData } from '@/types'
import { useQuery } from '@tanstack/vue-query'
import { API_BASE } from '@/constants/core'

export interface ChunkInfoResponse {
  build_id: string
  tag: string
  manifests: ChunkManifest[]
}

export function useGameVersions(gameId: ComputedRef<string>) {
  return useQuery({
    queryKey: computed(() => ['game-versions', gameId.value]),
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/${gameId.value}_versions.json`)
      if (!res.ok)
        throw new Error(`Failed to fetch versions: ${res.status}`)
      return res.json() as Promise<Record<string, VersionData>>
    },
    staleTime: 5 * 60 * 1000,
  })
}

export function useChunkInfo(gameId: ComputedRef<string>, version: ComputedRef<string | null>) {
  return useQuery({
    queryKey: computed(() => ['chunk-info', gameId.value, version.value]),
    queryFn: () => fetchChunkInfo(gameId.value, version.value!),
    enabled: computed(() => !!version.value),
    staleTime: 5 * 60 * 1000,
  })
}

export async function fetchChunkInfo(gameId: string, version: string): Promise<ChunkInfoResponse> {
  const res = await fetch(`${API_BASE}/chunk/${gameId}_${version}.json`)
  if (!res.ok)
    throw new Error(`Failed to fetch chunk info: ${res.status}`)
  const json = await res.json() as { retcode: number, data: ChunkInfoResponse }
  return json.data
}

export async function fetchFileList(gameId: string, version: string, filename: string): Promise<GameFileRecord[]> {
  const res = await fetch(`${API_BASE}/${gameId}/${version}/${filename}`)
  if (!res.ok)
    throw new Error(`Failed to fetch file list: ${res.status}`)
  const text = await res.text()
  return text
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as GameFileRecord)
}
