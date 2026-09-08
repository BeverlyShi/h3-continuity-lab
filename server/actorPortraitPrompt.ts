// 演员新建时由程序拼出的生图 prompt：模型只写人物外观，构图、背景和光线固定。
export const buildActorImagePrompt = (actor: {
  name: string
  gender: 'female' | 'male'
  minAge: number
  maxAge: number
  appearance: string
}) => {
  const genderLabel = actor.gender === 'female' ? '女' : '男'
  return '一张 16:9 横向的人物三视图设定图，纯白背景，无任何文字、边框和杂物。'
    + '同一人物的正面、侧面、背面全身像并排站立，占满画面高度，均匀柔和的摄影棚光线，无投影。写实中国古装风格。'
    + `人物：${genderLabel}，${actor.minAge}–${actor.maxAge} 岁，${actor.appearance}。`
    + '三张视图中的脸型、发型、服饰、身材必须完全一致。'
}
