import type { Actor } from '../types/actor'

type StoredActor = Partial<Actor> & {
  views?: {
    front?: string
  }
}

const DATABASE_NAME = 'h3-continuity-lab'
const DATABASE_VERSION = 1
const STORE_NAME = 'actors'

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('无法打开演员库'))
})

const runRequest = <T>(mode: IDBTransactionMode, create: (store: IDBObjectStore) => IDBRequest<T>) =>
  openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const request = create(transaction.objectStore(STORE_NAME))
    let result: T
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(request.error ?? new Error('演员库操作失败'))
    transaction.oncomplete = () => {
      database.close()
      resolve(result)
    }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? new Error('演员库操作失败'))
    }
  }))

export const loadActors = async () => {
  const storedActors = await runRequest<StoredActor[]>('readonly', (store) => store.getAll())
  return storedActors.flatMap((stored) => {
    const referenceImageUrl = stored.referenceImageUrl ?? stored.views?.front
    if (!stored.id || !stored.name || !stored.gender || stored.minAge === undefined
      || stored.maxAge === undefined || stored.createdAt === undefined || !referenceImageUrl) return []
    return [{
      id: stored.id,
      name: stored.name,
      gender: stored.gender,
      minAge: stored.minAge,
      maxAge: stored.maxAge,
      referenceImageUrl,
      createdAt: stored.createdAt,
    } satisfies Actor]
  }).sort((left, right) => left.createdAt - right.createdAt)
}

export const saveActor = (actor: Actor) =>
  runRequest<IDBValidKey>('readwrite', (store) => store.put(actor))

export const deleteActor = (actorId: string) =>
  runRequest<undefined>('readwrite', (store) => store.delete(actorId))
