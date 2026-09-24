import { IconPlugConnected } from "@tabler/icons-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import { i18n } from "@/utils/i18n"
import {
  checkLocalSubtitlesService,
  DEFAULT_LOCAL_SUBTITLES_SERVICE_URL as DEFAULT_LOCAL_URL,
  localSubtitlesApiKeyItem,
  localSubtitlesServiceUrlItem,
} from "@/utils/subtitles/ai/local-service"
import { ConfigItem } from "../../../components/config-item"
import { ConfigSection } from "../../../components/config-section"

/** Points AI subtitles at the user's own speech server instead of the hosted one. */
export function LocalServiceSection() {
  const [url, setUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    void localSubtitlesServiceUrlItem.getValue().then(setUrl)
    void localSubtitlesApiKeyItem.getValue().then(setApiKey)
  }, [])

  async function saveUrl(value: string) {
    setUrl(value)
    setResult(null)
    await localSubtitlesServiceUrlItem.setValue(value.trim())
  }

  async function saveApiKey(value: string) {
    setApiKey(value)
    setResult(null)
    await localSubtitlesApiKeyItem.setValue(value.trim())
  }

  async function handleTest() {
    setTesting(true)
    try {
      const target = url.trim() || DEFAULT_LOCAL_URL
      const health = await checkLocalSubtitlesService(target)
      setResult(
        health.ok
          ? i18n.t("options.videoSubtitles.localService.connected", [target])
          : i18n.t("options.videoSubtitles.localService.unreachable"),
      )
    } finally {
      setTesting(false)
    }
  }

  return (
    <ConfigSection
      id="subtitles-local-service"
      title={i18n.t("options.videoSubtitles.localService.title")}
    >
      <ConfigItem
        id="local-subtitles-service-url"
        title={i18n.t("options.videoSubtitles.localService.url.title")}
        description={
          <>
            {i18n.t("options.videoSubtitles.localService.description")}
            <br />
            {i18n.t("options.videoSubtitles.localService.url.description")}
          </>
        }
      >
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <Input
              className="w-64"
              placeholder={DEFAULT_LOCAL_URL}
              value={url}
              onChange={(event) => void saveUrl(event.target.value)}
            />
            <Button variant="outline" size="sm" disabled={testing} onClick={handleTest}>
              <IconPlugConnected className="size-4" />
              {testing
                ? i18n.t("options.videoSubtitles.localService.testing")
                : i18n.t("options.videoSubtitles.localService.test")}
            </Button>
          </div>
          {result && <p className="text-xs text-muted-foreground">{result}</p>}
        </div>
      </ConfigItem>
      <ConfigItem
        id="local-subtitles-api-key"
        title={i18n.t("options.videoSubtitles.localService.apiKey.title")}
        description={i18n.t("options.videoSubtitles.localService.apiKey.description")}
      >
        <Input
          className="w-64"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => void saveApiKey(event.target.value)}
        />
      </ConfigItem>
    </ConfigSection>
  )
}
