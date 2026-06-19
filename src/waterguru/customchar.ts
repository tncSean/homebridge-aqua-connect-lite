import { API, Characteristic, WithUUID } from 'homebridge';

/**
 * Custom read-only STRING characteristic carrying the EXACT chemistry reading
 * (e.g. "2900 ppm", "7.4 pH"). Apple Home ignores unknown characteristics, but
 * Eve and other HAP clients surface it — giving an at-a-glance precise value
 * the AirQuality compliance level can't express.
 *
 * The class is built from `api.hap.Characteristic` at runtime (homebridge's
 * standard custom-characteristic idiom) so it inherits everything HAP needs.
 * The UUID is a stable hardcoded random v4 — never change it or existing tiles
 * lose the characteristic on upgrade.
 */
const READING_UUID = '6b2e1f40-8c3a-4d21-9a7e-1f2b3c4d5e6f';

/** Returns the (cached) Reading characteristic constructor for this platform's HAP. */
export function makeReadingCharacteristic(api: API): WithUUID<{ new (): Characteristic }> {
    const hap = api.hap;
    class Reading extends hap.Characteristic {
        static readonly UUID: string = READING_UUID;
        constructor() {
            super('Reading', READING_UUID, {
                format: hap.Characteristic.Formats.STRING,
                perms: [hap.Characteristic.Perms.PAIRED_READ, hap.Characteristic.Perms.NOTIFY],
            });
            this.value = '';
        }
    }
    return Reading;
}
