<script setup lang="ts">
import type { PredownloadSummary } from '@/api/predownload'
import { usePredownloadDir, usePredownloadSummary } from '@/api/predownload'
import { API_BASE } from '@/constants/core'
import { downloadChunks } from '@/utils/chunk'
import { formatBytes } from '@/utils/file'

const route = useRoute()
const gameId = computed(() => route.params.gameId as string)

const summaryQuery = usePredownloadSummary(gameId)
const refreshing = ref(false)
const refreshError = ref<string | null>(null)
const refreshResult = ref<string | null>(null)

async function handleRefresh() {
  refreshing.value = true
  refreshError.value = null
  refreshResult.value = null
  try {
    const res = await fetch(`${API_BASE}/api/refresh/${gameId.value}`, { method: 'POST' })
    const data = await res.json()
    if (data.error)
      refreshError.value = data.error
    else if (data.predownload?.error)
      refreshError.value = data.predownload.error
    else
      refreshResult.value = data.predownload?.tag ? `已更新为预下载 ${data.predownload.tag}` : '已刷新 (当前无预下载)'
    await summaryQuery.refetch()
    await dirQuery.refetch()
  }
  catch (err) {
    refreshError.value = (err as Error).message
  }
  finally {
    refreshing.value = false
  }
}

const summary = computed<PredownloadSummary | null>(() => summaryQuery.data.value ?? null)

const activeTag = ref<string | null>(null)
const searchQuery = ref('')
const changeTypeFilter = ref<'added' | 'modified' | 'deleted' | null>(null)
const currentPath = ref<string[]>([])

watch(summary, (value) => {
  if (!value)
    return
  if (!activeTag.value || !value.tags.includes(activeTag.value))
    activeTag.value = value.tags.at(-1) ?? null
}, { immediate: true })

watch([activeTag, searchQuery, changeTypeFilter], () => {
  currentPath.value = []
})

const dirQuery = usePredownloadDir(gameId, activeTag, currentPath, searchQuery)
const dirData = computed(() => dirQuery.data.value)

const activeStats = computed(() => {
  if (!summary.value || !activeTag.value)
    return null
  return summary.value.stats[activeTag.value] ?? null
})

const TYPE_META: Record<string, { label: string, badge: string }> = {
  added: { label: '新增', badge: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' },
  modified: { label: '修改', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  deleted: { label: '删除', badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
}

const filterOptions: { value: 'added' | 'modified' | 'deleted' | null, label: string, color: string }[] = [
  { value: null, label: '全部', color: '' },
  { value: 'added', label: '新增', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' },
  { value: 'modified', label: '修改', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  { value: 'deleted', label: '删除', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
]

const visibleDirs = computed(() => {
  const dirs = dirData.value?.dirs ?? []
  if (!changeTypeFilter.value)
    return dirs
  return dirs.filter(d => d[changeTypeFilter.value!] > 0)
})

const visibleFiles = computed(() => {
  const files = dirData.value?.files ?? []
  if (!changeTypeFilter.value)
    return files
  return files.filter(f => f.type === changeTypeFilter.value)
})

// ---- 选中文件 (详情面板, 与文件列表页一致) ----

const selectedFile = ref<(PredownloadDirData['files'][number]) | null>(null)

function selectFile(file: PredownloadDirData['files'][number]) {
  selectedFile.value = selectedFile.value?.file === file.file ? null : file
}

watch([activeTag, searchQuery, changeTypeFilter, currentPath], () => {
  selectedFile.value = null
  clearSelection()
})

function getFilename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}

// ---- 批量选择 ----

const selectedFiles = ref<Set<string>>(new Set())
const selectedDirs = ref<Set<string>>(new Set())

const selectedCount = computed(() => selectedFiles.value.size + selectedDirs.value.size)
const selectedSize = computed(() => {
  let total = 0
  const files = dirData.value?.files ?? []
  const fileById = new Map(files.map(f => [f.file, f]))
  for (const f of selectedFiles.value)
    total += fileById.get(f)?.size ?? 0
  // 目录选中: 累加当前视图可见目录的累计大小 (服务器端会精确计算)
  const dirs = dirData.value?.dirs ?? []
  for (const d of dirs) {
    if (selectedDirs.value.has([...currentPath.value, d.name].join('/')))
      total += d.size
  }
  return total
})

function toggleFile(file: string) {
  const next = new Set(selectedFiles.value)
  if (next.has(file))
    next.delete(file)
  else
    next.add(file)
  selectedFiles.value = next
}

function toggleDir(name: string) {
  const key = [...currentPath.value, name].join('/')
  const next = new Set(selectedDirs.value)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  selectedDirs.value = next
}

function toggleAllVisible() {
  const fnext = new Set(selectedFiles.value)
  const dnext = new Set(selectedDirs.value)
  const visibleFilesList = visibleFiles.value
  const visibleDirsList = visibleDirs.value
  // 全部选中时点击 → 全不选; 否则全部选中
  const allSelected = visibleFilesList.every(f => fnext.has(f.file))
    && visibleDirsList.every(d => dnext.has([...currentPath.value, d.name].join('/')))
  if (allSelected) {
    for (const f of visibleFilesList)
      fnext.delete(f.file)
    for (const d of visibleDirsList)
      dnext.delete([...currentPath.value, d.name].join('/'))
  }
  else {
    for (const f of visibleFilesList)
      fnext.add(f.file)
    for (const d of visibleDirsList)
      dnext.add([...currentPath.value, d.name].join('/'))
  }
  selectedFiles.value = fnext
  selectedDirs.value = dnext
}

function clearSelection() {
  selectedFiles.value = new Set()
  selectedDirs.value = new Set()
}

// ---- 下载 ----

const downloading = ref(false)
const downloadResult = ref<{ ok: number, failed: number, skipped: number, errors: { file: string, error: string }[] } | null>(null)
const downloadProgress = ref<{ processed: number, total: number, current: string, kind: string, status: string, error?: string } | null>(null)
const singleDownloading = ref<Set<string>>(new Set())

function gameDir() {
  return localStorage.getItem(`game_dir_${gameId.value}`) || ''
}

function triggerDownload(filename: string, data: Uint8Array) {
  const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

/** 单文件下载: 优先浏览器端 chunk 直下 (与文件列表页相同, 无需本地客户端文件) */
async function handleSingleDownload(filePath: string) {
  const filename = filePath.slice(filePath.lastIndexOf('/') + 1)
  const next = new Set(singleDownloading.value)
  next.add(filePath)
  singleDownloading.value = next
  try {
    let info: { chunks: { id: string, offset: number, compressed_size: number, uncompressed_size: number }[], url_prefix: string, size: number } | null = null
    try {
      const res = await fetch(`${API_BASE}/api/predownload-chunkinfo/${gameId.value}?file=${encodeURIComponent(filePath)}`)
      if (res.ok)
        info = await res.json()
    }
    catch { /* 回退服务器下载 */ }

    if (info?.chunks?.length && info.url_prefix) {
      // 浏览器端直下 (与文件列表页相同); 失败 (如沙箱无法访问 CDN) 则回退服务器下载
      try {
        const chunks = [...info.chunks].sort((a, b) => a.offset - b.offset)
        const buffers: Uint8Array[] = []
        const controller = new AbortController()
        await downloadChunks(
          chunks.map(c => ({ id: c.id, offset: c.offset, compressedSize: c.compressed_size, uncompressedSize: c.uncompressed_size })),
          info.url_prefix,
          controller.signal,
          (decompressed) => { buffers.push(decompressed) },
        )
        const merged = new Uint8Array(info.size)
        let pos = 0
        for (const buf of buffers) {
          merged.set(buf, pos)
          pos += buf.length
        }
        triggerDownload(filename, merged)
        downloadResult.value = { ok: 1, failed: 0, skipped: 0, errors: [] }
      }
      catch {
        await handleDownload([filePath], null, filePath)
      }
    }
    else {
      // 目标版本 chunk 数据不可用 → 服务器 diff 重建
      await handleDownload([filePath], null, filePath)
    }
  }
  catch (err) {
    downloadResult.value = { ok: 0, failed: 1, skipped: 0, errors: [{ file: filePath, error: (err as Error).message }] }
  }
  finally {
    const next2 = new Set(singleDownloading.value)
    next2.delete(filePath)
    singleDownloading.value = next2
  }
}

/** 批量下载选中项: 服务器统一处理 (chunk 直下 + diff 回退, 与"下载全部"一致) */
async function handleDownloadSelected() {
  const files = [...selectedFiles.value]
  const dirs = [...selectedDirs.value]
  if (files.length === 0 && dirs.length === 0)
    return
  await handleDownload(files.length ? files : null, dirs.length ? dirs : null, `选中 (${files.length + dirs.length})`)
}

async function handleDownload(files: string[] | null, dirs: string[] | null, label: string, kinds?: string | null) {
  downloading.value = true
  downloadResult.value = null
  downloadProgress.value = null
  try {
    const res = await fetch(`${API_BASE}/api/predownload-download/${gameId.value}`, {
      method: 'POST',
      // 不带 Content-Type: 保持简单请求, 避免 CORS preflight (IAB 沙箱 preflight 会挂起)
      body: JSON.stringify({ files, dirs, kinds: kinds ?? null, game_dir: gameDir() || null }),
    })

    // 服务器以 NDJSON 流式返回进度; 每行: {type:'progress'|'done'|'error', ...}
    const reader = res.body?.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done: { ok?: unknown[], failed?: { file: string, error: string }[] } | null = null
    let streamError: string | null = null

    if (reader) {
      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished)
          break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line)
            continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'progress') {
              downloadProgress.value = {
                processed: msg.processed,
                total: msg.total,
                current: msg.current,
                kind: msg.kind,
                status: msg.status,
                error: msg.error,
              }
            }
            else if (msg.type === 'done') {
              done = msg
            }
            else if (msg.type === 'error') {
              streamError = msg.error
            }
          }
          catch { /* 忽略坏行 */ }
        }
      }
    }

    if (streamError)
      throw new Error(streamError)
    if (!done) {
      // 非流式响应 (兼容旧实现/代理), 走 JSON
      const data = await res.json().catch(() => null)
      if (data?.error)
        throw new Error(data.error)
      done = data ?? {}
    }
    downloadResult.value = {
      ok: (done.ok?.length ?? 0),
      failed: (done.failed?.length ?? 0),
      skipped: (done.ok?.filter((x: { skipped?: boolean }) => x.skipped)?.length ?? 0),
      errors: done.failed ?? [],
    }
  }
  catch (err) {
    downloadResult.value = { ok: 0, failed: 1, skipped: 0, errors: [{ file: label, error: (err as Error).message }] }
  }
  finally {
    downloading.value = false
  }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div
      v-if="summaryQuery.isPending.value"
      class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500"
    >
      <LucideLoader2 class="mr-2 h-5 w-5 animate-spin" />
      <span>加载预下载数据...</span>
    </div>

    <div
      v-else-if="summaryQuery.isError.value"
      class="flex h-full items-center justify-center text-red-500"
    >
      <LucideAlertCircle class="mr-2 h-5 w-5" />
      <span>预下载数据加载失败: {{ summaryQuery.error.value?.message }}</span>
    </div>

    <div
      v-else-if="!summary"
      class="flex h-full flex-col items-center justify-center gap-3 text-gray-400 dark:text-gray-500"
    >
      <div class="flex items-center">
        <LucideCloudDownload class="mr-2 h-5 w-5" />
        <span>暂无预下载数据</span>
      </div>
      <button
        class="flex items-center gap-1.5 rounded-md border border-blue-200 px-3 py-1.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800/50 dark:text-blue-400 dark:hover:bg-blue-900/20"
        :disabled="refreshing"
        @click="handleRefresh"
      >
        <LucideLoader2 v-if="refreshing" class="h-3.5 w-3.5 animate-spin" />
        <LucideRefreshCw v-else class="h-3.5 w-3.5" />
        {{ refreshing ? '刷新中...' : '从官方接口刷新' }}
      </button>
      <p v-if="refreshError" class="text-xs text-red-500">{{ refreshError }}</p>
    </div>

    <template v-else>
      <!-- 顶部信息条 -->
      <div class="shrink-0 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
            <LucideCloudDownload class="h-3.5 w-3.5" />
            预下载 {{ summary.predownload_version }}
          </span>
          <span class="text-sm text-gray-600 dark:text-gray-300">
            基于当前版本
            <span class="font-mono font-semibold">{{ summary.current_version }}</span>
          </span>
          <span v-if="summary.build_id" class="font-mono text-xs text-gray-400 dark:text-gray-500">
            build: {{ summary.build_id }}
          </span>
          <span v-if="summary.generated_at" class="text-xs text-gray-400 dark:text-gray-500">
            生成于 {{ new Date(summary.generated_at).toLocaleString() }}
          </span>
          <span class="ml-auto flex items-center gap-2">
            <span v-if="refreshResult" class="text-xs text-green-600 dark:text-green-400">{{ refreshResult }}</span>
            <span v-if="refreshError" class="text-xs text-red-500">{{ refreshError }}</span>
            <button
              class="flex items-center gap-1 rounded-md border border-blue-200 px-2.5 py-1 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800/50 dark:text-blue-400 dark:hover:bg-blue-900/20"
              :disabled="refreshing"
              @click="handleRefresh"
            >
              <LucideLoader2 v-if="refreshing" class="h-3 w-3 animate-spin" />
              <LucideRefreshCw v-else class="h-3 w-3" />
              {{ refreshing ? '刷新中...' : '刷新数据' }}
            </button>
          </span>
        </div>

        <!-- 旧版本 tag 切换 -->
        <div v-if="summary.tags.length > 1" class="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span class="text-xs text-gray-400 dark:text-gray-500">更新前版本:</span>
          <button
            v-for="tag in summary.tags"
            :key="tag"
            class="rounded-full px-2.5 py-0.5 font-mono text-xs font-medium transition-colors"
            :class="activeTag === tag
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
            @click="activeTag = tag"
          >
            {{ tag }}
          </button>
        </div>

        <!-- 统计 + 下载全部 -->
        <div v-if="activeStats" class="mt-3 flex flex-wrap items-end gap-3">
          <div class="grid flex-1 grid-cols-3 gap-3 sm:max-w-lg">
            <div class="rounded-lg border border-green-200 bg-green-50 px-3 py-2 dark:border-green-700/50 dark:bg-green-900/20">
              <p class="text-xs text-green-600 dark:text-green-400">新增文件</p>
              <p class="mt-0.5 text-lg font-bold text-green-700 dark:text-green-300">
                {{ activeStats.added }}
                <span class="text-xs font-normal opacity-70">{{ formatBytes(activeStats.added_size) }}</span>
              </p>
            </div>
            <div class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-700/50 dark:bg-amber-900/20">
              <p class="text-xs text-amber-600 dark:text-amber-400">修改文件</p>
              <p class="mt-0.5 text-lg font-bold text-amber-700 dark:text-amber-300">
                {{ activeStats.modified }}
                <span class="text-xs font-normal opacity-70">{{ formatBytes(activeStats.modified_size) }}</span>
              </p>
            </div>
            <div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-700/50 dark:bg-red-900/20">
              <p class="text-xs text-red-600 dark:text-red-400">删除文件</p>
              <p class="mt-0.5 text-lg font-bold text-red-700 dark:text-red-300">
                {{ activeStats.deleted }}
                <span class="text-xs font-normal opacity-70">{{ formatBytes(activeStats.deleted_size) }}</span>
              </p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 pb-0.5">
            <span v-if="!gameDir()" class="text-[11px] text-amber-500">
              目标版本无 chunk 数据时, 修改文件需配置游戏安装路径
            </span>
            <button
              class="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="downloading || activeStats.added === 0"
              @click="handleDownload(null, null, '新增', 'added')"
            >
              <LucideLoader2 v-if="downloading" class="h-3.5 w-3.5 animate-spin" />
              <LucideDownload v-else class="h-3.5 w-3.5" />
              下载新增 ({{ activeStats.added }})
            </button>
            <button
              class="flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="downloading || activeStats.modified === 0"
              @click="handleDownload(null, null, '修改', 'modified')"
            >
              <LucideLoader2 v-if="downloading" class="h-3.5 w-3.5 animate-spin" />
              <LucideDownload v-else class="h-3.5 w-3.5" />
              下载修改 ({{ activeStats.modified }})
            </button>
            <button
              class="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="downloading || (activeStats.added + activeStats.modified) === 0"
              @click="handleDownload(null, null, '新增+修改', 'added,modified')"
            >
              <LucideLoader2 v-if="downloading" class="h-3.5 w-3.5 animate-spin" />
              <LucideDownload v-else class="h-3.5 w-3.5" />
              下载全部 ({{ activeStats.added + activeStats.modified }})
            </button>
          </div>
        </div>

        <!-- 选中条 -->
        <div v-if="selectedCount > 0" class="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-blue-50 px-3 py-1.5 dark:bg-blue-900/20">
          <LucideCheckSquare class="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span class="text-xs font-medium text-blue-700 dark:text-blue-300">
            已选 {{ selectedCount }} 项
            <span v-if="selectedSize > 0" class="opacity-70">({{ formatBytes(selectedSize) }})</span>
          </span>
          <button
            class="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="downloading"
            @click="handleDownloadSelected()"
          >
            <LucideLoader2 v-if="downloading" class="h-3 w-3 animate-spin" />
            <LucideDownload v-else class="h-3 w-3" />
            下载选中
          </button>
          <button
            class="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            :disabled="downloading"
            @click="clearSelection()"
          >
            清空选择
          </button>
        </div>

        <!-- 下载进度 -->
        <div v-if="downloadProgress" class="mt-2 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-900/50">
          <div class="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
            <span>
              已下载 {{ downloadProgress.processed }} / {{ downloadProgress.total }} 个文件
            </span>
            <span class="font-mono">
              {{ downloadProgress.total > 0 ? Math.round(downloadProgress.processed / downloadProgress.total * 100) : 0 }}%
            </span>
          </div>
          <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              class="h-full rounded-full bg-blue-500 transition-all duration-200"
              :style="{ width: `${downloadProgress.total > 0 ? Math.round(downloadProgress.processed / downloadProgress.total * 100) : 0}%` }"
            />
          </div>
          <div class="mt-1 flex items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
            <LucideLoader2 class="h-3 w-3 animate-spin" />
            <span class="min-w-0 flex-1 truncate">
              <span :class="downloadProgress.kind === 'added' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'">
                {{ downloadProgress.kind === 'added' ? '新增' : '修改' }}
              </span>
              {{ downloadProgress.current }}
            </span>
            <span v-if="downloadProgress.status === 'failed'" class="shrink-0 text-red-500">
              失败: {{ downloadProgress.error }}
            </span>
            <span v-else-if="downloadProgress.status === 'skipped'" class="shrink-0 text-gray-400">
              已存在
            </span>
          </div>
        </div>

        <!-- 下载结果 -->
        <div v-if="downloadResult" class="mt-2 rounded-md bg-gray-50 px-3 py-2 text-xs dark:bg-gray-900/50">
          <p class="text-gray-600 dark:text-gray-400">
            下载完成: 成功 {{ downloadResult.ok }} / 失败 {{ downloadResult.failed }}
            <template v-if="downloadResult.skipped"> (已存在 {{ downloadResult.skipped }})</template>
          </p>
          <p v-for="err in downloadResult.errors.slice(0, 5)" :key="err.file" class="mt-0.5 text-red-500">
            {{ err.file }}: {{ err.error }}
          </p>
          <p v-if="downloadResult.errors.length > 5" class="mt-0.5 text-gray-400">
            另有 {{ downloadResult.errors.length - 5 }} 个失败未显示
          </p>
        </div>
      </div>

      <!-- 搜索与筛选 -->
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-4 py-2.5 dark:border-gray-700 dark:bg-gray-900">
        <div class="relative">
          <LucideSearch class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索文件路径..."
            class="w-64 rounded-md border border-gray-300 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
        </div>
        <div class="flex items-center gap-1">
          <button
            v-for="opt in filterOptions"
            :key="opt.label"
            class="rounded-full px-2.5 py-1 text-xs font-medium transition-colors"
            :class="changeTypeFilter === opt.value
              ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
              : (opt.color || 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700')"
            @click="changeTypeFilter = opt.value"
          >
            {{ opt.label }}
          </button>
        </div>
        <span class="ml-auto text-xs text-gray-400 dark:text-gray-500">
          <template v-if="searchQuery.trim() && dirData?.truncated">搜索结果过多, 仅显示前 300 条</template>
          <template v-else>共 {{ visibleDirs.length + visibleFiles.length }} 项</template>
        </span>
        <button
          v-if="visibleDirs.length + visibleFiles.length > 0"
          class="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          :disabled="downloading"
          @click="toggleAllVisible()"
        >
          全选当前
        </button>
      </div>

      <!-- 目录浏览 -->
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <div class="flex min-w-0 flex-1 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <div
            v-if="dirQuery.isPending.value"
            class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500"
          >
            <LucideLoader2 class="mr-2 h-4 w-4 animate-spin" />
            <span>加载中...</span>
          </div>
          <div v-else-if="visibleDirs.length === 0 && visibleFiles.length === 0" class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500">
            <LucideFileSearch class="mr-2 h-5 w-5" />
            <span>没有匹配的文件</span>
          </div>
          <template v-else>
            <!-- 面包屑 -->
            <div v-if="!searchQuery.trim()" class="flex shrink-0 items-center gap-1 border-b border-gray-100 bg-gray-50 px-4 py-1.5 text-xs dark:border-gray-800 dark:bg-gray-850">
              <button
                class="font-medium text-gray-600 transition-colors hover:text-blue-500 dark:text-gray-300"
                :class="currentPath.length === 0 ? 'cursor-default text-blue-500' : ''"
                @click="currentPath = []"
              >
                根目录
              </button>
              <template v-for="(part, i) in currentPath" :key="i">
                <LucideChevronRight class="h-3 w-3 text-gray-400" />
                <button
                  class="font-medium text-gray-600 transition-colors hover:text-blue-500 dark:text-gray-300"
                  :class="i === currentPath.length - 1 ? 'cursor-default text-blue-500' : ''"
                  @click="currentPath = currentPath.slice(0, i + 1)"
                >
                  {{ part }}
                </button>
              </template>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto">
              <!-- 目录行 -->
              <div
                v-for="dir in visibleDirs"
                :key="'d:' + dir.name"
                class="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60"
                :class="selectedDirs.has([...currentPath, dir.name].join('/')) ? 'bg-blue-50 dark:bg-blue-900/20' : ''"
                @click="currentPath = [...currentPath, dir.name]"
              >
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-blue-600"
                  :checked="selectedDirs.has([...currentPath, dir.name].join('/'))"
                  @click.stop="toggleDir(dir.name)"
                >
                <LucideFolder class="h-4 w-4 shrink-0 text-yellow-400" />
                <span class="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {{ dir.name }}
                </span>
                <div class="ml-1 flex items-center gap-1.5 text-xs">
                  <span v-if="dir.added" class="text-green-600 dark:text-green-400">+{{ dir.added }}</span>
                  <span v-if="dir.modified" class="text-amber-600 dark:text-amber-400">~{{ dir.modified }}</span>
                  <span v-if="dir.deleted" class="text-red-500 dark:text-red-400">-{{ dir.deleted }}</span>
                </div>
                <span class="ml-auto shrink-0 text-xs text-gray-400 dark:text-gray-500">
                  {{ formatBytes(dir.size) }}
                </span>
              </div>

              <!-- 文件行: 点击查看详情; 复选框批量选择 -->
              <div
                v-for="file in visibleFiles"
                :key="'f:' + file.file"
                class="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60"
                :class="(selectedFile?.file === file.file || selectedFiles.has(file.file)) ? 'bg-blue-50 dark:bg-blue-900/20' : ''"
                @click="selectFile(file)"
              >
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-blue-600"
                  :checked="selectedFiles.has(file.file)"
                  @click.stop="toggleFile(file.file)"
                >
                <LucideFile class="h-4 w-4 shrink-0 text-gray-400" />
                <span
                  class="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  :class="TYPE_META[file.type].badge"
                >
                  {{ TYPE_META[file.type].label }}
                </span>
                <span class="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-gray-200">
                  {{ searchQuery.trim() ? file.file : getFilename(file.file) }}
                </span>
                <span class="ml-auto shrink-0 text-xs text-gray-400 dark:text-gray-500">
                  {{ formatBytes(file.size) }}
                </span>
              </div>

              <div
                v-if="visibleDirs.length === 0 && visibleFiles.length === 0"
                class="py-8 text-center text-sm text-gray-400 dark:text-gray-500"
              >
                此目录为空
              </div>
            </div>
          </template>
        </div>

        <!-- 文件详情面板 (与文件列表页一致) -->
        <div
          v-if="selectedFile"
          class="fixed inset-0 z-50 flex flex-col border-l border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800 md:relative md:inset-auto md:z-auto md:w-80 md:shrink-0 md:dark:bg-gray-800/30"
        >
          <div class="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium text-gray-600 dark:text-gray-300">文件详情</span>
              <span
                class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                :class="TYPE_META[selectedFile.type].badge"
              >
                {{ TYPE_META[selectedFile.type].label }}
              </span>
            </div>
            <button
              class="rounded p-0.5 text-gray-400 hover:text-gray-600 focus:outline-none dark:hover:text-gray-200"
              @click="selectedFile = null"
            >
              <LucideX class="h-4 w-4" />
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-3">
            <div class="space-y-3">
              <div>
                <p class="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                  文件路径
                </p>
                <p class="break-all text-xs text-gray-700 dark:text-gray-200">
                  {{ selectedFile.file }}
                </p>
              </div>

              <div>
                <p class="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                  大小
                </p>
                <p class="text-sm font-semibold text-gray-800 dark:text-gray-100">
                  {{ formatBytes(selectedFile.size) }}
                </p>
                <p class="text-xs text-gray-400 dark:text-gray-500">
                  {{ selectedFile.size.toLocaleString() }} 字节
                </p>
              </div>

              <div>
                <p class="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                  MD5
                </p>
                <p class="break-all font-mono text-xs text-gray-700 dark:text-gray-200">
                  {{ selectedFile.md5 || '-' }}
                </p>
              </div>

              <div v-if="selectedFile.type === 'modified' && selectedFile.original_file">
                <p class="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                  原文件
                </p>
                <p class="break-all text-xs text-gray-700 dark:text-gray-200">
                  {{ selectedFile.original_file }}
                </p>
                <p class="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                  {{ formatBytes(selectedFile.original_size) }}
                </p>
              </div>

              <div v-if="selectedFile.type !== 'deleted'" class="flex flex-col gap-2 pt-1">
                <button
                  class="flex items-center justify-center gap-1.5 rounded-md bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-700"
                  :disabled="downloading || singleDownloading.has(selectedFile.file)"
                  @click="handleSingleDownload(selectedFile.file)"
                >
                  <LucideLoader2 v-if="singleDownloading.has(selectedFile.file)" class="h-3.5 w-3.5 animate-spin" />
                  <LucideDownload v-else class="h-3.5 w-3.5" />
                  {{ singleDownloading.has(selectedFile.file) ? '下载中...' : '下载文件' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
