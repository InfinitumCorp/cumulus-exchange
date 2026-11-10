# Third-party notices

The Cumulus Data Exchange console adapts permissively licensed patterns. Program source in this repository is MIT, Apache-2.0, or BSD. The optional geo datasets below are fetched into a gitignored directory and are not committed. Loyalsoldier and sing-box lists are GPL-3 and are not used.

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

## Geo routing data

`npm run geo:fetch` downloads the pinned v2fly release assets into `data/geo/` and refuses the download when the official `.sha256sum` or the file hash disagrees with `data/geo/geo.lock.json`.

### v2fly geoip — CC-BY-SA-4.0

Copyright v2fly contributors  
<https://github.com/v2fly/geoip>  
Release `202611080027`, asset `geoip.dat`  
SHA-256 `eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2`  
License: <https://creativecommons.org/licenses/by-sa/4.0/>

The geoip project includes free IP geolocation data by DB-IP, licensed under CC-BY-4.0.  
<https://db-ip.com>  
<https://creativecommons.org/licenses/by/4.0/>

### v2fly domain-list-community — MIT

Copyright (c) 2018-2019 V2Ray  
<https://github.com/v2fly/domain-list-community>  
Release `20261108011013`, asset `dlc.dat`, saved locally as `geosite.dat`  
SHA-256 `dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2`

Permission is granted to use the dataset under the MIT license published in that repository. The copyright notice and permission notice must stay with substantial portions of the dataset. This repository fetches the file instead of vendoring it.

## Pattern only

Granular opt-in, per-purpose withdrawal, and an append-only record follow the shape of consent managers such as Klaro (BSD-3-Clause, <https://github.com/kiprotect/klaro>). No Klaro source is included.
