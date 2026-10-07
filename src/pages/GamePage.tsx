import { useCallback, useEffect, useState } from 'react'
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
import { useDirectorAgent, type OnVideoPlanReady } from '../hooks/useDirectorAgent'
import { useGameSession } from '../hooks/useGameSession'
import { useSceneVideo } from '../hooks/useSceneVideo'
import { palaceStory } from '../stories/palace'
import { isDirectorActive } from '../services/directorStatus'
import type { AgentTraceUpdate } from '../types/director'
import type { ActorPortraits } from '../hooks/useActorPortraits'
import type { Actor, CreatedActor, SceneCastingResult } from '../types/actor'
import type { GameScene } from '../types/game'

type GamePageProps = {
  savedFalApiKey: string
  savedComfyApiKey: string
  savedOpenRouterApiKey: string
  savedDeepSeekApiKey: string
  savedBigModelApiKey: string
  onTraceUpdate: (update: AgentTraceUpdate) => void
  onRequestApiKey: () => void
  actors: Actor[]
  // 最新演员库：异步流程（等参考图、逐段生成）里读，不受渲染闭包影响。
  getActors: () => Actor[]
  onActorsCreated: (created: CreatedActor[]) => Promise<void> | void
  portraits: Pick<ActorPortraits, 'generatePortrait' | 'ensurePortraits' | 'waitForPortraits' | 'generatingIds'>
}

const DIRECTOR_MODEL_STORAGE_KEY = 'palace-director-model'
const DIRECTOR_THINKING_STORAGE_KEY = 'palace-director-thinking-enabled'
const VIDEO_MODE_STORAGE_KEY = 'palace-video-mode'
const COMFY_AUTO_GENERATE_STORAGE_KEY = 'h3-game-comfy-auto'

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
    // 旧版的「上传视频」「仅文字」已下线，连同无值一律落到 ComfyUI。
    return localStorage.getItem(VIDEO_MODE_STORAGE_KEY) === 'auto' ? 'auto' : 'comfy'
  } catch {
    return 'comfy'
  }
}

const loadComfyAutoGenerate = () => {
  try {
    return localStorage.getItem(COMFY_AUTO_GENERATE_STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

export function GamePage({ savedFalApiKey, savedComfyApiKey, savedOpenRouterApiKey, savedDeepSeekApiKey, savedBigModelApiKey, onTraceUpdate, onRequestApiKey, actors, getActors, onActorsCreated, portraits }: GamePageProps) {
  const game = useGameSession()
  const [modelId, setModelId] = useState<DirectorModelId>(loadDirectorModel)
  const [thinkingEnabled, setThinkingEnabled] = useState(loadDirectorThinking)
  const activeModelProvider = getDirectorModelProvider(modelId)
  const activeApiKey = { deepseek: savedDeepSeekApiKey, openrouter: savedOpenRouterApiKey, bigmodel: savedBigModelApiKey }[activeModelProvider]
  const apiKeyLabel = { deepseek: 'DeepSeek', openrouter: 'OpenRouter', bigmodel: '智谱 BigModel' }[activeModelProvider]
  const [videoMode, setVideoMode] = useState(loadVideoMode)
  const [comfyAutoGenerate, setComfyAutoGenerate] = useState(loadComfyAutoGenerate)
  const autoGenerate = videoMode === 'auto' || comfyAutoGenerate
  const [narrativeExpanded, setNarrativeExpanded] = useState(true)

  const sceneVideo = useSceneVideo({
    falApiKey: savedFalApiKey,
    comfyApiKey: savedComfyApiKey,
    videoMode,
    autoGenerate,
    game,
    getActors,
    // ComfyUI 模式先补齐缺的参考图；API 模式只等已在生成的（玩家在演员库手动点的）。
    preparePortraits: videoMode === 'comfy' && savedComfyApiKey ? portraits.ensurePortraits : portraits.waitForPortraits,
  })
  const { generateScene: generateSceneVideo } = sceneVideo
  const { generatePortrait } = portraits

  // 选角落定：新建演员先入库；ComfyUI 模式下本场次所有还没有参考图的演员（新建的和库里待生成的）立即生成三视图。
  const onSceneCast = useCallback(async (casting: SceneCastingResult) => {
    if (casting.createdActors?.length) await onActorsCreated(casting.createdActors)
    if (videoMode !== 'comfy' || !savedComfyApiKey) return
    for (const actorId of new Set(casting.castings.map((item) => item.actorId))) void generatePortrait(actorId)
  }, [generatePortrait, onActorsCreated, savedComfyApiKey, videoMode])

  // ComfyUI 模式按秒扣积分：没开「自动生成」时分镜就绪后不自动提交，等玩家在时间轴上点「生成本场次视频」。
  const onVideoPlanReady: OnVideoPlanReady = useCallback((sceneId) => {
    if (videoMode === 'comfy') {
      if (!savedComfyApiKey) return '未配置 Comfy API Key，请先在设置里配置。'
      if (comfyAutoGenerate) void generateSceneVideo(sceneId)
      return undefined
    }
    if (!savedFalApiKey) return '未配置 fal API Key，请先在设置里配置。'
    void generateSceneVideo(sceneId)
    return undefined
  }, [comfyAutoGenerate, generateSceneVideo, savedComfyApiKey, savedFalApiKey, videoMode])

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
    onSceneCast,
    onVideoPlanReady,
  )

  const mediaRunning = game.restoringVideos || sceneVideo.mediaBusy

  // 存档与本地视频都恢复完成后：刷新前已提交的 Comfy 任务（已在扣费）接着查结果；
  // 开了「自动生成」时整场接着生成（有任务 ID 的段续查原任务，不重复提交），没开时没提交过的段不自动提交。
  useEffect(() => {
    if (game.loading || game.restoringVideos) return
    const session = game.getSessionSnapshot()
    const scene = session?.currentScene
    if (videoMode !== 'comfy' || !savedComfyApiKey || !scene) return
    if (comfyAutoGenerate) {
      if (session.status === 'awaiting_video' && scene.videoClips?.some((item) => item.status !== 'ready')) {
        void generateSceneVideo(scene.id)
      }
      return
    }
    const clip = scene.videoClips?.find((item) => item.comfyJobId && item.status !== 'ready')
    if (!clip) return
    void sceneVideo.generateClip(scene.id, clip.sequence)
    // 只在存档加载完成的那一刻检查一次，之后的生成由玩家点击或新分镜触发。
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

  const switchComfyAutoGenerate = (enabled: boolean) => {
    if (videoMode !== 'comfy' || mediaRunning || isDirectorActive(director.status)) return
    if (game.session && game.session.status !== 'awaiting_action') return
    setComfyAutoGenerate(enabled)
    try {
      localStorage.setItem(COMFY_AUTO_GENERATE_STORAGE_KEY, enabled ? 'on' : 'off')
    } catch {
      // 存不进 localStorage 时仅影响刷新后的默认值
    }
  }

  const hasVideoKey = videoMode === 'auto' ? Boolean(savedFalApiKey) : Boolean(savedComfyApiKey)

  const generateClip = (sceneId: string, sequence: number) => {
    if (!hasVideoKey) {
      onRequestApiKey()
      return
    }
    void sceneVideo.generateClip(sceneId, sequence)
  }

  const generateScene = (sceneId: string) => {
    if (!hasVideoKey) {
      onRequestApiKey()
      return
    }
    void sceneVideo.generateScene(sceneId)
  }

  const rewriteSegment = (sceneId: string, sequence: number, reason: string) => {
    if (mediaRunning) return Promise.resolve(false)
    return director.rewriteSegment(sceneId, sequence, reason)
  }

  const skipVideo = () => {
    const sceneId = game.session?.currentScene?.id
    if (sceneId) game.skipSceneVideo(sceneId)
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
    if (!activeApiKey || videoMode === 'auto' && !savedFalApiKey || videoMode === 'comfy' && !savedComfyApiKey) {
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
          <div className="game-eyebrow"><ScrollText size={14} /> 互动剧情游戏</div>
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
            generatingPortraitIds={portraits.generatingIds}
            hasApiKey={Boolean(activeApiKey)}
            apiKeyLabel={apiKeyLabel}
            directorStatus={director.status}
            videoMode={videoMode}
            mediaRunning={mediaRunning}
            onStart={startStory}
            onVideoModeChange={switchVideoMode}
            comfyAutoGenerate={comfyAutoGenerate}
            onComfyAutoGenerateChange={switchComfyAutoGenerate}
            onGenerateClip={generateClip}
            onGenerateScene={generateScene}
            onRewriteSegment={rewriteSegment}
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
              videoMode={videoMode}
              comfyAutoGenerate={comfyAutoGenerate}
              mediaRunning={mediaRunning}
              onChoose={director.submitChoice}
              onSubmitFreeform={director.submitFreeform}
              onRetry={() => { void director.retry() }}
              onSkipVideo={skipVideo}
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
