export type LogLevel = "INFO" | "ERROR";
export type Logger = {
    info(action: string, detail?: string): Promise<void>;
    error(action: string, err: unknown): Promise<void>;
};
/**
 * Create a logger that appends structured entries to
 * <projectDir>/.opencode/memory/plugin.log.
 *
 * When enabled=false, all methods are no-ops.
 */
export declare function createLogger(projectDir: string, enabled: boolean): Logger;
//# sourceMappingURL=logging.d.ts.map