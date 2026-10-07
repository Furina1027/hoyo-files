import type { ParsedManifest } from '@/types'
import { openDB } from 'idb'

const DB_NAME = 'hoyo-files-cache'
const DB_VERSION = 1
const STORE_NAME = 'manifests'
const MAX_SIZE = 500 * 1024 * 1024 // 500MB

interface ManifestRecord {
  key: string
  data: ParsedManifest
  size: number
  timestamp: number
}

let dbPromise: ReturnType<typeof openDB<{ manifests: { key: string, value: ManifestRecord } }>> | null = null

// 缓存总字节数的会话内记忆: evictIfNeeded 原来每次写入都 getAll 把全部缓存
// (上限 500MB 的对象) 反序列化一遍只为算总量。首次写入时全量建一次基线,
// 之后增量维护; 页面刷新重新建基线。多标签页各自计数可能漂移, 但只影响
// 一次驱逐时机, 不影响数据正确性。
let totalSizeMemo: number | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<{ manifests: { key: string, value: ManifestRecord } }>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
      },
    })
  }
  return dbPromise
}

export async function getManifest(key: string): Promise<ParsedManifest | null> {
  try {
    const db = await getDB()
    const record = await db.get(STORE_NAME, key)
    return record?.data ?? null
  }
  catch {
    return null
  }
}

export async function setManifest(key: string, data: ParsedManifest, size: number): Promise<void> {
  try {
    const db = await getDB()
    if (totalSizeMemo === null) {
      const all = await db.getAll(STORE_NAME)
      totalSizeMemo = all.reduce((s, r) => s + r.size, 0)
    }
    if (totalSizeMemo + size > MAX_SIZE) {
      const all = await db.getAll(STORE_NAME)
      all.sort((a, b) => a.timestamp - b.timestamp)
      let total = totalSizeMemo
      for (const record of all) {
        if (total + size <= MAX_SIZE)
          break
        await db.delete(STORE_NAME, record.key)
        total -= record.size
      }
      totalSizeMemo = total
    }
    const record: ManifestRecord = { key, data, size, timestamp: Date.now() }
    await db.put(STORE_NAME, record)
    totalSizeMemo += size
  }
  catch { }
}

export interface CacheStats {
  available: true
  totalSize: number
  count: number
}

export interface CacheUnavailable {
  available: false
}

export async function getCacheStats(): Promise<CacheStats | CacheUnavailable> {
  try {
    const db = await getDB()
    const all = await db.getAll(STORE_NAME)
    return {
      available: true,
      totalSize: all.reduce((s, r) => s + r.size, 0),
      count: all.length,
    }
  }
  catch {
    return { available: false }
  }
}

export async function clearCache(): Promise<void> {
  const db = await getDB()
  await db.clear(STORE_NAME)
  totalSizeMemo = 0
}
