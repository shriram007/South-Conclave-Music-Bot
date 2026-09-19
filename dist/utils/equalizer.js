/**
 * Helper to generate full 15-band Equalizer curves with no sparse holes or nulls
 */
export function createFullEQ(bandGains) {
    return Array.from({ length: 15 }, (_, i) => ({
        band: i,
        gain: typeof bandGains[i] === "number" ? bandGains[i] : 0.0,
    }));
}
export const EQ_PRESETS = {
    hifi: createFullEQ({
        // Audiophile studio curve with headroom protection (prevents digital clipping on loud/Indian masters)
        0: 0.06, 1: 0.05, 2: 0.02, 3: 0.0, 4: -0.02,
        5: -0.02, 6: 0.0, 7: 0.02, 8: 0.04, 9: 0.05,
        10: 0.06, 11: 0.07, 12: 0.07, 13: 0.06, 14: 0.04,
    }),
    bassboost: createFullEQ({
        0: 0.22, 1: 0.18, 2: 0.12, 3: 0.05, 4: 0.0,
        5: -0.03, 6: -0.04, 7: -0.05, 8: -0.05, 9: -0.05,
        10: -0.05, 11: -0.05, 12: -0.05, 13: -0.05, 14: -0.05,
    }),
    nuclear: createFullEQ({
        0: 0.45, 1: 0.40, 2: 0.30, 3: 0.18, 4: 0.08,
    }),
    treble: createFullEQ({
        0: -0.05, 1: -0.05, 2: -0.04, 3: -0.03, 4: -0.02,
        8: 0.04, 9: 0.06, 10: 0.08, 11: 0.08, 12: 0.07, 13: 0.05, 14: 0.03,
    }),
    radio: createFullEQ({
        0: -0.20, 1: -0.20, 2: -0.15, 3: -0.10, 5: 0.15, 6: 0.25, 7: 0.20, 8: 0.10,
        11: -0.15, 12: -0.20, 13: -0.20, 14: -0.20,
    }),
    nextdoor: createFullEQ({
        0: 0.25, 1: 0.20, 2: 0.15, 3: 0.05, 5: -0.08, 6: -0.12, 7: -0.15,
        8: -0.20, 9: -0.20, 10: -0.20, 11: -0.20, 12: -0.20, 13: -0.20, 14: -0.20,
    }),
    megaphone: createFullEQ({
        0: -0.20, 1: -0.20, 2: -0.15, 3: -0.08,
        6: 0.22, 7: 0.30, 8: 0.22, 9: 0.12,
        12: -0.15, 13: -0.20, 14: -0.20,
    }),
    flat: createFullEQ({}),
};
