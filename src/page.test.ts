import { describe, expect, it } from "vitest"
import { buildPageJob } from "./page.js"

const page = { name: "docs", dir: "./dist" }

describe("buildPageJob", () => {
  it("builds a Caddy file-server job that bind-mounts the built dir read-only", () => {
    const { Job } = buildPageJob(page, "/abs/site/dist", { nomadAddr: "http://n", datacenter: "eu" })
    expect(Job.Type).toBe("service")
    const task = (Job.TaskGroups as any[])[0].Tasks[0]
    expect(task.Driver).toBe("docker")
    expect(task.Config.image).toBe("caddy:2-alpine")
    expect(task.Config.args).toEqual(["caddy", "file-server", "--root", "/site", "--listen", ":80", "--browse"])
    expect(task.Config.mounts).toEqual([{ type: "bind", source: "/abs/site/dist", target: "/site", readonly: true }])
  })

  it("defaults to bridge networking; honors host mode (local dev)", () => {
    expect(((buildPageJob(page, "/d", { nomadAddr: "n" }).Job.TaskGroups as any[])[0]).Networks[0].Mode).toBe("bridge")
    const host = buildPageJob(page, "/d", { nomadAddr: "n", networkMode: "host" })
    expect((host.Job.TaskGroups as any[])[0].Networks[0].Mode).toBe("host")
  })

  it("routes at a generated hostname; a custom domain adds a second Host rule", () => {
    const plain = buildPageJob(page, "/d", { nomadAddr: "n", appDomain: "up.flect.run" })
    const tags = (plain.Job.TaskGroups as any[])[0].Tasks[0].Services[0].Tags as string[]
    expect(tags.some((t) => /rule=Host\(`docs-[a-z0-9]+\.up\.flect\.run`\)$/.test(t))).toBe(true)
    expect(tags).toContain("flect.cloud/type=page")

    const custom = buildPageJob({ ...page, domain: "docs.acme.com" }, "/d", { nomadAddr: "n" })
    const ctags = (custom.Job.TaskGroups as any[])[0].Tasks[0].Services[0].Tags as string[]
    expect(ctags.some((t) => t.includes("|| Host(`docs.acme.com`)"))).toBe(true)
  })
})
