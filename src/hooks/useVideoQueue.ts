import { useEffect, useMemo, useReducer, useRef } from 'react'
import { mockVideoGenerator } from '../services/mockVideoGenerator'
import {
  MAX_VIDEO_DURATION,
  MIN_VIDEO_DURATION,
  type GeneratedVideo,
  type VideoClip,
  type VideoClipStatus,
  type VideoGenerator,
} from '../types/video'

type QueueState = {
  clips: VideoClip[]
  activeIndex: number
  isUserPaused: boolean
  isWaitingForNext: boolean
}

type QueueAction =
  | { type: 'enqueue'; clip: VideoClip }
  | { type: 'set-status'; id: string; status: VideoClipStatus }
  | { type: 'ready'; id: string; result: GeneratedVideo }
  | { type: 'failed'; id: string; error: string }
  | { type: 'ended' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'resume-current' }
  | { type: 'select'; index: number }

const initialState: QueueState = {
  clips: [],
  activeIndex: 0,
  isUserPaused: false,
  isWaitingForNext: false,
}

const isPlayable = (status: VideoClipStatus) =>
  ['ready', 'playing', 'completed'].includes(status)

const updateStatus = (
  clips: VideoClip[],
  id: string,
  status: VideoClipStatus,
): VideoClip[] => clips.map((clip) => (clip.id === id ? { ...clip, status } : clip))

function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'enqueue':
      return { ...state, clips: [...state.clips, action.clip] }

    case 'set-status':
      return { ...state, clips: updateStatus(state.clips, action.id, action.status) }

    case 'ready': {
      const clips = state.clips.map((clip) =>
        clip.id === action.id ? { ...clip, ...action.result, status: 'ready' as const } : clip,
      )
      const nextClip = clips[state.activeIndex + 1]
      const shouldAdvance =
        state.isWaitingForNext &&
        !state.isUserPaused &&
        nextClip?.id === action.id

      return {
        ...state,
        clips,
        activeIndex: shouldAdvance ? state.activeIndex + 1 : state.activeIndex,
        isUserPaused: clips[0]?.id === action.id ? false : state.isUserPaused,
        isWaitingForNext: shouldAdvance ? false : state.isWaitingForNext,
      }
    }

    case 'failed':
      return {
        ...state,
        clips: state.clips.map((clip) =>
          clip.id === action.id
            ? { ...clip, status: 'failed', error: action.error }
            : clip,
        ),
      }

    case 'ended': {
      const activeClip = state.clips[state.activeIndex]
      const nextClip = state.clips[state.activeIndex + 1]
      const canAdvance = Boolean(nextClip && isPlayable(nextClip.status))
      const clips = state.clips.map((clip, index) => {
        if (clip.id === activeClip?.id) return { ...clip, status: 'completed' as const }
        if (canAdvance && index === state.activeIndex + 1) {
          return { ...clip, status: 'ready' as const }
        }
        return clip
      })

      return {
        ...state,
        clips,
        activeIndex: canAdvance ? state.activeIndex + 1 : state.activeIndex,
        isUserPaused: false,
        isWaitingForNext: !canAdvance,
      }
    }

    case 'play': {
      const activeClip = state.clips[state.activeIndex]
      return {
        ...state,
        clips: activeClip ? updateStatus(state.clips, activeClip.id, 'playing') : state.clips,
        isUserPaused: false,
      }
    }

    case 'pause':
      return { ...state, isUserPaused: true }

    case 'resume-current':
      return { ...state, isUserPaused: false, isWaitingForNext: false }

    case 'select': {
      const selected = state.clips[action.index]
      if (!selected || !isPlayable(selected.status)) return state
      return {
        ...state,
        clips: updateStatus(state.clips, selected.id, 'ready'),
        activeIndex: action.index,
        isUserPaused: false,
        isWaitingForNext: false,
      }
    }
  }
}

export function useVideoQueue(generator: VideoGenerator = mockVideoGenerator) {
  const [state, dispatch] = useReducer(queueReducer, initialState)
  const videoRef = useRef<HTMLVideoElement>(null)
  const nextId = useRef(1)
  const activeClip = state.clips[state.activeIndex]
  const queuedCount = useMemo(
    () => state.clips.filter((clip) => clip.status === 'queued' || clip.status === 'generating').length,
    [state.clips],
  )

  useEffect(() => {
    if (!activeClip || activeClip.status !== 'ready' || !videoRef.current) return

    videoRef.current.load()
    if (!state.isUserPaused) {
      void videoRef.current.play().catch(() => dispatch({ type: 'pause' }))
    }
  }, [activeClip?.id, activeClip?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const enqueue = (prompt: string, duration: number) => {
    if (
      !Number.isInteger(duration) ||
      duration < MIN_VIDEO_DURATION ||
      duration > MAX_VIDEO_DURATION
    ) return

    const sequence = state.clips.length
    const id = `clip-${nextId.current++}`
    dispatch({ type: 'enqueue', clip: { id, prompt, duration, status: 'queued' } })

    Promise.resolve().then(() => {
      dispatch({ type: 'set-status', id, status: 'generating' })
    })

    void generator
      .generate(prompt, duration, sequence)
      .then((result) => dispatch({ type: 'ready', id, result }))
      .catch((error: unknown) => {
        dispatch({
          type: 'failed',
          id,
          error: error instanceof Error ? error.message : '视频生成失败',
        })
      })
  }

  const togglePlayback = () => {
    const video = videoRef.current
    if (!video || !activeClip || !isPlayable(activeClip.status)) return

    if (video.paused) {
      dispatch({ type: 'resume-current' })
      if (video.ended) video.currentTime = 0
      void video.play()
    } else {
      video.pause()
      dispatch({ type: 'pause' })
    }
  }

  return {
    clips: state.clips,
    activeClip,
    activeIndex: state.activeIndex,
    queuedCount,
    videoRef,
    isUserPaused: state.isUserPaused,
    isWaitingForNext: state.isWaitingForNext,
    enqueue,
    handleEnded: () => dispatch({ type: 'ended' }),
    handlePlay: () => dispatch({ type: 'play' }),
    handlePause: () => {
      if (!videoRef.current?.ended) dispatch({ type: 'pause' })
    },
    selectClip: (index: number) => dispatch({ type: 'select', index }),
    togglePlayback,
  }
}
