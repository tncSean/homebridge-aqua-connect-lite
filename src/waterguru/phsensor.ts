import { PlatformAccessory } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';
import { ChemistrySensor } from './chemistrysensor';
import { Band } from './compliance';

/**
 * pH tile. Delegates to ChemistrySensor, backed by a read-only HomeKit
 * LightSensor showing the value as a number on the tile face. pH is a small
 * decimal (~6.8–8.2) so it is scaled ×10 into lux to preserve the decimal; the
 * exact "N pH" reading is carried unscaled for Eve.
 *
 * NOTE: this swaps the underlying service AirQuality → LightSensor on the SAME
 * accessory (stable TYPE/NAME/UUID — no re-register). Apple Home may need a
 * reopen to re-render the service-type change; identity/room are preserved.
 */
export class PhSensor {
    private chem: ChemistrySensor;
    constructor(platform: AquaConnectLitePlatform, accessory: PlatformAccessory) {
        this.chem = new ChemistrySensor(platform, accessory, { unit: 'pH', scale: 10 });
    }
    setPh(ph: number, band: Band): void {
        this.chem.update(ph, band);
    }
}
