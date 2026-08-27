import fs from "fs/promises"
import path from "path"
import { memoryDir } from "./storage.js"

const LOG_FILE = "plugin.log"

export type LogLevel = "INFO" | "ERROR"

export type Logger = {
  info(action: string, detail?: string): Promise<void>
  error(action: string, err: unknown): Promise<void>
}

/**
 * Create a logger that appends structured entries to
 * <projectDir>/.opencode/memory/plugin.log.
 *
 * When enabled=false, all methods are no-ops.
 */
export function createLogger(projectDir: string, enabled: boolean): Logger {
  if (!enabled) {
    return {
      async info() {},
      async error() {},
    }
  }

  const logPath = path.join(memoryDir(projectDir), LOG_FILE)

  async function append(level: LogLevel, action: string, detail: string): Promise<void> {
    const ts = new Date().toISOString()
    const line = `${ts} [${level}] ${action}${detail ? " — " + detail : ""}\n`
    try {
      await fs.mkdir(memoryDir(projectDir), { recursive: true })
      await fs.appendFile(logPath, line, "utf8")
    } catch {
      // Logging must never crash the plugin; silently swallow I/O errors
    }
  }

  return {
    async info(action, detail = "") {
      await append("INFO", action, detail)
    },
    async error(action, err) {
      const msg = err instanceof Error ? err.message : String(err)
      await append("ERROR", action, msg)
    },
  }
}
