import { setSessionImageStore } from '../../src/services/sessionImageStorage.ts'

// 用内存实现替换 IndexedDB，让存档测试可以在 node 里跑。
export const installMemorySessionImages = () => {
  const images = new Map<string, string>()
  setSessionImageStore({
    save: async (id, dataUrl) => { images.set(id, dataUrl) },
    load: async (ids) => new Map(ids.flatMap((id) => {
      const image = images.get(id)
      return image ? [[id, image] as const] : []
    })),
    remove: async (ids) => { ids.forEach((id) => images.delete(id)) },
    clear: async () => { images.clear() },
  })
  return { images, restore: () => setSessionImageStore(null) }
}
