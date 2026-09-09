import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, RotateCcw, ScrollText, UserRound } from 'lucide-react'
import { AgentChat } from '../components/game/AgentChat'
import {
  DEFAULT_DIRECTOR_MODEL,
  getDirectorModelProvider,
  isDirectorModelId,
  type DirectorModelId,
} from '../config/directorModels'
import { GameInteraction } from '../components/game/GameInteraction'
import { GameStage } from '../components/game/GameStage'
import { useDirectorAgent, type OnAwaitingUpload } from '../hooks/useDirectorAgent'
import { useGameSession } from '../hooks/useGameSession'
import { useSceneVideo } from '../hooks/useSceneVideo'
import { palaceStory } from '../stories/palace'
import { isDirectorActive } from '../services/directorStatus'
import type { AgentTraceUpdate } from '../types/director'
import type { Actor, CreatedActor } from '../types/actor'
import type { GameScene } from '../types/game'

type GamePageProps = {
  savedFalApiKey: string
  savedOpenRouterApiKey: string
  savedDeepSeekApiKey: string
  savedBigModelApiKey: string
  onTraceUpdate: (update: AgentTraceUpdate) => void
  onRequestApiKey: () => void
  actors: Actor[]
  onActorsCreated: (created: CreatedActor[]) => Promise<void> | void
}

const DIRECTOR_MODEL_STORAGE_KEY = 'palace-director-model'
const DIRECTOR_THINKING_STORAGE_KEY = 'palace-director-thinking-enabled'
const VIDEO_GENERATION_STORAGE_KEY = 'palace-video-generation-enabled'
const VIDEO_MODE_STORAGE_KEY = 'palace-video-mode'

const loadDirectorModel = (): DirectorModelId => {
  try {
    const stored = localStorage.getItem(DIRECTOR_MODEL_STORAGE_KEY)
    return isDirectorModelId(stored) ? stored : DEFAULT_DIRECTOR_MODEL
  } catch {
    return DEFAULT_DIRECTOR_MODEL
  }
}

const loadDirectorThinking = () => {
  try {
    return localStorage.getItem(DIRECTOR_THINKING_STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

const loadVideoMode = (): NonNullable<GameScene['videoMode']> => {
  try {
    const mode = localStorage.getItem(VIDEO_MODE_STORAGE_KEY)
    if (mode === 'auto' || mode === 'manual' || mode === 'off') return mode
    return localStorage.getItem(VIDEO_GENERATION_STORAGE_KEY) === 'on' ? 'auto' : 'manual'
  } catch {
    return 'manual'
  }
}

export function GamePage({ savedFalApiKey, savedOpenRouterApiKey, savedDeepSeekApiKey, savedBigModelApiKey, onTraceUpdate, onRequestApiKey, actors, onActorsCreated }: GamePageProps) {
  const game = useGameSession()
  const [modelId, setModelId] = useState<DirectorModelId>(loadDirectorModel)
  const [thinkingEnabled, setThinkingEnabled] = useState(loadDirectorThinking)
  const activeModelProvider = getDirectorModelProvider(modelId)
  const activeApiKey = { deepseek: savedDeepSeekApiKey, openrouter: savedOpenRouterApiKey, bigmodel: savedBigModelApiKey }[activeModelProvider]
  const apiKeyLabel = { deepseek: 'DeepSeek', openrouter: 'OpenRouter', bigmodel: '智谱 BigModel' }[activeModelProvider]
  const [videoMode, setVideoMode] = useState(loadVideoMode)
  const [narrativeExpanded, setNarrativeExpanded] = useState(true)
  // useDirectorAgent 需要 onAwaitingUpload，onAwaitingUpload 需要 useSceneVideo，useSceneVideo 又需要 director.resumeTurn；
  // 用 ref 打破这个初始化顺序上的循环依赖，渲染后立即在 effect 里同步成最新值。
  const sceneVideoRef = useRef<ReturnType<typeof useSceneVideo> | null>(null)

  const onAwaitingUpload: OnAwaitingUpload = useCallback((sceneId, clip) => {
    if (videoMode !== 'auto') return undefined
    if (!savedFalApiKey) return '未配置 fal API Key，请手动上传这一段视频，或先在设置里配置 fal Key。'
    void sceneVideoRef.current?.generateSegmentWithFal(sceneId, clip.sequence)
    return undefined
  }, [savedFalApiKey, videoMode])

  const director = useDirectorAgent(
    game,
    savedOpenRouterApiKey,
    savedDeepSeekApiKey,
    savedBigModelApiKey,
    onTraceUpdate,
    videoMode,
    modelId,
    thinkingEnabled,
    actors,
    onActorsCreated,
    onAwaitingUpload,
  )

  const sceneVideo = useSceneVideo({
    falApiKey: savedFalApiKey,
    game,
    resumeTurn: director.resumeTurn,
  })
  useEffect(() => {
    sceneVideoRef.current = sceneVideo
  })

  const mediaRunning = game.restoringVideos || sceneVideo.mediaBusy

  // 存档与本地视频都恢复完成后，对齐一次服务端的回合状态：可能在等上传，也可能已经彻底空闲需要重试。
  useEffect(() => {
    if (game.loading || game.restoringVideos) return
    void director.syncTurnState()
    // 只在存档加载完成的那一刻对齐一次，之后的状态变化都由事件流驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.loading, game.restoringVideos])

  const switchVideoMode = (next: NonNullable<GameScene['videoMode']>) => {
    if (next === videoMode || mediaRunning || isDirectorActive(director.status)) return
    if (game.session && game.session.status !== 'awaiting_action') return
    setVideoMode(next)
    try {
      localStorage.setItem(VIDEO_MODE_STORAGE_KEY, next)
    } catch {
      // 存不进 localStorage 时仅影响刷新后的默认值
    }
  }

  const uploadVideo = async (sceneId: string, sequence: number, file: File) => {
    await sceneVideo.uploadSegmentVideo(sceneId, sequence, file)
  }

  const retrySegment = (sceneId: string) => {
    void sceneVideo.retryPendingSegment(sceneId)
  }

  const switchThinking = (enabled: boolean) => {
    if (isDirectorActive(director.status)) return
    setThinkingEnabled(enabled)
    try {
      localStorage.setItem(DIRECTOR_THINKING_STORAGE_KEY, enabled ? 'on' : 'off')
    } catch {
      // 存不进 localStorage 时仅影响刷新后的默认值
    }
  }

  const switchModel = (next: DirectorModelId) => {
    setModelId(next)
    try {
      localStorage.setItem(DIRECTOR_MODEL_STORAGE_KEY, next)
    } catch {
      // 存不进 localStorage 时仅影响刷新后的默认值
    }
  }

  const startStory = () => {
    if (!activeApiKey || videoMode === 'auto' && !savedFalApiKey) {
      onRequestApiKey()
      return
    }
    director.startStory()
  }

  const restartStory = () => {
    if (!director.reset()) return
    game.restart()
  }

  if (game.loading) return <main className="game-workspace"><p role="status">正在读取本地存档…</p></main>
  if (game.restoringVideos) return <main className="game-workspace"><p role="status">正在恢复本地视频…</p></main>

  return (
    <main className="game-workspace">
      <section className="game-intro">
        <div className="game-intro-copy">
          <div className="game-eyebrow"><ScrollText size={14} /> 互动文字游戏验证版</div>
          <h1>《{palaceStory.title}》</h1>
          <p>{palaceStory.summary}</p>
          <div className="game-role"><UserRound size={16} /> 你的身份：{palaceStory.role}</div>
        </div>
        <div className="game-intro-actions">
          {!activeApiKey && (
            <button className="button button-secondary" onClick={onRequestApiKey}>
              <KeyRound size={15} />设置 API Key
            </button>
          )}
          {game.session && (
            <button
              className="button button-secondary"
              disabled={isDirectorActive(director.status) || mediaRunning}
              onClick={restartStory}
            >
              <RotateCcw size={15} />重新开始
            </button>
          )}
        </div>
      </section>

      {game.storageError && (
        <section className="game-storage-notice" role="alert">
          <p>{game.storageError} 当前剧情与 Prompt 仍保留在页面中；保存成功前请勿刷新或关闭页面。</p>
          <button type="button" className="button button-secondary" onClick={() => { void game.retrySaveSession() }}>重试保存</button>
        </section>
      )}

      {!game.storageError && game.storageNotice && (
        <section className="game-storage-notice" role="status">
          <p>{game.storageNotice} 剧情与 Prompt 不受影响，早期分镜的参考图与尾帧将不再随刷新恢复。</p>
        </section>
      )}

      <div className={`game-layout${game.session ? '' : ' no-action'}`}>
        <div className="game-main-column">
          <GameStage
            key={game.session?.currentScene?.id ?? 'empty-stage'}
            session={game.session}
            actors={actors}
            hasApiKey={Boolean(activeApiKey)}
            apiKeyLabel={apiKeyLabel}
            directorStatus={director.status}
            videoMode={videoMode}
            mediaRunning={mediaRunning}
            onStart={startStory}
            onVideoModeChange={switchVideoMode}
            onUploadVideo={uploadVideo}
            onRetrySegment={retrySegment}
            narrativeExpanded={narrativeExpanded}
            onNarrativeExpandedChange={setNarrativeExpanded}
          />
        </div>
        {game.session && (
          <aside className="game-action-column">
            <GameInteraction
              key={`${game.session.id}:${game.session.turn}`}
              session={game.session}
              directorStatus={director.status}
              onChoose={director.submitChoice}
              onSubmitFreeform={director.submitFreeform}
              onRetry={() => { void director.retry() }}
            />
          </aside>
        )}
        <aside className="game-agent-column">
          <AgentChat
            session={game.session}
            modelId={modelId}
            onModelChange={switchModel}
            thinkingEnabled={thinkingEnabled}
            onThinkingChange={switchThinking}
            messages={director.messages}
            status={director.status}
            hasApiKey={Boolean(activeApiKey)}
            apiKeyLabel={apiKeyLabel}
            onRetry={() => { void director.retry() }}
            onRequestApiKey={onRequestApiKey}
          />
        </aside>
      </div>
    </main>
  )
}
