export const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(new Error('无法读取图片。'))
  reader.readAsDataURL(blob)
})

// 尾帧与参考图可能是 data URL、blob: 或 fal 的公开地址，交给服务端前统一转成 data:image/ 内联图片。
export const toImageDataUrl = async (url: string) => {
  if (url.startsWith('data:image/')) return url
  const response = await fetch(url)
  if (!response.ok) throw new Error('无法读取图片。')
  const dataUrl = await blobToDataUrl(await response.blob())
  if (!dataUrl.startsWith('data:image/')) throw new Error('图片格式无法识别。')
  return dataUrl
}
