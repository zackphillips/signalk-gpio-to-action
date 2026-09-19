# signalk-gpio-to-action

Routes GPIO digital inputs into Signal K actions: raise or clear a notification, silence
active alarms, send a delta, or fire a PUT request. Built for a MOB button wired to a
Raspberry Pi running OpenPlotter, but the input side is generic enough for any path that
publishes a pressed/released signal.

This replaces a Node-RED flow with a configurable plugin. Press, hold, short press, double
press and release are all separate triggers, each with its own action and its own condition.

## Install

Not published to npm. Install it from a local checkout as a `file:` dependency of your
Signal K config directory:

```bash
git clone https://github.com/zackphillips/signalk-gpio-to-action.git ~/code/signalk-gpio-to-action
cd ~/.signalk
npm install --save ~/code/signalk-gpio-to-action
sudo systemctl restart signalk
```

That symlinks `~/.signalk/node_modules/signalk-gpio-to-action` to the checkout and records
the dependency in `~/.signalk/package.json`. There is no build step — the plugin has no
runtime dependencies.

Then enable it under **Server → Plugin Config**, where it appears as "GPIO to action" with
the MOB rule already filled in.

To update:

```bash
git -C ~/code/signalk-gpio-to-action pull && sudo systemctl restart signalk
```

No reinstall: `node_modules` points at the working tree, so edits and pulls take effect on
the next restart.

**Do not clone directly into `~/.signalk/node_modules/`.** Installing any plugin from the
app store runs `npm --save install` with that directory as its cwd, and npm prunes anything
in `node_modules` that is not listed in `package.json` — your hand-placed checkout gets
deleted without warning. The `file:` dependency above is listed, so it survives.

Two other things worth knowing if you deviate from the commands above:

- The directory or symlink name must match the `name` field in `package.json`. The server
  finds plugins by scanning `~/.signalk/node_modules/` for a `package.json` carrying the
  `signalk-node-server-plugin` keyword, then loads them with
  `require(path.join(location, metadata.name))`. Rename the clone and it is discovered but
  fails to load.
- If `~/.signalk/package.json` does not exist yet, run `npm init -y` there first. A standard
  Signal K install already has one.

## The default config is a MOB button

Out of the box the plugin ships one rule that reproduces the flow this was written for:

| Gesture | Condition | Action |
| --- | --- | --- |
| press (button down) | `notifications.mob.GPIO18` not active | raise `emergency`, "Person Overboard!", visual + sound |
| release after 5 s down | `notifications.mob.GPIO18` active | clear to `normal`, "Person Overboard Cleared", no methods |

So: press raises, holding for 5 seconds and then letting go clears, and a panic hold from
idle raises only — it never clears the alarm it just raised. That last part is the whole
reason `Evaluate conditions` defaults to **at press time**: the clear's `target is active`
test uses the state captured when the button went down, not the state your own press created
5 seconds earlier. Set it to **when the action fires** if you want one press-and-hold to
raise and then clear.

Two deliberate asymmetries in that table, both worth keeping if you edit it:

- **The raise is on button down**, not on release. It is the life-safety path, so it takes
  the trigger with no latency and no way to miss it. A duration-band scheme that decides on
  release has a nasty case: press, hold in a panic while you stare at the water, let go at
  6 seconds — that lands in the long band, the clear finds nothing active to clear, and you
  get no alarm at all.
- **The clear is on release after the hold time** (`holdRelease`), not at the 5 second mark
  while still held (`hold`). A button that shorts closed — a wet deck switch, a chafed cable
  — never releases, so it never fires the clear. With a mid-hold trigger the same fault
  disarms your MOB alarm 5 seconds in and nothing tells you. Fail loud, not quiet. The cost
  is that you get no feedback at the 5 second mark; you hold, let go, and the alarm stops.

Use `hold` where the action is cheap to trigger by accident and mid-press feedback is worth
more than stuck-switch immunity — a silence button, for instance.

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

| Trigger | Fires | Stuck-closed button |
| --- | --- | --- |
| `press` | button down, as soon as the edge is accepted | fires once |
| `hold` | still down after the hold time | fires |
| `release` | button up | never fires |
| `holdRelease` | button up, after a press that lasted at least the hold time | never fires |
| `shortPress` | button up before the hold time | never fires |
| `doublePress` | second press inside the double press window; cancels the pending `shortPress` | never fires |

Use `press` for anything safety critical. It has no added latency. `shortPress` waits for
the hold time to elapse, and waits an extra double-press window on top if double press
detection is enabled on that input.

`shortPress` and `holdRelease` are the two duration bands of a single button, split at the
hold time and both decided when the button comes back up. That pair is how you get two
actions out of one button without a mid-press trigger.

Be careful with `doublePress` on anything destructive. Each press starts a new gesture with
a fresh condition snapshot, so a double tap from idle can raise on the first tap and then
satisfy a `target is active` clear on the second — raise and clear in under half a second.
`holdRelease` does not have this problem: it shares the snapshot of the press that started
it.

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
`hold` with mode `All methods` if you want a long press to also kill the visual — this is a
good place for `hold` rather than `holdRelease`, since the visual dropping out while your
finger is still down tells you it worked.

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
