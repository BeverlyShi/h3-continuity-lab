const BUSY_MESSAGE = '故事导演正在处理这个会话的上一项行动。'

// 没有 Web Locks 的环境（如旧版 Node 测试）退回进程内锁；Vite 重新加载模块时仍共用同一份。
const lockKey = Symbol.for('h3-continuity-lab.director-sessions')
const registry = globalThis as typeof globalThis & { [lockKey]?: Set<string> }
const activeSessions = registry[lockKey] ??= new Set<string>()

const getLockManager = (): LockManager | undefined =>
  typeof navigator === 'undefined' ? undefined : navigator.locks

// 同一局导演同时只能跑一项行动；Web Locks 跨标签页生效，防止两个页面交叉写同一份会话历史。
export async function withDirectorSession<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const locks = getLockManager()
  if (locks) {
    return locks.request(`h3-director-session:${sessionId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error(BUSY_MESSAGE)
      return run()
    })
  }

  if (activeSessions.has(sessionId)) throw new Error(BUSY_MESSAGE)
  activeSessions.add(sessionId)
  try {
    return await run()
  } finally {
    activeSessions.delete(sessionId)
  }
}
