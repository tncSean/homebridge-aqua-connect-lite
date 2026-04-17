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

/** Default AquaLogic (W610 bus bridge) connection settings */
export const AQUALOGIC_DEFAULTS = {
    HOST: '192.168.1.70',
    PORT: 8899,
};

/**
 * Supported accessory types.
 *
 * LIGHT/SWITCH are served by the HTTP bridge (legacy v2 path). The rest
 * are served by the AquaLogic RS-485 transport introduced in v3.
 */
export const ACCESSORY_TYPE = {
    LIGHT: 'light' as const,
    SWITCH: 'switch' as const,
    THERMOSTAT: 'thermostat' as const,
    DIMMER: 'dimmer' as const,
    FAN: 'fan' as const,
    TEMPSENSOR: 'tempsensor' as const,
};

export type AccessoryType = typeof ACCESSORY_TYPE[keyof typeof ACCESSORY_TYPE];

/** Which transport fetches state and issues commands for this accessory. */
export type AccessoryTransport = 'http' | 'aqualogic';

interface BaseAccessoryConfig {
    /** HomeKit display name */
    NAME: string;
    /** HomeKit service type */
    TYPE: AccessoryType;
    /** Transport — 'http' for WNewSt.htm, 'aqualogic' for RS-485 bus */
    TRANSPORT: AccessoryTransport;
}

export interface HttpAccessoryConfig extends BaseAccessoryConfig {
    TRANSPORT: 'http';
    /** KeyId sent to the controller to simulate a button press */
    PROCESS_KEY_NUM: string;
    /** Index into the decoded LED status byte string */
    STATUS_KEY_INDEX: number;
    /**
     * If true, LED "on" is reported to HomeKit as off (and vice versa).
     * Used for valve actuators whose LED tracks the actuated position,
     * which is inverse of the physically-flowing state (e.g. Valve 3
     * default position = waterfall flowing = LED "off").
     */
    INVERT?: boolean;
}

export interface AquaLogicAccessoryConfig extends BaseAccessoryConfig {
    TRANSPORT: 'aqualogic';
    /** Key name (see keys.ts Key map) for activation — e.g. 'FILTER', 'AUX_3'. */
    KEY?: string;
    /** Field in PoolState for read-only accessories (e.g. 'poolTempF', 'airTempF'). */
    FIELD?: string;
}

export type AccessoryConfig = HttpAccessoryConfig | AquaLogicAccessoryConfig;

/**
 * Default accessory definitions
 *
 * HTTP accessories map to physical controls on the pool controller. KeyId
 * and status index are derived from the bridge's own web UI at
 * http://<bridge-ip>/ — see AQUACONNECT.md for the full mapping.
 *
 * AquaLogic accessories use the USR-W610 bus bridge for direct RS-485
 * access — see W610-INSTALL.md and ROADMAP.md.
 */
export const ACCESSORIES: AccessoryConfig[] = [
    // --- HTTP-served (v2.0 parity) ---
    {
        NAME: 'Pool Light',
        TYPE: ACCESSORY_TYPE.LIGHT,
        TRANSPORT: 'http',
        PROCESS_KEY_NUM: '09',
        STATUS_KEY_INDEX: 4,
    },
    {
        NAME: 'Waterfalls',
        TYPE: ACCESSORY_TYPE.SWITCH,
        TRANSPORT: 'http',
        PROCESS_KEY_NUM: '11',
        STATUS_KEY_INDEX: 7,
        INVERT: true,
    },
    {
        NAME: 'Aux 1',
        TYPE: ACCESSORY_TYPE.SWITCH,
        TRANSPORT: 'http',
        PROCESS_KEY_NUM: '0A',
        STATUS_KEY_INDEX: 9,
    },
    {
        NAME: 'Aux 2',
        TYPE: ACCESSORY_TYPE.SWITCH,
        TRANSPORT: 'http',
        PROCESS_KEY_NUM: '0B',
        STATUS_KEY_INDEX: 10,
    },
    // --- AquaLogic-served (v3.0 additions) ---
    {
        NAME: 'Pool Heater',
        TYPE: ACCESSORY_TYPE.THERMOSTAT,
        TRANSPORT: 'aqualogic',
    },
    {
        NAME: 'Chlorinator',
        TYPE: ACCESSORY_TYPE.DIMMER,
        TRANSPORT: 'aqualogic',
    },
    {
        NAME: 'Super Chlorinate',
        TYPE: ACCESSORY_TYPE.SWITCH,
        TRANSPORT: 'aqualogic',
        /** Installer-programmed — defaults to AUX_3, overridable via platform config. */
        KEY: 'AUX_3',
    } as AquaLogicAccessoryConfig,
    {
        NAME: 'Filter Pump',
        TYPE: ACCESSORY_TYPE.FAN,
        TRANSPORT: 'aqualogic',
        KEY: 'FILTER',
    } as AquaLogicAccessoryConfig,
    {
        NAME: 'Pool Water Temp',
        TYPE: ACCESSORY_TYPE.TEMPSENSOR,
        TRANSPORT: 'aqualogic',
        FIELD: 'poolTempF',
    } as AquaLogicAccessoryConfig,
    {
        NAME: 'Air Temp',
        TYPE: ACCESSORY_TYPE.TEMPSENSOR,
        TRANSPORT: 'aqualogic',
        FIELD: 'airTempF',
    } as AquaLogicAccessoryConfig,
];
