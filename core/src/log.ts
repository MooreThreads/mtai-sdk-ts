import { Logger, LogLevel } from "./types";

/**
 * Creates a logger with enhanced functionality.
 * 
 * @param root - The base logger object without the push method
 * @returns A logger with the push method that allows for chaining and transformation of log calls
 * 
 * @example
 * const baseLogger = {
 *   log: console.log,
 *   error: console.error
 * };
 * 
 * const logger = createLogger(baseLogger);
 * 
 * // Use the logger directly
 * logger.log("Hello world");
 * 
 * // Use the push method to transform log calls
 * const prefixedLogger = logger.push((parent, ...args) => {
 *   parent("[PREFIX]", ...args);
 * });
 * 
 * prefixedLogger.log("This will have a prefix");
 */
export function createLogger(root: Omit<Logger, 'push'>): Logger {
    const logger = {
        ...root,
        push: (fn: (parent: (...args: any[]) => void, ...args: any[]) => void): Logger =>
            createLogger(
                Object.fromEntries(LogLevel.map(level => [level, (...args: any[]) => fn(logger[level], ...args)])) as Logger,
            )
    }
    return logger
}