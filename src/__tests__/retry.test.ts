import { withRetry } from '../utils/retry';

describe('withRetry', () => {
  it('resolves immediately on first success', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 'ok'; }, { attempts: 3, delayMs: 10 });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('fail');
        return 'success';
      },
      { attempts: 3, delayMs: 10 },
    );
    expect(result).toBe('success');
    expect(calls).toBe(3);
  });

  it('throws after all attempts exhausted', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => { calls++; throw new Error('always fails'); },
        { attempts: 3, delayMs: 10 },
      ),
    ).rejects.toThrow('always fails');
    expect(calls).toBe(3);
  });

  it('calls onRetry callback on each retry', async () => {
    const retries: number[] = [];
    await withRetry(
      async () => { throw new Error('x'); },
      {
        attempts: 3,
        delayMs: 10,
        onRetry: (_, attempt) => retries.push(attempt),
      },
    ).catch(() => {});
    expect(retries).toEqual([1, 2]);
  });
});
