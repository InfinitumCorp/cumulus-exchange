/** Tiny synthetic v2ray lists. The .dat files next to this module are the encoded form. */

const v4 = (a, b, c, d) => Uint8Array.from([a, b, c, d]);

export const geoipEntries = [
  { country: "US", cidrs: [{ ip: v4(1, 2, 3, 0), prefix: 24 }] },
  { country: "CN", cidrs: [{ ip: v4(1, 2, 3, 128), prefix: 25 }] },
  {
    country: "V6",
    cidrs: [
      {
        ip: Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        prefix: 32,
      },
    ],
  },
  { country: "PRIVATE", cidrs: [{ ip: v4(10, 0, 0, 0), prefix: 8 }] },
  { country: "OUTSIDE", reverse: true, cidrs: [{ ip: v4(10, 0, 0, 0), prefix: 8 }] },
];

export const geositeEntries = [
  {
    category: "google",
    domains: [{ type: 2, value: "google.com", attributes: [{ key: "cn", bool: true }] }],
  },
  { category: "ads", domains: [{ type: 0, value: "doubleclick" }] },
  { category: "cdn", domains: [{ type: 3, value: "cdn.example" }] },
  { category: "news", domains: [{ type: 1, value: "^news\\." }] },
];
