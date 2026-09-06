/**
 * The native side of the cross-origin fetch seam.
 *
 * The web build routes OGP, oEmbed and LNURL lookups through a proxy worker
 * because a browser tab cannot read a cross-origin response. React Native has
 * no such restriction: requests go out below the browser's origin model, so
 * the origin can simply be asked.
 *
 * That makes the proxy not merely unnecessary here but wrong - it would send
 * every link the viewer opens through a third party for no benefit.
 */

import { setCrossOriginFetch } from '../../src/common/native-http';

export function installNativeHttp(): void {
  setCrossOriginFetch((url: string, init?: RequestInit): Promise<Response> => {
    return fetch(url, init);
  });
}
