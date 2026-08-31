import { useCallback, useRef, useState } from 'react'
import { streamDirectorTurn } from '../services/directorClient'
import type { DirectorChatMessage, DirectorStatus, DirectorStreamEvent } from '../types/director'
import type { PlayerAction } from '../types/game'
import type { useGameSession } from './useGameSession'

type GameController = ReturnType<typeof useGameSession>

const makeMessage = (
  role: DirectorChatMessage['role'],
  text: string,
): DirectorChatMessage => ({ id: crypto.randomUUID(), role, text, createdAt: Date.now() })

export function useDirectorAgent(game: GameController, apiKey: string) {
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
    }

    try {
      const resolution = await streamDirectorTurn({ apiKey, context, onEvent: handleEvent })
      const committed = game.commitResolution(resolution)
      if (!committed.ok) throw new Error(`规则校验拒绝裁决：${committed.errors?.join('；') ?? '未知规则冲突'}`)

      setStatus('generating')
      append('agent', resolution.narrative)
      append('status', '规则校验通过，H3 Max 正在生成下一幕。')
      const generated = await game.requestVideo()
      if (!generated.ok) throw new Error(generated.error)

      const published = game.publishTurn()
      if (!published.ok) throw new Error(published.error)
      setStatus('idle')
      append('status', '下一幕已发布，视频播放结束后可继续行动。')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '导演执行失败。'
      setStatus('error')
      append('error', message)
      return false
    } finally {
      runningRef.current = false
    }
  }, [apiKey, append, game])

  const submitAction = useCallback((text: string, source: PlayerAction['source']) => {
    if (runningRef.current || !game.submitAction(text, source)) return false
    append('player', text.trim())
    void runPendingTurn()
    return true
  }, [append, game, runPendingTurn])

  const retry = useCallback(async () => {
    if (game.session?.status === 'awaiting_director') return runPendingTurn()
    if (game.session?.status !== 'failed' || game.session.failureStep !== 'next_scene') return false

    runningRef.current = true
    setStatus('generating')
    append('status', '正在重新生成上一份裁决对应的视频。')
    try {
      const generated = await game.requestVideo()
      if (!generated.ok) throw new Error(generated.error)
      const published = game.publishTurn()
      if (!published.ok) throw new Error(published.error)
      setStatus('idle')
      append('status', '下一幕已重新生成并发布。')
      return true
    } catch (error) {
      setStatus('error')
      append('error', error instanceof Error ? error.message : '重试失败。')
      return false
    } finally {
      runningRef.current = false
    }
  }, [append, game, runPendingTurn])

  return { messages, status, submitAction, retry }
}
