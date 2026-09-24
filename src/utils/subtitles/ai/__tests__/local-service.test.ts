import type { ProxyRequest, ProxyResponse } from "@/types/proxy-fetch"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeBrowser } from "wxt/testing/fake-browser"

const sendMessageMock = vi.fn<(type: string, data: ProxyRequest) => Promise<ProxyResponse>>()
vi.mock("@/utils/message", () => ({ sendMessage: sendMessageMock }))

const {
  checkLocalSubtitlesService,
  getLocalSubtitlesServiceUrl,
  localSubtitlesServiceUrlItem,
  requestLocalAiSubtitles,
} = await import("../local-service")

function reply(status: number, body: unknown): ProxyResponse {
  return { status, statusText: "", headers: [], body: JSON.stringify(body) }
}

const ctx = {
  videoId: "jNQXAC9IVRw",
  url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  durationSec: 19,
}

describe("local subtitles service", () => {
  beforeEach(() => {
    fakeBrowser.reset()
    sendMessageMock.mockReset()
    vi.useRealTimers()
  })

  it("falls back to the hosted service when no address is saved and nothing answers", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("Failed to fetch"))
    expect(await getLocalSubtitlesServiceUrl()).toBeNull()
  })

  it("detects a server running at the default address without setup", async () => {
    sendMessageMock.mockResolvedValueOnce(reply(200, { ok: true, model: "whisper" }))
    expect(await getLocalSubtitlesServiceUrl()).toBe("http://127.0.0.1:8765")
    expect(sendMessageMock.mock.calls[0]![1].url).toBe("http://127.0.0.1:8765/health")
  })

  it("prefers a saved address and trims trailing slashes", async () => {
    await localSubtitlesServiceUrlItem.setValue(" http://127.0.0.1:8765/ ")
    expect(await getLocalSubtitlesServiceUrl()).toBe("http://127.0.0.1:8765")
  })

  it("creates a job, polls it and converts seconds to milliseconds", async () => {
    vi.useFakeTimers()
    sendMessageMock
      .mockResolvedValueOnce(
        reply(200, { id: "job1", status: "pending", detectedLanguage: null, error: null }),
      )
      .mockResolvedValueOnce(
        reply(200, { id: "job1", status: "completed", detectedLanguage: "en", error: null }),
      )
      .mockResolvedValueOnce(
        reply(200, { segments: [{ start: 1.5, end: 3, text: "hello" }], detectedLanguage: "en" }),
      )

    const pending = requestLocalAiSubtitles("http://127.0.0.1:8765", ctx)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending

    expect(result).toEqual({
      segments: [{ text: "hello", start: 1500, end: 3000 }],
      detectedLanguage: "en",
    })
    const create = sendMessageMock.mock.calls[0]![1]
    expect(create).toMatchObject({
      url: "http://127.0.0.1:8765/v1/transcripts",
      method: "POST",
      headers: [["Content-Type", "application/json"]],
    })
    expect(JSON.parse(create.body!)).toEqual({ url: ctx.url, durationSec: 19 })
    expect(sendMessageMock.mock.calls[2]![1].url).toBe(
      "http://127.0.0.1:8765/v1/transcripts/job1/subtitles",
    )
  })

  it("surfaces a failed transcription", async () => {
    sendMessageMock.mockResolvedValueOnce(
      reply(200, {
        id: "job1",
        status: "failed",
        detectedLanguage: null,
        error: "download failed",
      }),
    )
    await expect(requestLocalAiSubtitles("http://127.0.0.1:8765", ctx)).rejects.toThrow(
      /localService\.failed/,
    )
  })

  it("rejects server errors", async () => {
    sendMessageMock.mockResolvedValueOnce(reply(400, { error: "unsupported_url" }))
    await expect(requestLocalAiSubtitles("http://127.0.0.1:8765", ctx)).rejects.toThrow(
      /localService\.failed/,
    )
  })

  it("reports an unreachable server from the health check", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("Failed to fetch"))
    expect(await checkLocalSubtitlesService("http://127.0.0.1:8765")).toEqual({ ok: false })

    sendMessageMock.mockResolvedValueOnce(reply(200, { ok: true, model: "whisper" }))
    expect(await checkLocalSubtitlesService("http://127.0.0.1:8765/")).toEqual({
      ok: true,
      model: "whisper",
    })
    expect(sendMessageMock.mock.calls[1]![1].url).toBe("http://127.0.0.1:8765/health")
  })
})
