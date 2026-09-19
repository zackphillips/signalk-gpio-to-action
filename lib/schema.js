'use strict'

const { DEFAULT_ACTIVE_STATES } = require('./actions')

const TRIGGERS = ['press', 'shortPress', 'hold', 'holdRelease', 'release', 'doublePress']
const TRIGGER_NAMES = [
  'Press (button down)',
  'Short press (released before hold time)',
  'Hold (still down after hold time)',
  'Hold release (released after hold fired)',
  'Release (button up)',
  'Double press'
]

const ACTION_TYPES = ['raise', 'clear', 'toggle', 'silence', 'delta', 'put']
const ACTION_TYPE_NAMES = [
  'Raise notification',
  'Clear notification',
  'Toggle notification',
  'Silence active notifications',
  'Send delta',
  'PUT value'
]

const NOTIFICATION_STATES = ['normal', 'nominal', 'alert', 'warn', 'alarm', 'emergency']

/**
 * The Node-RED MOB flow this plugin replaces, as config:
 *   press while MOB is clear        -> emergency, on button down
 *   release after 5s while MOB is up -> normal
 *   hold from idle                  -> nothing (raise path already ran, the
 *                                      condition is evaluated against the
 *                                      press-time snapshot)
 *
 * The clear is on holdRelease rather than hold so the decision is made when the
 * button comes back up. A button that shorts closed - plausible on a wet boat -
 * then never clears the alarm, where a mid-hold trigger would disarm it 5s in.
 * The raise stays on press: it is the life-safety path and cannot afford either
 * the latency or a duration band that a panic hold could fall outside of.
 */
const DEFAULT_MOB_RULE = {
  enabled: true,
  name: 'MOB button on GPIO18',
  inputPath: 'notifications.GPIO18',
  context: 'vessels.self',
  sourceFilter: '',
  conditionMode: 'press',
  detect: {
    source: 'auto',
    mode: 'values',
    pressedValues: ['Pressed'],
    releasedValues: ['Not Pressed'],
    matchType: 'exact',
    caseSensitive: false,
    invert: false,
    unmatched: 'ignore',
    threshold: 0.5,
    comparison: '>='
  },
  timing: {
    debounceMs: 100,
    holdMs: 5000,
    doublePressMs: 0,
    initialGraceMs: 1500
  },
  actions: [
    {
      enabled: true,
      label: 'Raise MOB',
      trigger: 'press',
      type: 'raise',
      condition: 'targetInactive',
      conditionPath: '',
      cooldownMs: 0,
      notificationPath: 'notifications.mob.GPIO18',
      notificationState: 'emergency',
      notificationMessage: 'Person Overboard!',
      notificationMethods: ['visual', 'sound'],
      notificationExtra: '',
      autoClearMs: 0,
      clearMode: 'normal',
      clearState: 'normal',
      clearMessage: 'Person Overboard Cleared',
      clearMethods: []
    },
    {
      enabled: true,
      label: 'Clear MOB on release after 5s hold',
      trigger: 'holdRelease',
      type: 'clear',
      condition: 'targetActive',
      conditionPath: '',
      cooldownMs: 0,
      notificationPath: 'notifications.mob.GPIO18',
      notificationState: 'emergency',
      notificationMessage: 'Person Overboard!',
      notificationMethods: ['visual', 'sound'],
      notificationExtra: '',
      autoClearMs: 0,
      clearMode: 'normal',
      clearState: 'normal',
      clearMessage: 'Person Overboard Cleared',
      clearMethods: []
    }
  ]
}

const actionSchema = {
  type: 'object',
  title: 'Action',
  required: ['trigger', 'type'],
  properties: {
    enabled: {
      type: 'boolean',
      title: 'Enabled',
      default: true
    },
    label: {
      type: 'string',
      title: 'Label',
      description: 'Shown in the log and in the plugin status line.',
      default: ''
    },
    trigger: {
      type: 'string',
      title: 'Trigger',
      description:
        'press fires on the button going down, shortPress on release before the hold time, ' +
        'hold once the hold time elapses while still held, holdRelease when the button ' +
        'comes back up after that. Use press for anything safety critical - it is the ' +
        'only trigger with no added latency. Prefer holdRelease over hold for anything ' +
        'destructive: a button stuck closed never releases, so it never fires.',
      enum: TRIGGERS,
      enumNames: TRIGGER_NAMES,
      default: 'press'
    },
    type: {
      type: 'string',
      title: 'Action type',
      enum: ACTION_TYPES,
      enumNames: ACTION_TYPE_NAMES,
      default: 'raise'
    },
    condition: {
      type: 'string',
      title: 'Only run when',
      description:
        'Evaluated against the notification path below (or the override path). ' +
        'By default the check uses the state captured when the button went down, ' +
        'so a press that raises an alarm does not immediately satisfy a hold that clears it.',
      enum: ['always', 'targetActive', 'targetInactive'],
      enumNames: [
        'Always',
        'Target notification is active',
        'Target notification is not active'
      ],
      default: 'always'
    },
    conditionPath: {
      type: 'string',
      title: 'Condition path override',
      description: 'Notification path to test instead of the action path. Leave blank to use the action path.',
      default: ''
    },
    cooldownMs: {
      type: 'number',
      title: 'Cooldown (ms)',
      description: 'Ignore this action if it ran less than this long ago. 0 disables.',
      default: 0
    },
    notificationPath: {
      type: 'string',
      title: 'Notification path (raise / clear / toggle)',
      description: 'With or without the leading "notifications." - it is added if missing.',
      default: 'notifications.mob.GPIO18'
    },
    notificationState: {
      type: 'string',
      title: 'State to set (raise / toggle)',
      enum: NOTIFICATION_STATES,
      default: 'emergency'
    },
    notificationMessage: {
      type: 'string',
      title: 'Message (raise / toggle)',
      default: 'Person Overboard!'
    },
    notificationMethods: {
      type: 'array',
      title: 'Methods (raise / toggle)',
      description: 'Signal K notification methods. Empty means no visual or audible alert.',
      default: ['visual', 'sound'],
      items: {
        type: 'string',
        enum: ['visual', 'sound']
      },
      uniqueItems: true
    },
    notificationExtra: {
      type: 'string',
      title: 'Extra notification properties (JSON)',
      description: 'Merged into the notification value, e.g. {"id":"mob-button"}. Leave blank for none.',
      default: ''
    },
    autoClearMs: {
      type: 'number',
      title: 'Auto clear after (ms)',
      description: 'Clear the notification this long after raising it. 0 disables.',
      default: 0
    },
    clearMode: {
      type: 'string',
      title: 'Clear mode (clear / toggle)',
      description:
        'normal sets the state below and drops all methods; delete sends a null value ' +
        'so the path disappears from the tree.',
      enum: ['normal', 'delete'],
      enumNames: ['Set state (keeps the path in the tree)', 'Delete the path'],
      default: 'normal'
    },
    clearState: {
      type: 'string',
      title: 'State when cleared',
      enum: NOTIFICATION_STATES,
      default: 'normal'
    },
    clearMessage: {
      type: 'string',
      title: 'Message when cleared',
      default: 'Person Overboard Cleared'
    },
    clearMethods: {
      type: 'array',
      title: 'Methods when cleared',
      default: [],
      items: {
        type: 'string',
        enum: ['visual', 'sound']
      },
      uniqueItems: true
    },
    silencePaths: {
      type: 'array',
      title: 'Silence: paths to include',
      description: 'Notification path prefixes. Empty means every active notification.',
      default: [],
      items: { type: 'string' }
    },
    silenceExcludePaths: {
      type: 'array',
      title: 'Silence: paths to exclude',
      description: 'Keep these shouting. A MOB path belongs here.',
      default: [],
      items: { type: 'string' }
    },
    silenceStates: {
      type: 'array',
      title: 'Silence: states to act on',
      description: 'Empty falls back to the plugin-wide active states.',
      default: [],
      items: {
        type: 'string',
        enum: NOTIFICATION_STATES
      },
      uniqueItems: true
    },
    silenceMode: {
      type: 'string',
      title: 'Silence: what to remove',
      enum: ['all', 'sound'],
      enumNames: ['All methods (visual and sound)', 'Sound only (keep the visual)'],
      default: 'sound'
    },
    deltaPath: {
      type: 'string',
      title: 'Delta path',
      description: 'Any Signal K path, e.g. electrical.switches.anchorLight.state',
      default: ''
    },
    deltaValue: {
      type: 'string',
      title: 'Delta value (JSON)',
      description: 'Parsed as JSON when possible, otherwise sent as a string. e.g. true, 1, "on"',
      default: ''
    },
    putPath: {
      type: 'string',
      title: 'PUT path',
      description: 'Path to send a PUT request to (requires a handler registered by another plugin).',
      default: ''
    },
    putValue: {
      type: 'string',
      title: 'PUT value (JSON)',
      default: ''
    }
  }
}

const ruleSchema = {
  type: 'object',
  title: 'Input',
  required: ['inputPath'],
  properties: {
    enabled: {
      type: 'boolean',
      title: 'Enabled',
      default: true
    },
    name: {
      type: 'string',
      title: 'Name',
      default: 'MOB button on GPIO18'
    },
    inputPath: {
      type: 'string',
      title: 'Input path',
      description:
        'The path the GPIO input publishes on. OpenPlotter digital inputs use ' +
        'notifications.GPIO<pin>. Plain boolean or numeric paths work too - see the detection mode.',
      default: 'notifications.GPIO18'
    },
    context: {
      type: 'string',
      title: 'Context',
      default: 'vessels.self'
    },
    sourceFilter: {
      type: 'string',
      title: 'Source filter',
      description: 'Only accept deltas whose $source contains this string. Leave blank to accept any source.',
      default: ''
    },
    conditionMode: {
      type: 'string',
      title: 'Evaluate conditions',
      description:
        'press uses the notification states captured when the button went down. ' +
        'This is what makes "press raises, hold clears" work on a single button: a hold ' +
        'that follows its own raise still sees the pre-press state. fire re-reads the ' +
        'tree at the moment the action runs.',
      enum: ['press', 'fire'],
      enumNames: ['At press time (recommended)', 'When the action fires'],
      default: 'press'
    },
    activeStates: {
      type: 'array',
      title: 'States counted as active (override)',
      description: 'Leave empty to use the plugin-wide setting.',
      default: [],
      items: {
        type: 'string',
        enum: NOTIFICATION_STATES
      },
      uniqueItems: true
    },
    detect: {
      type: 'object',
      title: 'Press detection',
      properties: {
        source: {
          type: 'string',
          title: 'Field to test',
          description:
            'auto tries message, then state, then value. OpenPlotter GPIO inputs keep state at ' +
            '"normal" and put Pressed / Not Pressed in message, so auto does the right thing.',
          enum: ['auto', 'message', 'state', 'value'],
          default: 'auto'
        },
        mode: {
          type: 'string',
          title: 'Detection mode',
          enum: ['values', 'truthy', 'threshold'],
          enumNames: [
            'Match against value lists',
            'Truthy / falsy (true, 1, on, closed ...)',
            'Numeric threshold'
          ],
          default: 'values'
        },
        pressedValues: {
          type: 'array',
          title: 'Values meaning pressed',
          default: ['Pressed'],
          items: { type: 'string' }
        },
        releasedValues: {
          type: 'array',
          title: 'Values meaning released',
          default: ['Not Pressed'],
          items: { type: 'string' }
        },
        matchType: {
          type: 'string',
          title: 'Match type',
          description:
            'Keep this on exact for OpenPlotter GPIO. "Not Pressed" contains "Pressed", so a ' +
            'contains test inverts the button. Released values are tested first, which makes ' +
            'contains and regex safe for that pair, but exact is still the honest setting.',
          enum: ['exact', 'contains', 'regex'],
          default: 'exact'
        },
        caseSensitive: {
          type: 'boolean',
          title: 'Case sensitive',
          default: false
        },
        invert: {
          type: 'boolean',
          title: 'Invert (active low wiring)',
          default: false
        },
        unmatched: {
          type: 'string',
          title: 'When a value matches nothing',
          enum: ['ignore', 'released', 'pressed'],
          enumNames: ['Ignore the delta', 'Treat as released', 'Treat as pressed'],
          default: 'ignore'
        },
        threshold: {
          type: 'number',
          title: 'Threshold (threshold mode)',
          default: 0.5
        },
        comparison: {
          type: 'string',
          title: 'Comparison (threshold mode)',
          enum: ['>=', '>', '<=', '<', '==', '!='],
          default: '>='
        }
      }
    },
    timing: {
      type: 'object',
      title: 'Timing',
      properties: {
        debounceMs: {
          type: 'number',
          title: 'Debounce (ms)',
          description: 'Edges arriving within this window of the last accepted edge are dropped.',
          default: 100
        },
        holdMs: {
          type: 'number',
          title: 'Hold time (ms)',
          description:
            'The boundary between a short and a long press. hold fires the moment it ' +
            'elapses while the button is still down; holdRelease fires when a press ' +
            'that lasted at least this long is released.',
          default: 5000
        },
        doublePressMs: {
          type: 'number',
          title: 'Double press window (ms)',
          description:
            'Set above 0 to enable the double press trigger. Note that this delays every ' +
            'shortPress by the same amount; press is unaffected.',
          default: 0
        },
        initialGraceMs: {
          type: 'number',
          title: 'Startup grace (ms)',
          description:
            'Values arriving this soon after startup only set the initial state and fire nothing. ' +
            'Stops a cached "Pressed" from raising an alarm every time the plugin restarts.',
          default: 1500
        }
      }
    },
    actions: {
      type: 'array',
      title: 'Actions',
      default: DEFAULT_MOB_RULE.actions,
      items: actionSchema
    }
  }
}

const schema = {
  type: 'object',
  title: 'GPIO to action',
  description:
    'Turns GPIO digital inputs into Signal K actions: raise or clear notifications, ' +
    'silence active alarms, send deltas or PUT requests.',
  properties: {
    debug: {
      type: 'boolean',
      title: 'Verbose logging',
      description: 'Log every accepted edge and gesture to the server log.',
      default: false
    },
    activeStates: {
      type: 'array',
      title: 'Notification states counted as active',
      default: DEFAULT_ACTIVE_STATES,
      items: {
        type: 'string',
        enum: NOTIFICATION_STATES
      },
      uniqueItems: true
    },
    rules: {
      type: 'array',
      title: 'Inputs',
      default: [DEFAULT_MOB_RULE],
      items: ruleSchema
    }
  }
}

const uiSchema = {
  rules: {
    'ui:options': { orderable: true },
    items: {
      notificationExtra: { 'ui:widget': 'textarea' },
      actions: {
        'ui:options': { orderable: true },
        items: {
          notificationExtra: { 'ui:widget': 'textarea' }
        }
      }
    }
  }
}

function pick (value, fallback) {
  return value === undefined || value === null ? fallback : value
}

/** Fill in defaults for anything the admin UI left out. */
function normalizeOptions (options) {
  const opts = options || {}
  const activeStates = Array.isArray(opts.activeStates) && opts.activeStates.length > 0
    ? opts.activeStates
    : DEFAULT_ACTIVE_STATES

  const rules = (Array.isArray(opts.rules) ? opts.rules : []).map((rule, index) => {
    const detect = rule.detect || {}
    const timing = rule.timing || {}
    return {
      enabled: rule.enabled !== false,
      name: rule.name || `input ${index + 1}`,
      inputPath: rule.inputPath || 'notifications.GPIO18',
      context: rule.context || 'vessels.self',
      sourceFilter: rule.sourceFilter || '',
      conditionMode: rule.conditionMode === 'fire' ? 'fire' : 'press',
      activeStates: Array.isArray(rule.activeStates) && rule.activeStates.length > 0
        ? rule.activeStates
        : activeStates,
      detect: {
        source: detect.source || 'auto',
        mode: detect.mode || 'values',
        pressedValues: pick(detect.pressedValues, ['Pressed']),
        releasedValues: pick(detect.releasedValues, ['Not Pressed']),
        matchType: detect.matchType || 'exact',
        caseSensitive: detect.caseSensitive === true,
        invert: detect.invert === true,
        unmatched: detect.unmatched || 'ignore',
        threshold: pick(detect.threshold, 0.5),
        comparison: detect.comparison || '>='
      },
      timing: {
        debounceMs: pick(timing.debounceMs, 100),
        holdMs: pick(timing.holdMs, 5000),
        doublePressMs: pick(timing.doublePressMs, 0),
        initialGraceMs: pick(timing.initialGraceMs, 1500)
      },
      actions: (Array.isArray(rule.actions) ? rule.actions : []).map((action, i) => ({
        enabled: action.enabled !== false,
        label: action.label || `${action.type || 'raise'} ${i + 1}`,
        trigger: TRIGGERS.includes(action.trigger) ? action.trigger : 'press',
        type: ACTION_TYPES.includes(action.type) ? action.type : 'raise',
        condition: action.condition || 'always',
        conditionPath: action.conditionPath || '',
        cooldownMs: Number(action.cooldownMs) || 0,
        notificationPath: action.notificationPath || '',
        notificationState: action.notificationState || 'alert',
        notificationMessage: pick(action.notificationMessage, ''),
        notificationMethods: pick(action.notificationMethods, ['visual', 'sound']),
        notificationExtra: action.notificationExtra || '',
        autoClearMs: Number(action.autoClearMs) || 0,
        clearMode: action.clearMode === 'delete' ? 'delete' : 'normal',
        clearState: action.clearState || 'normal',
        clearMessage: pick(action.clearMessage, ''),
        clearMethods: pick(action.clearMethods, []),
        silencePaths: pick(action.silencePaths, []),
        silenceExcludePaths: pick(action.silenceExcludePaths, []),
        silenceStates: pick(action.silenceStates, []),
        silenceMode: action.silenceMode === 'all' ? 'all' : 'sound',
        deltaPath: action.deltaPath || '',
        deltaValue: pick(action.deltaValue, ''),
        putPath: action.putPath || '',
        putValue: pick(action.putValue, '')
      }))
    }
  })

  return {
    debug: opts.debug === true,
    activeStates,
    rules
  }
}

module.exports = {
  schema,
  uiSchema,
  normalizeOptions,
  DEFAULT_MOB_RULE,
  TRIGGERS,
  ACTION_TYPES,
  NOTIFICATION_STATES
}
