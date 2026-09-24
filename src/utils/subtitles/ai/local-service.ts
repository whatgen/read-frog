import type { AiSubtitlesContext } from "./request-ai-subtitles"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { storage } from "#imports"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { OverlaySubtitlesError, ToastSubtitlesError } from "@/utils/subtitles/errors"

/**
 * Address of the self-hosted Read Frog local server (local-server/ in this repo).
 * When set, AI subtitles are transcribed there instead of by the hosted service,
 * so they need neither a sign-in nor a plan.
 */
export const localSubtitlesServiceUrlItem = storage.defineItem<string>(
  "local:localSubtitlesServiceUrl",
  { fallback: "" },
)

export async function getLocalSubtitlesServiceUrl(): Promise<string | null> {
  const value = (await localSubtitlesServiceUrlItem.getValue()).trim().replace(/\/+$/, "")
  return value || null
}

interface LocalJob {
  id: string
  status: "pending" | "processing" | "completed" | "failed"
  detectedLanguage: string | null
  error: string | null
}

const POLL_INTERVAL_MS = 1_000
const POLL_BASE_TIMEOUT_MS = 10 * 60 * 1_000
const MS_PER_SECOND = 1_000

/**
 * Content scripts run under the page's network rules, where YouTube (https) cannot
 * reach a plain-http localhost server. The background page has host access and no
 * mixed-content restriction, so every call is relayed through it.
 */
async function callLocal<T>(baseUrl: string, path: string, body?: unknown): Promise<T> {
  let response
  try {
    response = await sendMessage("backgroundFetch", {
      url: `${baseUrl}${path}`,
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? [] : [["Content-Type", "application/json"]],
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
    })
  } catch {
    throw new OverlaySubtitlesError(i18n.t("options.videoSubtitles.localService.unreachable"))
  }
  let data: unknown = null
  try {
    data = JSON.parse(response.body)
  } catch {}
  if (response.status < 200 || response.status >= 300) {
    const reason = (data as { error?: string } | null)?.error ?? `HTTP ${response.status}`
    throw new OverlaySubtitlesError(i18n.t("options.videoSubtitles.localService.failed", [reason]))
  }
  return data as T
}

export async function checkLocalSubtitlesService(
  baseUrl: string,
): Promise<{ ok: boolean; model?: string }> {
  try {
    return await callLocal<{ ok: boolean; model?: string }>(
      baseUrl.trim().replace(/\/+$/, ""),
      "/health",
    )
  } catch {
    return { ok: false }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError")
  }
}

export async function requestLocalAiSubtitles(
  baseUrl: string,
  ctx: AiSubtitlesContext,
  signal?: AbortSignal,
): Promise<{ segments: SubtitlesFragment[]; detectedLanguage: string }> {
  throwIfAborted(signal)
  let job = await callLocal<LocalJob>(baseUrl, "/v1/transcripts", {
    url: ctx.url,
    durationSec: ctx.durationSec,
  })

  // Local transcription runs at roughly real-time / 20 on Apple silicon, plus the
  // audio download; allow generously for long videos.
  const deadline = Date.now() + POLL_BASE_TIMEOUT_MS + ctx.durationSec * 200
  while (job.status === "pending" || job.status === "processing") {
    if (Date.now() > deadline) {
      throw new ToastSubtitlesError(i18n.t("subtitles.errors.aiStillProcessing"))
    }
    throwIfAborted(signal)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    throwIfAborted(signal)
    job = await callLocal<LocalJob>(baseUrl, `/v1/transcripts/${encodeURIComponent(job.id)}`)
  }
  if (job.status === "failed") {
    throw new OverlaySubtitlesError(
      i18n.t("options.videoSubtitles.localService.failed", [job.error ?? "unknown"]),
    )
  }

  throwIfAborted(signal)
  const subtitles = await callLocal<{
    segments: { start: number; end: number; text: string }[]
    detectedLanguage: string | null
  }>(baseUrl, `/v1/transcripts/${encodeURIComponent(job.id)}/subtitles`)

  return {
    segments: subtitles.segments.map((segment) => ({
      text: segment.text,
      start: segment.start * MS_PER_SECOND,
      end: segment.end * MS_PER_SECOND,
    })),
    detectedLanguage: subtitles.detectedLanguage ?? job.detectedLanguage ?? "",
  }
}
