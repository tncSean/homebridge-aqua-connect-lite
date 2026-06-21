import { PlatformAccessory } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';
import { ChemistrySensor } from './chemistrysensor';
import { Band } from './compliance';

/**
 * Free Chlorine (ppm) tile. Delegates to ChemistrySensor, which backs it with a
 * read-only HomeKit LightSensor showing the value as a number on the tile face.
 * FC is small (single-digit ppm) so it is scaled ×10 into lux to preserve the
 * decimal; the exact "N ppm" reading is carried unscaled for Eve.
 *
 * NOTE: this swaps the underlying service AirQuality → LightSensor on the SAME
 * accessory (stable TYPE/NAME/UUID — no re-register). Apple Home may need a
 * reopen to re-render the service-type change; identity/room are preserved.
 */
export class ChlorineSensor {
    private chem: ChemistrySensor;
    constructor(platform: AquaConnectLitePlatform, accessory: PlatformAccessory) {
        this.chem = new ChemistrySensor(platform, accessory, { unit: 'ppm', scale: 10 });
    }
    setFc(ppm: number, band: Band): void {
        this.chem.update(ppm, band);
    }
}
