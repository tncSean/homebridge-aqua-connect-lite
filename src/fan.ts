import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { AquaConnectLitePlatform } from './platform';
import { AquaLogicClient } from './aqualogic/client';
import { keyFromName, KeyValue } from './aqualogic/keys';
import { PoolState } from './aqualogic/state';

/**
 * Filter Pump accessory, surfaced as HomeKit Fan.
 *
 * On writable (emits FILTER key when target differs from state.filterOn).
 * RotationSpeed read-only: reflects state.pumpPercent. Setting speed from
 * HomeKit is NOT supported — the Pro Logic owns speed profiles (SPILLOVER
 * -> 90% etc.). We reject the HomeKit set with a silent no-op so the
 * slider stays truthful to the hardware.
 */
export class FilterFan {
    private service: Service;
    private readonly toggleKey: KeyValue;

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly client: AquaLogicClient,
    ) {
        const cfg = accessory.context.device;
        const keyName = (cfg.KEY as string | undefined) ?? 'FILTER';
        let resolved: KeyValue;
        try {
            resolved = keyFromName(keyName);
        } catch {
            this.platform.log.error(
                `Filter Pump KEY "${keyName}" is not a valid Pro Logic key; defaulting to FILTER.`,
            );
            resolved = keyFromName('FILTER');
        }
        this.toggleKey = resolved;

        this.service = this.accessory.getService(this.platform.Service.Fan)
            || this.accessory.addService(this.platform.Service.Fan);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => this.client.state.current.filterOn === true)
            .onSet(this.setOn.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
            .onGet(() => this.client.state.current.pumpPercent ?? 0)
            .onSet(this.setRotationSpeed.bind(this));

        this.client.state.on('change', (key: keyof PoolState) => {
            if (key === 'filterOn') {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.On,
                    this.client.state.current.filterOn === true,
                );
            }
            if (key === 'pumpPercent') {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.RotationSpeed,
                    this.client.state.current.pumpPercent ?? 0,
                );
            }
        });
    }

    private async setOn(value: CharacteristicValue): Promise<void> {
        const desired = value === true;
        const current = this.client.state.current.filterOn === true;
        this.platform.log.debug(`${this.accessory.displayName} setOn: desired=${desired} current=${current}`);
        if (desired === current) return;
        try {
            await this.client.sendKey(this.toggleKey);
        } catch (e) {
            this.platform.log.error(`${this.accessory.displayName} toggle failed: ${(e as Error).message}`);
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
        }
    }

    /**
     * HomeKit will try to set speed from the UI, but the Pro Logic profiles
     * aren't settable over RS-485. Keep the slider honest: re-emit the
     * actual pump percent on any write attempt, so the slider snaps back.
     */
    private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
        const actual = this.client.state.current.pumpPercent ?? 0;
        this.platform.log.info(
            `${this.accessory.displayName} RotationSpeed set (${value}) ignored; ` +
            `pump speed is owned by Pro Logic profiles. Snapping slider back to ${actual}%.`,
        );
        setTimeout(() => {
            this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, actual);
        }, 0);
    }
}

