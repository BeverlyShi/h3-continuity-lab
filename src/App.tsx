import { Activity, Check, Film, Gamepad2, KeyRound, UserRound } from 'lucide-react'
import { useState } from 'react'
import { ApiKeyDialog, type ApiKeys } from './components/ApiKeyDialog'
import { GamePage } from './pages/GamePage'
import { TracePage } from './pages/TracePage'
import { ActorLibraryPage } from './pages/ActorLibraryPage'
import { useActorLibrary } from './hooks/useActorLibrary'
import { useActorPortraits } from './hooks/useActorPortraits'
import { useAgentTraces } from './hooks/useAgentTraces'
import {
  loadApiKey,
  loadBigModelApiKey,
  loadComfyApiKey,
  loadDeepSeekApiKey,
  loadOpenRouterApiKey,
  saveApiKey,
  saveBigModelApiKey,
  saveComfyApiKey,
  saveDeepSeekApiKey,
  saveOpenRouterApiKey,
} from './services/localStorage'
import type { GameScene } from './types/game'

type Workspace = 'game' | 'actors' | 'trace'
type VideoMode = NonNullable<GameScene['videoMode']>

const VIDEO_MODE_STORAGE_KEY = 'palace-video-mode'

const loadVideoMode = (): VideoMode => {
  try {
    // 旧版的「上传视频」「仅文字」已下线，连同无值一律落到 ComfyUI。
    return localStorage.getItem(VIDEO_MODE_STORAGE_KEY) === 'auto' ? 'auto' : 'comfy'
  } catch {
    return 'comfy'
  }
}

function App() {
  const [workspace, setWorkspace] = useState<Workspace>('game')
  const [savedApiKey, setSavedApiKey] = useState(loadApiKey)
  const [savedComfyApiKey, setSavedComfyApiKey] = useState(loadComfyApiKey)
  const [savedOpenRouterApiKey, setSavedOpenRouterApiKey] = useState(loadOpenRouterApiKey)
  const [savedDeepSeekApiKey, setSavedDeepSeekApiKey] = useState(loadDeepSeekApiKey)
  const [savedBigModelApiKey, setSavedBigModelApiKey] = useState(loadBigModelApiKey)
  const [isApiDialogOpen, setIsApiDialogOpen] = useState(false)
  const { traces, updateTrace } = useAgentTraces()
  const actorLibrary = useActorLibrary()
  // 视频模式同时决定演员库生成参考图用哪个后端，所以放在这里；切换前的守卫在 GamePage。
  const [videoMode, setVideoMode] = useState(loadVideoMode)
  const portraits = useActorPortraits({ videoMode, falApiKey: savedApiKey, comfyApiKey: savedComfyApiKey }, actorLibrary)

  const changeVideoMode = (next: VideoMode) => {
    setVideoMode(next)
    try {
      localStorage.setItem(VIDEO_MODE_STORAGE_KEY, next)
    } catch {
      // 存不进 localStorage 时仅影响刷新后的默认值
    }
  }

  const updateApiKeys = ({ falApiKey, comfyApiKey, openRouterApiKey, deepSeekApiKey, bigModelApiKey }: ApiKeys) => {
    setSavedComfyApiKey(comfyApiKey)
    saveComfyApiKey(comfyApiKey)
    setSavedBigModelApiKey(bigModelApiKey)
    saveBigModelApiKey(bigModelApiKey)
    setSavedApiKey(falApiKey)
    setSavedOpenRouterApiKey(openRouterApiKey)
    setSavedDeepSeekApiKey(deepSeekApiKey)
    saveApiKey(falApiKey)
    saveOpenRouterApiKey(openRouterApiKey)
    saveDeepSeekApiKey(deepSeekApiKey)
    setIsApiDialogOpen(false)
  }

  const hasModelKey = Boolean(savedDeepSeekApiKey || savedOpenRouterApiKey || savedBigModelApiKey)
  const hasVideoKey = Boolean(savedApiKey || savedComfyApiKey)
  const allKeysConfigured = hasModelKey && hasVideoKey

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-start">
          <div className="brand">
            <span className="brand-mark"><Film size={16} /></span>
            <span>H3 Continuity Lab</span>
          </div>
          <nav className="workspace-tabs" aria-label="工作区">
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
              className={workspace === 'actors' ? 'active' : ''}
              aria-label="演员库"
              aria-pressed={workspace === 'actors'}
              onClick={() => setWorkspace('actors')}
            >
              <UserRound size={15} />
              <span>演员库</span>
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
          <span>{allKeysConfigured ? 'API 已配置' : hasModelKey || hasVideoKey ? 'API 待补充' : '设置 API Key'}</span>
        </button>
      </header>

      <div hidden={workspace !== 'actors'}>
        <ActorLibraryPage
          actors={actorLibrary.actors}
          loading={actorLibrary.loading}
          error={actorLibrary.error}
          onAdd={actorLibrary.addActor}
          onRemove={actorLibrary.removeActor}
          onSetImage={actorLibrary.setActorImage}
          portraits={portraits}
        />
      </div>
      <div hidden={workspace !== 'game'}>
        <GamePage
          savedFalApiKey={savedApiKey}
          savedComfyApiKey={savedComfyApiKey}
          savedOpenRouterApiKey={savedOpenRouterApiKey}
          savedDeepSeekApiKey={savedDeepSeekApiKey}
          savedBigModelApiKey={savedBigModelApiKey}
          videoMode={videoMode}
          onVideoModeChange={changeVideoMode}
          onTraceUpdate={updateTrace}
          onRequestApiKey={() => setIsApiDialogOpen(true)}
          actors={actorLibrary.actors}
          getActors={actorLibrary.getActors}
          onActorsCreated={actorLibrary.addCreatedActors}
          portraits={portraits}
        />
      </div>
      <div hidden={workspace !== 'trace'}>
        <TracePage traces={traces} />
      </div>

      {isApiDialogOpen && (
        <ApiKeyDialog
          savedFalApiKey={savedApiKey}
          savedComfyApiKey={savedComfyApiKey}
          savedOpenRouterApiKey={savedOpenRouterApiKey}
          savedDeepSeekApiKey={savedDeepSeekApiKey}
          savedBigModelApiKey={savedBigModelApiKey}
          onClose={() => setIsApiDialogOpen(false)}
          onSave={updateApiKeys}
          onClear={() => updateApiKeys({ falApiKey: '', comfyApiKey: '', openRouterApiKey: '', deepSeekApiKey: '', bigModelApiKey: '' })}
        />
      )}
    </div>
  )
}

export default App
