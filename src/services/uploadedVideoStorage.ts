const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('palace-uploaded-videos', 1)
  request.onupgradeneeded = () => request.result.createObjectStore('videos')
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('无法打开本地视频存储'))
})

const runRequest = async <T>(mode: IDBTransactionMode, create: (store: IDBObjectStore) => IDBRequest<T>) => {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction('videos', mode)
    const request = create(transaction.objectStore('videos'))
    transaction.oncomplete = () => { database.close(); resolve(request.result) }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? request.error ?? new Error('本地视频保存失败'))
    }
  })
}

export type UploadedVideo = { file: Blob; tailFrameUrl: string }

export const saveUploadedVideo = (id: string, file: Blob, tailFrameUrl: string) =>
  runRequest('readwrite', (store) => store.put({ file, tailFrameUrl }, id))

export const loadUploadedVideo = (id: string) =>
  runRequest<UploadedVideo | undefined>('readonly', (store) => store.get(id))

export const deleteUploadedVideo = (id: string) =>
  runRequest('readwrite', (store) => store.delete(id))
