/**
 * Platform and plugin constants
 */
export const PLATFORM_NAME = 'AquaConnectLite';
export const PLUGIN_NAME = 'homebridge-aqua-connect-lite';

/**
 * Aqua Connect API settings
 *
 * The controller exposes a web interface at /WNewSt.htm that accepts
 * POST requests to simulate button presses and read status.
 */
export const AC_API_SETTINGS = {
    /** Endpoint for status queries and button presses */
    PATH: '/WNewSt.htm',
    /** POST body for status query (simulates "Update Local Server" button) */
    UPDATE_LOCAL_SERVER_POST_BODY: 'Update Local Server&'
};

/**
 * Supported accessory types
 */
export const ACCESSORY_TYPE = {
    LIGHT: 'light' as const,
    SWITCH: 'switch' as const
};

/**
 * Default accessory definitions
 *
 * Each accessory maps to a physical control on the pool controller.
 * - PROCESS_KEY_NUM: The KeyId to send when toggling (simulates button press)
 * - STATUS_KEY_INDEX: Index into the LED status byte string for reading state
 *
 * To add Aux 3-6 or other devices, add entries here with the correct
 * process key numbers (check your controller manual for key mappings).
 */
export const ACCESSORIES = [
    {
        NAME: 'Pool Light',
        TYPE: ACCESSORY_TYPE.LIGHT,
        PROCESS_KEY_NUM: '09',
        STATUS_KEY_INDEX: 4
    },
    {
        NAME: 'Aux 1',
        TYPE: ACCESSORY_TYPE.SWITCH,
        PROCESS_KEY_NUM: '0A',
        STATUS_KEY_INDEX: 9
    },
    {
        NAME: 'Aux 2',
        TYPE: ACCESSORY_TYPE.SWITCH,
        PROCESS_KEY_NUM: '0B',
        STATUS_KEY_INDEX: 10
    }
];
