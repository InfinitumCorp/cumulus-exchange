// @ts-check

import { encodeGeoIpList, encodeGeoSiteList } from "./protobuf.mjs";

/** Tiny synthetic GeoIPList used by tests. Not an upstream dataset. */
export function fixtureGeoIpBytes() {
  return encodeGeoIpList([
    {
      code: "US",
      cidrs: [
        { ip: Uint8Array.of(1, 2, 3, 0), prefix: 24 },
        {
          ip: Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
          prefix: 32,
        },
      ],
    },
    {
      code: "CN",
      cidrs: [{ ip: Uint8Array.of(1, 2, 3, 4), prefix: 32 }],
    },
    {
      code: "PRIVATE",
      cidrs: [{ ip: Uint8Array.of(10, 0, 0, 0), prefix: 8 }],
    },
  ]);
}

/** Tiny synthetic GeoSiteList used by tests. Not an upstream dataset. */
export function fixtureGeoSiteBytes() {
  return encodeGeoSiteList([
    {
      code: "google",
      domains: [
        { type: 2, value: "google.com" },
        { type: 3, value: "www.google.com" },
      ],
    },
    {
      code: "category-ads",
      domains: [
        { type: 2, value: "ads.example" },
        { type: 0, value: "doubleclick" },
      ],
    },
    {
      code: "regex-sample",
      domains: [{ type: 1, value: "^ads\\.tracker\\.test$" }],
    },
  ]);
}
