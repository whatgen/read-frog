import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  cookies: { getAll: vi.fn<(...args: any[]) => any>(), set: vi.fn<(...args: any[]) => any>() },
  runtime: { sendNativeMessage: vi.fn<(...args: any[]) => any>() },
}))
vi.mock("#imports", () => ({ browser: mocks }))
vi.mock("wxt/browser", () => ({ browser: mocks }))
import { isNativeAccountURL, safariNativeFetch } from "../safari-native-fetch"
const url = "https://api.readfrog.app/api/identity/get-session"
const cookie = {
  name: "__Secure-better-auth.session_token",
  value: "session-a",
  storeId: "current",
}
const result = {
  status: 200,
  headers: [["content-type", "application/json"]],
  body: btoa('{"user":{"id":"test"}}'),
  cookies: [],
}
const request = (init: RequestInit = {}) => new Request(url, { credentials: "include", ...init })
describe("Safari native account transport", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.cookies.getAll.mockResolvedValue([cookie])
    mocks.runtime.sendNativeMessage.mockResolvedValue(result)
    vi.stubGlobal("fetch", vi.fn<(...args: any[]) => any>().mockResolvedValue(new Response("null")))
  })
  afterEach(() => vi.unstubAllGlobals())

  it("restores the authenticated session from current Safari cookies without a tab or saved token", async () => {
    expect(await (await safariNativeFetch(request())).json()).toEqual({ user: { id: "test" } })
    expect(mocks.cookies.getAll).toHaveBeenCalledWith({ url })
    expect(mocks.runtime.sendNativeMessage.mock.calls[0]![1]).toMatchObject({
      url,
      cookies: [{ name: cookie.name, value: cookie.value }],
      type: "read-frog-account-fetch",
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  it("reads fresh cookies on each request, including after sign-out", async () => {
    await safariNativeFetch(request())
    mocks.cookies.getAll.mockResolvedValue([])
    expect(await (await safariNativeFetch(request())).json()).toBeNull()
    expect(mocks.runtime.sendNativeMessage).toHaveBeenCalledOnce()
  })
  it("never forwards unrelated or expired cookies", async () => {
    mocks.cookies.getAll.mockResolvedValue([
      { name: "analytics", value: "private" },
      { ...cookie, expirationDate: 1 },
      { ...cookie, name: "better-auth.session_token.evil" },
    ])
    await safariNativeFetch(request())
    expect(mocks.runtime.sendNativeMessage).not.toHaveBeenCalled()
  })
  it("refuses third-party, insecure and lookalike account URLs", async () => {
    for (const target of [
      "https://api.readfrog.app.evil.test/api/identity/get-session",
      "http://api.readfrog.app/api/identity/get-session",
      "https://api.readfrog.app/api/identity-other/x",
      "https://api.readfrog.app:444/api/rpc/x",
    ]) {
      expect(isNativeAccountURL(target)).toBe(false)
      await expect(safariNativeFetch(new Request(target))).rejects.toThrow("destination")
    }
    expect(isNativeAccountURL("https://user@api.readfrog.app/api/rpc/x")).toBe(false)
    expect(mocks.cookies.getAll).not.toHaveBeenCalled()
  })
  it("applies session renewal and deletion to the original Safari store", async () => {
    const update = {
      ...cookie,
      domain: ".readfrog.app",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 1,
      value: "",
    }
    mocks.runtime.sendNativeMessage.mockResolvedValue({ ...result, cookies: [update] })
    await safariNativeFetch(request())
    expect(mocks.cookies.set).toHaveBeenCalledWith({ ...update, url: "https://api.readfrog.app/" })
  })
  it("does not restore an account that signed out while a read was in flight", async () => {
    mocks.cookies.getAll.mockResolvedValueOnce([cookie]).mockResolvedValueOnce([])
    mocks.runtime.sendNativeMessage.mockResolvedValue({
      ...result,
      cookies: [{ ...cookie, domain: ".readfrog.app", path: "/" }],
    })
    await safariNativeFetch(request())
    expect(mocks.cookies.set).not.toHaveBeenCalled()
  })
  it("reports native errors instead of converting them into a guest session or retrying a mutation", async () => {
    mocks.runtime.sendNativeMessage.mockResolvedValue({ error: "network unavailable" })
    await expect(safariNativeFetch(request({ method: "POST", body: "payload" }))).rejects.toThrow(
      "network unavailable",
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.runtime.sendNativeMessage).toHaveBeenCalledOnce()
  })
  it("cancels a pending native request and does not write cookies afterward", async () => {
    mocks.runtime.sendNativeMessage.mockReturnValue(new Promise(() => {}))
    const abort = new AbortController()
    const pending = safariNativeFetch(request({ signal: abort.signal })).catch((e) => e)
    await vi.waitFor(() => expect(mocks.runtime.sendNativeMessage).toHaveBeenCalledOnce())
    abort.abort()
    expect(await pending).toMatchObject({ name: "AbortError" })
    expect(mocks.runtime.sendNativeMessage.mock.calls[1]![1]).toMatchObject({
      type: "read-frog-account-cancel",
      id: mocks.runtime.sendNativeMessage.mock.calls[0]![1].id,
    })
    expect(mocks.cookies.set).not.toHaveBeenCalled()
  })
})
