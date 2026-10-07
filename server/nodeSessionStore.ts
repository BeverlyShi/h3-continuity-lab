import { JsonlSessionRepo, NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { resolve } from 'node:path'
import type { DirectorSessionStore } from './directorAgent.ts'

// 开发服务器用的会话存储：JSONL 落在 <cwd>/.agent-traces，以 cwd 作为会话分组键。
export const createNodeSessionStore = (cwd: string = process.cwd()): DirectorSessionStore => ({
  repo: new JsonlSessionRepo({
    fs: new NodeExecutionEnv({ cwd }),
    sessionsRoot: resolve(cwd, '.agent-traces'),
  }),
  scope: cwd,
})
