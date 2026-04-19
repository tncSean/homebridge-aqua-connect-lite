import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { AquaConnectLitePlatform } from './platform';
import { AquaLogicClient } from './aqualogic/client';
import { PoolState } from './aqualogic/state';

/**
 * Chlorinator output control, surfaced as HomeKit Lightbulb for a clean
 * 0-100 dimmer slider (Fan's RotationSpeed would also work but Lightbulb
 * feels more natural — users already understand Brightness).
 *
 * Brightness writes are converted to PLUS/MINUS keypresses via
 * AquaLogicClient.bump(). Slider debounce: 300ms from last write before
 * we actually emit keys, so dragging the slider only produces one burst.
 */
export class Chlorinator {
    private service: Service;
    private pendingTarget: number | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private writing = false;

    private static readonly DEBOUNCE_MS = 300;

    constructor(
        private readonly platform: AquaConnectLitePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly client: AquaLogicClient,
    ) {
        this.service = this.accessory.getService(this.platform.Service.Lightbulb)
            || this.accessory.addService(this.platform.Service.Lightbulb);

        this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => this.client.state.current.chlorinatorOn === true)
            .onSet(this.setOn.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.Brightness)
            .onGet(() => this.client.state.current.chlorinatorPercent ?? 0)
            .onSet(this.setBrightness.bind(this));

        this.client.state.on('change', (key: keyof PoolState) => {
            if (key === 'chlorinatorPercent') {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.Brightness,
                    this.client.state.current.chlorinatorPercent ?? 0,
                );
            }
            if (key === 'chlorinatorOn') {
                this.service.updateCharacteristic(
                    this.platform.Characteristic.On,
                    this.client.state.current.chlorinatorOn === true,
                );
            }
        });
    }

    private async setOn(value: CharacteristicValue): Promise<void> {
        // Turning "off" means drive brightness to 0 via the same keypress path.
        // Turning "on" with a previous percent just re-assserts HomeKit state —
        // HomeKit will also call setBrightness for a real value.
        if (value === false) {
            await this.queueBrightness(0);
        }
    }

    private async setBrightness(value: CharacteristicValue): Promise<void> {
        const target = clamp(Math.round(value as number), 0, 100);
        await this.queueBrightness(target);
    }

    private queueBrightness(target: number): Promise<void> {
        this.pendingTarget = target;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        return new Promise<void>((resolve) => {
            this.debounceTimer = setTimeout(() => {
                this.flushPending().then(resolve, () => resolve());
            }, Chlorinator.DEBOUNCE_MS);
        });
    }

    private async flushPending(): Promise<void> {
        if (this.pendingTarget === null || this.writing) return;
        const target = this.pendingTarget;
        this.pendingTarget = null;
        this.writing = true;
        try {
            const current = this.client.state.current.chlorinatorPercent;
            if (current === undefined) {
                // Cold start — we haven't read the display yet. Skip rather than
                // blind-press from assumed 0, which would spray keypresses at the
                // controller in the wrong menu context.
                this.platform.log.warn(
                    `${this.accessory.displayName} skipped: current % unknown. ` +
                    `Waiting for Pro Logic display to cycle — retry in ~30s.`,
                );
                return;
            }
            this.platform.log.info(
                `${this.accessory.displayName} adjust ${current}% → ${target}%`,
            );
            await this.client.bump(current, target);
        } catch (e) {
            this.platform.log.error(`${this.accessory.displayName} adjust failed: ${(e as Error).message}`);
        } finally {
            this.writing = false;
        }
    }
}

function clamp(n: number, lo: number, hi: number): number {
    return n < lo ? lo : n > hi ? hi : n;
}
