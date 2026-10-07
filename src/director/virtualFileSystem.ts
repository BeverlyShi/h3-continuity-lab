import {
  err,
  FileError,
  ok,
  type FileErrorCode,
  type FileInfo,
  type JsonlSessionRepoFileSystem,
} from '@earendil-works/pi-agent-core'

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

// 虚拟文件系统里的一条记录：键是规范化后的绝对 posix 路径。
export type VirtualFsRecord =
  | { kind: 'file'; content: string; mtimeMs: number }
  | { kind: 'directory'; mtimeMs: number }

// 底层只需要最简单的键值存储：内存 Map（测试）或 IndexedDB（浏览器）。
export type VirtualFsKeyValueStore = {
  get: (key: string) => Promise<VirtualFsRecord | undefined>
  set: (key: string, value: VirtualFsRecord) => Promise<void>
  delete: (key: string) => Promise<void>
  listKeys: () => Promise<string[]>
}

export const createMemoryKeyValueStore = (): VirtualFsKeyValueStore => {
  const records = new Map<string, VirtualFsRecord>()
  return {
    get: async (key) => records.get(key),
    set: async (key, value) => { records.set(key, value) },
    delete: async (key) => { records.delete(key) },
    listKeys: async () => [...records.keys()],
  }
}

const ROOT = '/'

const normalizePath = (path: string) => {
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop()
      else if (!absolute) parts.push(part)
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  return absolute ? `/${joined}` : joined || '.'
}

const resolvePath = (cwd: string, path: string) => normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`)

const parentOf = (path: string) => {
  if (path === ROOT) return ROOT
  const index = path.lastIndexOf('/')
  return index <= 0 ? ROOT : path.slice(0, index)
}

const baseName = (path: string) => path === ROOT ? ROOT : path.slice(path.lastIndexOf('/') + 1)

const isWithin = (path: string, directory: string) =>
  directory === ROOT ? path !== ROOT : path.startsWith(`${directory}/`)

const textOf = (content: string | Uint8Array) => typeof content === 'string' ? content : new TextDecoder().decode(content)

const byteLength = (content: string) => new TextEncoder().encode(content).byteLength

// Node 的 readline 以 \n 或 \r\n 分行，文件末尾的换行不产生额外空行。
const splitLines = (content: string) => {
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

const fail = (code: FileErrorCode, message: string, path?: string) => err<never, FileError>(new FileError(code, message, path))

const toInfo = (path: string, record: VirtualFsRecord): FileInfo => ({
  name: baseName(path),
  path,
  kind: record.kind,
  size: record.kind === 'file' ? byteLength(record.content) : 0,
  mtimeMs: record.mtimeMs,
})

/**
 * 在键值存储上实现 JsonlSessionRepo 需要的文件操作，语义对齐 NodeExecutionEnv：
 * 缺失路径返回 not_found（exists 返回 false），写文件时自动创建父目录，所有失败都编码进 Result 而不抛出。
 */
export const createVirtualFileSystem = (
  store: VirtualFsKeyValueStore,
  cwd: string = ROOT,
): JsonlSessionRepoFileSystem => {
  const resolve = (path: string) => resolvePath(cwd, path)

  // 同一路径的写操作串行执行：appendFile 是读-改-写，并发追加不能互相覆盖。
  const writeTails = new Map<string, Promise<void>>()
  const serialize = <T>(paths: string[], run: () => Promise<T>): Promise<T> => {
    const previous = Promise.all(paths.map((path) => writeTails.get(path)))
    const result = previous.then(run)
    const tail = result.then(() => undefined, () => undefined)
    paths.forEach((path) => writeTails.set(path, tail))
    void tail.then(() => paths.forEach((path) => {
      if (writeTails.get(path) === tail) writeTails.delete(path)
    }))
    return result
  }

  // 任何意外异常（如 IndexedDB 报错）都转成 unknown 错误，满足「文件操作永不抛出」的约定。
  const guard = async <T>(path: string, run: () => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> => {
    try {
      return await run()
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      return err(new FileError('unknown', cause.message, path, cause))
    }
  }

  const ensureDirectory = async (path: string): Promise<Result<void, FileError>> => {
    if (path === ROOT) return ok(undefined)
    const existing = await store.get(path)
    if (existing?.kind === 'directory') return ok(undefined)
    if (existing) return fail('not_directory', `Not a directory: ${path}`, path)
    const parent = await ensureDirectory(parentOf(path))
    if (!parent.ok) return parent
    await store.set(path, { kind: 'directory', mtimeMs: Date.now() })
    return ok(undefined)
  }

  const readFileRecord = async (path: string): Promise<Result<string, FileError>> => {
    const record = await store.get(path)
    if (!record) return fail('not_found', `No such file: ${path}`, path)
    if (record.kind !== 'file') return fail('is_directory', `Is a directory: ${path}`, path)
    return ok(record.content)
  }

  const childrenOf = async (directory: string) => (await store.listKeys())
    .filter((key) => key !== directory && parentOf(key) === directory)

  const descendantsOf = async (directory: string) => (await store.listKeys())
    .filter((key) => isWithin(key, directory))

  const writeText = async (path: string, content: string): Promise<Result<void, FileError>> => {
    const existing = await store.get(path)
    if (existing?.kind === 'directory') return fail('is_directory', `Is a directory: ${path}`, path)
    const parent = await ensureDirectory(parentOf(path))
    if (!parent.ok) return parent
    await store.set(path, { kind: 'file', content, mtimeMs: Date.now() })
    return ok(undefined)
  }

  return {
    absolutePath: async (path) => ok(resolve(path)),
    joinPath: async (parts) => ok(normalizePath(parts.join('/'))),
    readTextFile: async (path) => {
      const resolved = resolve(path)
      return guard(resolved, () => readFileRecord(resolved))
    },
    readTextLines: async (path, options) => {
      const resolved = resolve(path)
      return guard(resolved, async () => {
        if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([])
        const content = await readFileRecord(resolved)
        if (!content.ok) return err(content.error)
        const lines = splitLines(content.value)
        return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines))
      })
    },
    writeFile: async (path, content) => {
      const resolved = resolve(path)
      return guard(resolved, () => serialize([resolved], () => writeText(resolved, textOf(content))))
    },
    appendFile: async (path, content) => {
      const resolved = resolve(path)
      return guard(resolved, () => serialize([resolved], async () => {
        const existing = await store.get(resolved)
        if (existing?.kind === 'directory') return fail('is_directory', `Is a directory: ${resolved}`, resolved)
        return writeText(resolved, `${existing?.content ?? ''}${textOf(content)}`)
      }))
    },
    renameFile: async (sourcePath, destinationPath) => {
      const source = resolve(sourcePath)
      const destination = resolve(destinationPath)
      return guard(source, () => serialize([source, destination], async () => {
        const content = await readFileRecord(source)
        if (!content.ok) return err(content.error)
        if (source === destination) return ok(undefined)
        const written = await writeText(destination, content.value)
        if (!written.ok) return written
        await store.delete(source)
        return ok(undefined)
      }))
    },
    fileInfo: async (path) => {
      const resolved = resolve(path)
      return guard(resolved, async () => {
        if (resolved === ROOT) return ok({ name: ROOT, path: ROOT, kind: 'directory', size: 0, mtimeMs: 0 })
        const record = await store.get(resolved)
        return record ? ok(toInfo(resolved, record)) : fail('not_found', `No such file or directory: ${resolved}`, resolved)
      })
    },
    listDir: async (path) => {
      const resolved = resolve(path)
      return guard(resolved, async () => {
        if (resolved !== ROOT) {
          const record = await store.get(resolved)
          if (!record) return fail('not_found', `No such directory: ${resolved}`, resolved)
          if (record.kind !== 'directory') return fail('not_directory', `Not a directory: ${resolved}`, resolved)
        }
        const infos: FileInfo[] = []
        for (const key of await childrenOf(resolved)) {
          const record = await store.get(key)
          if (record) infos.push(toInfo(key, record))
        }
        return ok(infos)
      })
    },
    exists: async (path) => {
      const resolved = resolve(path)
      return guard(resolved, async () => ok(resolved === ROOT || Boolean(await store.get(resolved))))
    },
    createDir: async (path, options) => {
      const resolved = resolve(path)
      return guard(resolved, () => serialize([resolved], async () => {
        if (options?.recursive === false && resolved !== ROOT) {
          const existing = await store.get(resolved)
          if (existing) {
            return existing.kind === 'directory'
              ? fail('invalid', `Directory already exists: ${resolved}`, resolved)
              : fail('not_directory', `Not a directory: ${resolved}`, resolved)
          }
          const parent = parentOf(resolved)
          if (parent !== ROOT && (await store.get(parent))?.kind !== 'directory') {
            return fail('not_found', `No such directory: ${parent}`, parent)
          }
        }
        return ensureDirectory(resolved)
      }))
    },
    remove: async (path, options) => {
      const resolved = resolve(path)
      return guard(resolved, () => serialize([resolved], async () => {
        const record = resolved === ROOT ? { kind: 'directory' as const, mtimeMs: 0 } : await store.get(resolved)
        if (!record) return options?.force ? ok(undefined) : fail('not_found', `No such file or directory: ${resolved}`, resolved)
        if (record.kind === 'directory') {
          if (!options?.recursive) return fail('is_directory', `Is a directory: ${resolved}`, resolved)
          for (const key of await descendantsOf(resolved)) await store.delete(key)
        }
        if (resolved !== ROOT) await store.delete(resolved)
        return ok(undefined)
      }))
    },
  }
}
