<script setup lang="ts">
import type { DownloadStatus } from '@/types'
import { useDownload } from '@/store/download'

const download = useDownload()

const STATUS_LABELS: Record<DownloadStatus, string> = {
  pending: '等待中',
  downloading: '下载中',
  decompressing: '解压中',
  merging: '合并中',
  success: '已完成',
  failed: '下载失败',
  cancelled: '已取消',
}

const STATUS_COLORS: Record<DownloadStatus, string> = {
  pending: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  downloading: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300',
  decompressing: 'bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300',
  merging: 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300',
  success: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300',
  cancelled: 'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-500',
}

function isActive(status: DownloadStatus) {
  return status === 'pending' || status === 'downloading' || status === 'decompressing' || status === 'merging'
}

const hasCompleted = computed(() =>
  download.tasks.some(t => t.status === 'success' || t.status === 'failed' || t.status === 'cancelled'),
)

const showHelp = ref(false)
</script>

<template>
  <Teleport to="body">
    <Transition name="dl-fade">
      <div
        v-if="download.isListOpen"
        class="fixed inset-0 z-50 md:inset-auto md:left-20 md:bottom-4 md:z-30 md:w-96"
      >
        <div
          class="absolute inset-0 bg-black/40 md:hidden"
          @click="download.closeList()"
        />

        <div
          class="absolute inset-x-0 bottom-0 flex max-h-[90vh] flex-col rounded-t-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900
          md:relative md:inset-auto md:max-h-[600px] md:rounded-xl md:border-0 md:border-r md:shadow-xl"
        >
          <div class="flex shrink-0 items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <LucideDownload class="h-4 w-4 text-blue-500" />
            <span class="flex-1 text-sm font-semibold text-gray-800 dark:text-gray-100">下载列表</span>
            <span
              v-if="download.activeCount > 0"
              class="rounded-full bg-blue-500 px-2 py-0.5 text-xs font-bold text-white"
            >{{ download.activeCount }}</span>
            <button
              v-if="hasCompleted"
              class="rounded-md px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus:outline-none dark:hover:bg-gray-700 dark:hover:text-gray-200"
              @click="download.clearCompleted()"
            >
              清空已完成
            </button>
            <button
              class="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus:outline-none dark:hover:bg-gray-700 dark:hover:text-gray-200"
              @click="download.closeList()"
            >
              <LucideX class="h-4 w-4" />
            </button>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto" role="list">
            <div
              v-if="download.tasks.length === 0"
              class="flex flex-col items-center justify-center gap-2 py-12 text-gray-400 dark:text-gray-500"
            >
              <LucideInbox class="h-8 w-8" />
              <p class="text-sm">
                暂无下载任务
              </p>
            </div>

            <div
              v-for="task in download.tasks"
              :key="task.id"
              class="border-b border-gray-100 px-4 py-3 dark:border-gray-800"
            >
              <div class="flex items-start gap-3">
                <div class="mt-0.5 shrink-0">
                  <LucideLoader2
                    v-if="task.status === 'downloading' || task.status === 'decompressing' || task.status === 'merging'"
                    class="h-4 w-4 animate-spin text-blue-500"
                  />
                  <LucideCheckCircle2 v-else-if="task.status === 'success'" class="h-4 w-4 text-green-500" />
                  <LucideXCircle v-else-if="task.status === 'failed'" class="h-4 w-4 text-red-500" />
                  <LucideCircleSlash v-else-if="task.status === 'cancelled'" class="h-4 w-4 text-gray-400" />
                  <LucideClock v-else class="h-4 w-4 text-gray-400" />
                </div>

                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-gray-800 dark:text-gray-100" :title="task.name">
                    {{ task.name }}
                  </p>
                  <div class="mt-1 flex items-center gap-2">
                    <span
                      class="rounded px-1.5 py-0.5 text-xs font-medium"
                      :class="STATUS_COLORS[task.status]"
                    >
                      {{ task.status === 'failed' && task.error ? `下载失败：${task.error}` : STATUS_LABELS[task.status] }}
                    </span>
                  </div>

                  <div
                    v-if="task.status === 'downloading' || task.status === 'merging'"
                    class="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
                  >
                    <div
                      class="h-full rounded-full bg-blue-500 transition-all duration-300"
                      :style="{ width: `${task.progress}%` }"
                    />
                  </div>
                </div>

                <button
                  v-if="isActive(task.status)"
                  class="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-500 focus:outline-none dark:hover:bg-gray-700 dark:hover:text-red-400"
                  title="取消"
                  @click="download.cancelTask(task.id)"
                >
                  <LucideX class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          <div class="shrink-0 border-t border-gray-100 dark:border-gray-800">
            <button
              class="w-full px-4 py-2.5 text-center text-xs text-blue-500 hover:bg-gray-50 hover:text-blue-600 dark:hover:bg-gray-800"
              @click="showHelp = true"
            >
              出现 Failed to fetch？点击查看帮助
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <HelpModal v-if="showHelp" @close="showHelp = false" />
</template>

<style scoped>
.dl-fade-enter-active,
.dl-fade-leave-active {
  transition: opacity 0.15s ease;
}
.dl-fade-enter-from,
.dl-fade-leave-to {
  opacity: 0;
}
</style>
