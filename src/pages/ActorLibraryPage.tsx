import { ClipboardCopy, ImagePlus, LoaderCircle, Plus, Sparkles, Trash2, Upload, UserRound, X } from 'lucide-react'
import { useState, type ChangeEvent, type FormEvent } from 'react'
import { portraitPromptFor, type ActorPortraits } from '../hooks/useActorPortraits'
import type { Actor, ActorDraft, ActorGender } from '../types/actor'

type ActorLibraryPageProps = {
  actors: Actor[]
  loading: boolean
  error: string
  onAdd: (draft: ActorDraft) => Promise<Actor>
  onRemove: (actorId: string) => Promise<void>
  onSetImage: (actorId: string, referenceImageUrl: string) => Promise<void>
  portraits: Pick<ActorPortraits, 'generatePortrait' | 'generatingIds' | 'canGenerate'>
}

const readImage = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(new Error('无法读取图片'))
  reader.readAsDataURL(file)
})

export function ActorLibraryPage({ actors, loading, error, onAdd, onRemove, onSetImage, portraits }: ActorLibraryPageProps) {
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [gender, setGender] = useState<ActorGender>('female')
  const [minAge, setMinAge] = useState(15)
  const [maxAge, setMaxAge] = useState(25)
  const [appearance, setAppearance] = useState('')
  const [referenceImageUrl, setReferenceImageUrl] = useState('')
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [cardError, setCardError] = useState('')
  const [copiedActorId, setCopiedActorId] = useState('')

  const closeForm = () => {
    setFormOpen(false)
    setName('')
    setGender('female')
    setMinAge(15)
    setMaxAge(25)
    setAppearance('')
    setReferenceImageUrl('')
    setFormError('')
  }

  const uploadImage = async (actorId: string, event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target
    const file = input.files?.[0]
    if (!file) return
    try {
      await onSetImage(actorId, await readImage(file))
      setCardError('')
    } catch (reason) {
      setCardError(reason instanceof Error ? reason.message : '无法保存图片')
    } finally {
      input.value = ''
    }
  }

  const copyPrompt = async (actor: Actor) => {
    try {
      await navigator.clipboard.writeText(portraitPromptFor(actor) ?? '')
      setCopiedActorId(actor.id)
      setTimeout(() => { setCopiedActorId((current) => (current === actor.id ? '' : current)) }, 2000)
    } catch (reason) {
      setCardError(reason instanceof Error ? reason.message : '无法复制 prompt')
    }
  }

  const chooseImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const image = await readImage(file)
      setReferenceImageUrl(image)
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : '无法读取图片')
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const cleanName = name.trim()
    if (!cleanName) {
      setFormError('请填写演员姓名')
      return
    }
    if (minAge > maxAge) {
      setFormError('最小年龄不能大于最大年龄')
      return
    }
    if (!referenceImageUrl) {
      setFormError('请上传一张包含三视图的合成图')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      await onAdd({ name: cleanName, gender, minAge, maxAge, referenceImageUrl, ...(appearance.trim() ? { appearance: appearance.trim() } : {}) })
      closeForm()
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : '保存演员失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="actor-workspace">
      <section className="actor-heading">
        <div>
          <span className="actor-eyebrow"><UserRound size={14} />角色参考演员</span>
          <h1>演员库</h1>
          <p>上传一张 16:9、纯白背景的人物三视图；导演在库中找不到合适演员时会新建演员，ComfyUI 模式下自动生成三视图。</p>
        </div>
        <button className="button button-primary" onClick={() => setFormOpen(true)}>
          <Plus size={15} />新增演员
        </button>
      </section>

      {(error || cardError) && <div className="actor-notice error">{error || cardError}</div>}
      {loading ? (
        <div className="actor-empty">正在读取演员库…</div>
      ) : actors.length === 0 ? (
        <div className="actor-empty">
          <UserRound size={30} />
          <strong>还没有演员</strong>
          <span>新增演员后，游戏会按性别和年龄区间自动匹配。</span>
        </div>
      ) : (
        <section className="actor-grid" aria-label="演员列表">
          {actors.map((actor) => {
            const generating = portraits.generatingIds.has(actor.id)
            const portraitPrompt = portraitPromptFor(actor)
            return (
            <article className="actor-card" key={actor.id}>
              <div className="actor-card-image">
                {actor.referenceImageUrl ? (
                  <>
                    <img src={actor.referenceImageUrl} alt={`${actor.name}三视图`} />
                    <span>{generating ? '重新生成中…' : '三视图'}</span>
                  </>
                ) : generating ? (
                  <div className="actor-card-pending"><LoaderCircle size={26} className="spin" />正在生成参考图…</div>
                ) : (
                  <div className="actor-card-pending"><UserRound size={26} />待生成参考图</div>
                )}
              </div>
              <div className="actor-card-info">
                <div>
                  <h2>{actor.name}</h2>
                  <p>{actor.gender === 'female' ? '女' : '男'} · {actor.minAge}～{actor.maxAge} 岁</p>
                  {actor.appearance && <p className="actor-card-appearance">{actor.appearance}</p>}
                </div>
                <button
                  type="button"
                  aria-label={`删除演员 ${actor.name}`}
                  title="删除演员"
                  onClick={() => { void onRemove(actor.id) }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {actor.portraitError && !generating && (
                <p className="actor-card-error" role="alert">参考图生成失败：{actor.portraitError}</p>
              )}
              <div className="actor-card-actions">
                {portraits.canGenerate && portraitPrompt && (
                  <button
                    type="button"
                    disabled={generating}
                    title="用 ComfyUI（GPT Image 2）生成 16:9 三视图，约 $0.05 一张"
                    onClick={() => { void portraits.generatePortrait(actor.id, { force: true }) }}
                  >
                    <Sparkles size={13} />{generating ? '生成中…' : actor.portraitError ? '重试生成' : actor.referenceImageUrl ? '重新生成' : 'ComfyUI 生成'}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!portraitPrompt}
                  title={portraitPrompt ?? '该演员没有生图 prompt'}
                  onClick={() => { void copyPrompt(actor) }}
                >
                  <ClipboardCopy size={13} />{copiedActorId === actor.id ? '已复制' : '复制 prompt'}
                </button>
                <label>
                  <Upload size={13} />{actor.referenceImageUrl ? '更换图片' : '上传三视图'}
                  <input type="file" accept="image/*" onChange={(event) => { void uploadImage(actor.id, event) }} />
                </label>
              </div>
            </article>
            )
          })}
        </section>
      )}

      {formOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeForm()
        }}>
          <section className="dialog actor-dialog" role="dialog" aria-modal="true" aria-label="新增演员">
            <div className="dialog-heading">
              <div><h2>新增演员</h2><p>请上传一张在同一画布中清晰展示该演员三视图的图片。</p></div>
              <button className="dialog-close" type="button" aria-label="关闭" onClick={closeForm}><X size={16} /></button>
            </div>
            <form onSubmit={submit}>
              <div className="actor-form-grid">
                <label>姓名<input value={name} maxLength={30} onChange={(event) => setName(event.target.value)} /></label>
                <label>性别<select value={gender} onChange={(event) => setGender(event.target.value as ActorGender)}><option value="female">女</option><option value="male">男</option></select></label>
                <label>最小年龄<input type="number" min="0" max="100" value={minAge} onChange={(event) => setMinAge(Number(event.target.value))} /></label>
                <label>最大年龄<input type="number" min="0" max="100" value={maxAge} onChange={(event) => setMaxAge(Number(event.target.value))} /></label>
              </div>
              <label className="actor-form-appearance">
                外观描述（可选）
                <textarea
                  value={appearance}
                  maxLength={300}
                  rows={3}
                  placeholder="年龄、脸型、发式、服饰、标志物、气质"
                  onChange={(event) => setAppearance(event.target.value)}
                />
              </label>
              <label className="actor-upload">
                {referenceImageUrl ? <img src={referenceImageUrl} alt="三视图预览" /> : <ImagePlus size={22} />}
                <span>{referenceImageUrl ? '更换三视图' : '上传三视图合成图'}</span>
                <input type="file" accept="image/*" onChange={(event) => { void chooseImage(event) }} />
              </label>
              {formError && <p className="dialog-error">{formError}</p>}
              <div className="dialog-actions">
                <button className="button button-secondary" type="button" onClick={closeForm}>取消</button>
                <button className="button button-primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存演员'}</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  )
}
