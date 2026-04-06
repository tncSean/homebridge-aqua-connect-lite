import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { AquaConnectLitePlatform } from './platform';

/**
 * Homebridge plugin entry point
 *
 * @param api - Homebridge API instance
 */
export default (api: API): void => {
    api.registerPlatform(PLATFORM_NAME, AquaConnectLitePlatform);
};
