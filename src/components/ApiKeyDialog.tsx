import { KeyRound, LockKeyhole, Trash2, X } from 'lucide-react'
import { FormEvent, useState } from 'react'
import { clearLocalMedia } from '../services/localData'

export type ApiKeys = {
  falApiKey: string
  comfyApiKey: string
  openRouterApiKey: string
  deepSeekApiKey: string
  bigModelApiKey: string
}

type ApiKeyDialogProps = {
  savedFalApiKey: string
  savedComfyApiKey: string
  savedOpenRouterApiKey: string
  savedDeepSeekApiKey: string
  savedBigModelApiKey: string
  onClose: () => void
  onSave: (keys: ApiKeys) => void
  onClear: () => void
}

export function ApiKeyDialog({
  savedFalApiKey,
  savedComfyApiKey,
  savedOpenRouterApiKey,
  savedDeepSeekApiKey,
  savedBigModelApiKey,
  onClose,
  onSave,
  onClear,
}: ApiKeyDialogProps) {
  const [falApiKey, setFalApiKey] = useState(savedFalApiKey)
  const [comfyApiKey, setComfyApiKey] = useState(savedComfyApiKey)
  const [openRouterApiKey, setOpenRouterApiKey] = useState(savedOpenRouterApiKey)
  const [deepSeekApiKey, setDeepSeekApiKey] = useState(savedDeepSeekApiKey)
  const [bigModelApiKey, setBigModelApiKey] = useState(savedBigModelApiKey)
  const [clearing, setClearing] = useState(false)

  const clearMedia = async () => {
    if (clearing || !window.confirm('确定清理本地视频与存档吗？此操作无法撤销。')) return
    setClearing(true)
    try {
      await clearLocalMedia()
      location.reload()
    } finally {
      setClearing(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave({
      falApiKey: falApiKey.trim(),
      comfyApiKey: comfyApiKey.trim(),
      openRouterApiKey: openRouterApiKey.trim(),
      deepSeekApiKey: deepSeekApiKey.trim(),
      bigModelApiKey: bigModelApiKey.trim(),
    })
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="api-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div className="dialog-icon"><KeyRound size={18} /></div>
          <div><h2 id="api-title">API 连接设置</h2><p>导演模型至少填一个（DeepSeek / OpenRouter / 智谱），DeepSeek 还负责尾帧识别；视频生成填 fal 或 Comfy 其一</p></div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="fal-api-key">fal API Key（仅 API 生成需要）</label>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input
              id="fal-api-key"
              type="password"
              value={falApiKey}
              onChange={(event) => setFalApiKey(event.target.value)}
              placeholder="粘贴你的 fal API Key"
              autoComplete="off"
              autoFocus
            />
          </div>
          <label htmlFor="comfy-api-key">Comfy API Key（仅 ComfyUI 生成需要）</label>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input
              id="comfy-api-key"
              type="password"
              value={comfyApiKey}
              onChange={(event) => setComfyApiKey(event.target.value)}
              placeholder="粘贴 platform.comfy.org 生成的 comfyui- 开头的 Key"
              autoComplete="off"
            />
          </div>
          <label htmlFor="openrouter-api-key">OpenRouter API Key</label>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input
              id="openrouter-api-key"
              type="password"
              value={openRouterApiKey}
              onChange={(event) => setOpenRouterApiKey(event.target.value)}
              placeholder="粘贴你的 OpenRouter API Key"
              autoComplete="off"
            />
          </div>
          <label htmlFor="deepseek-api-key">DeepSeek API Key</label>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input
              id="deepseek-api-key"
              type="password"
              value={deepSeekApiKey}
              onChange={(event) => setDeepSeekApiKey(event.target.value)}
              placeholder="粘贴你的 DeepSeek API Key"
              autoComplete="off"
            />
          </div>
          <label htmlFor="bigmodel-api-key">智谱 BigModel API Key（GLM）</label>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input
              id="bigmodel-api-key"
              type="password"
              value={bigModelApiKey}
              onChange={(event) => setBigModelApiKey(event.target.value)}
              placeholder="粘贴智谱 BigModel 通用 API Key"
              autoComplete="off"
            />
          </div>
          <div className="dialog-section">
            <strong>本地数据</strong>
            <p>删除游戏存档、导演会话历史和本地保存的视频；保留 API Key、模型设置和演员库。</p>
            <button className="button button-secondary" type="button" disabled={clearing} onClick={() => { void clearMedia() }}>
              <Trash2 size={15} />{clearing ? '清理中…' : '清理本地视频与存档'}
            </button>
          </div>
          <div className="security-note">Key 只明文保存在当前浏览器的 localStorage，本站不保存。模型与 fal 请求由浏览器直连对应厂商；Comfy 请求经本站同源转发，转发时不存储、不记录 Key。建议使用单独设了额度上限的 Key，公用电脑用完请点「清除 Keys」。</div>
          <div className="dialog-actions">
            {(savedFalApiKey || savedComfyApiKey || savedOpenRouterApiKey || savedDeepSeekApiKey || savedBigModelApiKey) && <button className="button button-danger" type="button" onClick={onClear}>清除 Keys</button>}
            <button className="button button-ghost" type="button" onClick={onClose}>取消</button>
            <button className="button button-primary" type="submit" disabled={!falApiKey.trim() && !comfyApiKey.trim() && !openRouterApiKey.trim() && !deepSeekApiKey.trim() && !bigModelApiKey.trim()}>保存设置</button>
          </div>
        </form>
      </div>
    </div>
  )
}
