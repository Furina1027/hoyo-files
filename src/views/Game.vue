<script setup lang="ts">
import type { Component } from 'vue'
import { DEFAULT_PAGE_ID, GameList, PAGE_COMPONENT_MAP } from '@/constants/core'

const route = useRoute()
const router = useRouter()

const gameId = computed(() => route.params.gameId as string)
const pageId = computed(() => route.params.pageId as string)

watch([gameId, pageId], ([gId, pId]) => {
  const game = GameList.find(g => g.id === gId)
  if (!PAGE_COMPONENT_MAP[pId] || !game?.pages.includes(pId)) {
    router.replace(`/${gId}/${DEFAULT_PAGE_ID}`)
  }
}, { immediate: true })

const CurrentPage = computed(() => {
  const loader = PAGE_COMPONENT_MAP[pageId.value]
  return loader ? defineAsyncComponent(loader as () => Promise<Component>) : null
})
</script>

<template>
  <component :is="CurrentPage" v-if="CurrentPage" class="h-full w-full" />
  <div v-else class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500">
    <span>页面不存在</span>
  </div>
</template>
