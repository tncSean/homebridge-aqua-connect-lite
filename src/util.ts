import { AquaConnectLitePlatform } from './platform';
import axios, { AxiosError } from 'axios';
import { parse } from 'node-html-parser';
import { AC_API_SETTINGS } from './settings';

/**
 * Get the current state of a device by querying the pool controller.
 * Uses retry logic with exponential backoff for reliability.
 *
 * @param platform - The platform instance
 * @param deviceKeyIndex - Index into the LED status byte string
 * @param retries - Number of retry attempts (default: 3)
 * @returns Promise resolving to 'on', 'off', 'blink', or 'nokey'
 */
export const GetDeviceState = async (
    platform: AquaConnectLitePlatform,
    deviceKeyIndex: number,
    retries: number = 3
): Promise<string> => {
    let lastError: Error | null = null;
    const timeout = platform.config.request_timeout || 5000;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const body = AC_API_SETTINGS.UPDATE_LOCAL_SERVER_POST_BODY;
            const config = {
                method: 'post',
                url: `http://${platform.config.bridge_ip_address}${AC_API_SETTINGS.PATH}`,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Connection': 'close'
                },
                data: body,
                timeout: timeout,
                validateStatus: (status: number) => status === 200
            };

            platform.log.debug(`[${attempt}/${retries}] GetDeviceState - fetching state`);

            const response = await axios(config);
            const rawLedStatus = GetRawLedStatus(response.data);
            const asciiByteString = ConvertToAsciiByteString(rawLedStatus);
            const ledStatus = GetLedStatus(asciiByteString, deviceKeyIndex);

            platform.log.debug(`GetDeviceState success - LED status: ${ledStatus}`);
            return ledStatus;

        } catch (error) {
            lastError = error as Error;
            const axiosError = error as AxiosError;

            platform.log.warn(`GetDeviceState attempt ${attempt} failed: ${axiosError.message}`);

            if (attempt < retries) {
                // Exponential backoff: 500ms, 1s, 2s
                const delay = Math.pow(2, attempt - 1) * 500;
                platform.log.debug(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
};

/**
 * Toggle a device state by simulating a button press on the controller.
 * Uses retry logic with exponential backoff for reliability.
 *
 * @param platform - The platform instance
 * @param processKeyNum - The key ID to send (e.g., '09' for Pool Light)
 * @param retries - Number of retry attempts (default: 3)
 * @returns Promise resolving to 'success'
 */
export const ToggleDeviceState = async (
    platform: AquaConnectLitePlatform,
    processKeyNum: string,
    retries: number = 3
): Promise<string> => {
    let lastError: Error | null = null;
    const timeout = platform.config.request_timeout || 5000;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const body = `KeyId=${processKeyNum}&`;
            const config = {
                method: 'post',
                url: `http://${platform.config.bridge_ip_address}${AC_API_SETTINGS.PATH}`,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Connection': 'close'
                },
                data: body,
                timeout: timeout,
                validateStatus: (status: number) => status === 200
            };

            platform.log.debug(`[${attempt}/${retries}] ToggleDeviceState - sending KeyId=${processKeyNum}`);

            const response = await axios(config);
            platform.log.debug(`ToggleDeviceState response: ${response.status}`);

            return 'success';

        } catch (error) {
            lastError = error as Error;
            const axiosError = error as AxiosError;

            platform.log.warn(`ToggleDeviceState attempt ${attempt} failed: ${axiosError.message}`);

            if (attempt < retries) {
                const delay = Math.pow(2, attempt - 1) * 500;
                platform.log.debug(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
};

/**
 * Extract the raw LED status string from the controller's HTML response.
 * The controller returns a page with 'xxx' delimiters; the LED status is in the 3rd segment.
 *
 * @param htmlData - Raw HTML response from the controller
 * @returns The raw LED status string (e.g., "333333453333...")
 * @throws Error if the HTML format is unrecognized
 */
const GetRawLedStatus = (htmlData: string): string => {
    try {
        const root = parse(htmlData);
        const bodyText = root.querySelector('body')?.text || '';

        // Primary method: split on 'xxx' delimiter
        const splitResults = bodyText.split('xxx');

        if (splitResults.length >= 3) {
            const candidate = splitResults[2].trim();
            // Validate: LED status should be 24+ chars of valid status codes
            if (candidate.length >= 24 && /^[3-6C-S]+$/.test(candidate)) {
                return candidate;
            }
        }

        // Fallback: look for LED status pattern directly in body text
        // Pattern: 24+ consecutive valid status characters
        const ledPattern = /([3-6C-S]{24,})/.exec(bodyText);
        if (ledPattern) {
            return ledPattern[1];
        }

        // If we get here, the HTML format doesn't match expected patterns
        throw new Error(`Invalid controller response: expected LED status pattern, got "${bodyText.substring(0, 100)}..."`);

    } catch (error) {
        if (error instanceof Error && error.message.startsWith('Invalid controller response')) {
            throw error;
        }
        throw new Error(`Failed to parse controller HTML: ${(error as Error).message}`);
    }
};

/**
 * Extract the status of a specific LED from the ASCII byte string.
 *
 * @param asciiByteString - The converted LED status string
 * @param deviceKeyIndex - Index of the device in the status string
 * @returns 'on', 'off', 'blink', 'nokey', or empty string if invalid index
 */
const GetLedStatus = (asciiByteString: string, deviceKeyIndex: number): string => {
    if (deviceKeyIndex < 0 || deviceKeyIndex >= asciiByteString.length) {
        return '';
    }

    const statusCode = asciiByteString[deviceKeyIndex];

    switch (statusCode) {
        case '3': return 'nokey';
        case '4': return 'off';
        case '5': return 'on';
        case '6': return 'blink';
        default: return '';
    }
};

/**
 * Convert raw LED status characters to ASCII byte string.
 * Each character in the raw status represents two nibbles that encode the state.
 *
 * @param rawLedStatus - Raw LED status from controller
 * @returns ASCII byte string where each char represents a device state
 */
const ConvertToAsciiByteString = (rawLedStatus: string): string => {
    let asciiByteString = '';
    for (let i = 0; i < rawLedStatus.length; i++) {
        asciiByteString += ExtractNibbles(rawLedStatus[i]);
    }
    return asciiByteString;
};

/**
 * Convert a single character from the controller to its two-nibble ASCII representation.
 * The controller uses a custom encoding where each character maps to a byte pair.
 *
 * @param asciiByte - Single character from controller response
 * @returns Two-character ASCII string representing the byte
 */
const ExtractNibbles = (asciiByte: string): string => {
    const nibbleMap: Record<string, string> = {
        '3': '33', '4': '34', '5': '35', '6': '36',
        'C': '43', 'D': '44', 'E': '45', 'F': '46',
        'S': '53', 'T': '54', 'U': '55', 'V': '56',
        'c': '63', 'd': '64', 'e': '65', 'f': '66'
    };

    return nibbleMap[asciiByte] || '00';
};
