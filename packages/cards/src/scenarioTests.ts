import type { CardDefinition, DecisionAnswer } from '@mtg/engine';
import type { CardOptions, CastOptions, Scenario } from '@mtg/engine/testing';
import { scenario } from '@mtg/engine/testing';
import type { PlayerSetup, ScenarioAction, ScenarioTest } from './schema.js';

export interface ScenarioFailure {
  test: string;
  message: string;
}

function resolveName(name: string, self: string): string {
  return name === '~' ? self : name;
}

function targetsOf(
  a: { target?: string | string[]; targets?: (string | string[])[] },
  self: string,
): (string | string[])[] | undefined {
  const fix = (t: string | string[]) =>
    Array.isArray(t) ? t.map((x) => resolveName(x, self)) : resolveName(t, self);
  if (a.targets) return a.targets.map(fix);
  if (a.target !== undefined) return [fix(a.target)];
  return undefined;
}

function applySetup(
  b: ReturnType<typeof scenario>,
  player: 'A' | 'B',
  setup: PlayerSetup | undefined,
  self: string,
): void {
  b.player(player);
  if (!setup) {
    b.library('Smoke Filler');
    return;
  }
  if (setup.life !== undefined) b.life(setup.life);
  if (setup.hand) b.hand(...setup.hand.map((n) => resolveName(n, self)));
  if (setup.battlefield) {
    for (const c of setup.battlefield) {
      if (typeof c === 'string') b.battlefield(resolveName(c, self));
      else {
        const opts: CardOptions = {};
        if (c.tapped !== undefined) opts.tapped = c.tapped;
        if (c.counters) opts.counters = c.counters;
        if (c.attachedTo) opts.attachedTo = resolveName(c.attachedTo, self);
        b.battlefield([resolveName(c.name, self), opts]);
      }
    }
  }
  if (setup.graveyard) b.graveyard(...setup.graveyard.map((n) => resolveName(n, self)));
  b.library(...(setup.library ?? ['Smoke Filler']).map((n) => resolveName(n, self)));
}

function runAction(s: Scenario, action: ScenarioAction, self: string): void {
  if (typeof action === 'string') {
    switch (action) {
      case 'resolveAll':
        s.resolveAll();
        return;
      case 'pass':
        s.pass();
        return;
      case 'passBoth':
        s.passBoth();
        return;
      case 'finishCombat':
        s.finishCombat();
        return;
      case 'nextTurn':
        s.nextTurn();
        return;
    }
  }
  if ('cast' in action) {
    const opts: CastOptions = {};
    const t = targetsOf(action, self);
    if (t) opts.targets = t;
    if (action.x !== undefined) opts.x = action.x;
    if (action.mode !== undefined) opts.mode = action.mode;
    if (action.choose) opts.choose = action.choose.map((n) => resolveName(n, self));
    s.cast(resolveName(action.cast, self), opts);
    return;
  }
  if ('activate' in action) {
    const opts: CastOptions = {};
    const t = targetsOf(action, self);
    if (t) opts.targets = t;
    if (action.x !== undefined) opts.x = action.x;
    if (action.choose) opts.choose = action.choose.map((n) => resolveName(n, self));
    s.activate(resolveName(action.activate, self), action.ability ?? 0, opts);
    return;
  }
  if ('activateMana' in action) {
    s.activateMana(resolveName(action.activateMana, self), action.ability ?? 0, action.option ?? 0);
    return;
  }
  if ('playLand' in action) {
    s.playLand(resolveName(action.playLand, self));
    return;
  }
  if ('attack' in action) {
    s.attack(
      action.attack.map((a) =>
        typeof a === 'string'
          ? resolveName(a, self)
          : [
              resolveName(a[0], self),
              a[1] === 'A' || a[1] === 'B' ? a[1] : resolveName(a[1], self),
            ],
      ),
    );
    return;
  }
  if ('block' in action) {
    s.block(action.block.map(([b, a]) => [resolveName(b, self), resolveName(a, self)]));
    return;
  }
  if ('toStep' in action) {
    s.toStep(action.toStep as Parameters<Scenario['toStep']>[0]);
    return;
  }
  if ('answer' in action) {
    s.answer(resolvePlaceholders(action.answer, s) as unknown as DecisionAnswer);
    return;
  }
}

/** `__first__` inside `cards`/`objects` answers means "the first legal option of the pending decision". */
function resolvePlaceholders(
  answer: Record<string, unknown>,
  s: Scenario,
): Record<string, unknown> {
  const dec = s.state.pendingDecision;
  const out: Record<string, unknown> = { ...answer };
  for (const key of ['cards', 'objects'] as const) {
    const v = out[key];
    if (!Array.isArray(v) || !dec) continue;
    const options: unknown[] =
      'options' in dec
        ? (dec.options as unknown[])
        : 'cards' in dec
          ? (dec.cards as unknown[])
          : 'hand' in dec
            ? (dec.hand as unknown[])
            : [];
    out[key] = v.map((x) => (x === '__first__' ? options[0] : x));
  }
  return out;
}

function checkExpectation(
  s: Scenario,
  key: string,
  expected: unknown,
  self: string,
): string | null {
  const [head, ...rest] = key.split('.');
  const eq = (actual: unknown) =>
    JSON.stringify(actual) === JSON.stringify(expected)
      ? null
      : `${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  if (head === 'A' || head === 'B') {
    const what = rest[0];
    if (what === 'life') return eq(s.life(head));
    if (what === 'poison') return eq(s.state.players[head].poison);
    if (what === 'library' && rest[1] === 'size') return eq(s.state.zones[head].library.length);
    if (what === 'hand' && rest[1] === 'size') return eq(s.state.zones[head].hand.length);
    if (
      what === 'battlefield' ||
      what === 'graveyard' ||
      what === 'hand' ||
      what === 'exile' ||
      what === 'library'
    ) {
      const actual = s.zone(head, what);
      const wanted = (expected as string[]).map((n) => resolveName(n, self));
      // Every listed card must be present, with multiplicity.
      const remaining = actual.slice();
      for (const w of wanted) {
        const i = remaining.indexOf(w);
        if (i < 0)
          return `${key}: expected to contain ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`;
        remaining.splice(i, 1);
      }
      return null;
    }
    return `${key}: unknown player expectation`;
  }
  if (head === 'stack') return eq(s.state.stack.length);
  if (head === 'result') {
    if (rest[0] === 'winner') return eq(s.state.result?.winner ?? null);
    if (rest[0] === 'reason') return eq(s.state.result?.reason ?? null);
    return eq(s.state.result);
  }
  // <card name>[#n].<property>
  const name = resolveName(head!, self);
  const m = /^(.*)#(\d+)$/.exec(name);
  const objName = m ? m[1]! : name;
  const index = m ? Number(m[2]) : 0;
  const prop = rest[0];
  if (prop === 'zone') return eq(s.zoneOf(objName, index));
  if (prop === 'power') return eq(s.chars(objName, index).power);
  if (prop === 'toughness') return eq(s.chars(objName, index).toughness);
  if (prop === 'tapped') return eq(s.object(objName, index).tapped);
  if (prop === 'damage') return eq(s.object(objName, index).damage);
  if (prop === 'controller') return eq(s.object(objName, index).controller);
  if (prop === 'counters')
    return eq(s.object(objName, index).counters[rest.slice(1).join('.')] ?? 0);
  if (prop === 'keywords') return eq([...s.chars(objName, index).keywords].sort());
  if (prop === 'types') return eq(s.chars(objName, index).types.slice().sort());
  if (prop === 'subtypes') return eq(s.chars(objName, index).subtypes.slice().sort());
  if (prop === 'attachedTo') {
    const to = s.object(objName, index).attachedTo;
    return eq(to === null ? null : s.state.definitions[s.state.objects[to]!.definitionId]?.name);
  }
  return `${key}: unknown expectation`;
}

/** Runs the `tests:` of one card script against the engine with every listed definition available by name. */
export function runScenarioTests(
  self: CardDefinition,
  tests: ScenarioTest[],
  definitions: Record<string, CardDefinition>,
): ScenarioFailure[] {
  const failures: ScenarioFailure[] = [];
  const defs: Record<string, CardDefinition> = { ...definitions, [self.id]: self };
  if (!Object.values(defs).some((d) => d.name === 'Smoke Filler')) {
    defs['smoke:filler'] = {
      id: 'smoke:filler',
      name: 'Smoke Filler',
      types: ['sorcery'],
      manaCost: '{9}',
      abilities: [{ kind: 'spell', effects: [{ op: 'noop' }] }],
    };
  }
  for (const t of tests) {
    try {
      const b = scenario(defs);
      applySetup(b, 'A', t.setup.A, self.name);
      applySetup(b, 'B', t.setup.B, self.name);
      const s = b.start();
      for (const a of t.actions) runAction(s, a, self.name);
      for (const [k, v] of Object.entries(t.expect)) {
        const err = checkExpectation(s, k, v, self.name);
        if (err) failures.push({ test: t.name, message: err });
      }
    } catch (e) {
      failures.push({ test: t.name, message: (e as Error).message });
    }
  }
  return failures;
}
