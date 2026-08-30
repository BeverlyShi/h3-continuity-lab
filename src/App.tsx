import { Activity, Check, Film, Gamepad2, KeyRound, Video } from 'lucide-react'
import { useState } from 'react'
import { ApiKeyDialog } from './components/ApiKeyDialog'
import { GamePage } from './pages/GamePage'
import { TracePage } from './pages/TracePage'
import { VideoGenerationPage } from './pages/VideoGenerationPage'
import { useAgentTraces } from './hooks/useAgentTraces'
import {
  loadApiKey,
  loadDeepSeekApiKey,
  saveApiKey,
  saveDeepSeekApiKey,
} from './services/localStorage'

type Workspace = 'video' | 'game' | 'trace'

function App() {
  const [workspace, setWorkspace] = useState<Workspace>('video')
  const [savedApiKey, setSavedApiKey] = useState(loadApiKey)
  const [savedDeepSeekApiKey, setSavedDeepSeekApiKey] = useState(loadDeepSeekApiKey)
  const [isApiDialogOpen, setIsApiDialogOpen] = useState(false)
  const { traces, updateTrace } = useAgentTraces()

  const updateApiKeys = (falApiKey: string, deepSeekApiKey: string) => {
    setSavedApiKey(falApiKey)
    setSavedDeepSeekApiKey(deepSeekApiKey)
    saveApiKey(falApiKey)
    saveDeepSeekApiKey(deepSeekApiKey)
    setIsApiDialogOpen(false)
  }

  const allKeysConfigured = Boolean(savedApiKey && savedDeepSeekApiKey)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-start">
          <div className="brand">
            <span className="brand-mark"><Film size={16} /></span>
            <span>H3 Continuity Lab</span>
            <span className="badge">Prototype</span>
          </div>
          <nav className="workspace-tabs" aria-label="工作区">
            <button
              className={workspace === 'video' ? 'active' : ''}
              aria-label="视频生成"
              aria-pressed={workspace === 'video'}
              onClick={() => setWorkspace('video')}
            >
              <Video size={15} />
              <span>视频生成</span>
            </button>
            <button
              className={workspace === 'game' ? 'active' : ''}
              aria-label="游戏互动"
              aria-pressed={workspace === 'game'}
              onClick={() => setWorkspace('game')}
            >
              <Gamepad2 size={15} />
              <span>游戏互动</span>
            </button>
            <button
              className={workspace === 'trace' ? 'active' : ''}
              aria-label="Trace"
              aria-pressed={workspace === 'trace'}
              onClick={() => setWorkspace('trace')}
            >
              <Activity size={15} />
              <span>Trace</span>
            </button>
          </nav>
        </div>
        <button
          className="button button-secondary api-key-button"
          aria-label={allKeysConfigured ? 'API 已配置，打开设置' : '设置 API Key'}
          onClick={() => setIsApiDialogOpen(true)}
        >
          {allKeysConfigured ? <Check size={16} /> : <KeyRound size={16} />}
          <span>{allKeysConfigured ? 'API 已配置' : savedApiKey || savedDeepSeekApiKey ? 'API 待补充' : '设置 API Key'}</span>
        </button>
      </header>

      <div hidden={workspace !== 'video'}>
        <VideoGenerationPage
          savedApiKey={savedApiKey}
          onRequestApiKey={() => setIsApiDialogOpen(true)}
        />
      </div>
      <div hidden={workspace !== 'game'}>
        <GamePage
          savedDeepSeekApiKey={savedDeepSeekApiKey}
          onTraceUpdate={updateTrace}
          onRequestApiKey={() => setIsApiDialogOpen(true)}
        />
      </div>
      <div hidden={workspace !== 'trace'}>
        <TracePage traces={traces} />
      </div>

      {isApiDialogOpen && (
        <ApiKeyDialog
          savedFalApiKey={savedApiKey}
          savedDeepSeekApiKey={savedDeepSeekApiKey}
          onClose={() => setIsApiDialogOpen(false)}
          onSave={updateApiKeys}
          onClear={() => updateApiKeys('', '')}
        />
      )}
    </div>
  )
}

export default App
