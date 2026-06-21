import { Service, Characteristic, PlatformAccessory, WithUUID } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';
import { Band, inRange } from './compliance';
import { makeReadingCharacteristic } from './customchar';

/**
 * Generic chemistry tile backed by a read-only HomeKit LightSensor.
 *
 * Apple Home collapses multiple AirQualitySensors into a single summary tile,
 * so each chemistry parameter (FC, pH, Salt, TA, CYA, Calcium) is published as
 * its OWN LightSensor whose `CurrentAmbientLightLevel` (lux) carries the value
 * as a plain number on the tile face. Lux is read-only (no setter — never
 * issues an equipment command), has no unit conversion (unlike TemperatureSensor),
 * and its 0.0001–100000 range fits every chemistry value (incl. salt > 4000).
 *
 * Decimal / sub-100 params (pH, FC) are scaled ×10 into lux so the decimal
 * survives the integer-ish display; the TRUE labeled value (e.g. "7.4 pH") is
 * carried unscaled in the custom "Reading" characteristic for Eve. StatusFault
 * flags any out-of-band reading; StatusActive false = no data.
 *
 * The Name characteristic is set ONCE at construction and NEVER changed. This
 * class issues NO equipment writes/commands; it only updates display state.
 */
export class ChemistrySensor {
    private service: Service;
    /** Custom STRING characteristic carrying the exact labeled reading (Eve shows it). */
    private readonly Reading: WithUUID<{ new (): Characteristic }>;
    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly opts: { unit: string; scale?: number },
    ) {
        // In-place swap: earlier versions backed these tiles with an
        // AirQualitySensor. Remove that stale service so the accessory publishes
        // ONLY the LightSensor tile (Apple Home otherwise renders a confusing
        // dual-reading accessory). Harmless on a brand-new accessory.
        const staleAq = this.accessory.getService(this.platform.Service.AirQualitySensor);
        if (staleAq) {
            this.accessory.removeService(staleAq);
        }
        this.service = this.accessory.getService(this.platform.Service.LightSensor)
            || this.accessory.addService(this.platform.Service.LightSensor);
        // Name is fixed for the life of the accessory — never updated again.
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
        // Register supplemental characteristics as OPTIONAL so HAP doesn't warn
        // about characteristics outside the LightSensor required/optional set.
        this.service.addOptionalCharacteristic(this.platform.Characteristic.StatusActive);
        this.service.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
        this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, true);
        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.platform.Characteristic.StatusFault.NO_FAULT,
        );
        // Custom read-only "Reading" string (exact labeled value, for Eve).
        // addOptionalCharacteristic first to silence the HAP "not in section" warning.
        this.Reading = makeReadingCharacteristic(this.platform.api);
        this.service.addOptionalCharacteristic(this.Reading);
        this.service.getCharacteristic(this.Reading).updateValue('');
    }

    /** Update the tile from a fresh value + the active green band. No writes/commands. */
    update(value: number | undefined, band: Band | undefined): void {
        const C = this.platform.Characteristic;
        if (value === undefined || band === undefined) {
            this.service.updateCharacteristic(C.CurrentAmbientLightLevel, 0.0001);
            this.service.updateCharacteristic(C.StatusActive, false);
            this.service.getCharacteristic(this.Reading).updateValue('—');
            return;
        }
        const scale = this.opts.scale ?? 1;
        // CurrentAmbientLightLevel valid range is 0.0001 .. 100000 lux.
        const lux = Math.max(0.0001, Math.min(100000, value * scale));
        this.service.updateCharacteristic(C.CurrentAmbientLightLevel, lux);
        this.service.updateCharacteristic(C.StatusActive, true);
        this.service.updateCharacteristic(
            C.StatusFault,
            inRange(value, band) ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT,
        );
        // Exact labeled reading (TRUE value, NOT scaled) for Eve / non-Apple clients.
        this.service.getCharacteristic(this.Reading).updateValue(`${value} ${this.opts.unit}`);
        this.platform.log.debug(`${this.accessory.displayName} = ${value} ${this.opts.unit} (lux ${lux})`);
    }
}
