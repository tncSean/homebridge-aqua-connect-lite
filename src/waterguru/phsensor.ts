import { PlatformAccessory } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';
import { ChemistrySensor } from './chemistrysensor';
import { Band } from './compliance';

/**
 * pH compliance tile. Delegates to ChemistrySensor (HomeKit AirQualitySensor)
 * showing the color-coded compliance state against the configured green band.
 * The exact pH is delivered via the controller log + ntfy push.
 *
 * NOTE: this swaps the underlying service LightSensor → AirQuality on the SAME
 * accessory (stable TYPE/NAME/UUID — no re-register). Apple Home may need a
 * reload to show the new compliance state; identity/room are preserved.
 */
export class PhSensor {
    private chem: ChemistrySensor;
    constructor(platform: AquaConnectLitePlatform, accessory: PlatformAccessory) {
        this.chem = new ChemistrySensor(platform, accessory, { unit: 'pH' });
    }
    setPh(ph: number, band: Band): void {
        this.chem.update(ph, band);
    }
}
