import { KeyRound, RotateCcw, ScrollText, ShieldCheck } from 'lucide-react'
import { AgentChat } from '../components/game/AgentChat'
import { GameEventLog } from '../components/game/GameEventLog'
import { GameInteraction } from '../components/game/GameInteraction'
import { GameStage } from '../components/game/GameStage'
import { GameStatePanel } from '../components/game/GameStatePanel'
import { useDirectorAgent } from '../hooks/useDirectorAgent'
import { useGameSession } from '../hooks/useGameSession'
import { unregisteredCity } from '../stories/unregisteredCity'
import type { PlayerAction } from '../types/game'

type GamePageProps = {
  savedFalApiKey: string
  savedDeepSeekApiKey: string
  onRequestApiKey: () => void
}

export function GamePage({ savedFalApiKey, savedDeepSeekApiKey, onRequestApiKey }: GamePageProps) {
  const game = useGameSession(savedFalApiKey)
  const director = useDirectorAgent(game, savedDeepSeekApiKey)

  const submitAction = (text: string, source: PlayerAction['source']) => {
    if (!savedDeepSeekApiKey) {
      onRequestApiKey()
      return false
    }
    return director.submitAction(text, source)
  }

  const startGame = () => {
    if (!savedFalApiKey || !savedDeepSeekApiKey) {
      onRequestApiKey()
      return
    }
    void game.generateOpening()
  }

  const retryGeneration = () => {
    if (!savedFalApiKey) {
      onRequestApiKey()
      return
    }
    if (game.session?.failureStep === 'next_scene') void director.retry()
    else void game.generateOpening()
  }

  return (
    <main className="game-workspace">
      <section className="game-intro">
        <div className="game-intro-copy">
          <div className="game-eyebrow"><ScrollText size={14} /> 互动故事实验</div>
          <h1>《{unregisteredCity.title}》</h1>
          <p>{unregisteredCity.summary}</p>
          <div className="game-role"><ShieldCheck size={16} /> 你的身份：边境驿站老板</div>
        </div>
        <div className="game-intro-actions">
          {(!savedFalApiKey || !savedDeepSeekApiKey) && (
            <button className="button button-secondary" onClick={onRequestApiKey}>
              <KeyRound size={15} />设置 API Key
            </button>
          )}
          {game.session?.status === 'ended' && (
            <button className="button button-secondary" onClick={game.restart}>
              <RotateCcw size={15} />重新开始第一夜
            </button>
          )}
        </div>
      </section>

      <div className="game-layout">
        <div className="game-main-column">
          <GameStage
            key={game.session?.currentScene?.id ?? 'empty-stage'}
            session={game.session}
            hasApiKey={Boolean(savedFalApiKey && savedDeepSeekApiKey)}
            onStart={startGame}
            onRetry={retryGeneration}
            onEnded={game.completeScenePlayback}
          />
          {game.session && (
            <GameInteraction
              key={`${game.session.id}:${game.session.turn}`}
              session={game.session}
              onSubmit={submitAction}
            />
          )}
          <GameEventLog events={game.session?.events ?? []} />
        </div>
        <aside className="game-sidebar">
          <AgentChat
            session={game.session}
            messages={director.messages}
            status={director.status}
            hasApiKey={Boolean(savedDeepSeekApiKey)}
            onSubmit={(text) => submitAction(text, 'freeform')}
            onRetry={() => { void director.retry() }}
            onRequestApiKey={onRequestApiKey}
          />
          <GameStatePanel session={game.session} agentReady={Boolean(savedDeepSeekApiKey)} />
        </aside>
      </div>
    </main>
  )
}
