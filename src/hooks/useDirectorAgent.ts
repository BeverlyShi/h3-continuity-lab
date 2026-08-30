import { useCallback, useRef, useState } from 'react'
import { streamDirectorTurn } from '../services/directorClient'
import type {
  AgentTraceEntry,
  AgentTraceUpdate,
  DirectorChatMessage,
  DirectorStatus,
  DirectorStreamEvent,
} from '../types/director'
import type { PlayerAction } from '../types/game'
import type { useGameSession } from './useGameSession'

type GameController = ReturnType<typeof useGameSession>

const makeMessage = (
  role: DirectorChatMessage['role'],
  text: string,
): DirectorChatMessage => ({ id: crypto.randomUUID(), role, text, createdAt: Date.now() })

const makeTraceEntry = (
  kind: AgentTraceEntry['kind'],
  title: string,
  data?: unknown,
  text?: string,
): AgentTraceEntry => ({ id: crypto.randomUUID(), kind, title, data, text, timestamp: Date.now() })

export function useDirectorAgent(
  game: GameController,
  apiKey: string,
  onTraceUpdate: (update: AgentTraceUpdate) => void,
) {
  const [messages, setMessages] = useState<DirectorChatMessage[]>([])
  const [status, setStatus] = useState<DirectorStatus>('idle')
  const runningRef = useRef(false)

  const append = useCallback((role: DirectorChatMessage['role'], text: string) => {
    setMessages((current) => [...current, makeMessage(role, text)])
  }, [])

  const runPendingTurn = useCallback(async () => {
    if (runningRef.current) return false
    if (!apiKey) {
      setStatus('error')
      append('error', '缺少 DeepSeek API Key，请先打开 API 设置。')
      return false
    }

    const context = game.getTurnContext()
    if (!context.ok) {
      setStatus('error')
      append('error', context.error ?? '无法读取当前游戏状态。')
      return false
    }

    const traceId = crypto.randomUUID()
    const traceSession = context.session
    if (!traceSession) {
      setStatus('error')
      append('error', '无法建立当前游戏的 Trace。')
      return false
    }
    onTraceUpdate({
      type: 'start',
      run: {
        id: traceId,
        gameSessionId: traceSession.id,
        turn: traceSession.turn,
        action: traceSession.pendingAction?.text ?? '未知行动',
        startedAt: Date.now(),
        status: 'running',
        entries: [],
      },
    })

    runningRef.current = true
    setStatus('thinking')
    let assistantId = ''

    const handleEvent = (event: DirectorStreamEvent) => {
      if (event.type === 'status' || event.type === 'tool') append('status', event.text)
      if (event.type === 'delta') {
        if (!assistantId) {
          assistantId = crypto.randomUUID()
          setMessages((current) => [...current, {
            id: assistantId,
            role: 'agent',
            text: event.text,
            createdAt: Date.now(),
          }])
        } else {
          setMessages((current) => current.map((message) =>
            message.id === assistantId ? { ...message, text: message.text + event.text } : message,
          ))
        }
      }
      if (event.type === 'harness_trace') {
        onTraceUpdate({ type: 'harness', traceId, snapshot: event.trace })
      }
    }

    try {
      const resolution = await streamDirectorTurn({ apiKey, context, traceId, onEvent: handleEvent })
      const committed = game.commitResolution(resolution)
      if (!committed.ok) throw new Error(`规则校验拒绝裁决：${committed.errors?.join('；') ?? '未知规则冲突'}`)

      onTraceUpdate({
        type: 'append',
        traceId,
        entry: makeTraceEntry('rule_check', '确定性规则校验通过', {
          outcome: resolution.outcome,
          reason: resolution.reason,
          appliedStats: committed.appliedStats,
          ending: committed.ending,
        }),
      })
      onTraceUpdate({
        type: 'append',
        traceId,
        entry: makeTraceEntry('state_diff', '世界状态 Diff', committed.trace),
      })

      setStatus('publishing')
      append('agent', resolution.narrative)
      append('status', '规则校验通过，正在发布下一幕文字。')
      const published = game.publishTurn()
      if (!published.ok) throw new Error(published.error)
      onTraceUpdate({
        type: 'append',
        traceId,
        entry: makeTraceEntry('published', '文字场景已发布', {
          sceneId: published.sceneId,
          ending: published.ending,
        }, resolution.narrative),
      })
      onTraceUpdate({ type: 'complete', traceId, endedAt: Date.now() })
      setStatus('idle')
      append('status', '下一幕文字已发布，可以继续行动。')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '导演执行失败。'
      setStatus('error')
      append('error', message)
      onTraceUpdate({ type: 'error', traceId, endedAt: Date.now(), message })
      return false
    } finally {
      runningRef.current = false
    }
  }, [apiKey, append, game, onTraceUpdate])

  const submitAction = useCallback((text: string, source: PlayerAction['source']) => {
    if (runningRef.current || !game.submitAction(text, source)) return false
    append('player', text.trim())
    void runPendingTurn()
    return true
  }, [append, game, runPendingTurn])

  const retry = useCallback(async () => {
    if (game.session?.status === 'awaiting_director') return runPendingTurn()
    return false
  }, [game, runPendingTurn])

  return { messages, status, submitAction, retry }
}
