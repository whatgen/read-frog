import type { LocalTranscribeResult } from "@/utils/subtitles/ai/local-service"
import { browser } from "#imports"
import { onMessage } from "@/utils/message"

const NATIVE_APP_ID = "app.readfrog.safari.local"

/**
 * Relays AI subtitle jobs to the Safari app's native handler, which fetches the
 * audio with its bundled yt-dlp and posts it to the user's speech server. Only
 * the background page may use native messaging. A job is started, then polled,
 * so a long video never holds one native reply open.
 */
export function setupLocalTranscriptionHandlers() {
  onMessage("localTranscribeStart", async ({ data }) => {
    return (await sendNative({ type: "read-frog-transcribe-start", ...data })) as
      | { started: true }
      | { error: string }
  })

  onMessage("localTranscribeStatus", async ({ data }) => {
    return (await sendNative({ type: "read-frog-transcribe-status", id: data.id })) as
      | { status: "running" }
      | LocalTranscribeResult
  })

  onMessage("localTranscribeCancel", async ({ data }) => {
    await sendNative({ type: "read-frog-transcribe-cancel", id: data.id })
  })
}

async function sendNative(message: Record<string, unknown>): Promise<unknown> {
  if (!browser.runtime.sendNativeMessage) {
    return { error: "Local AI subtitles need the Safari app" }
  }
  try {
    return await browser.runtime.sendNativeMessage(NATIVE_APP_ID, message)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
