import type {
  LocalTranscribeRequest,
  LocalTranscribeResult,
} from "@/utils/subtitles/ai/local-service"
import { browser } from "#imports"
import { onMessage } from "@/utils/message"

const NATIVE_APP_ID = "app.readfrog.safari.local"

/**
 * Relays AI subtitle requests to the Safari app's native handler, which fetches
 * the audio with its bundled yt-dlp and posts it to the user's speech server.
 * Only the background page may use native messaging.
 */
export function setupLocalTranscriptionHandlers() {
  onMessage("localTranscribe", async ({ data }): Promise<LocalTranscribeResult> => {
    return await sendNative(data)
  })

  onMessage("localTranscribeCancel", async ({ data }) => {
    await browser.runtime
      .sendNativeMessage(NATIVE_APP_ID, { type: "read-frog-transcribe-cancel", id: data.id })
      .catch(() => {})
  })
}

async function sendNative(request: LocalTranscribeRequest): Promise<LocalTranscribeResult> {
  if (!browser.runtime.sendNativeMessage) {
    return { error: "Local AI subtitles need the Safari app" }
  }
  try {
    return (await browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
      type: "read-frog-transcribe",
      ...request,
    })) as LocalTranscribeResult
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
