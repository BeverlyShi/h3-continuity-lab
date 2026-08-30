import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import type { VideoClip, VideoProject } from '../types/video'

const FFMPEG_CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd'

const safeFileName = (name: string) =>
  name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'video'

const triggerDownload = (url: string, fileName: string) => {
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export const downloadClip = async (clip: VideoClip, index: number) => {
  if (!clip.videoUrl) throw new Error('这个片段没有可下载的视频地址。')
  const fileName = `片段-${index + 1}.mp4`

  try {
    const response = await fetch(clip.videoUrl)
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
    const blobUrl = URL.createObjectURL(await response.blob())
    triggerDownload(blobUrl, fileName)
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)
    return false
  } catch {
    const link = document.createElement('a')
    link.href = clip.videoUrl
    link.target = '_blank'
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    return true
  }
}

export const canExportProject = (project: VideoProject) =>
  project.clips.length > 0 &&
  project.clips.every((clip) =>
    ['ready', 'completed'].includes(clip.status) && Boolean(clip.videoUrl),
  )

export const getProjectExportDisabledReason = (project: VideoProject) => {
  if (project.clips.length === 0) return '项目中还没有视频片段。'
  if (project.clips.some((clip) => clip.status === 'queued' || clip.status === 'generating')) {
    return '请等待所有视频生成完成后再下载项目。'
  }
  if (project.clips.some((clip) => clip.status === 'failed')) {
    return '项目中存在生成失败的片段，暂时无法完整导出。'
  }
  if (project.clips.some((clip) => !clip.videoUrl)) return '部分片段缺少视频地址。'
  return ''
}

export const exportProject = async (
  project: VideoProject,
  onProgress: (progress: number) => void,
) => {
  if (!canExportProject(project)) {
    throw new Error(getProjectExportDisabledReason(project))
  }

  const ffmpeg = new FFmpeg()
  ffmpeg.on('progress', ({ progress }) => onProgress(Math.round(progress * 100)))
  try {
    onProgress(1)
    await ffmpeg.load({
      coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    })

    const inputs: string[] = []
    for (let index = 0; index < project.clips.length; index += 1) {
      const inputName = `input-${index}.mp4`
      inputs.push(inputName)
      await ffmpeg.writeFile(inputName, await fetchFile(project.clips[index].videoUrl!))
      onProgress(Math.max(2, Math.round(((index + 1) / project.clips.length) * 20)))
    }

    const concatFile = inputs.map((name) => `file '${name}'`).join('\n')
    await ffmpeg.writeFile('concat.txt', new TextEncoder().encode(concatFile))
    const exitCode = await ffmpeg.exec([
      '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
      '-c', 'copy', '-movflags', '+faststart', 'output.mp4',
    ])
    if (exitCode !== 0) throw new Error('视频合并失败，请确认所有片段格式一致后重试。')

    const output = await ffmpeg.readFile('output.mp4')
    if (typeof output === 'string') throw new Error('视频合并结果格式异常，请重试。')
    const blob = new Blob([new Uint8Array(output).buffer], { type: 'video/mp4' })
    const blobUrl = URL.createObjectURL(blob)
    triggerDownload(blobUrl, `${safeFileName(project.name)}.mp4`)
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)
    onProgress(100)
  } finally {
    ffmpeg.terminate()
  }
}
