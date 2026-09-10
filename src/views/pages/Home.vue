<script setup lang="ts">
import type { Component } from 'vue'
import { BarChart2, CloudDownload, Diff, FilePlay, Folder } from '@lucide/vue'
import { useGameVersions } from '@/api/files'
import { GameList, PageList } from '@/constants/core'
import { sortVersions } from '@/utils/semver'

const route = useRoute()
const router = useRouter()
const gameId = computed(() => route.params.gameId as string)

const versionsQuery = useGameVersions(gameId)

const currentGame = computed(() => GameList.find(g => g.id === gameId.value))

const sortedVersionsAsc = computed<string[]>(() => {
  if (!versionsQuery.data.value)
    return []
  return sortVersions(Object.keys(versionsQuery.data.value))
})

const totalVersionCount = computed(() => sortedVersionsAsc.value.length)
const latestVersion = computed(() => sortedVersionsAsc.value.at(-1) ?? null)

const firstChunkVersion = computed(() => {
  if (!versionsQuery.data.value)
    return null
  for (const ver of sortedVersionsAsc.value) {
    if (versionsQuery.data.value[ver]?.chunk !== null)
      return ver
  }
  return null
})

const latestHasNoPackage = computed(() => {
  if (!latestVersion.value || !versionsQuery.data.value)
    return false
  const vd = versionsQuery.data.value[latestVersion.value]
  if (!vd)
    return false
  const hasFull = !!vd.game?.full
  const hasSegments = !!(vd.game?.segments && vd.game.segments.length > 0)
  return !hasFull && !hasSegments
})

const supportUsmDecode = computed(() => currentGame.value?.features?.includes('usm-decode') ?? false)

const firstNoPackageVersion = computed(() => {
  if (!latestHasNoPackage.value || !versionsQuery.data.value)
    return null
  for (const ver of sortedVersionsAsc.value) {
    const vd = versionsQuery.data.value[ver]
    const hasFull = !!vd?.game?.full
    const hasSegments = !!(vd?.game?.segments && vd.game.segments.length > 0)
    if (!hasFull && !hasSegments)
      return ver
  }
  return null
})

const otherPages = computed(() => {
  const game = currentGame.value
  if (!game)
    return []
  return PageList.filter(p => p.id !== 'home' && game.pages.includes(p.id))
})

const PAGE_META: Record<string, { desc: string, icon: Component }> = {
  'files': { desc: '浏览各版本的游戏包、游戏文件列表、Chunk信息', icon: Folder },
  'version-compare': { desc: '对比不同版本之间的文件差异', icon: Diff },
  'predownload': { desc: '预下载版本与当前版本的文件差异', icon: CloudDownload },
  'usm-history': { desc: '查看 USM 格式视频文件的变更历史记录', icon: FilePlay },
  'stats': { desc: '待开发', icon: BarChart2 },
}

function navigateTo(pageId: string) {
  router.push(`/${gameId.value}/${pageId}`)
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div v-if="versionsQuery.isLoading.value" class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500">
      <LucideLoaderCircle class="mr-2 h-6 w-6 animate-spin" />
      <span>加载版本列表...</span>
    </div>

    <div v-else-if="versionsQuery.isError.value" class="flex h-full items-center justify-center text-red-400 dark:text-red-500">
      <LucideCircleX class="mr-2 h-5 w-5" />
      <span>加载失败</span>
    </div>

    <div v-else class="mx-auto min-h-full max-w-3xl px-6 py-8">
      <div class="mb-6 flex items-center gap-5">
        <img
          :src="`/images/icon/${gameId}.png`"
          :alt="currentGame?.name"
          class="h-16 w-16 rounded-xl shadow-md"
        >
        <div>
          <h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {{ currentGame?.name }}
          </h1>
          <div class="mt-1.5 flex flex-wrap items-center gap-2">
            <span class="inline-flex items-center gap-1 rounded-full bg-blue-50 px-3 py-0.5 text-sm font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
              <LucideTag class="h-3.5 w-3.5" />
              最新版本 {{ latestVersion ?? '-' }}
            </span>
            <span class="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-0.5 text-sm font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
              <LucideLayers class="h-3.5 w-3.5" />
              共 {{ totalVersionCount }} 个版本
            </span>
          </div>
        </div>
      </div>

      <div class="mb-8 space-y-3">
        <div
          v-if="supportUsmDecode"
          class="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 dark:border-green-700/50 dark:bg-green-900/20"
        >
          <LucideFilePlay class="mt-0.5 h-4.5 w-4.5 shrink-0 text-green-500 dark:text-green-400" />
          <p class="text-sm text-green-700 dark:text-green-300">
            支持在线播放 USM 视频
          </p>
        </div>

        <div
          v-if="firstChunkVersion"
          class="flex items-start gap-3 rounded-xl border border-purple-200 bg-purple-50 px-4 py-3 dark:border-purple-700/50 dark:bg-purple-900/20"
        >
          <LucideBoxes class="mt-0.5 h-4.5 w-4.5 shrink-0 text-purple-500 dark:text-purple-400" />
          <p class="text-sm text-purple-700 dark:text-purple-300">
            从 <span class="font-semibold">{{ firstChunkVersion }}</span> 版本起支持 Chunk 下载
          </p>
        </div>

        <div
          v-if="firstNoPackageVersion"
          class="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-700/50 dark:bg-amber-900/20"
        >
          <LucidePackageX class="mt-0.5 h-4.5 w-4.5 shrink-0 text-amber-500 dark:text-amber-400" />
          <p class="text-sm text-amber-700 dark:text-amber-300">
            从 <span class="font-semibold">{{ firstNoPackageVersion }}</span> 版本起停止使用压缩包分发游戏资源
          </p>
        </div>
      </div>

      <div>
        <h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          功能列表
        </h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            v-for="page in otherPages"
            :key="page.id"
            class="flex items-start gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3.5 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600 dark:hover:bg-gray-700/50"
            @click="navigateTo(page.id)"
          >
            <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700">
              <component
                :is="PAGE_META[page.id]?.icon"
                class="h-4 w-4 text-gray-500 dark:text-gray-400"
              />
            </div>
            <div>
              <p class="text-sm font-medium text-gray-800 dark:text-gray-200">
                {{ page.name }}
              </p>
              <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {{ PAGE_META[page.id]?.desc }}
              </p>
            </div>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
