<script setup lang="ts">
defineProps<{
  label: string
  color: string
}>()
</script>

<template>
  <span
    class="rounded-full px-2 py-0.5 text-xs font-medium"
    :class="{
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300': color === 'blue',
      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300': color === 'amber',
      'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300': color === 'purple',
      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300': color === 'green',
    }"
  >{{ label }}</span>
</template>
