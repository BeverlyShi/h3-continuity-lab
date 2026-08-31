import { useCallback, useRef, useState } from 'react'
import { KeyRound, RotateCcw, ScrollText, UserRound } from 'lucide-react'
import { AgentChat } from '../components/game/AgentChat'
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

type GamePageProps = {
  savedFalApiKey: string
  savedDeepSeekApiKey: string
  onTraceUpdate: (update: AgentTraceUpdate) => void
  onRequestApiKey: () => void
}

const AGENT_KIND_STORAGE_KEY = 'palace-director-agent-kind'
const VIDEO_GENERATION_STORAGE_KEY = 'palace-video-generation-enabled'

const loadAgentKind = (): DirectorAgentKind => {
  try {
    return localStorage.getItem(AGENT_KIND_STORAGE_KEY) === 'simple' ? 'simple' : 'pi'
  } catch {
    return 'pi'
  }
}

const loadVideoGenerationEnabled = (): boolean => {
  try {
    return localStorage.getItem(VIDEO_GENERATION_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function GamePage({ savedFalApiKey, savedDeepSeekApiKey, onTraceUpdate, onRequestApiKey }: GamePageProps) {
  const game = useGameSession()
  const [agentKind, setAgentKind] = useState<DirectorAgentKind>(loadAgentKind)
  const [videoGenerationEnabled, setVideoGenerationEnabled] = useState(loadVideoGenerationEnabled)
  // 开关随时可切，提交回调走 ref 读最新值，避免 agent 回合里拿到过期闭包。
  const videoGenerationEnabledRef = useRef(videoGenerationEnabled)
  const { submitSceneVideo, retrySceneVideo } = useSceneVideo({
    apiKey: savedFalApiKey,
    onVideoUpdate: game.attachSceneVideo,
  })
  const attachSceneVideo = game.attachSceneVideo
  const submitSceneVideoIfEnabled = useCallback((sceneId: string, request: VideoGenerationRequest) => {
    if (!videoGenerationEnabledRef.current) {
      attachSceneVideo(sceneId, { videoStatus: 'skipped', videoRequest: request })
      return
    }
    submitSceneVideo(sceneId, request)
  }, [attachSceneVideo, submitSceneVideo])
  const director = useDirectorAgent(game, savedDeepSeekApiKey, onTraceUpdate, agentKind, submitSceneVideoIfEnabled)

  const retryVideo = (sceneId: string) => {
    const scene = game.session?.sceneHistory.find((item) => item.id === sceneId)
    if (scene?.videoRequest) retrySceneVideo(sceneId, scene.videoRequest)
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

  const startStory = () => {
    if (!savedDeepSeekApiKey) {
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
          {!savedDeepSeekApiKey && (
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

      <div className="game-layout">
        <div className="game-main-column">
          <GameStage
            key={game.session?.currentScene?.id ?? 'empty-stage'}
            session={game.session}
            hasApiKey={Boolean(savedDeepSeekApiKey)}
            directorStatus={director.status}
            videoGenerationEnabled={videoGenerationEnabled}
            onStart={startStory}
            onToggleVideoGeneration={toggleVideoGeneration}
            onRetryVideo={retryVideo}
          />
          {game.session && (
            <GameInteraction
              key={`${game.session.id}:${game.session.turn}`}
              session={game.session}
              directorStatus={director.status}
              onChoose={director.submitChoice}
              onSubmitFreeform={director.submitFreeform}
              onRetry={() => { void director.retry() }}
            />
          )}
        </div>
        <aside className="game-sidebar">
          <AgentChat
            session={game.session}
            agentKind={agentKind}
            onAgentKindChange={switchAgentKind}
            messages={director.messages}
            status={director.status}
            hasApiKey={Boolean(savedDeepSeekApiKey)}
            onSubmit={director.submitFreeform}
            onRetry={() => { void director.retry() }}
            onRequestApiKey={onRequestApiKey}
          />
        </aside>
      </div>
    </main>
  )
}
