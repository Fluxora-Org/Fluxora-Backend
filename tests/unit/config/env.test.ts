const TESTNET_CONTRACT = 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIC';
const TESTNET_TOKEN = 'CBFFW3D5R2P3BQOS4P2AKFRHHBEVU234RWPK7QGR4LZQIFJGG5EFTAK6';
const MAINNET_CONTRACT = 'CBXYBENCWPCNLZXXBAMSUO2MLVXH7EFBWLB5JZPWA4MCSOSLLRWX5OUA';
const MAINNET_TOKEN = 'CCKKLNWH3DU7UCY4FU7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHTZ5';
const VALID_UNPINNED_CONTRACT = 'CASTMR2YNF5IXHFNX3H6B4ICCMSDKRSXNB4YVG5MXXHN74ABCIRTISIA';

function setBaseEnv(overrides: NodeJS.ProcessEnv = {}) {
  process.env = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/fluxora_test',
    JWT_SECRET: 'a-very-long-secret-key-for-testing-only-12345',
    INDEXER_WORKER_TOKEN: 'indexer-worker-token-for-testing-only-12345',
    STELLAR_NETWORK: 'testnet',
    STELLAR_CONTRACT_ADDRESS: TESTNET_CONTRACT,
    STELLAR_TOKEN_ADDRESS: TESTNET_TOKEN,
    ...overrides,
  };
}

async function loadEnvModule() {
  vi.resetModules();
  return import('../../../src/config/env');
}

describe('stellar environment pinning', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('accepts known-good testnet contract and token addresses', async () => {
    setBaseEnv();

    const { loadConfig, STELLAR_NETWORK_PASSPHRASES } = await loadEnvModule();
    const config = loadConfig();

    expect(config.stellarNetwork).toBe('testnet');
    expect(config.horizonNetworkPassphrase).toBe(STELLAR_NETWORK_PASSPHRASES.testnet);
    expect(config.contractAddresses.contract).toBe(TESTNET_CONTRACT);
    expect(config.contractAddresses.streaming).toBe(TESTNET_CONTRACT);
    expect(config.contractAddresses.token).toBe(TESTNET_TOKEN);
  });

  it('accepts known-good mainnet contract and token addresses', async () => {
    setBaseEnv({
      NODE_ENV: 'production',
      STELLAR_NETWORK: 'mainnet',
      STELLAR_CONTRACT_ADDRESS: MAINNET_CONTRACT,
      STELLAR_TOKEN_ADDRESS: MAINNET_TOKEN,
      PGCRYPTO_KEY: 'a-very-long-pgcrypto-key-for-testing-only-12345',
    });

    const { loadConfig, STELLAR_NETWORK_PASSPHRASES } = await loadEnvModule();
    const config = loadConfig();

    expect(config.stellarNetwork).toBe('mainnet');
    expect(config.horizonNetworkPassphrase).toBe(STELLAR_NETWORK_PASSPHRASES.mainnet);
    expect(config.contractAddresses.contract).toBe(MAINNET_CONTRACT);
    expect(config.contractAddresses.token).toBe(MAINNET_TOKEN);
  });

  it('halts startup when a mainnet contract is configured for testnet', async () => {
    setBaseEnv({ STELLAR_CONTRACT_ADDRESS: MAINNET_CONTRACT });

    await expect(loadEnvModule()).rejects.toThrow(
      'STELLAR_CONTRACT_ADDRESS is pinned for mainnet but STELLAR_NETWORK resolves to testnet'
    );
  });

  it('halts startup when the token address belongs to the other network', async () => {
    setBaseEnv({ STELLAR_TOKEN_ADDRESS: MAINNET_TOKEN });

    await expect(loadEnvModule()).rejects.toThrow(
      'STELLAR_TOKEN_ADDRESS is pinned for mainnet but STELLAR_NETWORK resolves to testnet'
    );
  });

  it('rejects non-contract StrKey prefixes', async () => {
    setBaseEnv({
      STELLAR_CONTRACT_ADDRESS: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZWM9CQJKR3BSQNEWVZOR',
    });

    await expect(loadEnvModule()).rejects.toThrow(
      'STELLAR_CONTRACT_ADDRESS must be a Stellar contract StrKey beginning with C'
    );
  });

  it('rejects missing pinned contract addresses', async () => {
    setBaseEnv();
    delete process.env.STELLAR_CONTRACT_ADDRESS;

    await expect(loadEnvModule()).rejects.toThrow('STELLAR_CONTRACT_ADDRESS: required');
  });

  it('rejects valid contract StrKeys that are not allowlisted', async () => {
    setBaseEnv({ STELLAR_CONTRACT_ADDRESS: VALID_UNPINNED_CONTRACT });

    await expect(loadEnvModule()).rejects.toThrow(
      'STELLAR_CONTRACT_ADDRESS is not in the known-good testnet contract address allowlist'
    );
  });

  it('rejects passphrase overrides that do not match STELLAR_NETWORK', async () => {
    setBaseEnv({ HORIZON_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015' });

    await expect(loadEnvModule()).rejects.toThrow(
      'HORIZON_NETWORK_PASSPHRASE must match testnet passphrase'
    );
  });
});

describe('local stellar network configuration', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('accepts valid unpinned contract and token addresses for local network', async () => {
    setBaseEnv({
      STELLAR_NETWORK: 'local',
      STELLAR_CONTRACT_ADDRESS: TESTNET_CONTRACT,
      STELLAR_TOKEN_ADDRESS: TESTNET_TOKEN,
    });

    const { loadConfig, STELLAR_NETWORK_PASSPHRASES } = await loadEnvModule();
    const config = loadConfig();

    expect(config.stellarNetwork).toBe('local');
    expect(config.horizonUrl).toBe('http://localhost:8000');
    expect(config.horizonNetworkPassphrase).toBe(STELLAR_NETWORK_PASSPHRASES.local);
    expect(config.contractAddresses.contract).toBe(TESTNET_CONTRACT);
    expect(config.contractAddresses.streaming).toBe(TESTNET_CONTRACT);
    expect(config.contractAddresses.token).toBe(TESTNET_TOKEN);
  });

  it('allows HORIZON_URL override and matching passphrase for local network', async () => {
    setBaseEnv({
      STELLAR_NETWORK: 'local',
      STELLAR_CONTRACT_ADDRESS: TESTNET_CONTRACT,
      STELLAR_TOKEN_ADDRESS: TESTNET_TOKEN,
      HORIZON_URL: 'http://custom-local:8000',
      HORIZON_NETWORK_PASSPHRASE: 'Standalone Network ; February 2017',
    });

    const { loadConfig } = await loadEnvModule();
    const config = loadConfig();

    expect(config.horizonUrl).toBe('http://custom-local:8000');
    expect(config.horizonNetworkPassphrase).toBe('Standalone Network ; February 2017');
  });

  it('rejects invalid passphrase override for local network', async () => {
    setBaseEnv({
      STELLAR_NETWORK: 'local',
      STELLAR_CONTRACT_ADDRESS: TESTNET_CONTRACT,
      STELLAR_TOKEN_ADDRESS: TESTNET_TOKEN,
      HORIZON_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    });

    await expect(loadEnvModule()).rejects.toThrow(
      'HORIZON_NETWORK_PASSPHRASE must match local passphrase'
    );
  });

  it('rejects missing STELLAR_CONTRACT_ADDRESS for local network', async () => {
    setBaseEnv({ STELLAR_NETWORK: 'local' });
    delete process.env.STELLAR_CONTRACT_ADDRESS;

    await expect(loadEnvModule()).rejects.toThrow('STELLAR_CONTRACT_ADDRESS: required');
  });

  it('rejects missing STELLAR_TOKEN_ADDRESS for local network', async () => {
    setBaseEnv({ STELLAR_NETWORK: 'local' });
    delete process.env.STELLAR_TOKEN_ADDRESS;

    await expect(loadEnvModule()).rejects.toThrow('STELLAR_TOKEN_ADDRESS: required');
  });

  it('rejects invalid contract address formatting for local network', async () => {
    setBaseEnv({
      STELLAR_NETWORK: 'local',
      STELLAR_CONTRACT_ADDRESS: 'CLOCALPLACEHOLDER000000000000000000000000000000000000000',
      STELLAR_TOKEN_ADDRESS: TESTNET_TOKEN,
    });

    await expect(loadEnvModule()).rejects.toThrow(
      'STELLAR_CONTRACT_ADDRESS must be a Stellar contract StrKey beginning with C'
    );
  });
});

describe('API key and pepper validation', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('allows startup when neither API_KEYS nor API_KEY_PEPPER are configured', async () => {
    setBaseEnv();
    delete process.env.API_KEYS;
    delete process.env.API_KEY_PEPPER;

    const { loadConfig } = await loadEnvModule();
    expect(() => loadConfig()).not.toThrow();
  });

  it('allows startup when API_KEYS is empty and API_KEY_PEPPER is missing', async () => {
    setBaseEnv({ API_KEYS: '' });
    delete process.env.API_KEY_PEPPER;

    const { loadConfig } = await loadEnvModule();
    expect(() => loadConfig()).not.toThrow();
  });

  it('allows startup when both API_KEYS and API_KEY_PEPPER are configured', async () => {
    setBaseEnv({
      API_KEYS: 'key1,key2',
      API_KEY_PEPPER: 'a-very-long-pepper-key-for-testing-only-123',
    });

    const { loadConfig } = await loadEnvModule();
    expect(() => loadConfig()).not.toThrow();
  });

  it('halts startup when API_KEYS is configured but API_KEY_PEPPER is missing', async () => {
    setBaseEnv({ API_KEYS: 'key1,key2' });
    delete process.env.API_KEY_PEPPER;

    await expect(loadEnvModule()).rejects.toThrow(
      'API_KEY_PEPPER is required when API_KEYS is configured'
    );
  });
});
