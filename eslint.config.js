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
    // 导演 agent 与 Comfy 业务逻辑在浏览器里运行，转发层跑在 Cloudflare Worker 里：都不得依赖 Node 专有 API。
    files: ['src/director/**/*.ts', 'src/comfy/**/*.ts', 'worker/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { regex: '^node:', message: '这里的代码运行在浏览器或 Worker 里，不能使用 Node 内置模块。' },
          { regex: '^@earendil-works/pi-agent-core/node$', message: '请从 @earendil-works/pi-agent-core 主入口导入。' },
        ],
      }],
      'no-restricted-globals': ['error',
        { name: 'Buffer', message: '浏览器和 Worker 里没有 Buffer。' },
        { name: 'process', message: '浏览器和 Worker 里没有 process。' },
      ],
    },
  },
)
