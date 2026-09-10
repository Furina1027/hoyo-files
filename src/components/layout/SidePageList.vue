<script setup lang="ts">
import { GameList, PageList } from '@/constants/core'

const route = useRoute()
const router = useRouter()

const currentGameId = computed(() => route.params.gameId as string)
const currentPageId = computed(() => route.params.pageId as string)

const currentGame = computed(() => GameList.find(g => g.id === currentGameId.value))
const availablePages = computed(() =>
  PageList.filter(p => currentGame.value?.pages.includes(p.id)),
)

function switchPage(pageId: string) {
  router.push(`/${currentGameId.value}/${pageId}`)
}
</script>

<template>
  <nav class="flex h-full w-48 flex-col border-r border-gray-200 bg-white py-3 dark:border-gray-700 dark:bg-gray-850">
    <ul class="flex flex-col gap-1 px-2">
      <li v-for="page in availablePages" :key="page.id">
        <button
          class="w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors"
          :class="currentPageId === page.id
            ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700/50 dark:hover:text-gray-100'"
          @click="switchPage(page.id)"
        >
          {{ page.name }}
        </button>
      </li>
    </ul>
  </nav>
</template>
