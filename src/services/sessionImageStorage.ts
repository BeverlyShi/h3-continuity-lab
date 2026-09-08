const DATABASE_NAME = 'palace-session-images'
const STORE_NAME = 'images'

export type SessionImageStore = {
  save: (id: string, dataUrl: string) => Promise<void>
  load: (ids: string[]) => Promise<Map<string, string>>
  remove: (ids: string[]) => Promise<void>
  clear: () => Promise<void>
}

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('无法打开本地图片存储'))
})

// run 在事务里发出请求并返回结果容器，事务提交后才把容器交给调用方。
const runTransaction = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => T) => {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const result = run(transaction.objectStore(STORE_NAME))
    transaction.oncomplete = () => { database.close(); resolve(result) }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? new Error('本地图片保存失败'))
    }
  })
}

const indexedDbStore: SessionImageStore = {
  save: (id, dataUrl) => runTransaction('readwrite', (store) => { store.put(dataUrl, id) }),
  load: (ids) => runTransaction('readonly', (store) => {
    const images = new Map<string, string>()
    ids.forEach((id) => {
      const request = store.get(id)
      request.onsuccess = () => {
        if (typeof request.result === 'string') images.set(id, request.result)
      }
    })
    return images
  }),
  remove: (ids) => runTransaction('readwrite', (store) => { ids.forEach((id) => store.delete(id)) }),
  clear: () => runTransaction('readwrite', (store) => { store.clear() }),
}

let activeStore: SessionImageStore = indexedDbStore

// 测试用：注入内存实现，避免依赖 IndexedDB。
export const setSessionImageStore = (store: SessionImageStore | null) => {
  activeStore = store ?? indexedDbStore
}

export const saveSessionImage = (id: string, dataUrl: string) => activeStore.save(id, dataUrl)

export const loadSessionImages = (ids: string[]) => ids.length
  ? activeStore.load(ids)
  : Promise.resolve(new Map<string, string>())

export const deleteSessionImages = (ids: string[]) => ids.length
  ? activeStore.remove(ids)
  : Promise.resolve()

export const clearSessionImages = () => activeStore.clear()
