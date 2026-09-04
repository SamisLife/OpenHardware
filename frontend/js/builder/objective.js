/* ============================================================================
   objective.js — plain language in, something measurable out.
   ----------------------------------------------------------------------------
   A work order is only worth submitting if the console can tell whether it was
   met. So the first thing that happens to a sentence is that it gets
   turned into constraints with a metric, a comparator and a number — and
   anything that does not survive that is reported as not survived, rather than
   quietly dropped and later declared satisfied.

       "the highest resolution that holds at least 10 fps"

         maximise  resolution
         require   fps >= 10

   That second line is the whole point. `fps` is a field in every heartbeat, so
   the claim "goal met" can be checked against the board instead of asserted.

   This runs locally and is not a model. It is the shape an agent's request has
   to arrive in — the seam is WebMCP tools, called by an agent in the browser —
   and everything downstream reads this object. See builder/plan.js for the
   half that decides what to do about it.
   ========================================================================== */

/** Metrics the harness actually reports, and how to read one off a sample. */
export const METRICS = {
  fps:   { label: 'fps',        unit: 'fps', read: s => s?.fps },
  temp:  { label: 'die temp',   unit: '°C',  read: s => s?.tempC },
  heap:  { label: 'heap free',  unit: 'KB',  read: s => s?.heapFree / 1024 },
  psram: { label: 'PSRAM free', unit: 'MB',  read: s => s?.psramFree / 1048576 },
};

/** What the agent is being asked to push on, when it is being asked at all. */
const MAXIMISE = [
  [/\b(high|large|big|great|max)\w*\s+(?:possible\s+)?(resolution|framesize|frame size|picture size)/i, 'resolution'],
  [/\b(?:max|highest|best)\w*\s+(?:possible\s+)?(?:frame\s*rate|fps)/i, 'fps'],
  [/\b(?:best|highest|max)\w*\s+(?:image\s+)?quality/i, 'quality'],
  [/\b(?:as\s+)?(?:sharp|detailed|large)\s+as\s+possible/i, 'resolution'],
];

/**
 * Read one bound out of the sentence.
 *
 * Both directions are matched separately rather than by looking for a number
 * and guessing which way it points. "at least 10 fps" and "under 10 fps" are
 * opposite work orders and the difference is entirely in words a number
 * regex does not see.
 */
const BOUNDS = [
  { metric: 'fps', op: '>=',
    re: /(?:at\s+least|minimum(?:\s+of)?|min|no\s+(?:less|lower)\s+than|≥|>=|keep|maintain|sustain\w*|hold|stay\s+(?:at|above)|above)[^.,;]{0,30}?(\d+(?:\.\d+)?)\s*(?:fps|f\/s|frames?\s*(?:per\s*second)?)/i },
  { metric: 'fps', op: '<=',
    re: /(?:at\s+most|no\s+more\s+than|under|below|≤|<=|cap(?:ped)?\s+(?:at|to))[^.,;]{0,20}?(\d+(?:\.\d+)?)\s*(?:fps|frames?\s*(?:per\s*second)?)/i },
  { metric: 'temp', op: '<=',
    re: /(?:under|below|beneath|less\s+than|no\s+(?:more|higher|hotter)\s+than|≤|<=|not\s+exceed|keep\w*[^.,;]{0,20}?(?:under|below))[^.,;]{0,20}?(\d+(?:\.\d+)?)\s*(?:°\s*)?(?:c\b|celsius|degrees?)/i },
  { metric: 'heap', op: '>=',
    re: /(?:at\s+least|keep|leave|reserve|minimum(?:\s+of)?|≥|>=)[^.,;]{0,24}?(\d+(?:\.\d+)?)\s*(?:kb|kilobytes?)[^.,;]{0,16}?(?:heap|internal|dram|ram)/i },
  { metric: 'psram', op: '>=',
    re: /(?:at\s+least|keep|leave|reserve|minimum(?:\s+of)?|≥|>=)[^.,;]{0,24}?(\d+(?:\.\d+)?)\s*(?:mb|megabytes?)[^.,;]{0,16}?psram/i },
];

/** Requirements that are real but that this console cannot yet measure. */
const UNMEASURED = [
  [/\b(?:no|without|zero)\s+(?:dropped|dropping|lost|skipped)\s+frames?/i,
   'no dropped frames', 'the harness reports a frame rate, not a drop count'],
  [/\bwi-?fi\b|\bover\s+the\s+air\b|\bota\b|\bunplugg?ed\b/i,
   'over Wi-Fi', 'this board has no radio: the harness is built without one and reports over the cable'],
  [/\b(?:low|minimum|least)\s+(?:power|current|draw)\b/i,
   'low power', 'this board reports no current measurement'],
  [/\bnight|\bdark|\blow[- ]light\b/i,
   'low-light scene', 'no measurement of scene illumination exists'],
];

/**
 * @param {string} text  what the operator typed
 * @returns {{goal, maximise, constraints, unmeasured, chips, targetFps, ok}}
 */
export function parseObjective(text) {
  const goal = String(text || '').trim().replace(/\s+/g, ' ');

  let maximise = null;
  for (const [re, what] of MAXIMISE) {
    if (re.test(goal)) { maximise = what; break; }
  }

  const constraints = [];
  const seen = new Set();
  for (const { metric, op, re } of BOUNDS) {
    const m = re.exec(goal);
    if (!m) continue;
    const key = `${metric}:${op}`;
    if (seen.has(key)) continue;
    seen.add(key);
    constraints.push({
      metric, op,
      value: Number(m[1]),
      unit: METRICS[metric].unit,
      label: `${METRICS[metric].label} ${op === '>=' ? '≥' : '≤'} ${Number(m[1])} ${METRICS[metric].unit}`,
    });
  }

  const unmeasured = UNMEASURED
    .filter(([re]) => re.test(goal))
    .map(([, label, why]) => ({ label, why }));

  const chips = [
    ...(maximise ? [`maximise ${maximise}`] : []),
    ...constraints.map(c => c.label),
    ...unmeasured.map(u => `${u.label} — not measurable`),
  ];

  const fpsFloor = constraints.find(c => c.metric === 'fps' && c.op === '>=');

  return {
    goal,
    maximise,
    constraints,
    unmeasured,
    chips,
    targetFps: fpsFloor ? fpsFloor.value : null,
    /* Something to optimise or something to check. Without either there is
       nothing for a loop to close on, and saying so beats running four
       attempts and declaring victory against no criterion. */
    ok: !!(maximise || constraints.length),
  };
}

/** Whether a sample satisfies one constraint. null when the metric is absent. */
export function satisfies(constraint, sample) {
  const v = METRICS[constraint.metric]?.read(sample);
  if (!Number.isFinite(v)) return null;
  return constraint.op === '>=' ? v >= constraint.value : v <= constraint.value;
}
