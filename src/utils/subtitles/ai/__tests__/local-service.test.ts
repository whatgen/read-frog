import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"

const sendMessageMock = vi.fn<(type: string, data: any) => Promise<any>>()
vi.mock("@/utils/message", () => ({ sendMessage: sendMessageMock }))

const {
  checkLocalSubtitlesService,
  getLocalSubtitlesServiceUrl,
  localSubtitlesApiKeyItem,
  localSubtitlesServiceUrlItem,
  normalizeSegments,
  requestLocalAiSubtitles,
} = await import("../local-service")

function reply(status: number, body: unknown = {}) {
  return { status, statusText: "", headers: [], body: JSON.stringify(body) }
}

const ctx = {
  videoId: "jNQXAC9IVRw",
  url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  durationSec: 19,
}

describe("local AI subtitles", () => {
  beforeEach(() => {
    fakeBrowser.reset()
    sendMessageMock.mockReset()
    vi.stubEnv("BROWSER", "safari")
  })

  describe("server discovery", () => {
    it("is never used outside the Safari build", async () => {
      vi.stubEnv("BROWSER", "chrome")
      await localSubtitlesServiceUrlItem.setValue("http://localhost:12017")
      expect(await getLocalSubtitlesServiceUrl()).toBeNull()
      expect(sendMessageMock).not.toHaveBeenCalled()
    })

    it("detects WhisperServer at its default address", async () => {
      sendMessageMock.mockResolvedValueOnce(reply(200))
      expect(await getLocalSubtitlesServiceUrl()).toBe("http://localhost:12017")
      expect(sendMessageMock.mock.calls[0]![1].url).toBe("http://localhost:12017/v1/models")
    })

    it("falls back to the hosted service when nothing answers", async () => {
      sendMessageMock.mockRejectedValueOnce(new Error("Failed to fetch"))
      expect(await getLocalSubtitlesServiceUrl()).toBeNull()
    })

    it("prefers a saved address and sends the API key to it", async () => {
      await localSubtitlesServiceUrlItem.setValue(" http://10.0.0.2:12017/ ")
      await localSubtitlesApiKeyItem.setValue("ws-secret")
      expect(await getLocalSubtitlesServiceUrl()).toBe("http://10.0.0.2:12017")

      sendMessageMock.mockResolvedValueOnce(reply(401))
      expect(await checkLocalSubtitlesService("http://10.0.0.2:12017")).toEqual({ ok: false })
      expect(sendMessageMock.mock.calls[0]![1].headers).toEqual([
        ["Authorization", "Bearer ws-secret"],
      ])
    })
  })

  describe("normalizeSegments", () => {
    it("drops empty and zero-length segments and converts to milliseconds", () => {
      expect(
        normalizeSegments([
          { start: 0, end: 2, text: " Hello. " },
          { start: 5, end: 5, text: "ghost" },
          { start: 6, end: 7, text: "   " },
        ]),
      ).toEqual([{ text: "Hello.", start: 0, end: 2000 }])
    })

    it("splits long segments at punctuation and shares the time span", () => {
      const lines = normalizeSegments([
        {
          start: 10,
          end: 30,
          text: "We're no strangers to love, you know the rules, and so do I.",
        },
      ])
      expect(lines.map((line) => line.text)).toEqual([
        "We're no strangers to love,",
        "you know the rules,",
        "and so do I.",
      ])
      expect(lines[0]!.start).toBe(10_000)
      expect(lines.at(-1)!.end).toBe(30_000)
      for (let i = 1; i < lines.length; i++) expect(lines[i]!.start).toBe(lines[i - 1]!.end)
    })

    it("splits Chinese text at full-width punctuation", () => {
      const lines = normalizeSegments([
        { start: 0, end: 12, text: "大家好，欢迎收看今天的节目。我们今天来聊一聊人工智能和字幕。" },
      ])
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.map((line) => line.text).join("")).toBe(
        "大家好，欢迎收看今天的节目。我们今天来聊一聊人工智能和字幕。",
      )
    })
  })

  describe("requestLocalAiSubtitles", () => {
    function nativeJob(results: unknown[]) {
      const queue = [...results]
      sendMessageMock.mockImplementation(async (type) => {
        if (type === "localTranscribeStart") return { started: true }
        if (type === "localTranscribeStatus") return queue.shift() ?? { status: "running" }
        return undefined
      })
    }

    it("starts a native job, polls it and caches the result", async () => {
      vi.useFakeTimers()
      await localSubtitlesApiKeyItem.setValue("ws-secret")
      nativeJob([
        { status: "running" },
        { segments: [{ start: 1.5, end: 3, text: "hello" }], language: "en" },
      ])

      const pending = requestLocalAiSubtitles("http://localhost:12017/", ctx)
      await vi.advanceTimersByTimeAsync(2_000)
      const first = await pending
      expect(first).toMatchObject({
        segments: [{ text: "hello", start: 1500, end: 3000 }],
        detectedLanguage: "en",
      })
      const [type, request] = sendMessageMock.mock.calls[0]!
      expect(type).toBe("localTranscribeStart")
      expect(request).toMatchObject({
        videoId: "jNQXAC9IVRw",
        server: "http://localhost:12017",
        apiKey: "ws-secret",
      })
      const polls = sendMessageMock.mock.calls.filter(([t]) => t === "localTranscribeStatus")
      expect(polls).toHaveLength(2)
      expect(polls[0]![1].id).toBe(request.id)

      sendMessageMock.mockClear()
      const second = await requestLocalAiSubtitles("http://localhost:12017", ctx)
      expect(second.segments).toEqual(first.segments)
      expect(sendMessageMock).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it("surfaces native errors", async () => {
      sendMessageMock.mockResolvedValueOnce({ error: "Invalid transcription request" })
      await expect(requestLocalAiSubtitles("http://localhost:12017", ctx)).rejects.toThrow(
        /localService\.failed/,
      )
    })

    it("stops at once and cancels the native job when the viewer leaves the video", async () => {
      nativeJob([])
      const controller = new AbortController()
      const pending = requestLocalAiSubtitles("http://localhost:12017", ctx, controller.signal)
      await vi.waitFor(() =>
        expect(sendMessageMock).toHaveBeenCalledWith("localTranscribeStart", expect.anything()),
      )
      controller.abort()
      await expect(pending).rejects.toThrow(/aborted/i)
      const startId = sendMessageMock.mock.calls[0]![1].id
      const cancel = sendMessageMock.mock.calls.find(([t]) => t === "localTranscribeCancel")
      expect(cancel?.[1].id).toBe(startId)
    })
  })
})
