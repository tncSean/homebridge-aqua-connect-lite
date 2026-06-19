import { Service, PlatformAccessory } from 'homebridge';
import { AquaConnectLitePlatform } from '../platform';

/**
 * Pool Alert — a ContactSensor. ContactSensorState NOT_DETECTED ("open") = a
 * red flag is active; DETECTED ("closed") = clear. Apple Home pushes a
 * notification when a contact sensor opens, giving us a native alert channel
 * with no push service. The Name is set ONCE at construction and NEVER changed
 * — the reason is delivered via the log + the optional ntfy push, not by
 * renaming the tile. StatusFault gives an at-a-glance fault badge.
 */
export class PoolAlert {
    private service: Service;
    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
    ) {
        this.service = this.accessory.getService(this.platform.Service.ContactSensor)
            || this.accessory.addService(this.platform.Service.ContactSensor);
        // Name is fixed for the life of the accessory — never updated again.
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
        // Register StatusFault so the tile can show a fault badge alongside the contact state.
        this.service.setCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.platform.Characteristic.StatusFault.NO_FAULT,
        );
        this.clear();
    }
    raise(reason: string): void {
        this.service.updateCharacteristic(
            this.platform.Characteristic.ContactSensorState,
            this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED, // "open" → alert
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.platform.Characteristic.StatusFault.GENERAL_FAULT,
        );
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
    }
}
