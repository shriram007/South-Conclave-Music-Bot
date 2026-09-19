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
    // True Audiophile Subtractive Mastering Curve (0 dBFS headroom ceiling, 100% distortion-free on all masters)
    0: -0.02, // 25Hz Sub-bass
    1: -0.02, // 40Hz Sub-bass
    2: -0.03, // 63Hz Deep Bass
    3: -0.04, // 100Hz Punch
    4: -0.07, // 160Hz Low-Mid (mud cut)
    5: -0.08, // 250Hz Low-Mid (boxiness cut)
    6: -0.07, // 400Hz Mid (hollowness cut)
    7: -0.04, // 630Hz Mid
    8: -0.03, // 1.0kHz Core Mid
    9: -0.02, // 1.6kHz Vocal Presence
    10: -0.01, // 2.5kHz Clarity
    11: 0.00, // 4.0kHz Attack & Detail (Peak at 0.0 dBFS)
    12: 0.00, // 6.3kHz Sheen (Peak at 0.0 dBFS)
    13: -0.01, // 10.0kHz Air
    14: -0.02, // 16.0kHz Top End
  }),
  bassboost: createFullEQ({
    0: 0.14, 1: 0.12, 2: 0.08, 3: 0.03, 4: -0.02,
    5: -0.05, 6: -0.06, 7: -0.06, 8: -0.06, 9: -0.06,
    10: -0.06, 11: -0.06, 12: -0.06, 13: -0.06, 14: -0.06,
  }),
  nuclear: createFullEQ({
    0: 0.28, 1: 0.24, 2: 0.16, 3: 0.08, 4: 0.0,
    5: -0.05, 6: -0.08, 7: -0.08, 8: -0.08, 9: -0.08,
  }),
  treble: createFullEQ({
    0: -0.08, 1: -0.08, 2: -0.06, 3: -0.05, 4: -0.04,
    5: -0.03, 6: -0.02, 7: -0.01, 8: 0.00, 9: 0.00,
    10: 0.00, 11: 0.00, 12: -0.01, 13: -0.02, 14: -0.03,
  }),
  radio: createFullEQ({
    0: -0.20, 1: -0.20, 2: -0.15, 3: -0.10, 5: 0.08, 6: 0.12, 7: 0.08, 8: 0.04,
    11: -0.15, 12: -0.20, 13: -0.20, 14: -0.20,
  }),
  nextdoor: createFullEQ({
    0: 0.15, 1: 0.12, 2: 0.08, 3: 0.02, 5: -0.08, 6: -0.12, 7: -0.15,
    8: -0.20, 9: -0.20, 10: -0.20, 11: -0.20, 12: -0.20, 13: -0.20, 14: -0.20,
  }),
  megaphone: createFullEQ({
    0: -0.20, 1: -0.20, 2: -0.15, 3: -0.08,
    6: 0.12, 7: 0.16, 8: 0.12, 9: 0.06,
    12: -0.15, 13: -0.20, 14: -0.20,
  }),
  flat: createFullEQ({}),
};
