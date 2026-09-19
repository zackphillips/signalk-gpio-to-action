# signalk-gpio-to-action

Routes GPIO digital inputs into Signal K actions: raise or clear a notification, silence
active alarms, send a delta, or fire a PUT request. Built for a MOB button wired to a
Raspberry Pi running OpenPlotter, but the input side is generic enough for any path that
publishes a pressed/released signal.

This replaces a Node-RED flow with a configurable plugin. Press, hold, short press, double
press and release are all separate triggers, each with its own action and its own condition.

## Install

From the Signal K app store, or:

```bash
cd ~/.signalk/node_modules
npm install signalk-gpio-to-action
```

Restart the server, then enable the plugin under **Server → Plugin Config**.

## The default config is a MOB button

Out of the box the plugin ships one rule that reproduces the flow this was written for:

| Gesture | Condition | Action |
| --- | --- | --- |
| press | `notifications.mob.GPIO18` not active | raise `emergency`, "Person Overboard!", visual + sound |
| hold 5s | `notifications.mob.GPIO18` active | clear to `normal`, "Person Overboard Cleared", no methods |

So: press raises, a 5 second hold clears, and holding from idle raises only — it never
clears the alarm it just raised. That last part is the whole reason `Evaluate conditions`
defaults to **at press time**: the hold's `target is active` test uses the state captured
when the button went down, not the state your own press created 5 seconds earlier. Set it
to **when the action fires** if you want a single hold to raise and then clear.

Set up the GPIO pin in OpenPlotter as a **digital input** publishing to
`notifications.GPIO18` before configuring the plugin.

## How the input is read

OpenPlotter's GPIO digital input publishes with `state` always `"normal"` and the real
signal in `message`:

```json
{ "state": "normal", "message": "Pressed" }
{ "state": "normal", "message": "Not Pressed" }
```

The default detection (`source: auto`, `mode: values`, `matchType: exact`) tests `message`
first and falls back to `state`, then `value`. Keep `matchType` on **exact**: `"Not Pressed"`
contains `"Pressed"`, so a contains or regex test is how you end up with an inverted button.
(Released values are tested before pressed values, so contains and regex do resolve that
specific pair correctly, but exact is the setting that says what you mean.)

Keeping the raw input at `state: normal` matters: nothing else in Signal K treats the
button itself as an alarm. Only the notification this plugin raises is an alarm.

Other input shapes work too:

- **Boolean or numeric path** (`electrical.switches.gpio24.state`): set detection mode to
  **truthy** — `true`, `1`, `on`, `closed`, `high` are pressed.
- **Analog input**: set mode to **threshold** with a comparison and a cut-off.
- **Active-low wiring**: tick **Invert**.
- **Anything else**: mode **values** with your own pressed/released lists, optionally regex.

Repeated identical readings are dropped, so an input that re-publishes while held collapses
to one press and one release. Edges arriving inside the debounce window (default 100 ms) are
dropped as contact bounce.

### Startup grace

Values the server replays right after the plugin subscribes only set the initial state; they
fire nothing. Without this, a cached `"Pressed"` would raise MOB every time the plugin
restarts. Default window is 1500 ms — real presses after that are handled normally. Set it
to 0 to disable.

## Triggers

| Trigger | Fires |
| --- | --- |
| `press` | button down, as soon as the edge is accepted |
| `hold` | still down after the hold time |
| `release` | button up |
| `holdRelease` | button up, after `hold` already fired |
| `shortPress` | button up before the hold time |
| `doublePress` | second press inside the double press window; cancels the pending `shortPress` |

Use `press` for anything safety critical. It has no added latency. `shortPress` waits for
the hold time to elapse, and waits an extra double-press window on top if double press
detection is enabled on that input.

## Action types

| Type | What it does |
| --- | --- |
| **Raise notification** | Writes state, message and methods to a notification path. Optional extra JSON properties and an auto-clear timer. |
| **Clear notification** | Sets the path to `normal` with no methods, or deletes it outright. |
| **Toggle notification** | Raises if inactive, clears if active. |
| **Silence active notifications** | Strips `sound` (or every method) from active notifications. Filter by path prefix, exclude paths, and by state. |
| **Send delta** | Any path, any JSON value. |
| **PUT value** | A PUT request to a path, for handing off to another plugin. |

Each action also has:

- **Only run when** — always, target notification active, or target not active. Tested
  against the action's own notification path, or a **condition path override**.
- **Cooldown (ms)** — ignore this action if it ran less than this long ago.
- **Enabled** — leave it configured but off.

Notification paths may be written with or without the leading `notifications.`; it is added
if missing.

## Recipes

**Silence button on GPIO23, MOB stays loud**

Input `notifications.GPIO23`, one action: trigger `press`, type **Silence active
notifications**, mode `Sound only`, exclude paths `notifications.mob`. Add a second action on
`hold` with mode `All methods` if you want a long press to also kill the visual.

**Anchor alarm arm/disarm on one button**

Input `electrical.switches.gpio24.state`, detection mode `truthy`, one action: trigger
`shortPress`, type **Toggle notification**, path `notifications.anchor.armed`, state `alert`.

**Double press to trigger something else entirely**

Set the double press window above 0 (400 ms is a good start), then add an action with
trigger `doublePress` and type **Send delta** or **PUT value**.

**Test without a button**

Publish the input path by hand over the Signal K websocket. With `websocat`:

```bash
websocat ws://localhost:3000/signalk/v1/stream?subscribe=none <<'EOF'
{"updates":[{"values":[{"path":"notifications.GPIO18","value":{"state":"normal","message":"Pressed"}}]}]}
{"updates":[{"values":[{"path":"notifications.GPIO18","value":{"state":"normal","message":"Not Pressed"}}]}]}
EOF
```

Add `?token=<jwt>` if the server requires authentication for writes. A Node-RED inject node
pointed at the same path works just as well. Turn on **Verbose logging** in the plugin
config to see each accepted edge and gesture in the server log.

## Caveats

- **Silencing fights re-sending sources.** This plugin writes the silenced value from its
  own `$source`. A plugin that keeps re-publishing the same notification with `sound` will
  win the next time it sends. Silence works cleanly against notifications that are raised
  once and then left alone.
- **Clearing a notification elsewhere** is picked up correctly: conditions read the server
  tree at press time, not a cached flag.
- **One rule per physical button.** Multiple rules can watch the same path if you want
  independent condition sets.

## Development

```bash
npm test
```

Tests cover press detection, the gesture state machine, the action runner, and the plugin
end to end against a stub Signal K app, with an injected clock so timing cases are
deterministic. No runtime dependencies.

## License

BSD 3-Clause. See [LICENSE](LICENSE).
