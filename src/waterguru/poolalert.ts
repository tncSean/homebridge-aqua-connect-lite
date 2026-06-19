import { Service, PlatformAccessory } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';

/**
 * Pool Alert — a ContactSensor. ContactSensorState DETECTED (1, "open") = a
 * red flag is active; NOT_DETECTED (0) = clear. Apple Home pushes a
 * notification when a contact sensor opens, giving us a native alert channel
 * with no push service. The current reason is mirrored into the
 * StatusFault/Name for at-a-glance context in the Home app.
 */
export class PoolAlert {
    private service: Service;
    private readonly defaultName: string;
    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.defaultName = this.accessory.displayName;
        this.service = this.accessory.getService(this.platform.Service.ContactSensor)
            || this.accessory.addService(this.platform.Service.ContactSensor);
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.defaultName);
        // Register StatusFault so the tile can show a fault badge alongside the contact state.
        this.service.setCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.platform.Characteristic.StatusFault.NO_FAULT,
        );
        this.clear();
    }
    raise(reason: string, tileName?: string): void {
        this.service.updateCharacteristic(
            this.platform.Characteristic.ContactSensorState,
            this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED, // "open" → alert
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.platform.Characteristic.StatusFault.GENERAL_FAULT,
        );
        if (tileName !== undefined) {
            this.service.updateCharacteristic(this.platform.Characteristic.Name, tileName);
        }
        this.platform.log.warn(`Pool Alert: ${reason}`);
    }
    clear(): void {
        this.service.updateCharacteristic(
            this.platform.Characteristic.ContactSensorState,
            this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED, // "closed" → ok
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.platform.Characteristic.StatusFault.NO_FAULT,
        );
        this.service.updateCharacteristic(this.platform.Characteristic.Name, this.defaultName);
    }
}
