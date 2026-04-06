import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME, ACCESSORY_TYPE, ACCESSORIES } from './settings';
import { Light } from './light';
import { Switch } from './switch';

/**
 * AquaConnectLitePlatform
 *
 * Homebridge platform plugin for Hayward Aqua Connect Home Network controllers.
 * Provides HomeKit integration for pool lights, aux relays, and other devices.
 */
export class AquaConnectLitePlatform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service = this.api.hap.Service;
    public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

    public readonly accessories: PlatformAccessory[] = [];

    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API
    ) {
        this.log.debug('Initializing AquaConnectLite platform...');

        // Validate required config
        if (!config.bridge_ip_address) {
            this.log.error('Configuration error: bridge_ip_address is required');
            return;
        }

        this.log.info(`Bridge IP: ${config.bridge_ip_address}`);
        this.log.info(`Request timeout: ${config.request_timeout || 5000}ms`);
        this.log.info(`Retry attempts: ${config.retry_attempts ?? 3}`);

        this.api.on('didFinishLaunching', () => {
            this.log.debug('didFinishLaunching - discovering accessories...');
            this.discoverAccessories();
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
        for (const accessory of ACCESSORIES) {
            this.log.debug(`---------------------------`);
            this.log.debug(`${accessory.NAME} discovery started`);

            // Check if accessory is excluded in config
            let excludeAccessory = false;
            if (this.config.exclude_accessories && this.config.exclude_accessories.includes(accessory.NAME)) {
                excludeAccessory = true;
                this.log.debug(`${accessory.NAME} is excluded in config`);
            }

            // Generate UUID and find existing accessory
            const uuid = this.api.hap.uuid.generate(`${PLATFORM_NAME}-${accessory.NAME}-${accessory.TYPE}`);
            const existingAccessory = this.accessories.find(a => a.UUID === uuid);

            if (existingAccessory) {
                // Accessory was previously registered

                if (excludeAccessory) {
                    // Remove excluded accessory
                    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
                    this.log.info(`${accessory.NAME} excluded and unregistered`);
                    continue;
                }

                // Update context and restore
                existingAccessory.context.device = accessory;
                this.api.updatePlatformAccessories([existingAccessory]);

                switch (accessory.TYPE) {
                    case ACCESSORY_TYPE.LIGHT:
                        new Light(this, existingAccessory);
                        break;
                    case ACCESSORY_TYPE.SWITCH:
                        new Switch(this, existingAccessory);
                        break;
                }

                this.log.info(`Restored ${existingAccessory.displayName} from cache`);

            } else {
                // New accessory

                if (excludeAccessory) {
                    this.log.debug(`${accessory.NAME} excluded, skipping`);
                    continue;
                }

                // Create new accessory
                const newAccessory = new this.api.platformAccessory(accessory.NAME, uuid);
                newAccessory.context.device = accessory;

                switch (accessory.TYPE) {
                    case ACCESSORY_TYPE.LIGHT:
                        new Light(this, newAccessory);
                        break;
                    case ACCESSORY_TYPE.SWITCH:
                        new Switch(this, newAccessory);
                        break;
                }

                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [newAccessory]);
                this.log.info(`Added ${accessory.NAME}`);
            }
        }

        this.log.debug('---------------------------');
        this.log.debug('Accessory discovery complete');
    }
}
