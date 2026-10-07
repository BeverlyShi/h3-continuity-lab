import type { VirtualFsKeyValueStore, VirtualFsRecord } from './virtualFileSystem.ts'

// 导演会话历史（JSONL）存放在独立的 IndexedDB 库里，与图片、视频存档分开。
// 本模块不依赖 pi-agent-core，可以被首屏代码静态引入用于删除与清理。
const DATABASE_NAME = 'h3-director-sessions'
const STORE_NAME = 'files'

// JsonlSessionRepo 的虚拟根目录与会话分组键：浏览器里只有一个分组。
export const DIRECTOR_SESSIONS_ROOT = '/agent-traces'
export const DIRECTOR_SESSION_SCOPE = 'browser'

let databasePromise: Promise<IDBDatabase> | undefined

const openDatabase = () => databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
  request.onsuccess = () => {
    const database = request.result
    // 其他标签页清理本地数据时主动让出连接，避免删除被阻塞。
    database.onversionchange = () => {
      database.close()
      databasePromise = undefined
    }
    database.onclose = () => { databasePromise = undefined }
    resolve(database)
  }
  request.onerror = () => {
    databasePromise = undefined
    reject(request.error ?? new Error('无法打开导演会话存储'))
  }
})

// run 在事务里发出请求并返回结果容器，事务提交后才把容器交给调用方。
const runTransaction = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => T) => {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const result = run(transaction.objectStore(STORE_NAME))
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = () => reject(transaction.error ?? new Error('导演会话保存失败'))
  })
}

const isRecord = (value: unknown): value is VirtualFsRecord =>
  Boolean(value) && typeof value === 'object'
  && ((value as VirtualFsRecord).kind === 'file' || (value as VirtualFsRecord).kind === 'directory')

export const createIndexedDbKeyValueStore = (): VirtualFsKeyValueStore => ({
  get: async (key) => {
    const holder: { value?: VirtualFsRecord } = {}
    await runTransaction('readonly', (store) => {
      const request = store.get(key)
      request.onsuccess = () => {
        if (isRecord(request.result)) holder.value = request.result
      }
    })
    return holder.value
  },
  set: (key, value) => runTransaction('readwrite', (store) => { store.put(value, key) }),
  delete: (key) => runTransaction('readwrite', (store) => { store.delete(key) }),
  listKeys: async () => {
    const holder: { keys: string[] } = { keys: [] }
    await runTransaction('readonly', (store) => {
      const request = store.getAllKeys()
      request.onsuccess = () => {
        holder.keys = request.result.filter((key): key is string => typeof key === 'string')
      }
    })
    return holder.keys
  },
})

// 会话文件名是 `<创建时间>_<会话 ID>.jsonl`（JsonlSessionRepo 的命名规则），连同残留的 .tmp 一起删掉。
export const deleteDirectorSession = async (
  sessionId: string,
  store: VirtualFsKeyValueStore = createIndexedDbKeyValueStore(),
) => {
  const suffixes = [`_${sessionId}.jsonl`, `_${sessionId}.jsonl.tmp`]
  const keys = (await store.listKeys()).filter((key) =>
    key.startsWith(`${DIRECTOR_SESSIONS_ROOT}/`) && suffixes.some((suffix) => key.endsWith(suffix)))
  for (const key of keys) await store.delete(key)
}

export const clearDirectorSessions = async () => {
  const database = await databasePromise?.catch(() => undefined)
  database?.close()
  databasePromise = undefined
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}
