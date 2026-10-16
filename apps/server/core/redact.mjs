/** Best-effort prompt hygiene; path policy still excludes credential/config files. */
export function redactSecrets(value){
 return String(value)
  .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/g,'[REDACTED KEY MATERIAL]')
  .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,'[REDACTED AWS ID]')
  .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,'[REDACTED TOKEN]')
  .replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi,'$1[REDACTED]$3')
  .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[REDACTED]@');
}
