# Third-party notices

The Cumulus Data Exchange console adapts permissively licensed patterns. No source was copied from a project whose license is not MIT, Apache-2.0, or BSD.

## Dependencies

### Leaflet — BSD-2-Clause

Copyright (c) 2010-2023, Volodymyr Agafonkin  
Copyright (c) 2010-2011, CloudMade  
<https://github.com/Leaflet/Leaflet>

Used for the catalog map. Consumed as the published package. Schematic tiles are drawn by this console. OpenStreetMap tiles are not used.

### Leaflet.markercluster — MIT

Copyright (c) 2012 Dave Leaver  
<https://github.com/Leaflet/Leaflet.markercluster>

Clusters dataset and asset markers.

### Blueprint — Apache-2.0

Copyright Palantir Technologies  
<https://github.com/palantir/blueprint>

`@blueprintjs/core`, `@blueprintjs/table`, and `@blueprintjs/icons` (required by the table package). Used for the catalog table, selects, scope switches, and the license-offer overlay. Legacy `Overlay` and `Popover` are not rendered.

## Reviewed and not copied

### Anduril Lattice sample-app-entity-visualizer

<https://github.com/anduril/sample-app-entity-visualizer>

License: Anduril Lattice SDK license. That license is not MIT, Apache-2.0, or BSD. No source was copied. The map, clustering, and mock SSE-shaped position feed in this console are original.

### react-leaflet

<https://github.com/PaulLeCam/react-leaflet>

License: Hippocratic License 2.1. Not installed and not copied. The map wrapper around Leaflet is original.

## Geo datasets

Drive can annotate a policy decision with a country and a domain category when `INFINITUM_GEO_ENABLED` is on. The flag defaults off. The binaries are downloaded by `cloud/scripts/fetch-geo.mjs` into `cloud/var/geo/` and are not committed. Loyalsoldier and sing-box geosite lists are GPL-3 and are not used.

### v2fly geoip — CC-BY-SA-4.0

Project: v2fly/geoip, tag `202611080027`, asset `geoip.dat`  
<https://github.com/v2fly/geoip>  
<https://creativecommons.org/licenses/by-sa/4.0/>

The v2fly geoip project states that the free IP geolocation data by DB-IP is licensed under CC-BY-4.0.  
IP Geolocation by DB-IP: <https://db-ip.com>  
<https://creativecommons.org/licenses/by/4.0/>

### v2fly domain-list-community — MIT

Copyright (c) 2018-2019 V2Ray  
Project: v2fly/domain-list-community, tag `20261108011013`, asset `dlc.dat` stored as `geosite.dat`  
<https://github.com/v2fly/domain-list-community>

The MIT license in that repository applies. Its copyright notice and permission notice stay with the dataset.

## Pattern only

Granular opt-in, per-purpose withdrawal, and an append-only record follow the shape of consent managers such as Klaro (BSD-3-Clause, <https://github.com/kiprotect/klaro>). No Klaro source is included.
