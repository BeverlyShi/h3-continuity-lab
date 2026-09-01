const waitForVideoEvent = (video: HTMLVideoElement, eventName: 'loadedmetadata' | 'seeked') =>
  new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(eventName, handleEvent)
      video.removeEventListener('error', handleError)
    }
    const handleEvent = () => {
      cleanup()
      resolve()
    }
    const handleError = () => {
      cleanup()
      reject(new Error('无法读取生成视频以提取尾帧'))
    }
    video.addEventListener(eventName, handleEvent, { once: true })
    video.addEventListener('error', handleError, { once: true })
  })

const canvasToFile = (canvas: HTMLCanvasElement) => new Promise<File>((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (!blob) {
      reject(new Error('浏览器无法编码视频尾帧'))
      return
    }
    resolve(new File([blob], 'video-tail-frame.jpg', { type: 'image/jpeg' }))
  }, 'image/jpeg', 0.94)
})

export const extractVideoTailFrame = async (videoUrl: string) => {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.src = videoUrl

  try {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      video.load()
      await waitForVideoEvent(video, 'loadedmetadata')
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
      throw new Error('生成视频缺少可用的时长或画面尺寸')
    }

    video.currentTime = Math.max(0, video.duration - 0.05)
    await waitForVideoEvent(video, 'seeked')

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法创建尾帧画布')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return await canvasToFile(canvas)
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
