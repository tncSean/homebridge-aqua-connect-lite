import { PlatformAccessory } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';
import { ChemistrySensor } from './chemistrysensor';
import { Band } from './compliance';

/**
 * Free Chlorine (ppm) compliance tile. Delegates to ChemistrySensor, which
 * backs it with a HomeKit AirQualitySensor showing the color-coded compliance
 * state against the WG-recommended (or configured) green band. The exact ppm
 * is delivered via the controller log + ntfy push.
 *
 * NOTE: this swaps the underlying service LightSensor → AirQuality on the SAME
 * accessory (stable TYPE/NAME/UUID — no re-register). Apple Home may need a
 * reload to show the new compliance state; identity/room are preserved.
 */
export class ChlorineSensor {
    private chem: ChemistrySensor;
    constructor(platform: AquaConnectLitePlatform, accessory: PlatformAccessory) {
        this.chem = new ChemistrySensor(platform, accessory, { unit: 'ppm' });
    }
    setFc(ppm: number, band: Band): void {
        this.chem.update(ppm, band);
    }
}
