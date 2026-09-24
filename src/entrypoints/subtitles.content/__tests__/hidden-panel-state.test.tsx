// @vitest-environment jsdom
import { act, render } from "@testing-library/react"
import { Provider, useAtomValue } from "jotai"
import { Activity } from "react"
import { describe, expect, it } from "vitest"
import { SUBTITLES_SOURCE } from "@/utils/constants/subtitles"
import { subtitlesSourceAtom, subtitlesStore, subtitlesVisibleAtom } from "../atoms"

/** Reads the same atoms the settings panel's AI item and on/off switch read. */
function PanelProbe() {
  const source = useAtomValue(subtitlesSourceAtom, { store: subtitlesStore })
  const visible = useAtomValue(subtitlesVisibleAtom)
  return <span data-testid="probe">{`${source}:${visible}`}</span>
}

/** The settings panel stays mounted but hidden (`<Activity>`) while closed. */
function Panel({ open }: { open: boolean }) {
  return (
    <Provider store={subtitlesStore}>
      <Activity mode={open ? "visible" : "hidden"}>
        <PanelProbe />
      </Activity>
    </Provider>
  )
}

describe("settings panel state across a hidden period", () => {
  it("shows the current source and visibility when reopened after a navigation reset", () => {
    act(() => {
      subtitlesStore.set(subtitlesSourceAtom, SUBTITLES_SOURCE.AI)
      subtitlesStore.set(subtitlesVisibleAtom, true)
    })
    const { container, rerender } = render(<Panel open />)
    const probe = () => container.querySelector("[data-testid=probe]")?.textContent

    expect(probe()).toBe("ai:true")

    // Navigating to another video closes the panel, then resets the adapter.
    rerender(<Panel open={false} />)
    act(() => {
      subtitlesStore.set(subtitlesSourceAtom, SUBTITLES_SOURCE.NATIVE)
      subtitlesStore.set(subtitlesVisibleAtom, false)
    })

    // Reopening must not show "using AI subtitles" with the switch stuck on.
    rerender(<Panel open />)
    expect(probe()).toBe("native:false")
  })
})
