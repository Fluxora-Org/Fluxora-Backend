export interface LogContext {
  requestId?: string | undefined;
  correlationId?: string | undefined;
  [key: string]: unknown;
}

export function info(message: string, context: LogContext = {}): void {
  console.log(JSON.stringify({ level: 'info', message, timestamp: new Date().toISOString(), ...context }));
}

export function warn(message: string, context: LogContext = {}): void {
  console.warn(JSON.stringify({ level: 'warn', message, timestamp: new Date().toISOString(), ...context }));
}

export function error(message: string, context: LogContext = {}, err?: Error): void {
  console.error(JSON.stringify({ 
    level: 'error', 
    message, 
    timestamp: new Date().toISOString(), 
    ...context, 
    error: err?.message, 
    stack: err?.stack 
  }));
}

export function debug(message: string, context: LogContext = {}): void {
  if (process.env.LOG_LEVEL === 'debug') {
    console.debug(JSON.stringify({ level: 'debug', message, timestamp: new Date().toISOString(), ...context }));
  }
}

export const SerializationLogger = {
  validationFailed: (field: string, raw: unknown, code: string, requestId?: string) => {
    warn(`Decimal validation failed: ${field}`, { field, raw, code, requestId });
  },
  amountSerialized: (count: number, requestId?: string) => {
    debug(`Amounts serialized: ${count}`, { requestId });
  }
};
