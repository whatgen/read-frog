import type { VideoTranscriptUsage } from "@read-frog/api-contract"
import { IconPlugConnected } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import { i18n } from "@/utils/i18n"
import {
  DEFAULT_SELF_HOSTED_TRANSCRIPT_URL,
  getSelfHostedTranscriptUrl,
  isSelfHostedTranscriptServer,
  selfHostedTranscriptUrlItem,
} from "@/utils/subtitles/ai/self-hosted"
import { ConfigItem } from "../../../components/config-item"

const SELF_HOSTED_QUERY_KEY = ["selfHostedTranscriptUrl"] as const

/** The self-hosted transcript server AI subtitles will use, or null for Read Frog's. */
export function useSelfHostedTranscriptUrl(): string | null {
  const { data } = useQuery({
    queryKey: SELF_HOSTED_QUERY_KEY,
    queryFn: getSelfHostedTranscriptUrl,
    staleTime: 10_000,
  })
  return data ?? null
}

export function SelfHostedStatus({ url, usage }: { url: string; usage?: VideoTranscriptUsage }) {
  return (
    <div className="flex flex-col gap-1 text-[13px] leading-[18px] text-muted-foreground">
      <p>{i18n.t("options.videoSubtitles.aiQuota.selfHosted.active", [url])}</p>
      {usage && (
        <p className="text-xs tabular-nums">
          {i18n.t("options.videoSubtitles.aiQuota.selfHosted.transcribed", [usage.usedMinutes])}
        </p>
      )}
    </div>
  )
}

/** Where AI subtitles are transcribed: empty auto-detects a server on this computer. */
export function SelfHostedServerItem() {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState("")
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    void selfHostedTranscriptUrlItem.getValue().then(setUrl)
  }, [])

  async function save(value: string) {
    setUrl(value)
    setResult(null)
    await selfHostedTranscriptUrlItem.setValue(value.trim())
    await queryClient.invalidateQueries({ queryKey: SELF_HOSTED_QUERY_KEY })
  }

  async function test() {
    setTesting(true)
    try {
      const target = url.trim() || DEFAULT_SELF_HOSTED_TRANSCRIPT_URL
      const ok = await isSelfHostedTranscriptServer(target)
      setResult(
        ok
          ? i18n.t("options.videoSubtitles.aiQuota.selfHosted.connected", [target])
          : i18n.t("options.videoSubtitles.aiQuota.selfHosted.unreachable"),
      )
      await queryClient.invalidateQueries({ queryKey: SELF_HOSTED_QUERY_KEY })
    } finally {
      setTesting(false)
    }
  }

  return (
    <ConfigItem
      id="self-hosted-transcript-server"
      title={i18n.t("options.videoSubtitles.aiQuota.selfHosted.title")}
      description={i18n.t("options.videoSubtitles.aiQuota.selfHosted.description", [
        DEFAULT_SELF_HOSTED_TRANSCRIPT_URL,
      ])}
    >
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <Input
            className="w-64"
            placeholder={DEFAULT_SELF_HOSTED_TRANSCRIPT_URL}
            value={url}
            onChange={(event) => void save(event.target.value)}
          />
          <Button variant="outline" size="sm" disabled={testing} onClick={test}>
            <IconPlugConnected className="size-4" />
            {testing
              ? i18n.t("options.videoSubtitles.aiQuota.selfHosted.testing")
              : i18n.t("options.videoSubtitles.aiQuota.selfHosted.test")}
          </Button>
        </div>
        {result && <p className="text-xs text-muted-foreground">{result}</p>}
      </div>
    </ConfigItem>
  )
}
