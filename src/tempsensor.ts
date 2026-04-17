import { Service, PlatformAccessory } from 'homebridge';
import { AquaConnectLitePlatform } from './platform';
import { AquaLogicClient } from './aqualogic/client';
import { PoolState } from './aqualogic/state';

const F_TO_C = (f: number): number => ((f - 32) * 5) / 9;

/**
 * Read-only TemperatureSensor backed by a PoolState field (e.g. poolTempF,
 * airTempF). State updates are pushed to HomeKit via subscribe() — no polling.
 */
export class TempSensor {
    private service: Service;
    private readonly field: keyof PoolState;

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly client: AquaLogicClient,
    ) {
        const cfg = accessory.context.device;
        this.field = (cfg.FIELD as keyof PoolState) ?? 'poolTempF';

        this.service = this.accessory.getService(this.platform.Service.TemperatureSensor)
            || this.accessory.addService(this.platform.Service.TemperatureSensor);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(() => this.readCelsius());

        this.client.state.on('change', (key: keyof PoolState) => {
            if (key === this.field) this.pushUpdate();
        });

        this.pushUpdate();
    }

    private readCelsius(): number {
        const f = this.client.state.current[this.field] as number | undefined;
        if (typeof f !== 'number') return 0;
        return round1(F_TO_C(f));
    }

    private pushUpdate(): void {
        const c = this.readCelsius();
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, c);
        this.platform.log.debug(`${this.accessory.displayName} temp=${c.toFixed(1)}°C`);
    }
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}
