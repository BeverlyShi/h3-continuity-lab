import { AlertTriangle, History, LoaderCircle, Play, RotateCcw, Sunset } from 'lucide-react'
import { useState } from 'react'
import type { GameSession } from '../../types/game'

type GameStageProps = {
  session: GameSession | null
  hasApiKey: boolean
  onStart: () => void
  onRetry: () => void
  onEnded: () => void
}

const getStatus = (session: GameSession | null) => {
  if (!session) return ['等待开始', ''] as const
  if (session.status === 'failed') return ['生成失败', 'error'] as const
  if (['generating_opening', 'generating_video'].includes(session.status)) {
    return ['生成中', 'busy'] as const
  }
  if (session.status === 'ended') return ['第一夜结束', ''] as const
  if (session.status === 'playing') return ['正在播放', ''] as const
  return ['等待行动', ''] as const
}

export function GameStage({ session, hasApiKey, onStart, onRetry, onEnded }: GameStageProps) {
  const [reviewSceneId, setReviewSceneId] = useState('')
  const currentScene = session?.currentScene
  const scene = session?.sceneHistory.find((item) => item.id === reviewSceneId) ?? currentScene
  const sceneIndex = session?.sceneHistory.findIndex((item) => item.id === scene?.id) ?? -1
  const isReviewing = Boolean(scene && currentScene && scene.id !== currentScene.id)
  const isGenerating = Boolean(session && ['generating_opening', 'generating_video'].includes(session.status))
  const [liveStatusLabel, liveStatusClass] = getStatus(session)
  const statusLabel = isReviewing ? `回看第 ${sceneIndex + 1} 幕` : liveStatusLabel
  const statusClass = isReviewing ? 'reviewing' : liveStatusClass

  return (
    <section className="game-stage-card">
      <div className="game-section-heading">
        <div>
          <h2>{scene?.title ?? '故事开场'}</h2>
          <p>{isGenerating && !isReviewing ? 'H3 Max 正在生成下一段 5 秒场景视频' : scene?.narrative ?? '点击开始后，将立即生成并播放第一幕'}</p>
        </div>
        <span className={`game-status ${statusClass}`}><span />{statusLabel}</span>
      </div>

      <div className="game-player">
        {scene ? (
          <video
            key={scene.id}
            src={scene.videoUrl}
            controls
            autoPlay={isReviewing || session?.status === 'playing'}
            playsInline
            onEnded={isReviewing ? undefined : onEnded}
          />
        ) : isGenerating ? (
          <div className="game-player-state">
            <LoaderCircle className="spin" size={28} />
            <strong>开场生成中</strong>
            <span>风沙、驿站与第一批无籍者正在进入镜头</span>
          </div>
        ) : session?.status === 'failed' ? (
          <div className="game-player-state error">
            <AlertTriangle size={27} />
            <strong>开场视频生成失败</strong>
            <span>{session.error}</span>
          </div>
        ) : (
          <div className="game-player-state">
            <span className="game-player-icon"><Sunset size={26} /></span>
            <strong>边境的日落即将开始</strong>
            <span>{hasApiKey ? '准备开启《无籍之城》的第一幕' : '准备好 FAL 与 DeepSeek Key，开启第一幕'}</span>
          </div>
        )}
        {isGenerating && scene && !isReviewing && (
          <div className="game-video-overlay">
            <LoaderCircle className="spin" size={24} />
            <strong>下一幕生成中</strong>
          </div>
        )}
      </div>

      {session && session.sceneHistory.length > 1 && (
        <nav className="game-scene-history" aria-label="已生成幕次">
          <div className="game-scene-history-heading">
            <span><History size={14} />幕次回看</span>
            <small>回看不会推进剧情或调用 API</small>
          </div>
          <div className="game-scene-history-track">
            {session.sceneHistory.map((historyScene, index) => {
              const isShown = historyScene.id === scene?.id
              const isCurrent = historyScene.id === currentScene?.id
              return (
                <button
                  className={isShown ? 'active' : ''}
                  type="button"
                  aria-pressed={isShown}
                  key={historyScene.id}
                  onClick={() => setReviewSceneId(isCurrent ? '' : historyScene.id)}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div><strong>{historyScene.title}</strong><small>{isCurrent ? '当前幕' : '点击回看'}</small></div>
                </button>
              )
            })}
          </div>
        </nav>
      )}

      {!session && (
        <div className="game-start-actions">
          <div>
            <button className="button button-primary game-start-button" onClick={onStart}>
              <Play size={17} fill="currentColor" />开始游戏 · 生成首幕
            </button>
            <p className="game-cost-note">本局最多生成 6 个 5 秒片段；公开标价约 $0.40/段，重试另计，以 fal 账户结算为准。</p>
          </div>
        </div>
      )}
      {session?.status === 'failed' && (
        <div className="game-start-actions">
          <button className="button button-primary game-start-button" onClick={onRetry}>
            <RotateCcw size={17} />重新生成{session.failureStep === 'opening' ? '开场' : '下一幕'} · 可能再次计费
          </button>
        </div>
      )}
    </section>
  )
}
