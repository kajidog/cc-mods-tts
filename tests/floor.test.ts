import { expect, test } from "claude-code/testing"

import { acquireCommand } from "../hooks/floor"

test("a wait limit below a second is still a limit, and 0 alone waits without one", () => {
  expect(acquireCommand(false, "id", 0, 0.5).at(-1)).toBe("1")
  expect(acquireCommand(false, "id", 0, 0).at(-1)).toBe("0")
  expect(acquireCommand(true, "id", 0, 0.5).at(-1)).toContain("$limit = 1;")
})
