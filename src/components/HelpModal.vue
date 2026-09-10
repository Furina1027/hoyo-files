<script setup lang="ts">
import { GameList } from '@/constants/core'

const emit = defineEmits<{ close: [] }>()

const domains = GameList.flatMap(g => g.domains)

function downloadRules() {
  const rules = {
    request: [],
    sendHeader: [],
    receiveHeader: [
      {
        enable: true,
        group: 'HoyoFiles CORS',
        ruleType: 'modifyReceiveHeader',
        isFunction: false,
        code: '',
        forceRunner: 'auto',
        name: 'HoyoFiles CORS',
        condition: { domain: domains },
        headers: { 'access-control-allow-origin': '*' },
        encoding: 'utf-8',
      },
    ],
    receiveBody: [],
  }
  const blob = new Blob([JSON.stringify(rules, null, '\t')], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'hoyo-files-cors-rules.json'
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/50" @click="emit('close')" />
      <div class="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div class="flex items-center gap-2 border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <LucideCircleHelp class="h-5 w-5 text-amber-500" />
          <span class="flex-1 font-semibold text-gray-800 dark:text-gray-100">解决 Failed to fetch 问题</span>
          <button
            class="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            @click="emit('close')"
          >
            <LucideX class="h-4 w-4" />
          </button>
        </div>

        <div class="space-y-4 px-5 py-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">
            由于浏览器的 CORS 限制，获取数据时可能出现 <span class="font-mono text-red-500">Failed to fetch</span> 错误。安装 HeaderEditor 拓展并导入规则可解决此问题。
          </p>
          <ol class="space-y-4">
            <li class="flex gap-3">
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white">1</span>
              <div class="min-w-0">
                <p class="text-sm font-medium text-gray-800 dark:text-gray-100">
                  安装 HeaderEditor / HeaderEditor Lite 拓展
                </p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <a
                    href="https://addons.mozilla.org/en-US/firefox/addon/header-editor/"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                  >
                    <LucideExternalLink class="h-3 w-3" />
                    Mozilla Add-ons
                  </a>
                  <a
                    href="https://chrome.google.com/webstore/detail/header-editor/eningockdidmgiojffjmkdblpjocbhgh"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                  >
                    <LucideExternalLink class="h-3 w-3" />
                    Chrome Web Store
                  </a>
                  <a
                    href="https://microsoftedge.microsoft.com/addons/detail/header-editor/afopnekiinpekooejpchnkgfffaeceko"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                  >
                    <LucideExternalLink class="h-3 w-3" />
                    Edge Addons
                  </a>
                  <a
                    href="https://github.com/FirefoxBar/HeaderEditor"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
                  >
                    <LucideExternalLink class="h-3 w-3" />
                    GitHub
                  </a>
                </div>
              </div>
            </li>
            <li class="flex gap-3">
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white">2</span>
              <div>
                <p class="text-sm font-medium text-gray-800 dark:text-gray-100">
                  下载并导入规则文件
                </p>
                <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  下载规则后，打开 HeaderEditor 设置 → 导出和导入 → 导入，选择下载的规则文件
                </p>
              </div>
            </li>
            <li class="flex gap-3">
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500 text-xs font-bold text-white">3</span>
              <div>
                <p class="text-sm font-medium text-gray-800 dark:text-gray-100">
                  确保 "HoyoFiles CORS" 规则启用后刷新页面重试
                </p>
              </div>
            </li>
          </ol>
        </div>

        <div class="border-t border-gray-200 px-5 py-4 dark:border-gray-700">
          <button
            class="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-600 active:bg-blue-700"
            @click="downloadRules()"
          >
            <LucideDownload class="h-4 w-4" />
            下载规则文件（JSON）
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
