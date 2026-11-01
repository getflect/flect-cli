import { afterEach, describe, expect, it, vi } from "vitest"
import { BrokerClient } from "./broker-client.js"

describe("BrokerClient.deleteApp", () => {
  afterEach(() => vi.unstubAllGlobals())

  const sent = () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify({ id: "app-1", status: "deleted" }), { status: 200 })
    })
    return calls
  }
  const client = () => new BrokerClient({ brokerUrl: "http://broker.test", token: "t" })

  it("keeps the data by default (the broker holds volumes 7 days)", async () => {
    const calls = sent()
    await client().deleteApp("app-1")
    expect(calls).toEqual([{ url: "http://broker.test/v1/apps/app-1/delete", method: "POST", body: {} }])
  })

  it("--purge-data asks for the volumes to go now", async () => {
    const calls = sent()
    await client().deleteApp("app-1", { purgeData: true })
    expect(calls[0]!.body).toEqual({ purgeData: true })
  })
})
