import { useEffect, useMemo, useRef, useState } from 'react'
import { mockVideoGenerator } from '../services/mockVideoGenerator'
import {
  MAX_VIDEO_DURATION,
  MIN_VIDEO_DURATION,
  type VideoClip,
  type VideoGenerator,
} from '../types/video'

const isPlayable = (clip?: VideoClip) =>
  Boolean(clip && ['ready', 'playing', 'completed'].includes(clip.status))

type UseVideoQueueOptions = {
  projectId?: string
  clips: VideoClip[]
  generator?: VideoGenerator
  addClip: (projectId: string, clip: VideoClip) => void
  updateClip: (projectId: string, clipId: string, patch: Partial<VideoClip>) => void
}

export function useVideoQueue({
  projectId,
  clips,
  generator = mockVideoGenerator,
  addClip,
  updateClip,
}: UseVideoQueueOptions) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [isUserPaused, setIsUserPaused] = useState(false)
  const [isWaitingForNext, setIsWaitingForNext] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const activeClip = clips[activeIndex]
  const queuedCount = useMemo(
    () => clips.filter((clip) => clip.status === 'queued' || clip.status === 'generating').length,
    [clips],
  )

  useEffect(() => {
    const firstPlayable = clips.findIndex(isPlayable)
    // A project switch is a navigation event; reset player-local state to that workspace.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIndex(firstPlayable >= 0 ? firstPlayable : 0)
    setIsUserPaused(false)
    setIsWaitingForNext(false)
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeClip || activeClip.status !== 'ready' || !videoRef.current) return
    videoRef.current.load()
    if (!isUserPaused) {
      void videoRef.current.play().catch(() => setIsUserPaused(true))
    }
  }, [activeClip?.id, activeClip?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isWaitingForNext || isUserPaused) return
    const nextClip = clips[activeIndex + 1]
    if (isPlayable(nextClip)) {
      // Readiness is delivered asynchronously by the generator and resumes the waiting player.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveIndex((index) => index + 1)
      setIsWaitingForNext(false)
    }
  }, [activeIndex, clips, isUserPaused, isWaitingForNext])

  const enqueue = (prompt: string, duration: number) => {
    if (
      !projectId ||
      !Number.isInteger(duration) ||
      duration < MIN_VIDEO_DURATION ||
      duration > MAX_VIDEO_DURATION
    ) return

    const targetProjectId = projectId
    const sequence = clips.length
    const id = crypto.randomUUID()
    addClip(targetProjectId, { id, prompt, duration, status: 'queued' })

    Promise.resolve().then(() => {
      updateClip(targetProjectId, id, { status: 'generating' })
    })

    void generator
      .generate(prompt, duration, sequence)
      .then((result) => updateClip(targetProjectId, id, { ...result, status: 'ready' }))
      .catch((error: unknown) => {
        updateClip(targetProjectId, id, {
          status: 'failed',
          error: error instanceof Error ? error.message : '视频生成失败',
        })
      })
  }

  const handleEnded = () => {
    if (!projectId || !activeClip) return
    updateClip(projectId, activeClip.id, { status: 'completed' })
    const nextClip = clips[activeIndex + 1]
    if (isPlayable(nextClip)) {
      setActiveIndex((index) => index + 1)
      setIsWaitingForNext(false)
    } else {
      setIsWaitingForNext(true)
    }
  }

  const togglePlayback = () => {
    const video = videoRef.current
    if (!video || !activeClip || !isPlayable(activeClip)) return

    if (video.paused) {
      setIsUserPaused(false)
      setIsWaitingForNext(false)
      if (video.ended) video.currentTime = 0
      void video.play()
    } else {
      video.pause()
      setIsUserPaused(true)
    }
  }

  return {
    clips,
    activeClip,
    activeIndex,
    queuedCount,
    videoRef,
    isUserPaused,
    isWaitingForNext,
    enqueue,
    handleEnded,
    handlePlay: () => setIsUserPaused(false),
    handlePause: () => {
      if (!videoRef.current?.ended) setIsUserPaused(true)
    },
    selectClip: (index: number) => {
      const selectedClip = clips[index]
      if (!isPlayable(selectedClip)) return
      if (projectId && selectedClip.status === 'completed') {
        updateClip(projectId, selectedClip.id, { status: 'ready' })
      }
      setActiveIndex(index)
      setIsUserPaused(false)
      setIsWaitingForNext(false)
    },
    togglePlayback,
  }
}
