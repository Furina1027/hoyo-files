import type { ChunkManifest, DownloadStatus, DownloadTask, GameFileRecord, ParsedFile } from '@/types'
import type { UsmKeyEntry } from '@/utils/usm_demux'
import { defineStore } from 'pinia'
import { API_BASE } from '@/constants/core'
import { decodeAdx, extractAdxFromUsm } from '@/utils/adx_decoder'
import { downloadChunks } from '@/utils/chunk'
import { fetchAndParseManifest } from '@/utils/manifest'
import { injectPcmAudioToWebm } from '@/utils/mkvmux'
import { decodeUsmToMkv, getUsmStreamDecoder } from '@/utils/usm'

function concatU8(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

const MAX_CONCURRENT = 3

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function triggerDownload(filename: string, data: Uint8Array | string, mimeType: string) {
  const blobPart = typeof data === 'string' ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const blob = new Blob([blobPart], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export const useDownload = defineStore('download', () => {
  const tasks = ref<DownloadTask[]>([])
  const isListOpen = ref(false)
  const controllers = new Map<string, AbortController>()

  const downloadingCount = computed(
    () => tasks.value.filter(t => t.status === 'downloading').length,
  )

  const activeCount = computed(
    () => tasks.value.filter(t => t.status === 'pending' || t.status === 'downloading' || t.status === 'decompressing' || t.status === 'merging').length,
  )

  function openList() {
    isListOpen.value = true
  }
  function closeList() {
    isListOpen.value = false
  }
  function toggleList() {
    isListOpen.value = !isListOpen.value
  }

  function clearCompleted() {
    tasks.value = tasks.value.filter(
      t => t.status !== 'success' && t.status !== 'failed' && t.status !== 'cancelled',
    )
  }

  function setTaskStatus(id: string, status: DownloadStatus, error?: string) {
    const task = tasks.value.find(t => t.id === id)
    if (!task)
      return
    task.status = status
    if (error !== undefined)
      task.error = error
  }

  function setTaskProgress(id: string, progress: number) {
    const task = tasks.value.find(t => t.id === id)
    if (task)
      task.progress = progress
  }

  function cancelTask(id: string) {
    const task = tasks.value.find(t => t.id === id)
    if (!task)
      return
    if (task.status === 'pending') {
      task.status = 'cancelled'
      return
    }
    if (task.status === 'downloading') {
      controllers.get(id)?.abort()
      controllers.delete(id)
      task.status = 'cancelled'
      processQueue()
    }
  }

  function processQueue() {
    while (downloadingCount.value < MAX_CONCURRENT) {
      const pending = [...tasks.value].reverse().find(t => t.status === 'pending')
      if (!pending)
        break

      pending.status = 'downloading'
      executeTask(pending)
    }
  }

  const manifestTaskData = new Map<string, {
    manifest: ChunkManifest
    gameId: string
    version: string
  }>()

  const chunkTaskData = new Map<string, {
    file: GameFileRecord
    manifests: ChunkManifest[]
    gameId: string
    version: string
  }>()

  const mkvExportTaskData = new Map<string, {
    filename: string
    filePath: string
    keyEntry: UsmKeyEntry
    directDownloadUrl: string | null
    bestChunkVersion: string | null
    gameId: string
    chIndex?: number
    manifests?: ChunkManifest[]
  }>()

  async function executeTask(task: DownloadTask) {
    try {
      if (task.type === 'manifest-json') {
        await runManifestJsonTask(task)
      }
      else if (task.type === 'usm-mkv-export') {
        await runUsmMkvExportTask(task)
      }
      else {
        await runChunkFileTask(task)
      }
    }
    catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setTaskStatus(task.id, 'failed', (e as Error).message)
      }
    }
    finally {
      // 任务数据只增不删就会随失败/取消的次数单调上涨 (manifests 里还可能拖着
      // vue-query 的响应式代理), 而这三个 Map 不是响应式, 界面上看不见、也没有
      // 任何自动回收。executeTask 的 finally 是唯一覆盖成功/失败/取消/abort
      // 全部出口的地方, 所以在这里统一清, 而不是散在各 run 函数的成功路径上。
      controllers.delete(task.id)
      manifestTaskData.delete(task.id)
      chunkTaskData.delete(task.id)
      mkvExportTaskData.delete(task.id)
      processQueue()
    }
  }

  async function runManifestJsonTask(task: DownloadTask) {
    const data = manifestTaskData.get(task.id)
    if (!data)
      throw new Error('任务数据丢失')

    const { manifest, gameId, version } = data
    const url = `${manifest.manifest_download.url_prefix}/${manifest.manifest.id}`
    const cacheKey = `${gameId}_${version}_${manifest.manifest.id}`
    const uncompressedSize = Number(manifest.manifest.uncompressed_size)

    const controller = new AbortController()
    controllers.set(task.id, controller)

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    setTaskStatus(task.id, 'decompressing')

    const parsed = await fetchAndParseManifest(url, cacheKey, uncompressedSize, controller.signal)

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    const json = JSON.stringify(parsed, null, 2)
    triggerDownload(`${manifest.manifest.id}.json`, json, 'application/json')

    setTaskStatus(task.id, 'success')
    setTaskProgress(task.id, 100)
  }

  async function runChunkFileTask(task: DownloadTask) {
    const data = chunkTaskData.get(task.id)
    if (!data)
      throw new Error('任务数据丢失')

    const { file, manifests, gameId, version } = data
    const controller = new AbortController()
    controllers.set(task.id, controller)

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    let foundFile: ParsedFile | null = null
    let chunkUrlPrefix = ''

    for (const m of manifests) {
      const cacheKey = `${gameId}_${version}_${m.manifest.id}`
      const url = `${m.manifest_download.url_prefix}/${m.manifest.id}`
      const uncompressedSize = Number(m.manifest.uncompressed_size)

      let parsed
      try {
        parsed = await fetchAndParseManifest(url, cacheKey, uncompressedSize, controller.signal)
      }
      catch (e) {
        if ((e as Error).name === 'AbortError' || e instanceof TypeError)
          throw e
        continue
      }

      const match = parsed.files.find(f => f.path === file.remoteName)
      if (match) {
        foundFile = match
        chunkUrlPrefix = m.chunk_download.url_prefix
        break
      }

      if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
        return
    }

    if (!foundFile) {
      throw new Error('无可用资源')
    }

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    const chunks = [...foundFile.chunks].sort((a, b) => a.offset - b.offset)
    const buffers: Uint8Array[] = []

    setTaskStatus(task.id, 'downloading')
    setTaskProgress(task.id, 0)

    await downloadChunks(chunks, chunkUrlPrefix, controller.signal, (decompressed, i, total) => {
      buffers.push(decompressed)
      setTaskProgress(task.id, Math.round(((i + 1) / total) * 90))
    })

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    setTaskStatus(task.id, 'merging')

    const totalSize = buffers.reduce((s, b) => s + b.length, 0)
    const merged = new Uint8Array(totalSize)
    let offset = 0
    for (const buf of buffers) {
      merged.set(buf, offset)
      offset += buf.length
    }

    const filename = file.remoteName.slice(file.remoteName.lastIndexOf('/') + 1)
    triggerDownload(filename, merged, 'application/octet-stream')

    setTaskStatus(task.id, 'success')
    setTaskProgress(task.id, 100)
  }

  function addManifestJsonTask(manifest: ChunkManifest, gameId: string, version: string) {
    const id = makeId()
    const task: DownloadTask = {
      id,
      type: 'manifest-json',
      status: 'pending',
      name: `${manifest.manifest.id}.json`,
      progress: 0,
    }
    manifestTaskData.set(id, { manifest, gameId, version })
    tasks.value.unshift(task)
    processQueue()
  }

  function addChunkFileTask(file: GameFileRecord, manifests: ChunkManifest[], gameId: string, version: string) {
    const id = makeId()
    const filename = file.remoteName.slice(file.remoteName.lastIndexOf('/') + 1)
    const task: DownloadTask = {
      id,
      type: 'chunk-file',
      status: 'pending',
      name: filename,
      progress: 0,
    }
    chunkTaskData.set(id, { file, manifests, gameId, version })
    tasks.value.unshift(task)
    processQueue()
  }

  /** 流式下载响应并回报进度 (0-95%) */
  async function streamResponseWithProgress(res: Response, onProgress: (pct: number) => void): Promise<Uint8Array> {
    const total = Number(res.headers.get('Content-Length') ?? 0)
    const reader = res.body!.getReader()
    const buffers: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      buffers.push(value)
      received += value.byteLength
      if (total > 0)
        onProgress(Math.min(95, Math.round((received / total) * 95)))
    }
    const totalSize = buffers.reduce((s, b) => s + b.length, 0)
    const out = new Uint8Array(totalSize)
    let off = 0
    for (const buf of buffers) {
      out.set(buf, off)
      off += buf.length
    }
    return out
  }

  async function runUsmMkvExportTask(task: DownloadTask) {
    const data = mkvExportTaskData.get(task.id)
    if (!data)
      throw new Error('任务数据丢失')

    const { filename, filePath, keyEntry, gameId } = data
    const controller = new AbortController()
    controllers.set(task.id, controller)
    const { signal } = controller

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    const baseName = filename.replace(/\.usm$/i, '')

    // 全程经服务器: 浏览器不直连外部 CDN, 直链失效自动回退 chunk 组装
    const params = new URLSearchParams()
    params.set('game', gameId)
    params.set('file', filePath)
    if (data.directDownloadUrl)
      params.set('url', data.directDownloadUrl)
    if (data.bestChunkVersion)
      params.set('version', data.bestChunkVersion)

    // 探测格式: H.264 → 服务器解密转 MP4 导出; VP9 → 下载 USM 后 wasm 解码 MKV (含音频)
    let fmt: string | null = null
    try {
      const gameDir = localStorage.getItem(`game_dir_${gameId}`) || null
      if (gameDir)
        params.set('game_dir', gameDir)
      const detectRes = await fetch(`${API_BASE}/api/usm-detect?${params}`, { signal })
      if (detectRes.ok)
        fmt = ((await detectRes.json()) as { format?: string }).format ?? null
    }
    catch { /* 按未知格式走 VP9 分支 */ }

    setTaskStatus(task.id, 'downloading')
    setTaskProgress(task.id, 0)

    const reunion67Alias = gameId === 'hk4e' && filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() === 'video_reunion_67_test.usm'

    if (fmt === 'mpeg1') {
      // 4.5 TV 类明文 MPEG1: 服务器借 ffmpeg 转码为 MP4 (无音轨)
      const t = tasks.value.find(x => x.id === task.id)
      if (t)
        t.name = `${baseName}.mp4`
      const res = await fetch(`${API_BASE}/api/usm-mp4?${params}`, { signal })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text.replace(/^USM 转换失败:\s*/, '') || `HTTP ${res.status}`)
      }
      const bytes = await streamResponseWithProgress(res, pct => setTaskProgress(task.id, pct))
      setTaskStatus(task.id, 'merging')
      setTaskProgress(task.id, 99)
      triggerDownload(`${baseName}.mp4`, bytes, 'video/mp4')
    }
    else if (fmt === 'vp9' && gameId === 'hk4e' && (typeof keyEntry === 'object' || reunion67Alias)) {
      const t = tasks.value.find(x => x.id === task.id)
      if (t)
        t.name = `${baseName}.mkv`
      const mkvParams = new URLSearchParams(params)
      if (data.chIndex != null)
        mkvParams.set('ch', String(data.chIndex))
      const res = await fetch(`${API_BASE}/api/usm-mkv?${mkvParams}`, { signal })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text.replace(/^USM 转换失败:\s*/, '') || `HTTP ${res.status}`)
      }
      const bytes = await streamResponseWithProgress(res, pct => setTaskProgress(task.id, pct))
      setTaskStatus(task.id, 'merging')
      setTaskProgress(task.id, 99)
      triggerDownload(`${baseName}.mkv`, bytes, 'video/x-matroska')
    }
    else if (fmt === 'h264') {
      const t = tasks.value.find(x => x.id === task.id)
      // 崩铁: H.264 USM 的 @SFA 是 ADX 音频, 服务器封装为含音轨的 MKV
      // (原神/绝区零保持 MP4/纯视频: 音频为 HCA 或不存在, 走 wasm 路径)
      const useMkv = gameId === 'hkrpg'
      const ext = useMkv ? 'mkv' : 'mp4'
      if (t)
        t.name = `${baseName}.${ext}`
      const mkvParams = new URLSearchParams(params)
      if (useMkv && data.chIndex != null)
        mkvParams.set('ch', String(data.chIndex))
      const res = await fetch(`${API_BASE}${useMkv ? '/api/usm-mkv' : '/api/usm-mp4'}?${mkvParams}`, { signal })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text.replace(/^USM 转换失败:\s*/, '') || `HTTP ${res.status}`)
      }
      const bytes = await streamResponseWithProgress(res, pct => setTaskProgress(task.id, pct))
      setTaskStatus(task.id, 'merging')
      setTaskProgress(task.id, 99)
      triggerDownload(`${baseName}.${ext}`, bytes, useMkv ? 'video/x-matroska' : 'video/mp4')
    }
    else {
      const res = await fetch(`${API_BASE}/api/usm-proxy?${params}`, { signal })
      if (!res.ok)
        throw new Error(`USM 下载失败: HTTP ${res.status}`)
      const usmBytes = await streamResponseWithProgress(res, pct => setTaskProgress(task.id, pct))
      setTaskStatus(task.id, 'merging')
      setTaskProgress(task.id, 85)

      // VP9 wasm 路径只支持 4.4 掩码字符串 key; 4.5 method2 对象 key 不应出现 VP9
      if (typeof keyEntry !== 'string')
        throw new Error('未识别的视频格式, 无法导出')
      const keyHex = keyEntry

      // 先尝试 MKV (含音频); 音频不可用时自动降级为流式解码导出视频
      // (崩铁: 音频非 HCA 兼容 → 降级后注入 ADX 音频 / 绝区零: USM 内无音轨)
      try {
        const mkvData = await decodeUsmToMkv(usmBytes, keyHex, data.chIndex ?? undefined)
        triggerDownload(`${baseName}.mkv`, mkvData, 'video/x-matroska')
      }
      catch (mkvErr) {
        const msg = typeof mkvErr === 'string' ? mkvErr : ((mkvErr as Error)?.message ?? String(mkvErr))
        console.warn(`[usm-export] MKV 导出降级: ${msg}`)
        const t = tasks.value.find(x => x.id === task.id)
        if (t)
          t.name = `${baseName}.webm`
        const dec = await getUsmStreamDecoder(keyHex)
        const parts: Uint8Array[] = []
        const PUSH_SIZE = 4 * 1024 * 1024
        // dec 持有 wasm 线性内存, 只有 free() 才回收; 中止早退和 push/finish
        // 抛错这两条路径原来都绕过了 free(), 每取消或失败一个视频就漏一个
        // 实例。getUsmStreamDecoder 每次都 new, 不共享, 所以这里独占释放安全。
        try {
          for (let off = 0; off < usmBytes.length; off += PUSH_SIZE) {
            if (signal.aborted)
              return
            const r = dec.push(usmBytes.subarray(off, off + PUSH_SIZE)) as {
              init_segment?: Uint8Array
              clusters?: Uint8Array[]
            }
            if (r.init_segment)
              parts.push(r.init_segment)
            for (const c of r.clusters ?? [])
              parts.push(c)
            setTaskProgress(task.id, Math.min(98, 85 + Math.round((off / usmBytes.length) * 13)))
          }
          const fin = dec.finish() as { init_segment?: Uint8Array, clusters?: Uint8Array[] }
          if (fin.init_segment)
            parts.push(fin.init_segment)
          for (const c of fin.clusters ?? [])
            parts.push(c)
        }
        finally {
          dec.free()
        }

        // 崩铁: 视频 WebM + 注入 ADX 音频 → 带音轨 MKV
        let output = concatU8(parts)
        let mime = 'video/webm'
        let ext = 'webm'
        if (gameId === 'hkrpg') {
          try {
            const adx = await extractAdxFromUsm(usmBytes, data.chIndex ?? 0, keyHex)
            const audio = decodeAdx(adx)
            output = injectPcmAudioToWebm(parts, {
              pcm: audio.pcm,
              sampleRate: audio.sampleRate,
              channels: audio.channels,
            })
            mime = 'video/x-matroska'
            ext = 'mkv'
            if (t) {
              t.name = `${baseName}.mkv`
            }
          }
          catch (audioErr) {
            console.warn(`[usm-export] ADX 音频注入失败, 保留纯视频: ${(audioErr as Error)?.message ?? String(audioErr)}`)
          }
        }
        triggerDownload(`${baseName}.${ext}`, output, mime)
      }
    }

    setTaskStatus(task.id, 'success')
    setTaskProgress(task.id, 100)
  }

  function addUsmMkvExportTask(params: {
    filename: string
    filePath: string
    keyEntry: UsmKeyEntry
    directDownloadUrl: string | null
    bestChunkVersion: string | null
    gameId: string
    chIndex?: number
  }) {
    const id = makeId()
    const baseName = params.filename.replace(/\.usm$/i, '')
    const task: DownloadTask = {
      id,
      type: 'usm-mkv-export',
      status: 'pending',
      name: `${baseName}.mkv`,
      progress: 0,
    }
    mkvExportTaskData.set(id, params)
    tasks.value.unshift(task)
    processQueue()
  }

  return {
    tasks,
    isListOpen,
    downloadingCount,
    activeCount,
    openList,
    closeList,
    toggleList,
    clearCompleted,
    cancelTask,
    addManifestJsonTask,
    addChunkFileTask,
    addUsmMkvExportTask,
  }
})
