/**
 * End to end: the built CLI against a running realm, through its gateway.
 *
 * Skipped unless FLECT_E2E_URL is set. `just e2e` sets it, plus the realm's
 * local HS256 secret, so the test can sign in as a brand-new user without a
 * browser. It makes its own org and deletes it afterwards, so it needs nothing
 * from the realm but that it is up.
 *
 * It runs dist/, the thing that is published, in a HOME of its own, so it never
 * reads or writes the developer's ~/.flect.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { createHmac, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const URL_ = process.env["FLECT_E2E_URL"]
const SECRET = process.env["FLECT_E2E_JWT_SECRET"]
const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url))

function hs256(claims: Record<string, unknown>, secret: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`
}

let home: string
const run = (...args: string[]) =>
  new Promise<{ code: number; out: string }>((ok) => {
    execFile(
      process.execPath,
      [DIST, ...args],
      { cwd: home, env: { PATH: process.env["PATH"], HOME: home, FLECT_URL: URL_, NO_COLOR: "1" } },
      (err, stdout, stderr) => ok({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, "") }),
    )
  })
const json = async <T>(...args: string[]): Promise<T> => {
  const r = await run(...args, "-o", "json")
  expect(r.code, r.out).toBe(0)
  return JSON.parse(r.out) as T
}
const context = () => (JSON.parse(readFileSync(join(home, ".flect", "config.json"), "utf8")) as { context: Record<string, string> }).context

type Row = { id: string; short_id: string; slug: string; is_default?: boolean }
const slug = `e2e-${randomUUID().slice(0, 8)}`

describe.skipIf(!URL_)("flect against a running realm", () => {
  beforeAll(() => {
    if (!SECRET) throw new Error("FLECT_E2E_JWT_SECRET is required with FLECT_E2E_URL")
    if (!existsSync(DIST)) throw new Error("build first: dist/index.js is missing")
    home = mkdtempSync(join(tmpdir(), "flect-e2e-"))
    mkdirSync(join(home, ".flect"))
    const now = Math.floor(Date.now() / 1000)
    const token = hs256({ sub: `e2e-${randomUUID()}`, type: "human", email: `${slug}@e2e.test`, iat: now, exp: now + 600 }, SECRET)
    writeFileSync(join(home, ".flect", "config.json"), JSON.stringify({ token }))
  })

  afterAll(async () => {
    if (home) {
      await run("org", "delete", slug)
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("a new user makes an org and gets the default chain with it", async () => {
    const created = await run("org", "create", "--name", "E2E", "--slug", slug)
    expect(created.code, created.out).toBe(0)
    const orgs = await json<Row[]>("org", "ls")
    expect(orgs.map((o) => o.slug)).toEqual([slug])
  })

  it("with only an org selected, the broker still answers (the org is not sent as a scope)", async () => {
    const r = await run("use", slug)
    expect(r.code, r.out).toBe(0)
    const d = await run("doctor")
    expect(d.out).toMatch(/✓ api access/)
  })

  it("use walks the tree and remembers every level by short id", async () => {
    const [ws] = await json<Row[]>("ws", "ls", "--org", slug)
    const [proj] = await json<Row[]>("proj", "ls", "--org", slug, "--ws", ws!.slug)
    const made = await run("env", "create", "--name", "Staging", "--org", slug, "--ws", ws!.slug, "--proj", proj!.slug)
    expect(made.code, made.out).toBe(0)

    const r = await run("use", `${slug}/${ws!.slug}/${proj!.slug}/staging`)
    expect(r.code, r.out).toBe(0)
    const c = context()
    for (const k of ["orgShort", "workspaceShort", "projectShort", "envShort"]) expect(c[k], k).toMatch(/^[a-z0-9]{6}$/)
  })

  it("doctor finds every service through the gateway, and the broker takes the short ids", async () => {
    const r = await run("doctor")
    expect(r.code, r.out).toBe(0)
    for (const line of ["auth", "iam", "org-service", "broker", "api access"]) expect(r.out).toMatch(new RegExp(`✓ ${line}`))
  })

  it("the broker's lists answer for the active scope", async () => {
    for (const args of [["apps"], ["db", "list"], ["kv", "list"], ["events"]]) {
      const r = await run(...args)
      expect(r.code, `${args.join(" ")}: ${r.out}`).toBe(0)
      expect(r.out, args.join(" ")).toContain(`scope: ${slug}/`)
    }
  })

  it("the PDP answers by short id", async () => {
    const r = await run("access", "role", context()["envShort"]!)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/role\s+owner/)
  })

  it("invites lists none for a new user", async () => {
    const r = await run("invites")
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain("0 invitations")
  })
})
