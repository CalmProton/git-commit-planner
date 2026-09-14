import { describe, expect, test } from 'bun:test';
import { buildCodexAppServerArgs } from '../src/codexAppServer';
import { PhaseTimer } from '../src/timing';

describe('performance timing', () => {
  test('records asynchronous and synchronous phases', async () => {
    let currentTime = 100;
    const timer = new PhaseTimer(() => currentTime);

    await timer.measure('first phase', async () => {
      currentTime += 12.34;
    });
    timer.measureSync('second phase', () => {
      currentTime += 7.66;
    });

    expect(timer.snapshot()).toEqual({
      totalMs: 20,
      phases: [
        { phase: 'first phase', durationMs: 12.3 },
        { phase: 'second phase', durationMs: 7.7 }
      ]
    });
  });

  test('adds Codex Fast mode arguments only when enabled', () => {
    expect(buildCodexAppServerArgs()).toEqual(['app-server', '--stdio']);
    expect(buildCodexAppServerArgs(true)).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'service_tier="fast"',
      '-c',
      'features.fast_mode=true'
    ]);
  });
});
