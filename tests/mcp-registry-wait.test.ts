import { describe, expect, it } from 'vitest';
import { waitForNpmVersion } from '../scripts/mcp-registry.js';

/**
 * A fake npm on a fake clock: each request answers the next status (or throws
 * for an Error) and takes `requestMs`; sleeping advances the clock.
 */
function fakeNpm(answers: (number | Error)[], requestMs = 0) {
  let clock = 0;
  const urls: string[] = [];
  const waits: number[] = [];
  const budgets: number[] = [];
  return {
    urls,
    waits,
    budgets,
    now: () => clock,
    fetch: async (url: string, timeoutMs: number) => {
      urls.push(url);
      budgets.push(timeoutMs);
      clock += requestMs;
      const answer = answers.shift() ?? 404;
      if (answer instanceof Error) throw answer;
      return { status: answer };
    },
    sleep: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    log: () => undefined,
  };
}

const PKG = {
  registryBaseUrl: 'https://registry.npmjs.org/',
  identifier: '@makemyclip/editor',
  version: '0.5.0',
};

describe('waitForNpmVersion', () => {
  it('polls the version metadata until npm serves it', async () => {
    const npm = fakeNpm([404, 404, 200]);
    await waitForNpmVersion({ ...PKG, ...npm, intervalMs: 20_000 });
    expect(npm.urls).toEqual(
      Array(3).fill('https://registry.npmjs.org/@makemyclip%2feditor/0.5.0'),
    );
    expect(npm.waits).toEqual([20_000, 20_000]);
  });

  it('returns at once when the version is already there', async () => {
    const npm = fakeNpm([200]);
    await waitForNpmVersion({ ...PKG, ...npm });
    expect(npm.waits).toEqual([]);
  });

  it('retries a network error instead of giving up', async () => {
    const npm = fakeNpm([new Error('getaddrinfo EAI_AGAIN registry.npmjs.org'), 404, 200]);
    await waitForNpmVersion({ ...PKG, ...npm });
    expect(npm.urls).toHaveLength(3);
  });

  it('gives up at the deadline with the last answer, the URL and the manual route', async () => {
    const npm = fakeNpm([]);
    await expect(
      waitForNpmVersion({ ...PKG, ...npm, timeoutMs: 60_000, intervalMs: 20_000 }),
    ).rejects.toThrow(
      /still answers 404 for @makemyclip\/editor@0\.5\.0 after 60 s.*RELEASING\.md/,
    );
    expect(npm.urls).toHaveLength(4);
  });

  it('counts slow requests against the deadline and bounds each one by what is left', async () => {
    // Each request takes 25 s: with a 60 s budget that's two requests, not four.
    const npm = fakeNpm([], 25_000);
    await expect(
      waitForNpmVersion({ ...PKG, ...npm, timeoutMs: 60_000, intervalMs: 20_000 }),
    ).rejects.toThrow(/after 70 s/);
    expect(npm.urls).toHaveLength(2);
    expect(npm.budgets).toEqual([30_000, 15_000]);
    expect(npm.waits).toEqual([20_000]);
  });

  it('waits long enough for npm’s observed lag by default', async () => {
    // 0.5.0 took about 4.5 minutes to appear; the default allows 20.
    const npm = fakeNpm(Array(14).fill(404).concat(200));
    await waitForNpmVersion({ ...PKG, ...npm });
    expect(npm.waits).toHaveLength(14);
  });
});
