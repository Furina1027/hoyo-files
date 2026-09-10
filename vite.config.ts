import { Buffer } from 'node:buffer'
import path from 'node:path'
import process from 'node:process'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import autoImport from 'unplugin-auto-import/vite'
import components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'
import simpleHtmlPlugin from 'vite-plugin-simple-html'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  base: '/',
  plugins: [
    vue(),
    tailwindcss(),
    autoImport({
      imports: ['vue', 'vue-router'],
      dts: 'src/auto-imports.d.ts',
      vueTemplate: true,
    }),
    components({
      dts: 'src/components.d.ts',
      resolvers: [
        (name: string) => {
          if (name.startsWith('Lucide'))
            return { name: name.slice(6), from: '@lucide/vue' }
        },
      ],
    }),
    simpleHtmlPlugin({
      inject: {
        data: {
          injectHead: process.env.INJECT_HEAD || '',
          injectHeadB: Buffer.from(process.env.INJECT_HEAD_B || '', 'base64').toString('ascii'),
        },
      },
    }),
  ],
})
