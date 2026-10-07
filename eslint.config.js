import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // 导演 agent 将来在浏览器里运行：server/ 下除开发插件与 Node 会话存储外不得依赖 Node 专有 API。
    files: ['server/**/*.ts'],
    ignores: ['server/directorPlugin.ts', 'server/comfyPlugin.ts', 'server/nodeSessionStore.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { regex: '^node:', message: '只有开发插件和 nodeSessionStore.ts 可以使用 Node 内置模块。' },
          { regex: '^@earendil-works/pi-agent-core/node$', message: '请从 @earendil-works/pi-agent-core 主入口导入。' },
        ],
      }],
      'no-restricted-globals': ['error',
        { name: 'Buffer', message: '浏览器里没有 Buffer。' },
        { name: 'process', message: '浏览器里没有 process。' },
      ],
    },
  },
)
