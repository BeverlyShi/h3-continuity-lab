// Vite 的 `?raw` 导入：以字符串形式拿到文件原文（Node 测试端由 tests/helpers/registerRawLoader.ts 提供同样行为）。
declare module '*.md?raw' {
  const content: string
  export default content
}
