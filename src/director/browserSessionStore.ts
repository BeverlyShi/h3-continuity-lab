import { JsonlSessionRepo } from '@earendil-works/pi-agent-core'
import type { DirectorSessionStore } from './directorAgent.ts'
import { createIndexedDbKeyValueStore, DIRECTOR_SESSION_SCOPE, DIRECTOR_SESSIONS_ROOT } from './sessionDatabase.ts'
import { createVirtualFileSystem, type VirtualFsKeyValueStore } from './virtualFileSystem.ts'

// 浏览器里的导演会话存储：JsonlSessionRepo 照常读写 JSONL，文件落在 IndexedDB 上的虚拟文件系统。
export const createBrowserSessionStore = (
  store: VirtualFsKeyValueStore = createIndexedDbKeyValueStore(),
): DirectorSessionStore => ({
  repo: new JsonlSessionRepo({
    fs: createVirtualFileSystem(store),
    sessionsRoot: DIRECTOR_SESSIONS_ROOT,
  }),
  scope: DIRECTOR_SESSION_SCOPE,
})
