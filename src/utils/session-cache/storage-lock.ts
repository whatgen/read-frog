const tails = new Map<string, Promise<unknown>>()

/**
 * Serializes read-modify-write sequences on one storage key within this context.
 * All cache registry and key-list writers live in the background, so an in-memory
 * queue per key is enough to stop concurrent updates from overwriting each other.
 */
export function withStorageLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  const result = previous.then(task, task)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return result
}
