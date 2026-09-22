import { mapWithConcurrency } from '../../../src/utils/concurrency';

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    const result = await mapWithConcurrency([30, 5, 15], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(result).toEqual([30, 5, 15]);
  });

  it('never runs more than `concurrency` calls at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return null;
    });
    expect(peak).toBe(2);
  });

  it('handles an empty list and a concurrency larger than the list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('rejects with the failure when one call throws', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) {
          throw new Error('boom');
        }
        return n;
      })
    ).rejects.toThrow('boom');
  });
});
