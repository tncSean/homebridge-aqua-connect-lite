import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME, ACCESSORY_TYPE, ACCESSORIES, AQUALOGIC_DEFAULTS, AccessoryConfig } from './settings';
import { Light } from './light';
import { Switch } from './switch';
import { TempSensor } from './tempsensor';
import { FilterFan } from './fan';
import { SuperChlor } from './superchlor';
import { Chlorinator } from './chlorinator';
import { Thermostat } from './thermostat';
import { AquaLogicClient } from './aqualogic/client';

/**
 * AquaConnectLitePlatform
 *
 * Homebridge platform plugin for Hayward Aqua Connect Home Network controllers.
 * Provides HomeKit integration for pool lights, aux relays, and (via the
 * W610 RS-485 bridge in v3.0+) thermostat, chlorinator, filter pump, super
 * chlorinate switch, and water/air temperature sensors.
 */
export class AquaConnectLitePlatform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service = this.api.hap.Service;
    public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

    public readonly accessories: PlatformAccessory[] = [];

    /** Shared RS-485 client, instantiated only when an AquaLogic accessory is enabled. */
    private aquaLogicClient: AquaLogicClient | null = null;

    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API
    ) {
        this.log.debug('Initializing AquaConnectLite platform...');

        if (!config.bridge_ip_address) {
            this.log.error('Configuration error: bridge_ip_address is required');
            return;
        }
        if (!isValidHost(config.bridge_ip_address)) {
            this.log.error(
                `Configuration error: bridge_ip_address "${config.bridge_ip_address}" ` +
                `is not a valid IPv4 address or hostname. Disabling platform.`,
            );
            return;
        }

        this.log.info(`Bridge IP: ${config.bridge_ip_address}`);
        this.log.info(`Request timeout: ${config.request_timeout || 5000}ms`);
        this.log.info(`Retry attempts: ${config.retry_attempts ?? 3}`);

        this.api.on('didFinishLaunching', () => {
            this.log.debug('didFinishLaunching - discovering accessories...');
            this.discoverAccessories();
        });

        this.api.on('shutdown', () => {
            if (this.aquaLogicClient) {
                this.log.debug('Shutdown — stopping AquaLogic client');
                this.aquaLogicClient.stop();
            }
        });
    }

    /**
     * Called when a cached accessory is being restored.
     * Store the accessory for later restoration in discoverAccessories().
     */
    configureAccessory(accessory: PlatformAccessory): void {
        this.log.debug(`configureAccessory: ${accessory.displayName} (${accessory.UUID})`);

        if (!this.accessories.some(a => a.UUID === accessory.UUID)) {
            this.accessories.push(accessory);
        }
    }

    /**
     * Discover and register accessories with Homebridge.
     * Handles both new accessories and restoring cached ones.
     */
    discoverAccessories(): void {
        // Start the RS-485 client up front if any aqualogic accessory is enabled
        // and not excluded. Accessories bind to it in their constructors.
        const rawExcluded = this.config.exclude_accessories;
        if (rawExcluded !== undefined && !Array.isArray(rawExcluded)) {
            this.log.warn('exclude_accessories must be an array of strings — ignoring');
        }
        const excluded: string[] = Array.isArray(rawExcluded)
            ? rawExcluded.filter((x): x is string => typeof x === 'string')
            : [];

        const hasAqualogic = ACCESSORIES.some(
            a => a.TRANSPORT === 'aqualogic' && !excluded.includes(a.NAME),
        );
        if (hasAqualogic) {
            const rawHost = this.config.w610_ip;
            const host = typeof rawHost === 'string' && rawHost.length > 0
                ? rawHost
                : AQUALOGIC_DEFAULTS.HOST;
            if (!isValidHost(host)) {
                this.log.error(
                    `w610_ip "${host}" is not a valid IPv4 address or hostname. ` +
                    `Skipping AquaLogic client — RS-485 accessories will not function.`,
                );
                return;
            }
            const rawPort = this.config.w610_port;
            const port = typeof rawPort === 'number' && rawPort >= 1 && rawPort <= 65535
                ? rawPort
                : AQUALOGIC_DEFAULTS.PORT;
            if (typeof rawPort === 'number' && (rawPort < 1 || rawPort > 65535)) {
                this.log.warn(`w610_port ${rawPort} out of range — using default ${AQUALOGIC_DEFAULTS.PORT}`);
            }
            this.log.info(`AquaLogic (W610): ${host}:${port}`);
            this.aquaLogicClient = new AquaLogicClient({ host, port, log: this.log });
            this.aquaLogicClient.start();
        }

        for (const accessory of ACCESSORIES) {
            this.log.debug(`---------------------------`);
            this.log.debug(`${accessory.NAME} discovery started`);

            const excludeAccessory = excluded.includes(accessory.NAME);
            if (excludeAccessory) this.log.debug(`${accessory.NAME} is excluded in config`);

            const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}-${accessory.NAME}-${accessory.TYPE}`);
            const existingAccessory = this.accessories.find(a => a.UUID === uuid);

            if (existingAccessory) {
                if (excludeAccessory) {
                    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
                    this.log.info(`${accessory.NAME} excluded and unregistered`);
                    continue;
                }

                existingAccessory.context.device = accessory;
                this.api.updatePlatformAccessories([existingAccessory]);
                this.bindAccessory(accessory, existingAccessory);
                this.log.info(`Restored ${existingAccessory.displayName} from cache`);

            } else {
                if (excludeAccessory) {
                    this.log.debug(`${accessory.NAME} excluded, skipping`);
                    continue;
                }

                const newAccessory = new this.api.platformAccessory(accessory.NAME, uuid);
                newAccessory.context.device = accessory;
                this.bindAccessory(accessory, newAccessory);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [newAccessory]);
                this.log.info(`Added ${accessory.NAME}`);
            }
        }

        this.log.debug('---------------------------');
        this.log.debug('Accessory discovery complete');
    }

    /**
     * Instantiate the right accessory handler class for a given accessory type.
     * Throws if an aqualogic accessory is asked for before the client is initialized.
     */
    private bindAccessory(cfg: AccessoryConfig, platformAccessory: PlatformAccessory): void {
        switch (cfg.TYPE) {
            case ACCESSORY_TYPE.LIGHT:
                new Light(this, platformAccessory);
                return;
            case ACCESSORY_TYPE.SWITCH:
                if (cfg.TRANSPORT === 'aqualogic') {
                    this.requireClient(cfg.NAME);
                    new SuperChlor(this, platformAccessory, this.aquaLogicClient!);
                } else {
                    new Switch(this, platformAccessory);
                }
                return;
            case ACCESSORY_TYPE.THERMOSTAT:
                this.requireClient(cfg.NAME);
                new Thermostat(this, platformAccessory, this.aquaLogicClient!);
                return;
            case ACCESSORY_TYPE.DIMMER:
                this.requireClient(cfg.NAME);
                new Chlorinator(this, platformAccessory, this.aquaLogicClient!);
                return;
            case ACCESSORY_TYPE.FAN:
                this.requireClient(cfg.NAME);
                new FilterFan(this, platformAccessory, this.aquaLogicClient!);
                return;
            case ACCESSORY_TYPE.TEMPSENSOR:
                this.requireClient(cfg.NAME);
                new TempSensor(this, platformAccessory, this.aquaLogicClient!);
                return;
        }
    }

    private requireClient(name: string): void {
        if (!this.aquaLogicClient) {
            throw new Error(`${name} requires the AquaLogic client, which is not initialized. Set w610_ip in config.`);
        }
    }
}

/**
 * Loose host validator — accepts dotted-quad IPv4 or a simple hostname label.
 * Rejects strings with URL-y noise (@, /, :, ?, #, <, >, spaces, control chars)
 * that could divert HTTP requests or net.connect() to unintended targets.
 */
function isValidHost(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
    if (/[\s@\/?#:<>\\]/.test(value)) return false;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const m = value.match(ipv4);
    if (m) {
        return m.slice(1, 5).every(o => { const n = parseInt(o, 10); return n >= 0 && n <= 255; });
    }
    // Accept hostnames per RFC-1123 (letters, digits, hyphens, dots; labels 1-63 chars).
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(value);
}
