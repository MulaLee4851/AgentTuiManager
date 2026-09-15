/** Only accept DSH's local root URL, optionally carrying its bootstrap token. */
export function deepSeekWebUrl(value: string | undefined): string | undefined {
  if (!value || !/^http:\/\/127\.0\.0\.1:\d+(?:\/)?(?:\?token=[A-Za-z0-9_-]+)?$/.test(value)) return undefined
  try {
    const url = new URL(value)
    if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535) return undefined
    return value
  } catch { return undefined }
}
