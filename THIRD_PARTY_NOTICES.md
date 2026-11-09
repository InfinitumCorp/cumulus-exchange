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

## Pattern only

Granular opt-in, per-purpose withdrawal, and an append-only record follow the shape of consent managers such as Klaro (BSD-3-Clause, <https://github.com/kiprotect/klaro>). No Klaro source is included.
