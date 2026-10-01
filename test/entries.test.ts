import { describe, expect, test } from "bun:test"
import v1Entry, { server } from "../src/index.js"
import v2Entry, { Plugin } from "../src/v2-entry.js"
import { PLUGIN_ID } from "../src/id.js"
import { v1Input } from "./support.js"

describe("plugin entries", () => {
  test("#given the v1 entry #when imported #then it exports the host-detectable { id, server } object", () => {
    expect(v1Entry.id).toBe(PLUGIN_ID)
    expect(typeof v1Entry.server).toBe("function")
    expect(typeof server).toBe("function")
  })

  test("#given the v1 entry #when loaded disabled #then the server registers no hooks", async () => {
    const input = v1Input({})
    const hooks = await server(input.pluginInput, { enabled: false })
    expect(Object.keys(hooks)).toEqual([])
  })

  test("#given the v2 entry #when imported #then it exports a v2 plugin object as default and named", () => {
    expect(v2Entry.id).toBe(PLUGIN_ID)
    expect(typeof v2Entry.setup).toBe("function")
    expect(Plugin).toBe(v2Entry)
  })
})
