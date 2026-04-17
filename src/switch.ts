import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { AquaConnectLitePlatform } from './platform';
import { GetDeviceState, ToggleDeviceState } from './util';

/**
 * Platform accessory for Switch-type devices (Aux relays, etc.)
 * Handles HomeKit Switch service with proper async state management.
 */
export class Switch {
    private service: Service;
    private currentState = {
        IsOn: true,
        ToggleInProgress: false,
        ExpectedToggleState: false
    };

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory
    ) {
        this.service = this.accessory.getService(this.platform.Service.Switch)
            || this.accessory.addService(this.platform.Service.Switch);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onSet(this.setOn.bind(this))
            .onGet(this.getOn.bind(this));
    }

    /**
     * Handle HomeKit set requests for the Switch On characteristic.
     * Uses proper async/await to ensure the toggle completes before returning.
     *
     * @param value - The new On state (true/false)
     */
    async setOn(value: CharacteristicValue): Promise<void> {
        this.platform.log.debug('---------------------------');
        this.platform.log.debug(
            `${this.accessory.displayName} setOn request: ${value === true ? 'on' : 'off'}. ` +
            `Current: IsOn=${this.currentState.IsOn}, ToggleInProgress=${this.currentState.ToggleInProgress}`
        );

        // Prevent concurrent toggle requests
        if (this.currentState.ToggleInProgress) {
            this.platform.log.debug(`${this.accessory.displayName} toggle in progress, ignoring request`);
            return;
        }

        try {
            // Get current device state to determine if toggle is needed
            const deviceState = await GetDeviceState(
                this.platform,
                this.accessory.context.device.STATUS_KEY_INDEX
            );

            const invert = this.accessory.context.device.INVERT === true;
            const onLedValue = invert ? 'off' : 'on';
            const isDeviceOn = deviceState === onLedValue;
            const isStateInSync = isDeviceOn === value;

            this.platform.log.debug(
                `${this.accessory.displayName} deviceState=${deviceState}, ` +
                `isStateInSync=${isStateInSync}`
            );

            if (!isStateInSync) {
                // State mismatch - need to toggle
                this.platform.log.debug(`${this.accessory.displayName} toggling device...`);
                this.currentState.ToggleInProgress = true;
                this.currentState.ExpectedToggleState = value === true;

                try {
                    await ToggleDeviceState(
                        this.platform,
                        this.accessory.context.device.PROCESS_KEY_NUM
                    );

                    // Toggle succeeded - update state
                    this.currentState.IsOn = value === true;
                    this.platform.log.debug(`${this.accessory.displayName} toggle succeeded, IsOn=${this.currentState.IsOn}`);

                } catch (error) {
                    this.platform.log.error(`${this.accessory.displayName} toggle failed: ${(error as Error).message}`);
                    throw new this.platform.api.hap.HapStatusError(
                        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
                    );
                } finally {
                    this.currentState.ToggleInProgress = false;
                }

            } else {
                // Already in sync - just update internal state
                this.currentState.IsOn = value === true;
                this.platform.log.debug(`${this.accessory.displayName} already in target state`);
            }

        } catch (error) {
            if (error instanceof this.platform.api.hap.HapStatusError) {
                throw error;
            }
            this.platform.log.error(`${this.accessory.displayName} setOn failed: ${(error as Error).message}`);
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
            );
        }
    }

    /**
     * Handle HomeKit get requests for the Switch On characteristic.
     * Returns cached state if toggle is in progress, otherwise queries controller.
     *
     * @returns Current On state
     */
    async getOn(): Promise<CharacteristicValue> {
        this.platform.log.debug('---------------------------');
        this.platform.log.debug(
            `${this.accessory.displayName} getOn request. ` +
            `Current: IsOn=${this.currentState.IsOn}, ToggleInProgress=${this.currentState.ToggleInProgress}`
        );

        // If toggle is in progress, return expected state for responsive UI
        if (this.currentState.ToggleInProgress) {
            this.platform.log.debug(`${this.accessory.displayName} returning ExpectedToggleState: ${this.currentState.ExpectedToggleState}`);
            return this.currentState.ExpectedToggleState;
        }

        try {
            const deviceState = await GetDeviceState(
                this.platform,
                this.accessory.context.device.STATUS_KEY_INDEX
            );

            const invert = this.accessory.context.device.INVERT === true;
            const onLedValue = invert ? 'off' : 'on';
            this.currentState.IsOn = deviceState === onLedValue;
            this.platform.log.debug(`${this.accessory.displayName} getOn success: ${this.currentState.IsOn}`);

            return this.currentState.IsOn;

        } catch (error) {
            this.platform.log.error(`${this.accessory.displayName} getOn failed: ${(error as Error).message}`);
            throw new this.platform.api.hap.HapStatusError(
                this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
            );
        }
    }
}
