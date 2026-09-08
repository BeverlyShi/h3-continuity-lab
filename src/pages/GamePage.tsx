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
import { useDirectorAgent } from '../hooks/useDirectorAgent'
import { useGameSession } from '../hooks/useGameSession'
import { useSceneVideo } from '../hooks/useSceneVideo'
import { palaceStory } from '../stories/palace'
import { isDirectorActive } from '../services/directorStatus'
import type { AgentTraceUpdate } from '../types/director'
import type { SceneCharacter, VideoGenerationRequest } from '../types/story'
import type { Actor, CreatedActor } from '../types/actor'
import type { VideoCharacterReference } from '../types/video'
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
  // 提交回调走 ref 读最新模式，避免 agent 回合里拿到过期闭包。
  const videoModeRef = useRef(videoMode)
  const { submitSceneVideo, retrySceneVideo, uploadSceneVideo, retryUploadedTail, manualBusy, autoBusy } = useSceneVideo({
    apiKey: savedFalApiKey,
    deepSeekApiKey: savedDeepSeekApiKey,
    onVideoPlan: game.setSceneVideoPlan,
    onVideoClipUpdate: game.updateSceneVideoClip,
    onVideoRetry: game.resetSceneVideoFrom,
    onManualUploadComplete: game.completeManualUpload,
    onTailFrameAnalyzed: game.completeTailFrameAnalysis,
  })
  const setSceneVideoPlan = game.setSceneVideoPlan
  const prepareManualVideo = game.prepareManualVideo
  const submitSceneVideoIfEnabled = useCallback((
    sceneId: string,
    request: VideoGenerationRequest,
    characterReferences: Record<string, VideoCharacterReference>,
    characters: SceneCharacter[],
    previousTailFrameUrl?: string,
  ) => {
    if (videoModeRef.current === 'manual') {
      setSceneVideoPlan(sceneId, request, 'awaiting_upload')
      prepareManualVideo(sceneId, characterReferences)
      return
    }
    if (videoModeRef.current === 'off' || !savedFalApiKey) {
      setSceneVideoPlan(sceneId, request, 'skipped')
      return
    }
    submitSceneVideo(sceneId, request, characterReferences, characters, previousTailFrameUrl)
  }, [savedFalApiKey, setSceneVideoPlan, submitSceneVideo, prepareManualVideo])
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
    submitSceneVideoIfEnabled,
  )

  const retryVideo = (sceneId: string) => {
    if (!savedFalApiKey) { onRequestApiKey(); return }
    const scene = game.session?.sceneHistory.find((item) => item.id === sceneId)
    if (scene?.videoRequest && game.session) {
      retrySceneVideo(scene, game.getCharacterReferences(actors), game.session.characters)
    }
  }

  const mediaRunning = game.restoringVideos || manualBusy || autoBusy
  const currentScene = game.session?.currentScene
  const getCharacterReferences = game.getCharacterReferences
  useEffect(() => {
    if (videoMode === 'manual' && currentScene?.videoRequest && currentScene.videoMode !== 'manual'
      && !mediaRunning && !isDirectorActive(director.status) && game.session?.status !== 'awaiting_agent') {
      prepareManualVideo(currentScene.id, getCharacterReferences(actors))
    }
  }, [videoMode, currentScene, mediaRunning, director.status, game.session?.status, prepareManualVideo, getCharacterReferences, actors])

  const switchVideoMode = (next: NonNullable<GameScene['videoMode']>) => {
    if (next === videoMode || mediaRunning || isDirectorActive(director.status)) return
    videoModeRef.current = next
    setVideoMode(next)
    if (next === 'manual' && currentScene?.videoRequest) prepareManualVideo(currentScene.id, getCharacterReferences(actors))
    if (next === 'off' && currentScene && game.session?.status === 'awaiting_media') game.releaseSceneChoices(currentScene.id)
    try {
      localStorage.setItem(VIDEO_MODE_STORAGE_KEY, next)
    } catch {
      // 存不进 localStorage 时仅影响刷新后的默认值
    }
  }

  const uploadVideo = async (sceneId: string, sequence: number, file: File) => {
    const scene = game.session?.currentScene
    if (!scene || scene.id !== sceneId || game.session?.status === 'awaiting_agent') throw new Error('请在当前幕上传视频。')
    await uploadSceneVideo(scene, sequence, file, game.session!.characters.filter((character) => scene.characterIds?.includes(character.id)))
  }

  const retryTail = (sceneId: string) => {
    const scene = game.session?.currentScene
    if (scene?.id === sceneId) void retryUploadedTail(scene, game.session!.characters.filter((character) => scene.characterIds?.includes(character.id)))
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
          <button type="button" className="button button-secondary" onClick={game.retrySaveSession}>重试保存</button>
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
            manualBusy={manualBusy}
            onStart={startStory}
            onVideoModeChange={switchVideoMode}
            onRetryVideo={retryVideo}
            onUploadVideo={uploadVideo}
            onRetryTail={retryTail}
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
              mediaBusy={manualBusy}
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
