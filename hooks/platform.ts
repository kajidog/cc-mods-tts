/** Quotes a literal for PowerShell, including the smart quotes it treats as delimiters. */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, quote => quote + quote)}'`
}

/** Keep paths containing Japanese readable when Windows PowerShell writes to a pipe. */
export function powershellCommand(script: string): string[] {
  return [
    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); ${script}`,
  ]
}

/** Unix uses mode 0700; Windows inherits the user's temporary folder permissions. */
export function tempDirectoryCommand(isWindows: boolean): string[] {
  return isWindows
    ? powershellCommand("$path = Join-Path ([IO.Path]::GetTempPath()) ('claude-tts-' + [Guid]::NewGuid().ToString('N')); [IO.Directory]::CreateDirectory($path).FullName")
    : ["mktemp", "-d", "/tmp/claude-tts-XXXXXXXXXX"]
}

export function removeFilesCommand(files: string[], isWindows: boolean): string[] {
  return isWindows
    ? powershellCommand(`Remove-Item -LiteralPath ${files.map(quotePowerShell).join(", ")} -Force -ErrorAction SilentlyContinue; exit 0`)
    : ["rm", "-f", ...files]
}

export function removeDirectoryCommand(directory: string, isWindows: boolean): string[] {
  return isWindows
    ? powershellCommand(`Remove-Item -LiteralPath ${quotePowerShell(directory)} -Recurse -Force -ErrorAction SilentlyContinue; exit 0`)
    : ["rm", "-rf", "--", directory]
}

export function findProgramCommand(program: string, isWindows: boolean): string[] {
  return isWindows ? ["where.exe", program] : ["sh", "-c", 'command -v "$1" >/dev/null', "probe", program]
}
