import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

// 让 Node 测试也认识 Vite 的 `?raw` 导入：以字符串形式默认导出文件原文。
const RAW_SUFFIX = '?raw'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(RAW_SUFFIX)) return nextResolve(specifier, context)
    const resolved = nextResolve(specifier.slice(0, -RAW_SUFFIX.length), context)
    return { url: `${resolved.url}${RAW_SUFFIX}`, shortCircuit: true }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(RAW_SUFFIX)) return nextLoad(url, context)
    const text = readFileSync(new URL(url.slice(0, -RAW_SUFFIX.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
