/** The largest edit distance at which an unknown flag gets a hint. */
const MAX_DISTANCE = 2;

/** The Levenshtein distance between two strings. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The known flag name nearest to an unknown name, or undefined when no name is at an edit distance
 * of MAX_DISTANCE or less. A tie goes to the first name in the list.
 */
export function nearestFlag(name: string, known: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = MAX_DISTANCE + 1;
  for (const candidate of known) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
