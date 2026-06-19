import { Service, PlatformAccessory } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';

/**
 * pH sensor. Same generic-numeric approach as ChlorineSensor — pH (~6.8-8.2)
 * sits inside the LightSensor lux range. Pushed by the controller via setPh().
 */
export class PhSensor {
    private service: Service;
    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.service = this.accessory.getService(this.platform.Service.LightSensor)
            || this.accessory.addService(this.platform.Service.LightSensor);
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
    }
    setPh(ph: number): void {
        const v = Math.max(0.0001, ph);
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, v);
        this.platform.log.debug(`${this.accessory.displayName} pH=${ph}`);
    }
}
