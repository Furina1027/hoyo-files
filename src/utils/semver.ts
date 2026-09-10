export function parseSemver(v: string): number[] {
  return v.split('.').map(n => Number.parseInt(n, 10))
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0)
      return diff
  }
  return 0
}

export function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareSemver)
}
