<script setup lang="ts">
import type DropdownSelect from '@/components/DropdownSelect.vue'
import { GameList, PageList } from '@/constants/core'
import { useDownload } from '@/store/download'
import { useSettings } from '@/store/settings'

const route = useRoute()
const router = useRouter()
const settings = useSettings()
const download = useDownload()

const currentGameId = computed(() => route.params.gameId as string)
const currentPageId = computed(() => route.params.pageId as string)

const currentGame = computed(() => GameList.find(g => g.id === currentGameId.value))
const availablePages = computed(() =>
  PageList.filter(p => currentGame.value?.pages.includes(p.id)),
)

const isSettingsPage = computed(() => route.path === '/settings')

const gameDropdownRef = ref<InstanceType<typeof DropdownSelect> | null>(null)
const pageDropdownRef = ref<InstanceType<typeof DropdownSelect> | null>(null)

function selectGame(gameId: string | null) {
  if (gameId)
    router.push(`/${gameId}/${currentPageId.value || 'home'}`)
}

function selectPage(pageId: string | null) {
  if (pageId)
    router.push(`/${currentGameId.value}/${pageId}`)
}
</script>

<template>
  <header>
    <div class="sticky top-0 z-40 flex h-12 items-center gap-2 border-b border-gray-200 bg-white/90 px-3 backdrop-blur-sm dark:border-gray-700 dark:bg-gray-900/90">
      <DropdownSelect
        ref="gameDropdownRef"
        :model-value="currentGameId"
        :options="GameList.map(g => ({ value: g.id, label: g.name }))"
        placeholder="选择游戏"
        @update:model-value="selectGame"
        @open="pageDropdownRef?.close()"
      >
        <template #trigger="{ label }">
          <img
            v-show="currentGame"
            :src="`/images/icon/${currentGameId}.png`"
            class="h-4 w-4 rounded"
            :alt="currentGame?.name"
          >
          <span>{{ label }}</span>
        </template>
        <template #option="{ option }">
          <img :src="`/images/icon/${option.value}.png`" class="h-5 w-5 rounded" :alt="option.label">
          {{ option.label }}
        </template>
      </DropdownSelect>

      <template v-if="!isSettingsPage">
        <span class="text-gray-300 dark:text-gray-600">/</span>

        <DropdownSelect
          ref="pageDropdownRef"
          :model-value="currentPageId"
          :options="availablePages.map(p => ({ value: p.id, label: p.name }))"
          placeholder="选择页面"
          @update:model-value="selectPage"
          @open="gameDropdownRef?.close()"
        />
      </template>

      <div class="flex-1" />

      <button
        class="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        title="切换主题模式"
        @click="settings.cycleTheme()"
      >
        <LucideSun v-if="!settings.isDark" class="h-4.5 w-4.5" />
        <LucideMoon v-else class="h-4.5 w-4.5" />
      </button>

      <button
        class="relative flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        title="下载列表"
        @click="download.toggleList()"
      >
        <LucideDownload class="h-4.5 w-4.5" />
        <span
          v-if="download.activeCount > 0"
          class="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white"
        >{{ download.activeCount }}</span>
      </button>

      <button
        class="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
        :class="isSettingsPage
          ? 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-100'
          : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'"
        title="设置"
        @click="router.push('/settings')"
      >
        <LucideSettings class="h-4.5 w-4.5" />
      </button>
    </div>
  </header>
</template>
