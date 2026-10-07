import type { StoredLlmReviewSettings } from './llm-review-settings-store'

type ReviewCredentials = Pick<StoredLlmReviewSettings, 'apiKey' | 'proxyUsername' | 'proxyPassword'>

function credentialVariants(settings: ReviewCredentials): string[] {
  const variants = new Set<string>()
  for (const secret of [settings.apiKey, settings.proxyPassword]) {
    if (typeof secret !== 'string') continue
    for (const value of [secret, secret.trim()]) {
      if (!value) continue
      variants.add(value)
      variants.add(Buffer.from(value, 'utf8').toString('base64'))
      try { variants.add(encodeURIComponent(value)) } catch { /* Raw matching still protects invalid Unicode. */ }
    }
  }
  if (settings.proxyUsername && settings.proxyPassword) {
    for (const password of [settings.proxyPassword, settings.proxyPassword.trim()]) {
      variants.add(Buffer.from(`${settings.proxyUsername}:${password}`, 'utf8').toString('base64'))
    }
  }
  return [...variants]
}

/** Sanitizes nonsecret labels too: a remote provider can put a credential in its model/name. */
export function redactLlmCredentialText(value: string, settings: ReviewCredentials): string {
  let result = value
  for (const secret of credentialVariants(settings).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[受保护凭据]')
  return result
}

/** Call after JSON.parse, before publishing any API review/audit fields. */
export function assertLlmResponseHasNoCredentials(value: unknown, settings: ReviewCredentials): void {
  const secrets = credentialVariants(settings)
  if (!secrets.length) return
  const pending: unknown[] = [value]
  const visited = new Set<object>()
  const checkText = (text: string): void => {
    if (secrets.some(secret => text.includes(secret))) {
      throw new Error('模型响应包含受保护凭据，已拒绝显示')
    }
  }
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string') checkText(current)
    else if (current && typeof current === 'object' && !visited.has(current)) {
      visited.add(current)
      for (const [key, child] of Object.entries(current)) {
        checkText(key)
        pending.push(child)
      }
    }
  }
}
