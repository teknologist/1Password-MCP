/**
 * Tests for src/client.ts — 1Password SDK client singleton.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@1password/sdk', () => ({ createClient: vi.fn() }));

import { createClient } from '@1password/sdk';
import { getClient, resetClient } from '../src/client.js';
import { resetConfig } from '../src/config.js';

type Client = Awaited<ReturnType<typeof createClient>>;

describe('getClient', () => {
  const originalToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;

  beforeEach(() => {
    resetClient();
    resetConfig();
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_test-token';
    vi.mocked(createClient).mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined)
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    else process.env.OP_SERVICE_ACCOUNT_TOKEN = originalToken;
    resetClient();
    resetConfig();
  });

  it('reuses one client across calls', async () => {
    const client = {} as Client;
    vi.mocked(createClient).mockResolvedValue(client);

    await expect(getClient()).resolves.toBe(client);
    await expect(getClient()).resolves.toBe(client);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  // A transient failure (the SDK reports network errors as "request library
  // compatibility issue") must not wedge every later tool call until restart.
  it('retries after a failed initialization', async () => {
    const client = {} as Client;
    vi.mocked(createClient)
      .mockRejectedValueOnce(new Error('error sending request'))
      .mockResolvedValueOnce(client);

    await expect(getClient()).rejects.toThrow('error sending request');
    await expect(getClient()).resolves.toBe(client);
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});
