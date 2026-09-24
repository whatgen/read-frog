import { beforeEach, describe, expect, it } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"
import { storage } from "#imports"
import { SessionCache } from "../session-cache-group"
import { SessionCacheGroupRegistry } from "../session-cache-group-registry"
import { withStorageLock } from "../storage-lock"

const response = { status: 200, statusText: "OK", headers: [], body: "ok" }

describe("session cache concurrency", () => {
  beforeEach(() => {
    fakeBrowser.reset()
  })

  it("keeps every group registered concurrently", async () => {
    const groups = Array.from({ length: 10 }, (_, i) => `group-${i}`)
    await Promise.all(groups.map((group) => SessionCacheGroupRegistry.getCacheGroup(group)))

    expect((await SessionCacheGroupRegistry.getAllCacheGroup()).toSorted()).toEqual(
      groups.toSorted(),
    )
  })

  it("tracks every key written concurrently so clear removes them all", async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`)
    await Promise.all(urls.map((url) => new SessionCache("blog").set("GET", url, response as any)))

    const cache = new SessionCache("blog")
    await cache.clear()

    for (const url of urls) {
      expect(await storage.getItem(`session:cache_blog_GET_${url}`)).toBeNull()
    }
  })

  it("keeps serializing after a task fails", async () => {
    const order: string[] = []
    const failed = withStorageLock("k", async () => {
      order.push("a")
      throw new Error("boom")
    })
    const next = withStorageLock("k", async () => {
      order.push("b")
    })

    await expect(failed).rejects.toThrow("boom")
    await next
    expect(order).toEqual(["a", "b"])
  })
})
