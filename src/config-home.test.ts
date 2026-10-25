import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configDir, configPath } from "./lib/config-home.js"

let home: string
const realHome = process.env["HOME"]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flect-home-"))
  process.env["HOME"] = home
  mkdirSync(join(home, ".flect"))
  writeFileSync(join(home, ".flect", "config.json"), "{}")
})
afterEach(() => {
  process.env["HOME"] = realHome
  rmSync(home, { recursive: true, force: true })
})

describe("where the config lives", () => {
  it("is ~/.flect by default", () => {
    expect(configPath({}, join(home, "somewhere"))).toBe(join(home, ".flect", "config.json"))
  })

  it("FLECT_HOME wins over everything", () => {
    expect(configDir({ FLECT_HOME: "/tmp/x", FLECT_PROFILE: "local" }, home)).toBe("/tmp/x")
  })

  it("FLECT_PROFILE is a directory of its own under ~/.flect/profiles", () => {
    expect(configDir({ FLECT_PROFILE: "local" }, home)).toBe(join(home, ".flect", "profiles", "local"))
    expect(() => configDir({ FLECT_PROFILE: "../prod" }, home)).toThrow(/not a profile name/)
  })

  it("a project's own .flect/config.json is used in that project", () => {
    const project = join(home, "app")
    mkdirSync(join(project, ".flect"), { recursive: true })
    writeFileSync(join(project, ".flect", "config.json"), "{}")
    expect(configDir({}, project)).toBe(join(project, ".flect"))
  })

  it("a .flect directory without config.json (deploy state only) is not a project config", () => {
    const project = join(home, "app")
    mkdirSync(join(project, ".flect"), { recursive: true })
    expect(configDir({}, project)).toBe(join(home, ".flect"))
  })

  it("in the home directory, ./.flect is the global config, not a project's", () => {
    // Run from ~, ./.flect/config.json exists and IS ~/.flect/config.json. A
    // profile selected there must still get its own directory.
    expect(configDir({}, home)).toBe(join(home, ".flect"))
    expect(configDir({ FLECT_PROFILE: "local" }, home)).toBe(join(home, ".flect", "profiles", "local"))
  })
})
