import { Service, PlatformAccessory } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';

/**
 * Free Chlorine sensor (ppm). HomeKit has no chlorine characteristic, so we
 * reuse LightSensor.CurrentAmbientLightLevel as a generic numeric carrier
 * (mirrors jkoehl/homebridge-waterguru). Lux min is >0 so FC is clamped to
 * >= 0.0001. Value is pushed by the controller via setFc().
 */
export class ChlorineSensor {
    private service: Service;
    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.service = this.accessory.getService(this.platform.Service.LightSensor)
            || this.accessory.addService(this.platform.Service.LightSensor);
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
    }
    setFc(ppm: number): void {
        const v = Math.max(0.0001, ppm);
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, v);
        this.platform.log.debug(`${this.accessory.displayName} FC=${ppm}ppm`);
    }
}
