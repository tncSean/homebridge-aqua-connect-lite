import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { AquaConnectLitePlatform } from './platform';
import { AquaLogicClient } from './aqualogic/client';
import { Key } from './aqualogic/keys';
import { PoolState } from './aqualogic/state';

const F_TO_C = (f: number): number => ((f - 32) * 5) / 9;
const C_TO_F = (c: number): number => (c * 9) / 5 + 32;

/**
 * Pool Heater surfaced as HomeKit Thermostat.
 *
 * CurrentTemperature   ← poolTempF
 * TargetTemperature    ← heaterSetpointF; writes emit PLUS/MINUS keypresses
 * CurrentHeatingCoolingState  = Heat when heater relay is on, Off otherwise
 * TargetHeatingCoolingState   = Off / Heat (no Cool, no Auto)
 *
 * Range: 65-104°F (Hayward Pro Logic hard limits).
 *
 * Setpoint writes are best-effort: we send delta × PLUS/MINUS presses;
 * the Pro Logic must already be on the heater menu for PLUS/MINUS to
 * take effect. We send the HEATER key first to navigate there, then the
 * delta. Readback verification comes from the next DISPLAY_UPDATE frame.
 */
export class Thermostat {
    private service: Service;
    private pendingTargetF: number | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private writing = false;

    private static readonly DEBOUNCE_MS = 500;
    private static readonly MIN_F = 65;
    private static readonly MAX_F = 104;

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly client: AquaLogicClient,
    ) {
        this.service = this.accessory.getService(this.platform.Service.Thermostat)
            || this.accessory.addService(this.platform.Service.Thermostat);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

        // Configure TargetTemperature range (HomeKit uses °C).
        this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
            .setProps({
                minValue: round1(F_TO_C(Thermostat.MIN_F)),
                maxValue: round1(F_TO_C(Thermostat.MAX_F)),
                minStep: round1(F_TO_C(1) - F_TO_C(0)),
            })
            .onGet(() => {
                const sp = this.client.state.current.heaterSetpointF;
                // If setpoint is 'off' or still unknown, show MIN_F as an
                // obvious placeholder. HomeKit will also show the thermostat
                // as OFF so the value is moot, but it must be in range.
                const f = typeof sp === 'number' ? sp : Thermostat.MIN_F;
                return round1(F_TO_C(f));
            })
            .onSet(this.setTargetTemp.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .onGet(() => round1(F_TO_C(this.client.state.current.poolTempF ?? 75)));

        this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
            .setProps({
                validValues: [
                    this.platform.Characteristic.TargetHeatingCoolingState.OFF,
                    this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
                ],
            })
            .onGet(() => this.computeTargetState())
            .onSet(this.setTargetState.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.computeCurrentState());

        // Default the user's display unit to Fahrenheit (matches the pool).
        this.service.setCharacteristic(
            this.platform.Characteristic.TemperatureDisplayUnits,
            this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
        );

        // Seed with the MIN of the valid range so HAP doesn't reject the stock
        // default (10°C, below our 18.3°C min). Using MIN_F rather than an
        // invented mid-range value makes it obvious when the characteristic
        // is still at the placeholder and the real setpoint hasn't been
        // read from the Pro Logic display yet. Setpoint only becomes visible
        // to RS-485 when the controller's menu cycles through or is
        // navigated to the "Heater1 SET TO XX°F" screen.
        this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            round1(F_TO_C(Thermostat.MIN_F)),
        );
        this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            round1(F_TO_C(Thermostat.MIN_F)),
        );

        this.client.state.on('change', (key: keyof PoolState) => {
            if (key === 'poolTempF') {
                const v = this.client.state.current.poolTempF;
                if (typeof v === 'number') {
                    this.service.updateCharacteristic(
                        this.platform.Characteristic.CurrentTemperature,
                        round1(F_TO_C(v)),
                    );
                }
            }
            if (key === 'heaterSetpointF') {
                const v = this.client.state.current.heaterSetpointF;
                this.platform.log.info(
                    `${this.accessory.displayName} setpoint read from Pro Logic: ${v === 'off' ? 'Off' : v + '°F'}`,
                );
                // Thermostat characteristic demands a number in range even when
                // the pool's setpoint is "Off"; we park it at MIN_F and let the
                // TargetHeatingCoolingState = OFF be the truthful signal.
                const f = typeof v === 'number' ? v : Thermostat.MIN_F;
                this.service.updateCharacteristic(
                    this.platform.Characteristic.TargetTemperature,
                    round1(F_TO_C(f)),
                );
                // Setpoint change can also imply a mode change (off ↔ armed),
                // so re-push both HeatingCoolingState characteristics.
                this.service.updateCharacteristic(
                    this.platform.Characteristic.TargetHeatingCoolingState,
                    this.computeTargetState(),
                );
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentHeatingCoolingState,
                    this.computeCurrentState(),
                );
            }
            if (key === 'heaterMode') {
                const mode = this.client.state.current.heaterMode;
                this.platform.log.info(`${this.accessory.displayName} mode read from Pro Logic: ${mode}`);
                this.service.updateCharacteristic(
                    this.platform.Characteristic.TargetHeatingCoolingState,
                    this.computeTargetState(),
                );
                this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentHeatingCoolingState,
                    this.computeCurrentState(),
                );
            }
        });
    }

    /**
     * Truthful heater-enabled state for HomeKit:
     *  - Setpoint === 'off' → OFF (user has disabled heater via setpoint)
     *  - Setpoint unknown   → OFF (don't claim armed without evidence)
     *  - Setpoint is a number or mode says 'heating' → HEAT
     */
    private computeTargetState(): number {
        const st = this.client.state.current;
        const Char = this.platform.Characteristic.TargetHeatingCoolingState;
        if (st.heaterSetpointF === 'off') return Char.OFF;
        if (st.heaterMode === 'heating' || typeof st.heaterSetpointF === 'number') return Char.HEAT;
        return Char.OFF;
    }

    private computeCurrentState(): number {
        const mode = this.client.state.current.heaterMode;
        const Char = this.platform.Characteristic.CurrentHeatingCoolingState;
        return mode === 'heating' ? Char.HEAT : Char.OFF;
    }

    private async setTargetState(value: CharacteristicValue): Promise<void> {
        const sp = this.client.state.current.heaterSetpointF;
        const want = value === this.platform.Characteristic.TargetHeatingCoolingState.OFF ? 'off' : 'on';
        const isOff = sp === 'off' || sp === undefined;
        this.platform.log.info(
            `${this.accessory.displayName} setTargetState value=${value} want=${want} sp=${sp} isOff=${isOff}`,
        );
        if ((want === 'off' && !isOff) || (want === 'on' && isOff)) {
            try {
                this.platform.log.info(`${this.accessory.displayName} sending HEATER_1 key (0x${Key.HEATER_1.toString(16)})`);
                await this.client.sendKey(Key.HEATER_1);
                this.platform.log.info(`${this.accessory.displayName} HEATER_1 key sent`);
            } catch (e) {
                this.platform.log.error(`${this.accessory.displayName} HEATER toggle failed: ${(e as Error).message}`);
                throw new this.platform.api.hap.HapStatusError(
                    this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
                );
            }
        } else {
            this.platform.log.info(`${this.accessory.displayName} no-op: already in target state`);
        }
    }

    private async setTargetTemp(value: CharacteristicValue): Promise<void> {
        const targetC = value as number;
        const targetF = clamp(Math.round(C_TO_F(targetC)), Thermostat.MIN_F, Thermostat.MAX_F);
        this.pendingTargetF = targetF;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        return new Promise<void>((resolve) => {
            this.debounceTimer = setTimeout(() => {
                this.flushPending().then(resolve, () => resolve());
            }, Thermostat.DEBOUNCE_MS);
        });
    }

    private async flushPending(): Promise<void> {
        if (this.pendingTargetF === null || this.writing) return;
        const target = this.pendingTargetF;
        this.pendingTargetF = null;
        this.writing = true;
        try {
            const current = this.client.state.current.heaterSetpointF;
            if (current === undefined || current === 'off') {
                // Either cold start or setpoint is literally "Off". In both
                // cases a blind bump is wrong:
                //  - unknown: we don't know the delta to apply
                //  - 'off':   first PLUS from Off jumps to 65°F not (65+N)
                // Skip and warn; navigating the setpoint menu from HomeKit
                // requires a multi-key macro we cannot run blindly.
                this.platform.log.warn(
                    `${this.accessory.displayName} skipped: setpoint is ` +
                    `${current === 'off' ? '"Off" — enable at panel first' : 'unknown — waiting for display cycle'}. ` +
                    `Retry in ~30s or navigate the Pro Logic Heater1 menu once.`,
                );
                return;
            }
            this.platform.log.info(
                `${this.accessory.displayName} adjust ${current}°F → ${target}°F`,
            );
            // Navigate to heater menu first so PLUS/MINUS adjust the setpoint,
            // then emit the delta. On some firmware the HEATER key toggles mode;
            // if that happens the user will see no setpoint change and retry.
            await this.client.sendKey(Key.HEATER_1);
            await sleep(150);
            await this.client.bump(current, target);
        } catch (e) {
            this.platform.log.error(`${this.accessory.displayName} setpoint adjust failed: ${(e as Error).message}`);
        } finally {
            this.writing = false;
        }
    }
}

function clamp(n: number, lo: number, hi: number): number {
    return n < lo ? lo : n > hi ? hi : n;
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}
