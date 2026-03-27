import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
    Logger,
    ContextualLogger,
    initializeLogger,
    getLogger,
    resetLogger,
    LogLevel,
} from './logger';

describe('Logger Module', () => {
    let originalLog: any;
    let originalWarn: any;
    let originalError: any;
    let logs: any[] = [];

    beforeEach(() => {
        logs = [];
        originalLog = console.log;
        originalWarn = console.warn;
        originalError = console.error;

        console.log = (msg: string) => logs.push({ level: 'log', msg });
        console.warn = (msg: string) => logs.push({ level: 'warn', msg });
        console.error = (msg: string) => logs.push({ level: 'error', msg });

        resetLogger();
    });

    afterEach(() => {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
        resetLogger();
    });

    describe('Logger', () => {
        it('should create logger with default level', () => {
            const logger = new Logger();
            expect(logger).toBeDefined();
        });

        it('should create logger with custom level', () => {
            const logger = new Logger('debug');
            expect(logger).toBeDefined();
        });

        it('should log debug messages', () => {
            const logger = new Logger('debug');
            logger.debug('test message');

            expect(logs.length).toBeGreaterThan(0);
            const entry = JSON.parse(logs[0].msg);
            expect(entry.level).toBe('debug');
            expect(entry.message).toBe('test message');
        });

        it('should log info messages', () => {
            const logger = new Logger('info');
            logger.info('test message');

            expect(logs.length).toBeGreaterThan(0);
            const entry = JSON.parse(logs[0].msg);
            expect(entry.level).toBe('info');
        });

        it('should log warn messages', () => {
            const logger = new Logger('warn');
            logger.warn('test message');

            expect(logs.length).toBeGreaterThan(0);
            const entry = JSON.parse(logs[0].msg);
            expect(entry.level).toBe('warn');
        });

        it('should log error messages', () => {
            const logger = new Logger('error');
            logger.error('test message');

            expect(logs.length).toBeGreaterThan(0);
            const entry = JSON.parse(logs[0].msg);
            expect(entry.level).toBe('error');
        });

        it('should include context in logs', () => {
            const logger = new Logger('info');
            logger.info('test', { userId: '123', action: 'login' });

            const entry = JSON.parse(logs[0].msg);
            expect(entry.context.userId).toBe('123');
            expect(entry.context.action).toBe('login');
        });

        it('should include error details', () => {
            const logger = new Logger('error');
            const error = new Error('Test error');
            logger.error('Something failed', error);

            const entry = JSON.parse(logs[0].msg);
            expect(entry.error.name).toBe('Error');
            expect(entry.error.message).toBe('Test error');
            expect(entry.error.stack).toBeDefined();
        });

        it('should respect log level filtering', () => {
            const logger = new Logger('warn');
            logger.debug('debug');
            logger.info('info');
            logger.warn('warn');
            logger.error('error');

            // Only warn and error should be logged
            expect(logs.length).toBe(2);
        });

        it('should set log level dynamically', () => {
            const logger = new Logger('info');
            logger.debug('debug1');
            expect(logs.length).toBe(0);

            logger.setLevel('debug');
            logger.debug('debug2');
            expect(logs.length).toBe(1);
        });

        it('should create child logger with context', () => {
            const logger = new Logger('info');
            const child = logger.child({ requestId: 'req-123' });

            expect(child).toBeInstanceOf(ContextualLogger);
        });
    });

    describe('ContextualLogger', () => {
        it('should include parent context in logs', () => {
            const logger = new Logger('info');
            const child = logger.child({ requestId: 'req-123' });

            child.info('test message');

            const entry = JSON.parse(logs[0].msg);
            expect(entry.context.requestId).toBe('req-123');
        });

        it('should merge parent and child context', () => {
            const logger = new Logger('info');
            const child = logger.child({ requestId: 'req-123' });

            child.info('test', { userId: '456' });

            const entry = JSON.parse(logs[0].msg);
            expect(entry.context.requestId).toBe('req-123');
            expect(entry.context.userId).toBe('456');
        });

        it('should allow child context to override parent', () => {
            const logger = new Logger('info');
            const child = logger.child({ key: 'parent' });

            child.info('test', { key: 'child' });

            const entry = JSON.parse(logs[0].msg);
            expect(entry.context.key).toBe('child');
        });

        it('should log errors with context', () => {
            const logger = new Logger('error');
            const child = logger.child({ requestId: 'req-123' });
            const error = new Error('Test error');

            child.error('Something failed', error);

            const entry = JSON.parse(logs[0].msg);
            expect(entry.context.requestId).toBe('req-123');
            expect(entry.error.message).toBe('Test error');
        });
    });

    describe('Global logger', () => {
        it('should initialize global logger', () => {
            const logger = initializeLogger('info');
            expect(logger).toBeDefined();
        });

        it('should return same instance on multiple calls', () => {
            const logger1 = initializeLogger('info');
            const logger2 = initializeLogger('debug');

            expect(logger1).toBe(logger2);
        });

        it('should get global logger', () => {
            initializeLogger('info');
            const logger = getLogger();

            expect(logger).toBeDefined();
        });

        it('should create default logger if not initialized', () => {
            resetLogger();
            const logger = getLogger();

            expect(logger).toBeDefined();
        });

        it('should reset logger', () => {
            initializeLogger('info');
            resetLogger();

            const logger = getLogger();
            expect(logger).toBeDefined();
        });
    });

    describe('Log entry format', () => {
        it('should include timestamp', () => {
            const logger = new Logger('info');
            logger.info('test');

            const entry = JSON.parse(logs[0].msg);
            expect(entry.timestamp).toBeDefined();
            expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0);
        });

        it('should include level', () => {
            const logger = new Logger('info');
            logger.info('test');

            const entry = JSON.parse(logs[0].msg);
            expect(entry.level).toBe('info');
        });

        it('should include message', () => {
            const logger = new Logger('info');
            logger.info('test message');

            const entry = JSON.parse(logs[0].msg);
            expect(entry.message).toBe('test message');
        });
    });
});
