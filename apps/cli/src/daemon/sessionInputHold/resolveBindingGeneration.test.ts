import { describe, expect, it } from 'vitest';
import { resolveBindingGeneration } from './resolveBindingGeneration';

describe('resolveBindingGeneration', () => {
  it('uses the immutable creation time for an initial binding', () => {
    expect(resolveBindingGeneration(undefined, 1790445118786)).toBe(1790445118786);
  });

  it('changes generation when a profile switch is confirmed', () => {
    expect(resolveBindingGeneration(1790445241960, 1790445118786)).toBe(1790445241960);
  });

  it('does not invent a generation when neither server timestamp is valid', () => {
    expect(resolveBindingGeneration(null, undefined)).toBeNull();
    expect(resolveBindingGeneration('1790445241960', 1790445118786)).toBe(1790445118786);
  });
});
