<script setup lang="ts">
import type { MkvExportLang, UsmAudioLang } from '@/store/settings'
import type { CacheStats, CacheUnavailable } from '@/utils/idb'
import { AUDIO_LANG_LABELS, API_BASE, GameList, ThemeOptions } from '@/constants/core'
import { useSettings } from '@/store/settings'
import { formatBytes } from '@/utils/file'
import { clearCache, getCacheStats } from '@/utils/idb'

const settings = useSettings()

interface GameDataStatus {
  name: string
  versions: number
  latest_version: string | null
  predownload: { version: string | null, generated_at: string | null, tags: string[] } | null
}

interface RefreshResult {
  game: string
  name: string
  main_tag: string | null
  predownload: {
    tag?: string
    manifests?: number
    tags?: string[]
    stats?: { added: number, modified: number, deleted: number }
    error?: string
  } | null
  file_list: { version: string, files?: number, existed?: boolean, error?: string } | null
}

const gameStatuses = ref<Record<string, GameDataStatus> | null>(null)
const refreshing = ref<Set<string>>(new Set())
const refreshResults = ref<Record<string, RefreshResult | { error: string }>>({})
const statusError = ref<string | null>(null)
const gameDirs = ref<Record<string, string>>({})

function loadGameDirs() {
  for (const game of GameList) {
    gameDirs.value = { ...gameDirs.value, [game.id]: localStorage.getItem(`game_dir_${game.id}`) ?? '' }
  }
}

function saveGameDir(gameId: string) {
  localStorage.setItem(`game_dir_${gameId}`, gameDirs.value[gameId] ?? '')
}

/** 调用后端原生文件夹选择对话框 (需本地数据服务器, Windows) */
async function browseGameDir(gameId: string) {
  try {
    const res = await fetch(`${API_BASE}/api/browse-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text || `HTTP ${res.status}`)
    }
    const { path: dirPath } = await res.json()
    if (dirPath) {
      gameDirs.value[gameId] = dirPath
      saveGameDir(gameId)
    }
  }
  catch (err) {
    if ((err as Error).name !== 'AbortError') {
      console.error('选择文件夹失败:', err)
      alert(`选择失败: ${(err as Error).message}\n\n该按钮需要本地数据服务器 (localhost)，纯静态部署不可用。`)
    }
  }
}

async function loadGameStatuses() {
  statusError.value = null
  try {
    const res = await fetch(`${API_BASE}/api/games`)
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`)
    gameStatuses.value = await res.json()
  }
  catch (err) {
    statusError.value = (err as Error).message
  }
}

async function handleRefresh(gameId: string) {
  const next = new Set(refreshing.value)
  next.add(gameId)
  refreshing.value = next
  refreshResults.value = { ...refreshResults.value, [gameId]: { game: gameId, name: '', main_tag: null, predownload: null, file_list: null } }
  try {
    const res = await fetch(`${API_BASE}/api/refresh/${gameId}`, { method: 'POST' })
    const data = await res.json()
    refreshResults.value = { ...refreshResults.value, [gameId]: data }
  }
  catch (err) {
    refreshResults.value = { ...refreshResults.value, [gameId]: { error: (err as Error).message } }
  }
  finally {
    const next2 = new Set(refreshing.value)
    next2.delete(gameId)
    refreshing.value = next2
    await loadGameStatuses()
  }
}

const usmAudioLangOptions: { value: UsmAudioLang, label: string }[] = [
  { value: 'zh-cn', label: AUDIO_LANG_LABELS['zh-cn'] },
  { value: 'en-us', label: AUDIO_LANG_LABELS['en-us'] },
  { value: 'ja-jp', label: AUDIO_LANG_LABELS['ja-jp'] },
  { value: 'ko-kr', label: AUDIO_LANG_LABELS['ko-kr'] },
]

const mkvExportLangOptions: { value: MkvExportLang, label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'zh-cn', label: AUDIO_LANG_LABELS['zh-cn'] },
  { value: 'en-us', label: AUDIO_LANG_LABELS['en-us'] },
  { value: 'ja-jp', label: AUDIO_LANG_LABELS['ja-jp'] },
  { value: 'ko-kr', label: AUDIO_LANG_LABELS['ko-kr'] },
]

type StatsResult = CacheStats | CacheUnavailable | null

const cacheStats = ref<StatsResult>(null)
const isClearing = ref(false)

async function loadStats() {
  cacheStats.value = await getCacheStats()
}

async function handleClearCache() {
  isClearing.value = true
  try {
    await clearCache()
    await loadStats()
  }
  finally {
    isClearing.value = false
  }
}

onMounted(() => {
  loadStats()
  loadGameStatuses()
  loadGameDirs()
})
</script>

<template>
  <div class="flex min-h-full flex-col items-center justify-center gap-3 py-6">
    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        设置
      </p>
      <div class="flex items-center gap-3 justify-between">
        <span class="text-sm text-gray-600 dark:text-gray-300">主题</span>
        <div class="flex items-center gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-gray-600">
          <button
            v-for="opt in ThemeOptions"
            :key="opt.value"
            class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors focus:outline-none"
            :class="settings.theme === opt.value
              ? 'bg-gray-100 font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-100'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
            @click="settings.setTheme(opt.value)"
          >
            <component :is="opt.icon" class="h-3.5 w-3.5" />
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        USM 播放
      </p>
      <div class="flex items-center gap-3 justify-between">
        <span class="text-sm text-gray-600 dark:text-gray-300">默认音频语言</span>
        <DropdownSelect v-model="settings.usmDefaultAudioLang" :options="usmAudioLangOptions" />
      </div>
    </div>

    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        MKV 导出
      </p>
      <div class="flex items-center gap-3 justify-between">
        <span class="text-sm text-gray-600 dark:text-gray-300">默认导出语言</span>
        <DropdownSelect v-model="settings.mkvExportLang" :options="mkvExportLangOptions" />
      </div>
    </div>

    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <div class="mb-3 flex items-center justify-between">
        <p class="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          数据管理
        </p>
        <button
          class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          :disabled="!gameStatuses"
          @click="loadGameStatuses()"
        >
          <LucideRefreshCw class="h-3 w-3" />
          刷新状态
        </button>
      </div>
      <p class="mb-3 text-xs text-gray-400 dark:text-gray-500">
        一键从官方接口更新当前版本数据与预下载差异
      </p>

      <div v-if="statusError" class="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
        状态获取失败: {{ statusError }}
      </div>

      <div v-else-if="!gameStatuses" class="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500">
        <LucideLoader2 class="h-4 w-4 animate-spin" />
        <span>加载中...</span>
      </div>

      <div v-else class="space-y-2">
        <div
          v-for="game in GameList"
          :key="game.id"
          class="rounded-lg border border-gray-100 px-3 py-2.5 dark:border-gray-700"
        >
          <div class="flex items-center gap-2.5">
            <img :src="`/images/icon/${game.id}.png`" :alt="game.name" class="h-7 w-7 rounded-md">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-gray-800 dark:text-gray-200">{{ game.name }}</p>
              <p class="text-xs text-gray-400 dark:text-gray-500">
                {{ gameStatuses[game.id]?.versions ?? 0 }} 个版本
                <template v-if="gameStatuses[game.id]?.latest_version">
                  · 最新 {{ gameStatuses[game.id]!.latest_version }}
                </template>
                <template v-if="gameStatuses[game.id]?.predownload">
                  · 预下载 {{ gameStatuses[game.id]!.predownload!.version }}
                </template>
              </p>
            </div>
            <button
              class="flex shrink-0 items-center gap-1 rounded-md border border-blue-200 px-2.5 py-1 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800/50 dark:text-blue-400 dark:hover:bg-blue-900/20"
              :disabled="refreshing.has(game.id)"
              @click="handleRefresh(game.id)"
            >
              <LucideLoader2 v-if="refreshing.has(game.id)" class="h-3 w-3 animate-spin" />
              <LucideRefreshCw v-else class="h-3 w-3" />
              {{ refreshing.has(game.id) ? '刷新中...' : '刷新' }}
            </button>
          </div>

          <!-- 游戏安装路径 (预下载「修改文件」补丁 & USM 播放/导出/探测共用) -->
          <div class="mt-2 flex items-center gap-2">
            <input
              v-model="gameDirs[game.id]"
              type="text"
              :placeholder="`${game.name} 游戏根目录 (含 *_Data 文件夹的那一层)`"
              :title="`填写游戏根目录，例如 D:/Games/${game.name === '原神' ? 'Genshin Impact Game' : game.name === '崩坏：星穹铁道' ? 'Star Rail Game' : 'ZenlessZoneZero Game'}`"
              class="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              @change="saveGameDir(game.id)"
            >
            <button
              type="button"
              class="shrink-0 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-100 focus:outline-none dark:border-blue-800/50 dark:bg-blue-900/20 dark:text-blue-400 dark:hover:bg-blue-900/30"
              @click="browseGameDir(game.id)"
            >
              浏览
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700"
              @click="saveGameDir(game.id)"
            >
              保存
            </button>
          </div>
          <p class="mt-1 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
            用于预下载「修改文件」增量补丁，以及 USM 视频播放/导出/格式探测时优先读取本地游戏文件
            （本地文件通常比 CDN 更新，密钥按本地版本才能正确解密）。
          </p>

          <div
            v-if="refreshResults[game.id]"
            class="mt-2 rounded-md bg-gray-50 px-2.5 py-1.5 text-xs dark:bg-gray-900/50"
          >
            <template v-if="(refreshResults[game.id] as { error?: string }).error">
              <p class="text-red-500">刷新失败: {{ (refreshResults[game.id] as { error: string }).error }}</p>
            </template>
            <template v-else>
              <p class="text-gray-600 dark:text-gray-400">
                当前版本 {{ (refreshResults[game.id] as RefreshResult).main_tag ?? '-' }}
              </p>
              <p
                v-if="(refreshResults[game.id] as RefreshResult).predownload"
                class="mt-0.5 text-gray-600 dark:text-gray-400"
              >
                <template v-if="(refreshResults[game.id] as RefreshResult).predownload!.error">
                  预下载: {{ (refreshResults[game.id] as RefreshResult).predownload!.error }}
                </template>
                <template v-else>
                  预下载 {{ (refreshResults[game.id] as RefreshResult).predownload!.tag }}
                  ({{ (refreshResults[game.id] as RefreshResult).predownload!.manifests }} manifests,
                  新{{ (refreshResults[game.id] as RefreshResult).predownload!.stats!.added }}
                  / 改{{ (refreshResults[game.id] as RefreshResult).predownload!.stats!.modified }}
                  / 删{{ (refreshResults[game.id] as RefreshResult).predownload!.stats!.deleted }})
                </template>
              </p>
              <p
                v-if="(refreshResults[game.id] as RefreshResult).file_list"
                class="mt-0.5 text-gray-600 dark:text-gray-400"
              >
                <template v-if="(refreshResults[game.id] as RefreshResult).file_list!.error">
                  文件清单: {{ (refreshResults[game.id] as RefreshResult).file_list!.error }}
                </template>
                <template v-else>
                  文件清单 {{ (refreshResults[game.id] as RefreshResult).file_list!.version }}
                  <template v-if="(refreshResults[game.id] as RefreshResult).file_list!.files">
                    ({{ (refreshResults[game.id] as RefreshResult).file_list!.files }} 个文件)
                  </template>
                  <template v-else>已存在</template>
                </template>
              </p>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        缓存管理
      </p>
      <p v-if="cacheStats && !cacheStats.available" class="text-sm font-medium text-red-500">
        IndexedDB 不可用
      </p>
      <template v-else-if="cacheStats && cacheStats.available">
        <div class="mb-3 flex items-center justify-between text-sm">
          <span class="text-gray-600 dark:text-gray-300">Manifest 缓存</span>
          <span class="font-medium text-gray-800 dark:text-gray-100">
            {{ formatBytes(cacheStats.totalSize) }}（{{ cacheStats.count }} 条）
          </span>
        </div>
        <button
          class="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-500 transition-colors hover:bg-red-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800/50 dark:text-red-400 dark:hover:bg-red-900/20"
          :disabled="isClearing || cacheStats.count === 0"
          @click="handleClearCache"
        >
          <LucideLoader2 v-if="isClearing" class="h-3.5 w-3.5 animate-spin" />
          <LucideTrash2 v-else class="h-3.5 w-3.5" />
          {{ isClearing ? '清空中...' : '清空缓存' }}
        </button>
      </template>
      <div v-else class="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500">
        <LucideLoader2 class="h-4 w-4 animate-spin" />
        <span>加载中...</span>
      </div>
    </div>

  </div>
</template>
