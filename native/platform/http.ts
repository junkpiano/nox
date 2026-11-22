/**
 * The native side of the cross-origin fetch seam.
 *
 * React Native has no CORS: requests go out below the browser's origin
 * model, so LNURL endpoints are asked directly. Link cards (OGP) still go
 * through the proxy worker, as on every platform: a URL from somebody
 * else's post, fetched by the reader's own phone, could reach the reader's
 * own network.
 */

import { setCrossOriginFetch } from '../../src/common/native-http';

export function installNativeHttp(): void {
  setCrossOriginFetch((url: string, init?: RequestInit): Promise<Response> => {
    return fetch(url, init);
  });
}
