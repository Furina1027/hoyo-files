export function highlightText(text: string, query: string): string {
  const q = query.trim()
  if (!q)
    return escapeHtml(text)

  const lowerText = text.toLowerCase()
  const lowerQuery = q.toLowerCase()
  const parts: string[] = []
  let lastIdx = 0
  let idx = lowerText.indexOf(lowerQuery, lastIdx)

  while (idx !== -1) {
    if (idx > lastIdx)
      parts.push(escapeHtml(text.slice(lastIdx, idx)))
    parts.push(`<mark class="search-highlight">${escapeHtml(text.slice(idx, idx + q.length))}</mark>`)
    lastIdx = idx + q.length
    idx = lowerText.indexOf(lowerQuery, lastIdx)
  }

  if (lastIdx < text.length)
    parts.push(escapeHtml(text.slice(lastIdx)))

  return parts.join('')
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes < 0)
    return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx++
  }
  return `${value.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`
}
