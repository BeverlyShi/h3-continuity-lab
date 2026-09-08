// Vite 重新加载模块时仍共用同一把会话锁，Pi 与极简导演也不能交叉运行同一局。
const lockKey = Symbol.for('h3-continuity-lab.director-sessions')
const registry = globalThis as typeof globalThis & { [lockKey]?: Set<string> }
const activeSessions = registry[lockKey] ??= new Set<string>()

export async function withDirectorSession<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  if (activeSessions.has(sessionId)) throw new Error('故事导演正在处理这个会话的上一项行动。')
  activeSessions.add(sessionId)
  try {
    return await run()
  } finally {
    activeSessions.delete(sessionId)
  }
}
