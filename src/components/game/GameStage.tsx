import { BookOpenText, History, Play, Sunset } from 'lucide-react'
import { useState } from 'react'
import { isDirectorActive } from '../../services/directorStatus'
import type { DirectorStatus } from '../../types/director'
import type { GameSession } from '../../types/game'

type GameStageProps = {
  session: GameSession | null
  hasApiKey: boolean
  directorStatus: DirectorStatus
  onStart: () => void
}

const getStatus = (session: GameSession | null, directorStatus: DirectorStatus) => {
  if (!session) return ['等待开始', ''] as const
  if (session.status === 'awaiting_director') {
    return isDirectorActive(directorStatus)
      ? ['导演裁决中', 'busy'] as const
      : ['裁决待恢复', 'error'] as const
  }
  if (session.status === 'resolved') return ['正在发布', 'busy'] as const
  if (session.status === 'ended') return ['第一夜结束', ''] as const
  return ['等待行动', ''] as const
}

export function GameStage({ session, hasApiKey, directorStatus, onStart }: GameStageProps) {
  const [reviewSceneId, setReviewSceneId] = useState('')
  const currentScene = session?.currentScene
  const scene = session?.sceneHistory.find((item) => item.id === reviewSceneId) ?? currentScene
  const sceneIndex = session?.sceneHistory.findIndex((item) => item.id === scene?.id) ?? -1
  const isReviewing = Boolean(scene && currentScene && scene.id !== currentScene.id)
  const [liveStatusLabel, liveStatusClass] = getStatus(session, directorStatus)
  const statusLabel = isReviewing ? `回看第 ${sceneIndex + 1} 幕` : liveStatusLabel
  const statusClass = isReviewing ? 'reviewing' : liveStatusClass

  return (
    <section className="game-stage-card">
      <div className="game-section-heading">
        <div>
          <h2>{scene?.title ?? '故事开场'}</h2>
          <p>{scene ? `文字场景 · 第 ${sceneIndex + 1} 幕` : '点击开始后，直接进入第一幕文字互动'}</p>
        </div>
        <span className={`game-status ${statusClass}`}><span />{statusLabel}</span>
      </div>

      <article className={`game-story-page ${scene?.ending ? `ending ${scene.ending.kind}` : ''}`}>
        {scene ? (
          <>
            <div className="game-story-kicker"><BookOpenText size={15} /> 当前叙事</div>
            <p>{scene.narrative}</p>
            {scene.ending && <footer><strong>{scene.ending.title}</strong><span>{scene.ending.summary}</span></footer>}
          </>
        ) : (
          <div className="game-story-empty">
            <span className="game-player-icon"><Sunset size={26} /></span>
            <strong>边境的日落即将开始</strong>
            <span>{hasApiKey ? '准备开启《无籍之城》的第一幕' : '配置 DeepSeek Key 后开启第一幕'}</span>
          </div>
        )}
      </article>

      {session && session.sceneHistory.length > 1 && (
        <nav className="game-scene-history" aria-label="已发布幕次">
          <div className="game-scene-history-heading">
            <span><History size={14} />幕次回看</span>
            <small>回看不会推进剧情或调用 Agent</small>
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
              <Play size={17} fill="currentColor" />开始游戏 · 进入首幕
            </button>
            <p className="game-cost-note">纯文字诊断模式不会调用生视频模型，仅使用 DeepSeek 世界导演。</p>
          </div>
        </div>
      )}
    </section>
  )
}
