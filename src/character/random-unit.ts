/** One draw from a random source must be a finite unit-interval value. */
export type RandomUnit = () => number;

export const INVALID_RANDOM_UNIT_MESSAGE = "random unit must be a finite number in [0, 1)";

export class RandomUnitError extends RangeError {
  constructor() {
    super(INVALID_RANDOM_UNIT_MESSAGE);
    this.name = "RandomUnitError";
  }
}

/** Calls the underlying source exactly once, then validates that single draw. */
export function drawRandomUnit(source: RandomUnit): number {
  const unit = source();
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) throw new RandomUnitError();
  return unit;
}
