import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { AquaConnectLitePlatform } from './platform';
import { AquaLogicClient } from './aqualogic/client';
import { keyFromName, KeyValue } from './aqualogic/keys';
import { PoolState } from './aqualogic/state';

/**
 * Super Chlorinate toggle.
 *
 * Super Chlorinate on the Pro Logic is a configured button press (the
 * installer maps it to some AUX/LIGHTS/VALVE button). Duration is
 * programmed on the Pro Logic itself (1-96h) — the hardware auto-terminates.
 * The plugin only needs to send the button press; we do not attempt to
 * time the cycle.
 *
 * State is derived from the display showing "Super Chlorinate" text.
 */
export class SuperChlor {
    private service: Service;
    private readonly toggleKey: KeyValue;

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly client: AquaLogicClient,
    ) {
        const cfg = accessory.context.device;
        const keyName = (this.platform.config.super_chlorinate_key as string | undefined)
            ?? (cfg.KEY as string | undefined)
            ?? 'AUX_3';
        let resolved: KeyValue;
        try {
            resolved = keyFromName(keyName);
        } catch {
            this.platform.log.error(
                `super_chlorinate_key "${keyName}" is not a valid Pro Logic key; ` +
                `defaulting to AUX_3. Valid keys: AUX_1..AUX_14, LIGHTS, VALVE_3, VALVE_4.`,
            );
            resolved = keyFromName('AUX_3');
        }
        this.toggleKey = resolved;

        this.service = this.accessory.getService(this.platform.Service.Switch)
            || this.accessory.addService(this.platform.Service.Switch);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => this.client.state.current.superChlorinateOn === true)
            .onSet(this.setOn.bind(this));

        this.client.state.on('change', (key: keyof PoolState) => {
            if (key === 'superChlorinateOn') {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.On,
                    this.client.state.current.superChlorinateOn === true,
                );
            }
        });
    }

    private async setOn(value: CharacteristicValue): Promise<void> {
        const desired = value === true;
        const current = this.client.state.current.superChlorinateOn === true;
        this.platform.log.debug(`${this.accessory.displayName} setOn: desired=${desired} current=${current}`);
        if (desired === current) return;
        try {
            await this.client.sendKey(this.toggleKey);
        } catch (e) {
            this.platform.log.error(`${this.accessory.displayName} send failed: ${(e as Error).message}`);
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
        }
    }
}
