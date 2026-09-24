import type { AiSubtitlesContext } from "./request-ai-subtitles"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { storage } from "#imports"
import { i18n } from "@/utils/i18n"
import { sendMessage } from "@/utils/message"
import { OverlaySubtitlesError } from "@/utils/subtitles/errors"

/**
 * Local AI subtitles: the Safari app's native handler fetches the video's audio
 * with its bundled yt-dlp and sends it to a speech server the user runs — any
 * OpenAI-compatible /v1/audio/transcriptions endpoint that returns timed
 * segments, such as WhisperServer. No sign-in or plan is involved.
 */
export const DEFAULT_LOCAL_SUBTITLES_SERVICE_URL = "http://localhost:12017"

export const localSubtitlesServiceUrlItem = storage.defineItem<string>(
  "local:localSubtitlesServiceUrl",
  { fallback: "" },
)

/** Only needed when the speech server runs on another machine; localhost is exempt. */
export const localSubtitlesApiKeyItem = storage.defineItem<string>("local:localSubtitlesApiKey", {
  fallback: "",
})

interface CachedTranscript {
  videoId: string
  segments: SubtitlesFragment[]
  detectedLanguage: string
}

const transcriptCacheItem = storage.defineItem<CachedTranscript[]>("local:localTranscriptCache", {
  fallback: [],
})
const TRANSCRIPT_CACHE_LIMIT = 30

export interface LocalTranscribeRequest {
  id: string
  videoId: string
  server: string
  apiKey?: string
}

export type LocalTranscribeResult =
  | { segments: { start: number; end: number; text: string }[]; language?: string }
  | { error: string }
  | { cancelled: true }

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

async function authHeaders(): Promise<[string, string][]> {
  const apiKey = (await localSubtitlesApiKeyItem.getValue()).trim()
  return apiKey ? [["Authorization", `Bearer ${apiKey}`]] : []
}

export async function checkLocalSubtitlesService(baseUrl: string): Promise<{ ok: boolean }> {
  try {
    const response = await sendMessage("backgroundFetch", {
      url: `${normalizeUrl(baseUrl)}/v1/models`,
      method: "GET",
      headers: await authHeaders(),
      credentials: "omit",
    })
    return { ok: response.status >= 200 && response.status < 300 }
  } catch {
    return { ok: false }
  }
}

/**
 * The configured speech server, or the default one when it answers — so a
 * running WhisperServer works without setup. Null falls back to the hosted
 * service. Native messaging only exists in the Safari build.
 */
export async function getLocalSubtitlesServiceUrl(): Promise<string | null> {
  if (import.meta.env.BROWSER !== "safari") return null
  const configured = normalizeUrl(await localSubtitlesServiceUrlItem.getValue())
  if (configured) return configured
  const health = await checkLocalSubtitlesService(DEFAULT_LOCAL_SUBTITLES_SERVICE_URL)
  return health.ok ? DEFAULT_LOCAL_SUBTITLES_SERVICE_URL : null
}

const MAX_LINE_SECONDS = 7
const MAX_LINE_CHARS = 80
// Break after CJK punctuation, or after Latin punctuation followed by a space.
const BREAK_AFTER = /[。！？；…，、]|[.!?;,](?=\s)/g

/**
 * Speech servers return paragraph-sized segments (often 10-30 s). Split long ones
 * at punctuation, sharing the time span by character count, and drop empty or
 * zero-length segments.
 */
export function normalizeSegments(
  segments: { start: number; end: number; text: string }[],
): SubtitlesFragment[] {
  const lines: SubtitlesFragment[] = []
  for (const segment of segments) {
    const text = segment.text.trim()
    const start = segment.start * 1000
    const end = segment.end * 1000
    if (!text || !(end > start)) continue
    if (end - start <= MAX_LINE_SECONDS * 1000 && text.length <= MAX_LINE_CHARS) {
      lines.push({ text, start, end })
      continue
    }

    const pieces: string[] = []
    let last = 0
    for (const match of text.matchAll(BREAK_AFTER)) {
      const cut = match.index + match[0].length
      if (cut - last >= 8) {
        pieces.push(text.slice(last, cut).trim())
        last = cut
      }
    }
    if (last < text.length) pieces.push(text.slice(last).trim())
    const kept = pieces.filter(Boolean)
    const total = kept.reduce((sum, piece) => sum + piece.length, 0)
    let cursor = start
    kept.forEach((piece, index) => {
      const pieceEnd =
        index === kept.length - 1 ? end : cursor + ((end - start) * piece.length) / total
      lines.push({ text: piece, start: Math.round(cursor), end: Math.round(pieceEnd) })
      cursor = pieceEnd
    })
  }
  return lines
}

async function readCache(videoId: string): Promise<CachedTranscript | undefined> {
  return (await transcriptCacheItem.getValue()).find((entry) => entry.videoId === videoId)
}

async function writeCache(entry: CachedTranscript): Promise<void> {
  const cache = (await transcriptCacheItem.getValue()).filter((e) => e.videoId !== entry.videoId)
  await transcriptCacheItem.setValue([entry, ...cache].slice(0, TRANSCRIPT_CACHE_LIMIT))
}

export async function requestLocalAiSubtitles(
  baseUrl: string,
  ctx: AiSubtitlesContext,
  signal?: AbortSignal,
): Promise<{ segments: SubtitlesFragment[]; detectedLanguage: string }> {
  signal?.throwIfAborted()
  const cached = await readCache(ctx.videoId)
  if (cached) return cached

  const id = crypto.randomUUID()
  const onAbort = () => void sendMessage("localTranscribeCancel", { id }).catch(() => {})
  signal?.addEventListener("abort", onAbort, { once: true })
  let result: LocalTranscribeResult
  try {
    const apiKey = (await localSubtitlesApiKeyItem.getValue()).trim()
    result = await sendMessage("localTranscribe", {
      id,
      videoId: ctx.videoId,
      server: normalizeUrl(baseUrl),
      ...(apiKey ? { apiKey } : {}),
    })
  } catch (error) {
    throw new OverlaySubtitlesError(
      i18n.t("options.videoSubtitles.localService.failed", [String(error)]),
    )
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }

  signal?.throwIfAborted()
  if ("cancelled" in result) throw new DOMException("Aborted", "AbortError")
  if ("error" in result) {
    throw new OverlaySubtitlesError(
      i18n.t("options.videoSubtitles.localService.failed", [result.error]),
    )
  }

  const transcript: CachedTranscript = {
    videoId: ctx.videoId,
    segments: normalizeSegments(result.segments),
    detectedLanguage: result.language ?? "",
  }
  if (transcript.segments.length > 0) await writeCache(transcript)
  return transcript
}
