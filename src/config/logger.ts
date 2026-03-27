/**
 * Logger module for Fluxora Backend
 * 
 * Provides structured logging for operational observability.
 * Operators can diagnose incidents by reviewing logs without tribal knowledge.
 * 
 * Log levels:
 * - debug: Development and detailed diagnostics
 * - info: Normal operational events
 * - warn: Degraded conditions, recoverable errors
 * - error: Failures requiring operator attention
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    context?: Record<string, unknown>;
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
}

/**
 * Logger instance for structured logging
 */
export class Logger {
    private minLevel: LogLevel;
    private levelOrder: Record<LogLevel, number> = {
        debug: 0,
        info: 1,
        warn: 2,
        error: 3,
    };

    constructor(minLevel: LogLevel = 'info') {
        this.minLevel = minLevel;
    }

    /**
     * Check if a log level should be emitted
     */
    private shouldLog(level: LogLevel): boolean {
        return this.levelOrder[level] >= this.levelOrder[this.minLevel];
    }

    /**
     * Format and emit a log entry
     */
    private emit(entry: LogEntry): void {
        if (!this.shouldLog(entry.level)) {
            return;
        }

        const output = {
            ...entry,
            timestamp: new Date().toISOString(),
        };

        // Use appropriate console method
        const method = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'log';
        console[method](JSON.stringify(output));
    }

    /**
     * Log debug message
     */
    debug(message: string, context?: Record<string, unknown>): void {
        this.emit({ timestamp: '', level: 'debug', message, context });
    }

    /**
     * Log info message
     */
    info(message: string, context?: Record<string, unknown>): void {
        this.emit({ timestamp: '', level: 'info', message, context });
    }

    /**
     * Log warning message
     */
    warn(message: string, context?: Record<string, unknown>): void {
        this.emit({ timestamp: '', level: 'warn', message, context });
    }

    /**
     * Log error message
     */
    error(message: string, error?: Error, context?: Record<string, unknown>): void {
        const errorInfo = error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
            }
            : undefined;

        this.emit({
            timestamp: '',
            level: 'error',
            message,
            context,
            error: errorInfo,
        });
    }

    /**
     * Create a child logger with additional context
     */
    child(context: Record<string, unknown>): ContextualLogger {
        return new ContextualLogger(this, context);
    }

    /**
     * Set minimum log level
     */
    setLevel(level: LogLevel): void {
        this.minLevel = level;
    }
}

/**
 * Logger with persistent context (e.g., request ID, user ID)
 */
export class ContextualLogger {
    constructor(
        private logger: Logger,
        private context: Record<string, unknown>
    ) { }

    debug(message: string, context?: Record<string, unknown>): void {
        this.logger.debug(message, { ...this.context, ...context });
    }

    info(message: string, context?: Record<string, unknown>): void {
        this.logger.info(message, { ...this.context, ...context });
    }

    warn(message: string, context?: Record<string, unknown>): void {
        this.logger.warn(message, { ...this.context, ...context });
    }

    error(message: string, error?: Error, context?: Record<string, unknown>): void {
        this.logger.error(message, error, { ...this.context, ...context });
    }
}

/**
 * Global logger instance
 */
let globalLogger: Logger | null = null;

/**
 * Initialize global logger
 */
export function initializeLogger(level: LogLevel = 'info'): Logger {
    if (globalLogger) {
        return globalLogger;
    }

    globalLogger = new Logger(level);
    return globalLogger;
}

/**
 * Get global logger instance
 */
export function getLogger(): Logger {
    if (!globalLogger) {
        globalLogger = new Logger('info');
    }
    return globalLogger;
}

/**
 * Reset logger (for testing)
 */
export function resetLogger(): void {
    globalLogger = null;
}
