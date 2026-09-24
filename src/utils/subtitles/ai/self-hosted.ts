import { storage } from "#imports"
import { sendMessage } from "@/utils/message"

/**
 * AI subtitles can run on a self-hosted server that implements the same
 * `videoTranscript` contract as the Read Frog API, such as the Read Frog
 * transcript server on your own Mac. Only where those calls go changes; the
 * AI subtitles flow itself is untouched.
 */
export const DEFAULT_SELF_HOSTED_TRANSCRIPT_URL = "http://localhost:12018"
const SELF_HOSTED_SERVICE = "readfrog-transcript-server"
const DETECTION_TTL_MS = 10_000

/** Empty means "use the local server when one answers, otherwise the Read Frog API". */
export const selfHostedTranscriptUrlItem = storage.defineItem<string>(
  "local:selfHostedTranscriptUrl",
  { fallback: "" },
)

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

export async function isSelfHostedTranscriptServer(url: string): Promise<boolean> {
  try {
    const response = await sendMessage("backgroundFetch", {
      url: `${normalizeUrl(url)}/health`,
      method: "GET",
      credentials: "omit",
    })
    return response.status === 200 && JSON.parse(response.body)?.service === SELF_HOSTED_SERVICE
  } catch {
    return false
  }
}

let detected: { url: string | null; at: number } | null = null

/** The self-hosted server to use, or null for the Read Frog API. */
export async function getSelfHostedTranscriptUrl(): Promise<string | null> {
  const configured = normalizeUrl(await selfHostedTranscriptUrlItem.getValue())
  if (configured) {
    return configured
  }
  // Polling asks every second; probe the default address at most every few seconds.
  if (!detected || Date.now() - detected.at > DETECTION_TTL_MS) {
    const found = await isSelfHostedTranscriptServer(DEFAULT_SELF_HOSTED_TRANSCRIPT_URL)
    detected = { url: found ? DEFAULT_SELF_HOSTED_TRANSCRIPT_URL : null, at: Date.now() }
  }
  return detected.url
}

/** Base URL for an oRPC call: `videoTranscript.*` goes to the self-hosted server when there is one. */
export async function resolveApiUrl(path: readonly string[], defaultUrl: string): Promise<string> {
  if (path[0] !== "videoTranscript") {
    return defaultUrl
  }
  return (await getSelfHostedTranscriptUrl()) ?? defaultUrl
}
