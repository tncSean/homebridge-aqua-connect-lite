import { Service, Characteristic, PlatformAccessory, WithUUID } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';
import { Band, complianceLevel, inRange } from './compliance';
import { makeReadingCharacteristic } from './customchar';

/**
 * Generic chemistry-compliance tile backed by a HomeKit AirQualitySensor.
 *
 * Each pool chemistry parameter (FC, pH, Salt, TA, CYA) maps to a color-coded
 * AirQuality compliance state against a configurable green band:
 *   1 EXCELLENT (in band) · 3 FAIR (just outside) · 5 POOR (far outside) ·
 *   0 UNKNOWN (no value/band).
 * StatusFault flags any out-of-band reading; StatusActive false = no data.
 *
 * The Name characteristic is set ONCE at construction and NEVER changed
 * afterward — the exact value/instruction is delivered via the controller log
 * and the optional ntfy push, not by renaming the tile. This class issues NO
 * equipment writes/commands; it only updates display characteristics.
 */
export class ChemistrySensor {
    private service: Service;
    /** Custom STRING characteristic carrying the exact reading (Eve shows it; Apple Home ignores it). */
    private readonly Reading: WithUUID<{ new (): Characteristic }>;
    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly opts: { unit: string },
    ) {
        this.service = this.accessory.getService(this.platform.Service.AirQualitySensor)
            || this.accessory.addService(this.platform.Service.AirQualitySensor);
        // Clean upgrade path: Free Chlorine & pH used to be LightSensor tiles.
        // Remove that stale service so the upgraded accessory publishes ONLY the
        // AirQuality tile — otherwise Apple Home renders a confusing accessory
        // carrying both a light reading and an air-quality reading. Harmless for
        // the brand-new Salt/TA/CYA accessories (they have no LightSensor).
        const staleLux = this.accessory.getService(this.platform.Service.LightSensor);
        if (staleLux) {
            this.accessory.removeService(staleLux);
        }
        // Name is fixed for the life of the accessory — never updated again.
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
        this.service.updateCharacteristic(
            this.platform.Characteristic.AirQuality,
            this.platform.Characteristic.AirQuality.UNKNOWN,
        );
        this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, true);
        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.platform.Characteristic.StatusFault.NO_FAULT,
        );
        // Add the custom read-only "Reading" characteristic to the service.
        // Declare it as OPTIONAL first so HAP doesn't log a "Characteristic not
        // in required or optional section … Adding anyway" warning, THEN
        // getCharacteristic(constructor) auto-adds the instance.
        this.Reading = makeReadingCharacteristic(this.platform.api);
        this.service.addOptionalCharacteristic(this.Reading);
        this.service.getCharacteristic(this.Reading).updateValue('');
    }

    /** Update the tile from a fresh value + the active green band. No writes/commands. */
    update(value: number | undefined, band: Band | undefined): void {
        const C = this.platform.Characteristic;
        if (value === undefined || band === undefined) {
            this.service.updateCharacteristic(C.AirQuality, C.AirQuality.UNKNOWN);
            this.service.updateCharacteristic(C.StatusActive, false);
            this.service.getCharacteristic(this.Reading).updateValue('—');
            return;
        }
        const lvl = complianceLevel(value, band);
        const aq = lvl === 1 ? C.AirQuality.EXCELLENT
            : lvl === 3 ? C.AirQuality.FAIR
                : C.AirQuality.POOR;
        this.service.updateCharacteristic(C.AirQuality, aq);
        this.service.updateCharacteristic(C.StatusActive, true);
        this.service.updateCharacteristic(
            C.StatusFault,
            inRange(value, band) ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT,
        );
        // Best-effort numeric carrier for the Apple Home detail view. VOCDensity
        // is clamped to 0..1000, so large values (e.g. salt ppm) saturate at
        // 1000 — the exact value is always in the log + ntfy push, not here.
        this.service.updateCharacteristic(C.VOCDensity, Math.max(0, Math.min(1000, value)));
        // Exact reading for Eve / non-Apple clients (e.g. "2900 ppm", "7.4 pH").
        this.service.getCharacteristic(this.Reading).updateValue(`${value} ${this.opts.unit}`);
        this.platform.log.debug(`${this.accessory.displayName} = ${value} ${this.opts.unit} (AirQuality ${lvl})`);
    }
}
