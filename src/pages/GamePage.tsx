import { useCallback, useRef, useState } from 'react'
import { KeyRound, RotateCcw, ScrollText, UserRound } from 'lucide-react'
import { AgentChat } from '../components/game/AgentChat'
import {
  DEFAULT_DIRECTOR_MODEL,
  getDirectorModelProvider,
  isDirectorModelId,
  type DirectorModelId,
} from '../config/directorModels'
import type { DirectorAgentKind } from '../services/directorClient'
import { GameInteraction } from '../components/game/GameInteraction'
import { GameStage } from '../components/game/GameStage'
import { useDirectorAgent } from '../hooks/useDirectorAgent'
import { useGameSession } from '../hooks/useGameSession'
import { useSceneVideo } from '../hooks/useSceneVideo'
import { palaceStory } from '../stories/palace'
import { isDirectorActive } from '../services/directorStatus'
import type { AgentTraceUpdate } from '../types/director'
import type { VideoGenerationRequest } from '../types/story'
import type { Actor } from '../types/actor'
import type { VideoCharacterReference } from '../types/video'

type GamePageProps = {
  savedFalApiKey: string
  savedOpenRouterApiKey: string
  savedDeepSeekApiKey: string
  onTraceUpdate: (update: AgentTraceUpdate) => void
  onRequestApiKey: () => void
  actors: Actor[]
}

const AGENT_KIND_STORAGE_KEY = 'palace-director-agent-kind'
const DIRECTOR_MODEL_STORAGE_KEY = 'palace-director-model'
const VIDEO_GENERATION_STORAGE_KEY = 'palace-video-generation-enabled'

const loadAgentKind = (): DirectorAgentKind => {
  try {
    return localStorage.getItem(AGENT_KIND_STORAGE_KEY) === 'simple' ? 'simple' : 'pi'
  } catch {
    return 'pi'
  }
}

const loadDirectorModel = (): DirectorModelId => {
  try {
    const stored = localStorage.getItem(DIRECTOR_MODEL_STORAGE_KEY)
    return isDirectorModelId(stored) ? stored : DEFAULT_DIRECTOR_MODEL
  } catch {
    return DEFAULT_DIRECTOR_MODEL
  }
}

const loadVideoGenerationEnabled = (): boolean => {
  try {
    return localStorage.getItem(VIDEO_GENERATION_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function GamePage({ savedFalApiKey, savedOpenRouterApiKey, savedDeepSeekApiKey, onTraceUpdate, onRequestApiKey, actors }: GamePageProps) {
  const game = useGameSession()
  const [agentKind, setAgentKind] = useState<DirectorAgentKind>(loadAgentKind)
  const [modelId, setModelId] = useState<DirectorModelId>(loadDirectorModel)
  const activeModelProvider = getDirectorModelProvider(modelId)
  const activeApiKey = activeModelProvider === 'deepseek' ? savedDeepSeekApiKey : savedOpenRouterApiKey
  const apiKeyLabel = activeModelProvider === 'deepseek' ? 'DeepSeek' : 'OpenRouter'
  const [videoGenerationEnabled, setVideoGenerationEnabled] = useState(loadVideoGenerationEnabled)
  const [narrativeExpanded, setNarrativeExpanded] = useState(true)
  // 开关随时可切，提交回调走 ref 读最新值，避免 agent 回合里拿到过期闭包。
  const videoGenerationEnabledRef = useRef(videoGenerationEnabled)
  const { submitSceneVideo, retrySceneVideo } = useSceneVideo({
    apiKey: savedFalApiKey,
    onVideoPlan: game.setSceneVideoPlan,
    onVideoClipUpdate: game.updateSceneVideoClip,
    onVideoRetry: game.resetSceneVideoFrom,
  })
  const setSceneVideoPlan = game.setSceneVideoPlan
  const submitSceneVideoIfEnabled = useCallback((
    sceneId: string,
    request: VideoGenerationRequest,
    characterReferences: Record<string, VideoCharacterReference>,
  ) => {
    if (!videoGenerationEnabledRef.current) {
      setSceneVideoPlan(sceneId, request, 'skipped')
      return
    }
    submitSceneVideo(sceneId, request, characterReferences)
  }, [setSceneVideoPlan, submitSceneVideo])
  const director = useDirectorAgent(
    game,
    savedOpenRouterApiKey,
    savedDeepSeekApiKey,
    onTraceUpdate,
    agentKind,
    modelId,
    actors,
    submitSceneVideoIfEnabled,
  )

  const retryVideo = (sceneId: string) => {
    const scene = game.session?.sceneHistory.find((item) => item.id === sceneId)
    if (scene?.videoRequest && game.session) {
      retrySceneVideo(scene, game.getCharacterReferences(actors))
    }
  }

  const toggleVideoGeneration = (next: boolean) => {
    videoGenerationEnabledRef.current = next
    setVideoGenerationEnabled(next)
    try {
      localStorage.setItem(VIDEO_GENERATION_STORAGE_KEY, next ? 'on' : 'off')
    } catch {
      // 存不进 localStorage 时仅影响刷新后的默认值
    }
  }

  const switchAgentKind = (next: DirectorAgentKind) => {
    setAgentKind(next)
    try {
      localStorage.setItem(AGENT_KIND_STORAGE_KEY, next)
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
    if (!activeApiKey) {
      onRequestApiKey()
      return
    }
    director.startStory()
  }

  const restartStory = () => {
    if (!director.reset()) return
    game.restart()
  }

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
              disabled={isDirectorActive(director.status)}
              onClick={restartStory}
            >
              <RotateCcw size={15} />重新开始
            </button>
          )}
        </div>
      </section>

      <div className={`game-layout${game.session ? '' : ' no-action'}`}>
        <div className="game-main-column">
          <GameStage
            key={game.session?.currentScene?.id ?? 'empty-stage'}
            session={game.session}
            hasApiKey={Boolean(activeApiKey)}
            apiKeyLabel={apiKeyLabel}
            directorStatus={director.status}
            videoGenerationEnabled={videoGenerationEnabled}
            onStart={startStory}
            onToggleVideoGeneration={toggleVideoGeneration}
            onRetryVideo={retryVideo}
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
            agentKind={agentKind}
            onAgentKindChange={switchAgentKind}
            modelId={modelId}
            onModelChange={switchModel}
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
