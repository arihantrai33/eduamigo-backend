# Live bus tracking

How a parent sees the school bus move on a map, the way a delivery app shows its rider. Code: `src/services/busTracking.js`
(the engine), `src/routes/transportRoutes.js` (the API), `src/pages/driver/` and `src/pages/bus/` in the frontend.

## The path of one GPS reading

```
driver phone ──batch of readings──> POST /api/transport/driver/:token/location
                                       │  checks, snaps to the road, follows the stops, works out ETAs
                                       ▼
                         saved on the bus (database) + pushed to everyone watching
                                       │
parent / student / school <── GET /api/transport/live/:busId          (the whole picture: first, and as a fallback)
                          <── GET /api/transport/live/:busId/stream   (then every change, one JSON line each)
```

No Firebase and no other real-time service is involved. The old Firebase path (`transport/<trackingId>`) is not used any more;
`FIREBASE_SERVICE_ACCOUNT` is still needed for push notifications to phones, not for the map.

## A trip, step by step

1. The driver opens the driver page (`/driver`) with the secret driver code, chooses **Morning pickup** or **Afternoon drop** and
   presses **Start Trip**. The server resets the stops, builds the road route (below), tells the parents "the bus has started".
2. The phone reads the GPS (high accuracy) and keeps every reading in a queue saved on the phone. Every 4 seconds it sends the
   queue in one batch. With no network the queue keeps growing (up to 400 readings) and is sent, in order, when the network is
   back. A standing bus sends a "still here" reading every 10 seconds.
3. For every reading the server:
   - drops it if the coordinates are wrong, the accuracy is worse than 100 m, it is older than the last one or a repeat, or it
     would mean driving faster than 120 km/h since the last reading (a GPS jump);
   - snaps it onto the road when it is within 50 m of it (otherwise shows the raw position and marks the bus "off route");
   - works out the speed (smoothed) and the direction;
   - follows the stops: within 70 m of the current stop it is "reached"; 130 m on (or past it along the road) it is "departed"
     and the next stop becomes current. The driver's "Reached stop" button does the same by hand;
   - recalculates the ETA of every stop that is still ahead: distance left on the road ÷ the bus's recent average speed
     (between 12 and 45 km/h), plus 30 seconds for each stop in between.
4. Parents are told, once per trip and per child: trip started; bus about 5 minutes from the child's stop; bus at the child's
   stop; trip ended. The child's stop is set by the school under **Transport → Assign students**. Notifications go through the
   normal notification service, so they appear in the app and as phone pushes.
5. The driver ends the trip (or the school's clean-up job does, after 3 hours without a reading).

The drop run goes the other way: the stops are reversed, so the first stop is the school.

## What the screens show

- A moving bus that glides along the road between readings instead of jumping, a road line split into "driven" and "to go", the
  stops with their real status and ETA, and the child's stop marked. The map follows the bus like a navigation app, stops
  following when the person drags the map, and a button brings it back.
- A status pill: **LIVE**, **WEAK GPS SIGNAL**, **WAITING FOR GPS**, or **SIGNAL LOST · LAST SEEN 2 MIN AGO** (nothing for
  45 seconds). If the live stream breaks the screen keeps working by asking for the picture every few seconds and reconnects.

## Settings (all optional)

| Variable | Default | Meaning |
|---|---|---|
| `ROUTING_URL` | public OSRM demo server | An OSRM-compatible routing service for the road line. `off` = straight lines between stops. The public demo server has no promise of availability: for a school fleet use your own OSRM or a paid provider with the same API. Called once when a trip starts, never per viewer. |
| `BUS_STALE_MS` | 45000 | No reading for this long = "signal lost" |
| `BUS_MAX_ACCURACY_M` | 100 | Readings less accurate than this are ignored |
| `BUS_MAX_SPEED_KMH` | 120 | A jump faster than this between two readings is ignored |
| `BUS_ARRIVE_M` / `BUS_DEPART_M` | 70 / 130 | Stop reached / left |
| `BUS_NEAR_MINUTES` | 5 | "Bus is about N minutes away" alert |
| `DRIVER_LOCATION_PER_MINUTE` | 90 | Limit per driver code |

The frontend map uses the free OpenStreetMap tile server. Its usage policy allows light use only; for real traffic set a tile
provider (MapTiler, Mapbox, Stadia) in the map components.

## Limits you should know

- **A web page cannot read the GPS when the phone is locked or another app is in front.** The driver page keeps the screen on
  (Wake Lock) and warns when it was hidden. Tracking that continues with the screen off needs the installed Android app with a
  background-location plugin (not built yet): this is the one thing a web app cannot do.
- Live updates are pushed from the server process that received the reading. With one server instance that is everyone; with
  several, the other instances' viewers are served by the polling fallback (a few seconds late) until a shared channel is added.
- The ETA is a good estimate from distance and recent speed, not a traffic prediction.

## Trying it

```
node src/scripts/simulateBus.js <driverToken> --api http://localhost:8000/api --kmh 40   # drives the bus along its route
```
Open the Bus screen as a student or parent of that bus. Tests: `tests/bus-tracking.test.js` (22 tests through the HTTP API) and
the frontend `e2e/bus-live.spec.js` (real backend: a student watching the bus, signal loss and recovery, and the driver page
driven by the browser's simulated GPS including going offline and reloading).

## Data

`Transport.live` holds the latest position; `BusTripPoint` keeps a sampled point every 15 seconds for 3 days (`GET
/api/transport/live/:busId/history` for the school office). `Student.busStopId` is where the child gets on and off.
