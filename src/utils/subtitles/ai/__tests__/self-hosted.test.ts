// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"

const sendMessage = vi.fn<(type: string, data: { url: string }) => Promise<unknown>>()
const getSession = vi.fn<() => Promise<unknown>>()
const getUsage = vi.fn<() => Promise<unknown>>()

vi.mock("@/utils/message", () => ({
  sendMessage: (...args: [string, { url: string }]) => sendMessage(...args),
}))
vi.mock("@/env", () => ({ env: { WXT_WEBSITE_URL: "https://readfrog.app" } }))
vi.mock("@/utils/auth/auth-client", () => ({ authClient: { getSession: () => getSession() } }))
vi.mock("@/utils/orpc/client", () => ({
  orpcClient: { videoTranscript: { getUsage: () => getUsage() } },
}))
vi.mock("@/utils/subtitles/toast", () => ({ showAiSubtitlesWallToast: vi.fn<() => void>() }))

function health(service = "readfrog-transcript-server") {
  return { status: 200, statusText: "OK", headers: [], body: JSON.stringify({ ok: true, service }) }
}

async function load() {
  vi.resetModules()
  const selfHosted = await import("../self-hosted")
  const guard = await import("../access-guard")
  return { ...selfHosted, ...guard }
}

describe("self-hosted AI subtitles server", () => {
  beforeEach(() => {
    fakeBrowser.reset()
    sendMessage.mockReset()
    getSession.mockReset()
    getUsage.mockReset()
  })

  it("never reroutes anything but videoTranscript calls", async () => {
    const { resolveApiUrl, selfHostedTranscriptUrlItem } = await load()
    await selfHostedTranscriptUrlItem.setValue("http://10.0.0.2:12018")

    expect(await resolveApiUrl(["notebase", "list"], "https://api.readfrog.app")).toBe(
      "https://api.readfrog.app",
    )
    expect(await resolveApiUrl(["hostedAi", "status"], "https://api.readfrog.app")).toBe(
      "https://api.readfrog.app",
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("sends videoTranscript calls to a configured server", async () => {
    const { resolveApiUrl, selfHostedTranscriptUrlItem } = await load()
    await selfHostedTranscriptUrlItem.setValue(" http://10.0.0.2:12018/ ")

    expect(await resolveApiUrl(["videoTranscript", "create"], "https://api.readfrog.app")).toBe(
      "http://10.0.0.2:12018",
    )
  })

  it("detects the local server and probes at most once per window", async () => {
    const { resolveApiUrl } = await load()
    sendMessage.mockResolvedValue(health())

    expect(await resolveApiUrl(["videoTranscript", "get"], "https://api.readfrog.app")).toBe(
      "http://localhost:12018",
    )
    expect(await resolveApiUrl(["videoTranscript", "get"], "https://api.readfrog.app")).toBe(
      "http://localhost:12018",
    )
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]![1].url).toBe("http://localhost:12018/health")
  })

  it("falls back to Read Frog when nothing, or something else, answers", async () => {
    let { resolveApiUrl } = await load()
    sendMessage.mockRejectedValueOnce(new Error("Failed to fetch"))
    expect(await resolveApiUrl(["videoTranscript", "create"], "https://api.readfrog.app")).toBe(
      "https://api.readfrog.app",
    )
    ;({ resolveApiUrl } = await load())
    sendMessage.mockResolvedValueOnce(health("some-other-app"))
    expect(await resolveApiUrl(["videoTranscript", "create"], "https://api.readfrog.app")).toBe(
      "https://api.readfrog.app",
    )
  })

  it("does not ask for a Read Frog sign-in when a self-hosted server is used", async () => {
    const { ensureAiSubtitlesAccess } = await load()
    sendMessage.mockResolvedValue(health())
    getUsage.mockResolvedValue({
      usedMinutes: 0,
      limitMinutes: 100_000,
      remainingMinutes: 100_000,
      plan: "ultra",
      pools: [],
    })

    expect(await ensureAiSubtitlesAccess()).toBe(true)
    expect(getSession).not.toHaveBeenCalled()
  })

  it("still requires a sign-in for Read Frog's own service", async () => {
    const { ensureAiSubtitlesAccess } = await load()
    sendMessage.mockRejectedValue(new Error("Failed to fetch"))
    getSession.mockResolvedValue({ data: null })

    expect(await ensureAiSubtitlesAccess()).toBe(false)
    expect(getSession).toHaveBeenCalledTimes(1)
  })
})
