/**
 * Helper to generate full 15-band Equalizer curves with no sparse holes or nulls
 */
export function createFullEQ(bandGains: Record<number, number>): { band: number; gain: number }[] {
  return Array.from({ length: 15 }, (_, i) => ({
    band: i,
    gain: typeof bandGains[i] === "number" ? bandGains[i] : 0.0,
  }));
}

export const EQ_PRESETS = {
  hifi: createFullEQ({
    0: 0.18, 1: 0.14, 2: 0.08, 3: 0.02, 4: 0.0,
    5: 0.02, 6: 0.05, 7: 0.08, 8: 0.10, 9: 0.12,
    10: 0.15, 11: 0.18, 12: 0.22, 13: 0.25, 14: 0.25,
  }),
  bassboost: createFullEQ({
    0: 0.40, 1: 0.35, 2: 0.30, 3: 0.20, 4: 0.10,
  }),
  treble: createFullEQ({
    8: 0.15, 9: 0.20, 10: 0.25, 11: 0.30, 12: 0.35, 13: 0.40, 14: 0.40,
  }),
  flat: createFullEQ({}),
};
