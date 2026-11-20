// Shapes of credentials that are not saved keys: provider keys, bearer tokens, and
// token or key parameters in addresses (the Web login address carries one).
const CREDENTIALS = [
  [/\bsk-[A-Za-z0-9_*.-]{6,}/g, 'sk-[hidden]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[hidden]'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[hidden]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[hidden]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[hidden]'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, '[hidden]'],
  // JSON web tokens: three base64url parts, the first always starting eyJ.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[hidden]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=*-]{8,}/gi, '$1 [hidden]'],
  [/([?&#](?:token|access_token|api_key|apikey|key|secret|password)=)[^&\s"']+/gi, '$1[hidden]'],
  [/(["']?(?:api[_-]?key|authorization|x-api-key|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1[hidden]'],
]

export function redactCredentials(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement)
  return out
}
