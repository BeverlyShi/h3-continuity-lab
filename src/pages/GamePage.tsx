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
import type { AgentTraceUpdate } from '../types/director'

type GamePageProps = {
  savedDeepSeekApiKey: string
  onTraceUpdate: (update: AgentTraceUpdate) => void
  onRequestApiKey: () => void
}

export function GamePage({ savedDeepSeekApiKey, onTraceUpdate, onRequestApiKey }: GamePageProps) {
  const game = useGameSession()
  const director = useDirectorAgent(game, savedDeepSeekApiKey, onTraceUpdate)

  const submitAction = (text: string, source: PlayerAction['source']) => {
    if (!savedDeepSeekApiKey) {
      onRequestApiKey()
      return false
    }
    return director.submitAction(text, source)
  }

  const startGame = () => {
    if (!savedDeepSeekApiKey) {
      onRequestApiKey()
      return
    }
    game.generateOpening()
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
          {!savedDeepSeekApiKey && (
            <button className="button button-secondary" onClick={onRequestApiKey}>
              <KeyRound size={15} />设置 API Key
            </button>
          )}
          {game.session && (
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
            hasApiKey={Boolean(savedDeepSeekApiKey)}
            directorStatus={director.status}
            onStart={startGame}
          />
          {game.session && (
            <GameInteraction
              key={`${game.session.id}:${game.session.turn}`}
              session={game.session}
              directorStatus={director.status}
              onSubmit={submitAction}
              onRetry={() => { void director.retry() }}
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
