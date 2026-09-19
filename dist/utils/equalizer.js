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
        // Gentle subtractive contour: retain bass/presence, reduce low-mid masking.
        // No fixed curve can guarantee clip-free output for every recording.
        0: 0, 1: 0, 2: 0, 3: -0.01, 4: -0.04,
        5: -0.05, 6: -0.04, 7: -0.02, 8: 0, 9: 0,
        10: 0, 11: 0, 12: 0, 13: -0.01, 14: -0.01,
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
