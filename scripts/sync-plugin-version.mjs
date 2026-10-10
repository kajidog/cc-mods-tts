import { readFile, writeFile } from "node:fs/promises"

const packagePath = new URL("../package.json", import.meta.url)
const pluginPath = new URL("../.claude-plugin/plugin.json", import.meta.url)
const pkg = JSON.parse(await readFile(packagePath, "utf8"))
const plugin = JSON.parse(await readFile(pluginPath, "utf8"))

if (process.argv.includes("--check")) {
  const lockPath = new URL("../package-lock.json", import.meta.url)
  const lock = JSON.parse(await readFile(lockPath, "utf8"))
  if (plugin.version !== pkg.version || lock.version !== pkg.version || lock.packages[""].version !== pkg.version) {
    console.error("Version mismatch: package.json, package-lock.json, and .claude-plugin/plugin.json must agree. Run npm run release:version when preparing a release.")
    process.exitCode = 1
  }
} else if (plugin.version !== pkg.version) {
  plugin.version = pkg.version
  await writeFile(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`)
}
