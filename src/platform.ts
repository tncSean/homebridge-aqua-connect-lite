import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME, ACCESSORY_TYPE, ACCESSORIES, AQUALOGIC_DEFAULTS, CHLORINE_CONTROLLER_DEFAULTS, AccessoryConfig } from './settings';
import { Light } from './light';
import { Switch } from './switch';
import { TempSensor } from './tempsensor';
import { FilterFan } from './fan';
import { SuperChlor } from './superchlor';
import { Chlorinator } from './chlorinator';
import { Thermostat } from './thermostat';
import { AquaLogicClient } from './aqualogic/client';
import { ChlorineSensor } from './waterguru/chlorinesensor';
import { PhSensor } from './waterguru/phsensor';
import { PoolAlert } from './waterguru/poolalert';
import { ChemistrySensor } from './waterguru/chemistrysensor';
import { Notifier } from './waterguru/notifier';
import { WaterGuruClient } from './waterguru/client';
import { LesliesClient } from './leslies/client';
import { WaterGuruController, ControllerConfig } from './waterguru/controller';

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

    private wgController: WaterGuruController | null = null;
    private chlorineSensor: ChlorineSensor | null = null;
    private phSensor: PhSensor | null = null;
    private poolAlert: PoolAlert | null = null;
    private saltSensor: ChemistrySensor | null = null;
    private taSensor: ChemistrySensor | null = null;
    private cyaSensor: ChemistrySensor | null = null;
    private calciumSensor: ChemistrySensor | null = null;
    private chlorinatorAccessory: Chlorinator | null = null;

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
            if (this.wgController) this.wgController.stop();
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

        const wgEmail = typeof this.config.waterguru_email === 'string' ? this.config.waterguru_email.trim() : '';
        const wgPassword = typeof this.config.waterguru_password === 'string' ? this.config.waterguru_password : '';
        const wgEnabled = wgEmail.length > 0 && wgPassword.length > 0;
        if (!wgEnabled) {
            for (const n of ['Free Chlorine', 'pH', 'Pool Alert', 'Salt', 'Total Alkalinity', 'CYA']) {
                if (!excluded.includes(n)) excluded.push(n);
            }
            this.log.info('Water Guru credentials absent — chlorine auto-tuner disabled (plugin behaves as before).');
        }

        // Leslie's Pool water-test import. Creds (email/password) live in
        // config.json only — never in source/logs. When absent, the Leslie's
        // fetch is skipped and the Calcium tile is force-excluded.
        const lesliesCfg = (this.config.chlorine_controller ?? {}) as Record<string, unknown>;
        const lesliesEmail = typeof lesliesCfg.leslies_email === 'string' ? lesliesCfg.leslies_email.trim() : '';
        const lesliesPassword = typeof lesliesCfg.leslies_password === 'string' ? lesliesCfg.leslies_password : '';
        const lesliesPoolId = typeof lesliesCfg.leslies_pool_id === 'string' && lesliesCfg.leslies_pool_id.trim().length > 0
            ? lesliesCfg.leslies_pool_id.trim()
            : CHLORINE_CONTROLLER_DEFAULTS.LESLIES_POOL_ID;
        const lesliesEnabled = lesliesEmail.length > 0 && lesliesPassword.length > 0 && lesliesPoolId.length > 0;
        if (!lesliesEnabled) {
            if (!excluded.includes('Calcium Hardness')) excluded.push('Calcium Hardness');
            this.log.info("Leslie's credentials absent — Leslie's water-test import disabled (Calcium tile excluded).");
        } else {
            this.log.info(`Leslie's water-test import enabled (pool profile ${lesliesPoolId}).`);
        }

        const hasAqualogic = ACCESSORIES.some(
            a => a.TRANSPORT === 'aqualogic' && !excluded.includes(a.NAME),
        ) || wgEnabled;
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
            // The W610 is on DHCP and a second PUSR device shares the LAN, so we
            // identify it by MAC: when a connect to the last-known IP fails, the
            // client relocates the device — ARP-scan by its Ethernet MAC first
            // (works from the wired Homebridge host), then PUSR UDP-48899 by its
            // protocol MAC. Both config overrides are OPTIONAL (sane defaults).
            const rawL2Mac = this.config.w610_l2_mac;
            const l2Mac = typeof rawL2Mac === 'string' && rawL2Mac.length > 0
                ? rawL2Mac
                : AQUALOGIC_DEFAULTS.L2_MAC;
            const rawMac = this.config.w610_mac;
            const mac = typeof rawMac === 'string' && rawMac.length > 0
                ? rawMac
                : AQUALOGIC_DEFAULTS.MAC;
            this.log.info(
                `AquaLogic (W610): ${host}:${port} (auto-relocate by ARP MAC ${l2Mac} / UDP MAC ${mac})`,
            );
            this.aquaLogicClient = new AquaLogicClient({ host, port, l2Mac, mac, log: this.log });
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

        if (wgEnabled && this.aquaLogicClient) {
            const raw = (this.config.chlorine_controller ?? {}) as Record<string, unknown>;
            const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
            const cfg: ControllerConfig = {
                enabled: raw.enabled !== false && CHLORINE_CONTROLLER_DEFAULTS.ENABLED,
                runAt: typeof raw.run_at === 'string' ? raw.run_at : CHLORINE_CONTROLLER_DEFAULTS.RUN_AT,
                minPct: num(raw.min_pct, CHLORINE_CONTROLLER_DEFAULTS.MIN_PCT),
                maxPct: num(raw.max_pct, CHLORINE_CONTROLLER_DEFAULTS.MAX_PCT),
                maxStep: num(raw.max_step, CHLORINE_CONTROLLER_DEFAULTS.MAX_STEP),
                gain: num(raw.gain, CHLORINE_CONTROLLER_DEFAULTS.GAIN),
                computeOnly: raw.compute_only === undefined ? CHLORINE_CONTROLLER_DEFAULTS.COMPUTE_ONLY : raw.compute_only === true,
                poolGallons: num(raw.pool_gallons, CHLORINE_CONTROLLER_DEFAULTS.POOL_GALLONS),
                saltCurrentPpm: num(raw.salt_current_ppm, CHLORINE_CONTROLLER_DEFAULTS.SALT_CURRENT_PPM),
                saltTargetPpm: num(raw.salt_target_ppm, CHLORINE_CONTROLLER_DEFAULTS.SALT_TARGET_PPM),
                saltDeadbandPpm: num(raw.salt_deadband_ppm, CHLORINE_CONTROLLER_DEFAULTS.SALT_DEADBAND_PPM),
                saltMaxAgeDays: num(raw.salt_max_age_days, CHLORINE_CONTROLLER_DEFAULTS.SALT_MAX_AGE_DAYS),
                saltGreenMin: num(raw.salt_green_min, CHLORINE_CONTROLLER_DEFAULTS.SALT_GREEN_MIN),
                saltGreenMax: num(raw.salt_green_max, CHLORINE_CONTROLLER_DEFAULTS.SALT_GREEN_MAX),
                phGreenMin: num(raw.ph_green_min, CHLORINE_CONTROLLER_DEFAULTS.PH_GREEN_MIN),
                phGreenMax: num(raw.ph_green_max, CHLORINE_CONTROLLER_DEFAULTS.PH_GREEN_MAX),
                fcGreenMin: num(raw.fc_green_min, CHLORINE_CONTROLLER_DEFAULTS.FC_GREEN_MIN),
                fcGreenMax: num(raw.fc_green_max, CHLORINE_CONTROLLER_DEFAULTS.FC_GREEN_MAX),
                taGreenMin: num(raw.ta_green_min, CHLORINE_CONTROLLER_DEFAULTS.TA_GREEN_MIN),
                taGreenMax: num(raw.ta_green_max, CHLORINE_CONTROLLER_DEFAULTS.TA_GREEN_MAX),
                cyaGreenMin: num(raw.cya_green_min, CHLORINE_CONTROLLER_DEFAULTS.CYA_GREEN_MIN),
                cyaGreenMax: num(raw.cya_green_max, CHLORINE_CONTROLLER_DEFAULTS.CYA_GREEN_MAX),
                calciumGreenMin: num(raw.calcium_green_min, CHLORINE_CONTROLLER_DEFAULTS.CALCIUM_GREEN_MIN),
                calciumGreenMax: num(raw.calcium_green_max, CHLORINE_CONTROLLER_DEFAULTS.CALCIUM_GREEN_MAX),
                cyaCurrentPpm: num(raw.cya_current_ppm, CHLORINE_CONTROLLER_DEFAULTS.CYA_CURRENT_PPM),
                cyaTargetPpm: num(raw.cya_target_ppm, CHLORINE_CONTROLLER_DEFAULTS.CYA_TARGET_PPM),
                stabilizerOzPerPpmPer10kGal: num(
                    raw.stabilizer_oz_per_ppm_per_10k_gal,
                    CHLORINE_CONTROLLER_DEFAULTS.STABILIZER_OZ_PER_PPM_PER_10K_GAL,
                ),
                ntfyServer: typeof raw.ntfy_server === 'string' && raw.ntfy_server.length > 0
                    ? raw.ntfy_server : CHLORINE_CONTROLLER_DEFAULTS.NTFY_SERVER,
                ntfyTopic: typeof raw.ntfy_topic === 'string' ? raw.ntfy_topic : CHLORINE_CONTROLLER_DEFAULTS.NTFY_TOPIC,
            };
            if (cfg.enabled) {
                const wgClient = new WaterGuruClient(wgEmail, wgPassword, this.log);
                const notifier = new Notifier(
                    { ntfyServer: cfg.ntfyServer, ntfyTopic: cfg.ntfyTopic || undefined },
                    this.log, () => Date.now(), fetch,
                );
                const lesliesClient = lesliesEnabled
                    ? new LesliesClient(lesliesEmail, lesliesPassword, lesliesPoolId, this.log)
                    : null;
                this.wgController = new WaterGuruController(
                    this, wgClient, this.aquaLogicClient, this.chlorinatorAccessory,
                    {
                        chlorine: this.chlorineSensor ?? undefined,
                        ph: this.phSensor ?? undefined,
                        salt: this.saltSensor ?? undefined,
                        ta: this.taSensor ?? undefined,
                        cya: this.cyaSensor ?? undefined,
                        calcium: this.calciumSensor ?? undefined,
                        alert: this.poolAlert ?? undefined,
                    },
                    cfg,
                    notifier,
                    lesliesClient,
                );
                this.wgController.start();
                this.log.info(`Chlorine auto-tuner started (run_at ${cfg.runAt}, compute_only=${cfg.computeOnly}, max ${cfg.maxPct}%).`);
            }
        }
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
                this.chlorinatorAccessory = new Chlorinator(this, platformAccessory, this.aquaLogicClient!);
                return;
            case ACCESSORY_TYPE.CHLORINE_SENSOR:
                this.chlorineSensor = new ChlorineSensor(this, platformAccessory);
                return;
            case ACCESSORY_TYPE.PH_SENSOR:
                this.phSensor = new PhSensor(this, platformAccessory);
                return;
            case ACCESSORY_TYPE.POOL_ALERT:
                this.poolAlert = new PoolAlert(this, platformAccessory);
                return;
            case ACCESSORY_TYPE.SALT_SENSOR:
                this.saltSensor = new ChemistrySensor(this, platformAccessory, { unit: 'ppm' });
                return;
            case ACCESSORY_TYPE.TA_SENSOR:
                this.taSensor = new ChemistrySensor(this, platformAccessory, { unit: 'ppm' });
                return;
            case ACCESSORY_TYPE.CYA_SENSOR:
                this.cyaSensor = new ChemistrySensor(this, platformAccessory, { unit: 'ppm' });
                return;
            case ACCESSORY_TYPE.CALCIUM_SENSOR:
                this.calciumSensor = new ChemistrySensor(this, platformAccessory, { unit: 'ppm' });
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
