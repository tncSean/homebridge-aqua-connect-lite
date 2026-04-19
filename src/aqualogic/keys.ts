/**
 * Hayward Pro Logic keycodes for wireless-key-event frames (type 0x00 0x83).
 *
 * Each key is a single bit in a 32-bit little-endian mask. Sending a frame
 * with a key bit set is equivalent to pressing that key on the attached
 * keypad. Ported from swilson/aqualogic keys.py.
 */
export const Key = {
    RIGHT:      0x00000001,
    MENU:       0x00000002,
    LEFT:       0x00000004,
    SERVICE:    0x00000008,
    MINUS:      0x00000010,
    PLUS:       0x00000020,
    POOL_SPA:   0x00000040,
    FILTER:     0x00000080,
    LIGHTS:     0x00000100,
    AUX_1:      0x00000200,
    AUX_2:      0x00000400,
    AUX_3:      0x00000800,
    AUX_4:      0x00001000,
    AUX_5:      0x00002000,
    AUX_6:      0x00004000,
    AUX_7:      0x00008000,
    VALVE_3:    0x00010000,
    VALVE_4:    0x00020000,
    HEATER_1:   0x00040000,
    AUX_8:      0x00080000,
    AUX_9:      0x00100000,
    AUX_10:     0x00200000,
    AUX_11:     0x00400000,
    AUX_12:     0x00800000,
    AUX_13:     0x01000000,
    AUX_14:     0x02000000,
} as const;

export type KeyName = keyof typeof Key;
export type KeyValue = typeof Key[KeyName];

/** Map from string name (case-insensitive) to KeyValue; throws on unknown. */
export function keyFromName(name: string): KeyValue {
    const k = name.toUpperCase() as KeyName;
    const v = Key[k];
    if (v === undefined) throw new Error(`Unknown Pro Logic key: ${name}`);
    return v;
}
