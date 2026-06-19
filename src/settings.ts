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

/** Chlorine controller defaults (spec §Configuration). */
export const CHLORINE_CONTROLLER_DEFAULTS = {
    ENABLED: true,
    RUN_AT: '09:30',
    MIN_PCT: 2,
    MAX_PCT: 20,
    MAX_STEP: 3,
    GAIN: 2,
    COMPUTE_ONLY: false,
};

/** Default AquaLogic (W610 bus bridge) connection settings */
export const AQUALOGIC_DEFAULTS = {
    /** Static fallback IP, used only when MAC auto-discovery finds nothing. */
    HOST: '192.168.1.73',
    PORT: 8899,
    /**
     * Stable identity of the pool W610 for auto-discovery (device is on DHCP;
     * a second PUSR device shares the LAN, so we MUST match by MAC). Two MACs
     * because the W610 reports different values on different channels:
     *
     *   L2_MAC (...59) — the Ethernet/ARP MAC. Used by ARP-scan discovery, the
     *     PRIMARY method on the Homebridge host (unicast; works from CT 131).
     *   MAC (...58)    — the MAC the PUSR UDP-48899 protocol reports. Used by
     *     the SECONDARY broadcast-discovery fallback.
     */
    L2_MAC: 'D4:AD:20:DF:8D:59',
    MAC: 'D4:AD:20:DF:8D:58',
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
    CHLORINE_SENSOR: 'chlorinesensor' as const,
    PH_SENSOR: 'phsensor' as const,
    POOL_ALERT: 'poolalert' as const,
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
    // --- Water Guru sensors (v3.5; only instantiated when WG creds present) ---
    {
        NAME: 'Free Chlorine',
        TYPE: ACCESSORY_TYPE.CHLORINE_SENSOR,
        TRANSPORT: 'aqualogic',
    } as AquaLogicAccessoryConfig,
    {
        NAME: 'pH',
        TYPE: ACCESSORY_TYPE.PH_SENSOR,
        TRANSPORT: 'aqualogic',
    } as AquaLogicAccessoryConfig,
    {
        NAME: 'Pool Alert',
        TYPE: ACCESSORY_TYPE.POOL_ALERT,
        TRANSPORT: 'aqualogic',
    } as AquaLogicAccessoryConfig,
];
