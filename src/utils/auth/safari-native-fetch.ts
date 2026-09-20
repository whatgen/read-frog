import { browser } from "#imports"

// Safari's native handler independently enforces this same destination. Never
// turn native messaging into a general-purpose authenticated HTTP proxy.
export function isNativeAccountURL(url: string): boolean {
  try {
    const target = new URL(url)
    return (
      target.origin === "https://api.readfrog.app" &&
      !target.username &&
      !target.password &&
      ["/api/identity", "/api/rpc"].some(
        (path) => target.pathname === path || target.pathname.startsWith(`${path}/`),
      )
    )
  } catch {
    return false
  }
}

export function isSessionCookie(name: string): boolean {
  return /^(?:__Secure-|__Host-)?better-auth\.session_token(?:\.\d+)?$/.test(name)
}

type CookieUpdate = {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: "strict" | "lax" | "no_restriction"
}
type NativeResponse = {
  error?: string
  status: number
  headers: [string, string][]
  body: string
  cookies: CookieUpdate[]
}

/** No token copies in extension storage: Safari remains the source of truth. */
export async function safariNativeFetch(request: Request): Promise<Response> {
  if (!isNativeAccountURL(request.url)) throw new Error("Invalid native account destination")
  request.signal.throwIfAborted()
  // With no storeId Safari uses the store of this execution context, including
  // its profile/private browsing boundary. Never enumerate another store.
  const cookies = (await browser.cookies.getAll({ url: request.url })).filter(
    (cookie) =>
      isSessionCookie(cookie.name) &&
      (cookie.expirationDate === undefined || cookie.expirationDate > Date.now() / 1000),
  )
  if (cookies.length === 0) return fetch(request)
  const body = request.body ? Array.from(new Uint8Array(await request.arrayBuffer())) : undefined
  request.signal.throwIfAborted()
  const id = crypto.randomUUID()
  const onAbort = () => {
    void browser.runtime
      .sendNativeMessage("app.readfrog.safari.local", {
        type: "read-frog-account-cancel",
        id,
      })
      .catch(() => {})
  }
  const response = await new Promise<NativeResponse>((resolve, reject) => {
    const abort = () => {
      onAbort()
      reject(new DOMException("The request was aborted", "AbortError"))
    }
    request.signal.addEventListener("abort", abort, { once: true })
    if (request.signal.aborted) {
      abort()
      return
    }
    void browser.runtime
      .sendNativeMessage("app.readfrog.safari.local", {
        type: "read-frog-account-fetch",
        id,
        url: request.url,
        method: request.method,
        headers: [...request.headers.entries()],
        body,
        cookies: cookies.map(({ name, value }) => ({ name, value })),
      })
      .then(resolve, reject)
      .finally(() => request.signal.removeEventListener("abort", abort))
  })
  request.signal.throwIfAborted()
  if (response.error) throw new Error(response.error)
  // Apply server rotation/logout to the same Safari store. Check the original
  // cookie snapshot first so an in-flight read cannot resurrect a signed-out user.
  const current = (await browser.cookies.getAll({ url: request.url })).filter((cookie) =>
    isSessionCookie(cookie.name),
  )
  const snapshot = (values: typeof cookies) =>
    values
      .map((c) => `${c.name}=${c.value}`)
      .sort()
      .join(";")
  if (snapshot(current) === snapshot(cookies)) {
    for (const cookie of response.cookies) {
      if (
        !isSessionCookie(cookie.name) ||
        !["readfrog.app", "api.readfrog.app"].includes(cookie.domain.replace(/^\./, ""))
      )
        continue
      const original = cookies.find((c) => c.name === cookie.name)
      await browser.cookies.set({
        ...cookie,
        url: `https://api.readfrog.app${cookie.path}`,
        ...(original ? { storeId: original.storeId } : {}),
      })
    }
  }
  const bytes = Uint8Array.from(atob(response.body), (character) => character.charCodeAt(0))
  return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
    status: response.status,
    headers: response.headers,
  })
}
