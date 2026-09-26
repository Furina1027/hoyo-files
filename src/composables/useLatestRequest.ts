/**
 * 只认最后一次请求。
 *
 * 页面里大量模式是"watch 到变化就发请求, 回来直接写状态":
 *
 *   const list = await fetchFileList(...)
 *   mainFileList.value = list
 *
 * 请求返回顺序不保证 —— 快速切游戏/切版本时, 先发的请求可能后到, 于是把
 * 旧数据写进新界面。这类 bug 不报错、不空白, 只是"显示的是别的版本的文件",
 * 排查起来极难。
 *
 * 两种用法:
 *
 *   const latest = useLatestRequest()
 *   const data = await latest.run(() => fetchFileList(...))
 *   if (!data) return          // run 内部已丢弃过期结果
 *
 *   // 需要自己控制时序时:
 *   const token = latest.begin()
 *   const data = await fetch(...)
 *   if (!latest.isCurrent(token)) return
 *
 * run() 同时会 abort 上一次未完成的 signal(如果调用方传了 signal 参数)。
 */
export function useLatestRequest() {
  let seq = 0
  let controller: AbortController | null = null

  function begin(): number {
    seq++
    return seq
  }

  function isCurrent(token: number): boolean {
    return token === seq
  }

  function abort(): void {
    controller?.abort()
    controller = null
  }

  /**
   * @param task 接收 signal; 返回值原样透出
   * @returns 过期时返回 undefined (调用方应直接 return, 不要写状态)
   */
  async function run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    abort()
    controller = new AbortController()
    const { signal } = controller
    const token = begin()
    try {
      const result = await task(signal)
      if (!isCurrent(token))
        return undefined
      return result
    }
    finally {
      if (isCurrent(token))
        controller = null
    }
  }

  return { run, begin, isCurrent, abort }
}
