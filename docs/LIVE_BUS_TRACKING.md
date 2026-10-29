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

**Student and parent (`/student/bus`, `/parent/bus`; `src/pages/bus/`):** the map fills the screen and everything else floats on it.
- A recognisable school bus seen from above that turns to face the way it drives (the angle is smoothed the short way round), glides
  along the road between readings, shows a pulse while live and is greyed out when its position is old. A road line split into "driven"
  (grey) and "to go" (the school's colour), numbered stops (done = green tick, next = dark with a yellow ring and its name, the child's
  stop = orange with "<name>'s stop", school = yellow), and a "Follow bus" button: the map follows the bus like a navigation app, stops
  following the moment the person drags or zooms, and the button brings it back.
- A header card: route, bus number plate, status pill (**LIVE**, **WEAK GPS SIGNAL**, **WAITING FOR GPS**, **SIGNAL LOST**, **TRIP COMPLETED**,
  **NOT ON ROUTE**), the run (morning pickup / afternoon drop) and how long ago the position was received. Under it, truthful banners:
  *Waiting for the bus's GPS*, *Weak GPS signal* (with how far off it may be), *Signal lost* (last seen, "shows where the bus was"),
  *You're offline* (last update time), *Reconnecting to the live feed*, *The bus is away from its usual route*, *Trip completed* (end time
  and duration). Nothing is shown as live when it is not, and ETAs and speed are shown only while the position is fresh.
- A sheet at the bottom (phone), a centred card (tablet), a card on the right (desktop, open by default): the ETA to the child's stop (or the
  last stop), the next stop, a progress ring, speed, last update, the child's card (stop and ETA), Call driver, SOS, trip start/end times and the
  stop timeline ("Left at 8:04 AM", "The bus is here now", "Arriving in about 4 min"). The sheet has three heights (drag, tap or the arrow keys).
- A finished trip is shown as "completed" for 6 hours, after that as "not started" (it would otherwise show yesterday's end time at breakfast).
- A parent with several children gets a child selector (only the children linked to that parent are listed; the server checks the child on
  every request); a child with no bus gets a plain message. Loading is a skeleton of the screen; "no bus" and "could not load" (with Try
  again, or offline) are different messages; access that ends while the map is open shows why and stops reconnecting.
- Keyboard and touch: every control is at least 40 px (44 px on touch screens); the sheet is a slider; reduced-motion places the bus instead of
  gliding and stops the pulse; text and banners meet WCAG AA (checked with axe); safe-area insets are respected.

**Driver (`/driver`; `src/pages/driver/`):** dark, one-hand screen. The bus, route and run; three status cards (GPS with accuracy and speed,
network with how many readings are waiting, location sharing with the time of the last upload); **Start Trip** and **End Trip** are 64 px
buttons that each ask first ("Start the morning pickup?", "End this trip?", with a warning if the bus has not reached the last stop or looks
like it is moving; Escape or Cancel changes nothing); next stop in large type and the stop list; "Reached stop" is **disabled while the bus is
moving** (above 8 km/h, from the phone's own speed) and the screen then shows only "Driving" and the next stop; blocked location, lost GPS,
no internet, a slow connection, a screen that was off and a trip running on another phone each have their own message with a retry or a
choice. There is no background tracking (see below): the screen says so.

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
| `DRIVER_IP_PER_MINUTE` | 3000 | A high ceiling per network address for driver requests (buses are counted per code, so buses sharing one address are fine; this only stops floods of guessed codes) |
| `BUS_SMOOTH_ABOVE_M` | 30 | A reading with a worse accuracy than this moves the bus only part of the way (weight falls with the square of the accuracy) |
| `BUS_STREAM_RECHECK_MS` | 30000 | An open live map re-checks that its viewer may still watch, this often (and at once when the bus's students change) |
| `BUS_SYNC_MS` / `BUS_IDLE_SYNC_MS` / `BUS_OWNER_MS` | 500 / 5000 / 6000 | Several server instances: how often an instance looks in the database for a bus it is not receiving readings for (on a trip / not on a trip), and how long after writing a bus itself it assumes it is in charge |

**Map tiles (frontend, Vercel):** `VITE_MAP_TILES` is the tile URL template (default: the free OpenStreetMap server, whose usage
policy allows light use only and forbids heavy or commercial traffic) and `VITE_MAP_ATTRIBUTION` the credit the provider requires.
For a real launch use a paid or self-hosted tile service (MapTiler, Mapbox, Stadia and similar) and set both; check the provider's
current price and its rules for the key (a browser-visible key must be restricted to your website's address in the provider's console).
Tile keys are public by nature; **server-only keys** (`MAPBOX_ACCESS_TOKEN` for routing) stay in the backend and never reach the website.
**Road routing (backend):** `ROUTING_URL` defaults to the public OSRM demo server (no availability promise, fair-use only) and `MAPBOX_ACCESS_TOKEN`
switches to Mapbox Directions (paid per request beyond a free allowance; one request per trip start, cached per route). If neither answers,
the route is drawn as straight lines between the stops and the screen says nothing more than that: the position itself is never invented.

## Who may watch, and for how long

- A student sees only the bus they are assigned to; a parent only the bus of the linked child they ask for (`?studentId=`, checked
  against the linked children on the server); the school office needs the transport permission. Everything is filtered by school.
  Every read (`/live/:busId`, `/live/:busId/stream`, `/my-child-bus`, lists, history) and every change (assigning students) is checked
  on the server; hiding a bus on the screen is never the protection.
- An **open live map is checked again** every `BUS_STREAM_RECHECK_MS` (30 s, a little random) and at once when students are assigned or
  removed or a bus is deleted: a removed assignment, a disabled account, a session that was signed out (or expired), a suspended
  school or a deleted bus ends the stream with `{"type":"revoked","reason":...}` and the screen says why and stops reconnecting
  (the screen also stops on 401/403/404). Without this a viewer would keep the stream open for days.
- Positions are published only to the people watching that one bus (a per-bus channel), never to all users or all schools. Driver
  codes and photo links never appear in the logs (the path is redacted). Raw GPS is not stored beyond the latest position and one
  sampled point every 15 s for 3 days.

## The driver, the trip and the phone

- The driver page has **no sign-in**: a secret code per bus (80 bits of randomness, shown only to the school office, replaceable at
  any time with "regenerate code") opens that one bus. A code works for its own bus only; a wrong code is a plain 404.
- **One running trip per bus.** Start Trip on a trip that is already running is refused (`409 TRIP_ALREADY_RUNNING`) instead of resetting
  the stops and telling every parent "the bus has started" again. A trip nobody has heard from for 15 minutes counts as abandoned and
  can be replaced. A deliberate takeover sends `restart: true`.
- **One phone per trip.** Each phone makes a random id once and sends it with everything. Readings or "reached stop" from any other
  phone while the trip runs are refused (`409 OTHER_PHONE`), so two phones with the same code cannot feed the bus conflicting
  positions. The second phone is told the trip runs elsewhere and may take over; the first is told and stops. Ending a trip is allowed
  from any phone (a lost phone must not lock the bus). Readings sent after the trip ended are refused (`409 TRIP_NOT_ACTIVE`).
- Readings are checked on the server: coordinates, timestamp (not older than 6 h; a phone clock more than 30 s ahead is corrected to the server's time), accuracy, speed, jumps,
  order and repeats; at most 60 per batch; 90 batches a minute per code.

## How a position gets from the phone to the map

phone GPS (every second, kept in a queue on the phone) -> batch every 4 s `POST /api/transport/driver/:code/location` -> server
checks, snaps to the road (a poor reading is blended with where the bus should be), follows the stops, works out ETAs, saves the latest
position on the bus -> pushed on the bus's own channel to the people watching it (`/live/:busId/stream`, one JSON object per line, a ping
every 15 s) -> the map glides the bus from its old position to the new one. The animation lives only in the browser: no reading is
ever invented, a reading older than one already shown is ignored, a far jump or a long gap is shown where it is, a reduced-motion
setting places the bus instead of gliding, the direction arrow turns the short way round (359 to 1 is a turn of 2 degrees), and a
position older than the stale time is shown faded with "signal lost" and the time it was last seen.

## Several server instances

Each instance keeps the picture of a bus in memory and in the database. An instance that did not write the bus itself looks in
the database (at most one small read per bus every 0.5 s while someone watches a trip, every 5 s otherwise), and passes changes on to
the people connected to it. With a single instance it never reads. Measured with two instances and the driver's batches alternating
between them: nothing refused, nothing missing, phone-to-screen p95 under 1 s. Per-instance state that is not shared and does not need
to be: rate-limit counters on the API (in memory by design), the tutor's answer cache.

## Limits you should know

- **Background tracking does not exist yet.** A web page cannot read the GPS when the phone is locked or another app is in front. The
  driver page keeps the screen on (Wake Lock) and warns when it was hidden; the driver must keep the app open and the screen on.
  No background-location plugin is installed in the Android/iOS apps (checked: only the app, keyboard, status-bar and messaging
  plugins). To add it: a Capacitor background-geolocation plugin, the Android foreground-service location permission and a
  persistent notification, iOS "Always" location with the background-mode entitlement and store justification, and a test on real
  phones (battery, vendor battery savers, permission prompts). This has to be tested on real devices; it cannot be verified in a
  browser or emulator.
- The ETA is a good estimate from distance and recent speed (about 35 to 55 s late on average because minutes are rounded up and
  30 s of waiting is assumed per stop), not a traffic prediction, and it is not shown when there is no reading.
- Road alignment depends on the routing service; without it the line between stops is straight.

## Trying it

```
node src/scripts/simulateBus.js <driverToken> --api http://localhost:8000/api --kmh 40   # drives the bus along its route
```
Open the Bus screen as a student or parent of that bus. Tests: `tests/bus-tracking.test.js` (through the HTTP API), `tests/bus-security.test.js` (who may see a bus, access taken away
while a map is open, one trip and one phone), `tests/bus-instances.test.js` (several servers), `tests/driver-rate-limit.test.js`, and
the frontend `e2e/bus-states.spec.js` (every state, five screen sizes, follow button, accessibility, child selector), `e2e/driver-ui.spec.js`,
`e2e/bus-live.spec.js` (real backend: a student watching the bus, signal loss and recovery, the driver page driven by the
browser's simulated GPS), `e2e/bus-access-ui.spec.js`, `e2e/bus-motion.spec.js`. Load and accuracy: `node loadtests/bus-check.js`
and `loadtests/mixed-check.js`. All of these use controlled readings; none replaces a drive with a real phone.

## Data

`Transport.live` holds the latest position; `BusTripPoint` keeps a sampled point every 15 seconds for 3 days (`GET
/api/transport/live/:busId/history` for the school office). `Student.busStopId` is where the child gets on and off.

## SOS (what it really does)

`POST /api/transport/sos` (parent or student, own bus only) saves an **SosEvent** (school, who, student, bus, trip, the server's own last reading of the bus, note) and creates an in-app notification for every active school admin. The event records per recipient whether the in-app row was created; push is fire-and-forget and recorded as `unconfirmed`; the driver has no account and is recorded as `driverNotified: false`. A location sent by the phone is ignored. A retry with the same `requestId` (8 to 64 characters) returns the same event with `duplicate: true` and sends nothing new; otherwise one SOS per user per 2 minutes (counted on saved events, so it holds even when the school has no admin). The event is saved before anyone is notified, so two copies of one tap at the same moment alert the office once. Each SOS is written to the audit log (`transport.sos`).

Not built: SMS or push confirmation to the office, an alert to the driver, escalation when nobody reads it, and a screen listing SOS events for the office. Adding a provider means calling it where the recipients are notified and recording its receipt in `recipients[].push`.

## Road routing: reading the logs
`roadGeometry` logs (JSON lines, no secrets, no coordinates): `route_provider_off` (ROUTING_URL is `off` or empty and no Mapbox token), `route_provider_failed` with `provider` (`osrm`/`mapbox`), `host` and a `reason` (`timeout`, `http_<status>`, `osrm_<code>`, `no_geometry`, or a network error code such as `ENOTFOUND`), and `route_provider_ok`. A stored straight route is no longer reused at trip start: the road is tried again every trip. If a trip stays `straight`, search the service logs for `route_provider`.
