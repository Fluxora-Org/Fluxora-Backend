

export interface RedisConfig {
    url: string;
    enabled: boolean;
}

export interface RedisClient {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { ex?: number }): Promise<void>;
    exists(key: string): Promise<boolean>;
    close(): Promise<void>;
}

export interface RedisClientFactory {
    createClient(config: RedisConfig): Promise<RedisClient>;
}

class IORedisClient implements RedisClient {
    private client: import('ioredis').Redis;

    constructor(client: import('ioredis').Redis) {
        this.client = client;
    }

    async get(key: string): Promise<string | null> {
        return this.client.get(key) as Promise<string | null>;
    }

    async set(key: string, value: string, options?: { ex?: number }): Promise<void> {
        if (options?.ex) {
            await this.client.set(key, value, 'EX', options.ex);
        } else {
            await this.client.set(key, value);
        }
    }

    async exists(key: string): Promise<boolean> {
        const result = await this.client.exists(key);
        return result === 1;
    }

    async close(): Promise<void> {
        await this.client.quit();
    }
}

export class DefaultRedisClientFactory implements RedisClientFactory {
    async createClient(config: RedisConfig): Promise<RedisClient> {
        const { URL } = await import('url');
        const ioredis = await import('ioredis');
        const url = new URL(config.url);
        const port = parseInt(url.port ?? '6379', 10);
        const host = url.hostname ?? 'localhost';
        const password = url.password || undefined;

        const client = new ioredis.default(host, port, {
            password,
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            connectTimeout: 5000,
        });

        await client.connect();
        return new IORedisClient(client);
    }
}

let factory: RedisClientFactory = new DefaultRedisClientFactory();

export function setRedisClientFactory(f: RedisClientFactory): void {
    factory = f;
}

export function getRedisClientFactory(): RedisClientFactory {
    return factory;
}

export async function createRedisClient(config: RedisConfig): Promise<RedisClient> {
    return factory.createClient(config);
}

export class NoOpRedisClient implements RedisClient {
    async get(): Promise<string | null> {
        return null;
    }
    async set(): Promise<void> {
        return;
    }
    async exists(): Promise<boolean> {
        return false;
    }
    async close(): Promise<void> {
        return;
    }
}