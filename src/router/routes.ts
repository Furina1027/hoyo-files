import type { RouteRecordRaw } from 'vue-router'
import { DEFAULT_GAME_ID, DEFAULT_PAGE_ID } from '@/constants/core'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: `/${DEFAULT_GAME_ID}/${DEFAULT_PAGE_ID}`,
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('@/views/Settings.vue'),
  },
  {
    path: '/:gameId',
    redirect: to => `/${to.params.gameId}/${DEFAULT_PAGE_ID}`,
  },
  {
    path: '/:gameId/:pageId',
    name: 'Game',
    component: () => import('@/views/Game.vue'),
  },
]

export default routes
