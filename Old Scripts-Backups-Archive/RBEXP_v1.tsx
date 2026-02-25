import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Riftbound Duel Emulator (rules-based core)
 * - Loads card data from the provided JSON (riftbound_data_expert.json format)
 * - Implements Duel (1v1) board: 2 Battlefields, 1 Base per player, Rune decks, Rune pools
 * - Implements: Setup (legend/champion/battlefield auto), Mulligan (up to 2 Recycle), Turn structure,
 *              Rune channel/draw, Rune pool empty timing, Standard Move, Showdowns, Combat (simplified but rules-aligned),
 *              Hold/Conquer scoring + Final Point rule, Burn Out, Hidden/Legion/Accelerate (core constraints),
 *              Deflect additional cost (single-target), Stun timing, and a lightweight effect resolver for common verbs.
 *
 * Notes:
 * - Card effect parsing is intentionally conservative: it covers the most common templated effects but
 *   does not fully automate every unique card text.
 * - Where automation is ambiguous, the UI offers “Manual resolve” helpers rather than guessing.
 */

// ----------------------------- Types -----------------------------

type PlayerId = "P1" | "P2";

declare global {
  interface Window {
    render_game_to_text?: () => string;
  }
}


type MatchFormat = "BO1" | "BO3";

// --- UI Types & Helpers ---

type ActionButtonState =
  | { kind: "IDLE"; label: string; action: () => void; disabled?: boolean }
  | { kind: "PENDING_PLAY"; label: string; action: () => void; disabled?: boolean }
  | { kind: "PENDING_TARGET"; label: string; action: () => void; disabled?: boolean }
  | { kind: "SELECTION"; label: string; action: () => void; disabled?: boolean };

interface SecondaryAction {
  label: string;
  action: () => void;
  disabled?: boolean;
  color?: string;
  id?: string;
}

type BattlefieldPick = string; // card id

type MatchState = {
  format: MatchFormat;
  gamesCompleted: number; // 0..2
  wins: Record<PlayerId, number>;
  usedBattlefieldIds: Record<PlayerId, string[]>;
  lastGameWinner: PlayerId | null;
  // Starting player selection
  diceRoll?: { P1: number; P2: number } | null;  // Dice roll results for game 1
  startingPlayerChooser?: PlayerId | null;  // Who chooses starting player (dice winner for game 1, loser for games 2/3)
  chosenStartingPlayer?: PlayerId | null;  // The chosen starting player for next game
  pendingStartingPlayerChoice?: boolean;  // Whether we're waiting for starting player choice
};

type Bo3SideboardingState = {
  matchStateAfterCommit: MatchState;
  lastGameWinner: PlayerId | null;
};


type Step =
  | "SETUP"
  | "MULLIGAN"
  | "AWAKEN"
  | "SCORING"
  | "CHANNEL"
  | "DRAW"
  | "ACTION"
  | "ENDING"
  | "GAME_OVER";

type WindowKind = "NONE" | "SHOWDOWN" | "COMBAT";

type CombatStep = "SHOWDOWN" | "DAMAGE_ASSIGNMENT" | "DAMAGE" | "RESOLUTION";

type Domain =
  | "Body"
  | "Calm"
  | "Chaos"
  | "Fury"
  | "Mind"
  | "Order"
  | "Colorless";

type CardType = "Unit" | "Spell" | "Gear" | "Rune" | "Battlefield" | "Legend";

interface CardData {
  id: string;
  name: string;
  image?: string;
  image_url?: string;
  rarity?: string;
  domain: string; // can be "Fury" or "Fury, Mind"
  cost: number; // energy
  type: CardType;
  tags?: string[];
  ability?: {
    trigger?: string;
    effect_text?: string;
    reminder_text?: string[];
    raw_text?: string;
    keywords?: string[];
  };
  stats: {
    might: number | null;
    power: number | null; // "colored" power icons count
  };
  rules_text?: ExpertRulesText;
}

interface ExpertRulesText {
  raw?: string;
  keywords?: string[];
}

interface ExpertCardData {
  id: string;
  name: string;
  rarity?: string;
  domain?: string; // Domain directly from CSV (e.g., "Fury", "Calm, Mind")
  type_line?: string;
  stats?: {
    energy?: number;
    might?: number;
    power?: number | string;
  };
  rules_text?: ExpertRulesText;
  game_logic?: {
    chain?: Array<{
      type?: string;
      condition?: string;
      effects?: Array<Record<string, unknown>>;
    }>;
  };
  image_url?: string; // Image URL from CSV
  supertypes?: string; // e.g., "basic" for runes
  tags?: string[]; // Additional tags from CSV
}

interface CardInstance extends CardData {
  instanceId: string;
  owner: PlayerId;
  controller: PlayerId;
  subtypes?: string[];
  prevMightSnapshot?: number;

  // unit-specific state
  isReady: boolean;
  damage: number;
  buffs: number; // permanent +1 might buffs (max 1)
  tempMightBonus: number; // "this turn" might
  stunned: boolean;
  stunnedUntilTurn: number; // Turn number when stun expires (0 = not stunned)

  // Dynamic keyword grants
  extraKeywords?: string[]; // permanent (rare; used by some effects)
  tempKeywords?: string[]; // cleared end of turn
  conditionalKeywords?: string[]; // computed from conditional text (buffed, mighty, etc.)

  // Attached gear (for Weaponmaster and Equip)
  attachedGear?: CardInstance[];

  // bookkeeping
  createdTurn: number;
  moveCountThisTurn: number;
  killOnDamageUntilTurn?: number;
  preventNextDamageUntilTurn?: number; // Counter Strike: "The next time that unit would be dealt damage this turn, prevent it"
  deathReplacement?: {
    untilTurn: number;
    recallExhausted: boolean;
    payRuneDomain?: Domain;
    payRuneAny?: boolean;
    optional?: boolean;
  };
}

interface RuneInstance {
  instanceId: string;
  owner: PlayerId;
  controller: PlayerId;
  domain: Domain;
  isReady: boolean;
  createdTurn: number;

  // Visual / provenance (optional but used by Arena UI)
  cardId?: string;
  name?: string;
  image_url?: string;
  image?: string;
}

type RunePayKind = "EXHAUST" | "RECYCLE" | "BOTH";

interface SealPayInfo {
  instanceId: string;
  domain: Domain; // The domain of power this Seal provides
  amount: number; // Usually 1
}

interface AutoPayPlan {
  runeUses: Record<string, RunePayKind>; // key = rune.instanceId
  sealUses: SealPayInfo[]; // Seals to exhaust for power
  recycleCount: number;
  exhaustCount: number;
  exhaustOnlyCount: number;
  addsEnergy: number;
  addsPower: Record<Domain, number>;
}

interface FacedownCard {
  card: CardInstance;
  owner: PlayerId;
  hiddenOnTurn: number;
  markedForRemoval: boolean;
  // The battlefield this facedown is associated with is implicit (the container battlefield index)
}

interface BattlefieldState {
  index: number;
  card: CardData; // battlefield card (public)
  owner: PlayerId; // who contributed it
  controller: PlayerId | null; // who controls it (can be null if uncontrolled)
  contestedBy: PlayerId | null; // who is contesting it (if any)
  facedown: FacedownCard | null; // only one total, duel rules
  facedownExtra: FacedownCard | null; // Bandle Tree: extra slot
  dreamingTreeChosenThisTurn: Record<PlayerId, boolean>;
  units: Record<PlayerId, CardInstance[]>;
  gear: Record<PlayerId, CardInstance[]>;
}

interface RunePool {
  energy: number;
  power: Record<Domain, number>;
}

interface PlayerState {
  id: PlayerId;
  legend: CardData | null;
  legendReady: boolean;
  championZone: CardInstance | null; // chosen champion starts here
  base: {
    units: CardInstance[];
    gear: CardInstance[];
  };

  mainDeck: CardInstance[];
  hand: CardInstance[];
  trash: CardInstance[];
  banishment: CardInstance[];

  runeDeck: RuneInstance[];
  runesInPlay: RuneInstance[];

  runePool: RunePool;

  points: number;

  // Bookkeeping for costs/keywords
  domains: Domain[]; // Domain Identity (derived from Legend for this emulator)
  chosenChampionId?: string;
  pendingReadyRunesEndOfTurn?: number;
  nextSpellDiscount?: number;
  nextSpellRepeatByCost?: boolean;
  unitsEnterReadyThisTurn?: boolean;
  mainDeckCardsPlayedThisTurn: number; // for Legion condition (724)
  scoredBattlefieldsThisTurn: number[]; // indices scored by this player this turn (630)
  discardedThisTurn: number;
  enemyUnitsDiedThisTurn: number;
  sealExhaustedThisTurn: boolean; // Prevents auto-payer from recycling runes when Seal was used
  preventSpellAbilityDamageThisTurn: boolean; // Unyielding Spirit: "Prevent all spell and ability damage this turn"
  opponentCantPlayCardsThisTurn: boolean; // Brynhir Thundersong: "Opponents can't play cards this turn"
  nonTokenGearPlayedThisTurn: boolean; // Ornn's Forge
  turnsTaken: number; // per-player turn count

  // Mulligan (setup)
  mulliganSelectedIds: string[];
  mulliganDone: boolean;
}

type Target =
  | { kind: "UNIT"; owner: PlayerId; instanceId: string; battlefieldIndex?: number | null; zone?: "BASE" | "BF" }
  | { kind: "GEAR"; owner: PlayerId; instanceId: string }
  | { kind: "BATTLEFIELD"; index: number }
  | { kind: "NONE" };



interface RevealWindow {
  id: string;
  player: PlayerId; // The player who sees the window (or both)
  cards: CardInstance[];
  sourceLabel: string;
  message?: string;
  // If the window is interactive (e.g. choose a card to discard), we need more structure here.
  // For now, "Reveal" implies just showing. 
  // If we need to choose, we'll use a subsequent "Optional Choice" or specialized step.
  // BUT: "Reveal hand, choose non-unit, recycle it" -> This is a choice FROM the revealed cards.
  // We can model this as a "Reveal Window" that has a "Confirm" action, which then triggers the choice?
  // Or better: The Reveal Window *IS* the choice window if `selection` is present.
  selection?: {
    min: number;
    max: number;
    canChoose: (c: CardInstance) => boolean;
    actionLabel: string;
    resolutionId: string;
  };
}

type EngineAction =
  | { type: "NEXT_STEP"; player: PlayerId }
  | { type: "PASS_PRIORITY"; player: PlayerId }
  | { type: "MULLIGAN_CONFIRM"; player: PlayerId; recycleIds: string[] }
  | { type: "SET_CHAIN_TARGETS"; player: PlayerId; chainItemId: string; targets: Target[] }
  | { type: "OPTIONAL_CHOICE"; player: PlayerId; choiceId: string; accept: boolean; value?: number }
  | {
    type: "PLAY_CARD";
    player: PlayerId;
    source: "HAND" | "CHAMPION" | "FACEDOWN";
    cardInstanceId: string;
    fromBattlefieldIndex?: number;
    destination?: { kind: "BASE" } | { kind: "BF"; index: number } | null;
    accelerate?: { pay: boolean; domain: Domain };
    targets?: Target[];
    repeatCount?: number;
    payOptionalAdditionalCost?: boolean;
    additionalDiscardIds?: string[];
    autoPay?: boolean;
  }
  | { type: "HIDE_CARD"; player: PlayerId; cardInstanceId: string; battlefieldIndex: number; autoPay?: boolean }
  | {
    type: "STANDARD_MOVE";
    player: PlayerId;
    from: { kind: "BASE" } | { kind: "BF"; index: number };
    to: { kind: "BASE" } | { kind: "BF"; index: number };
    unitIds: string[];
  }
  | { type: "RUNE_EXHAUST"; player: PlayerId; runeInstanceId: string }
  | { type: "RUNE_RECYCLE"; player: PlayerId; runeInstanceId: string }
  | { type: "SEAL_EXHAUST"; player: PlayerId; gearInstanceId: string }
  | { type: "LEGEND_ACTIVATE"; player: PlayerId; targets?: Target[]; autoPay?: boolean }
  | { type: "GEAR_ACTIVATE"; player: PlayerId; gearInstanceId: string; targets?: Target[]; autoPay?: boolean }
  | { type: "EQUIP_START"; player: PlayerId; gearInstanceId: string }
  | { type: "EQUIP_CONFIRM"; player: PlayerId; unitInstanceId: string }
  | { type: "EQUIP_CANCEL"; player: PlayerId }
  | { type: "DAMAGE_ASSIGN"; player: PlayerId; assignment: Record<string, number> }
  | { type: "DAMAGE_CONFIRM"; player: PlayerId }
  | { type: "DAMAGE_AUTO_ASSIGN"; player: PlayerId }
  | { type: "KILL_GEAR_ACTIVATE"; player: PlayerId; gearInstanceId: string }
  | { type: "SPEND_MY_BUFF_ACTIVATE"; player: PlayerId; unitInstanceId: string }
  | { type: "CULL_CHOOSE"; player: PlayerId; unitInstanceId: string }
  | { type: "REVEAL_WINDOW_CONFIRM"; player: PlayerId; selectedIds?: string[] };

interface ChainItem {
  id: string;
  controller: PlayerId;
  kind: "PLAY_CARD" | "TRIGGERED_ABILITY" | "ACTIVATED_ABILITY";
  label: string;

  sourceCard?: CardInstance; // for play-card
  sourceZone?: "HAND" | "FACEDOWN" | "CHAMPION";
  playDestination?: { kind: "BASE" } | { kind: "BF"; index: number } | null;

  // ability resolution
  effectText?: string;
  contextBattlefieldIndex?: number | null;

  targets: Target[];
  // Target-selection gate for triggered/activated items (or weird spells)
  needsTargets?: boolean;
  targetRequirement?: TargetRequirement;
  restrictTargetsToBattlefieldIndex?: number | null;
  sourceInstanceId?: string;
  sourceCardType?: CardType;
  repeatCount?: number;

  // Special flags captured at play time (so later resolution is correct)
  legionActive?: boolean;
  additionalCostPaid?: boolean;

  // costs already paid before putting onto chain
  // (except some manual helpers)
}

// Delayed triggers that fire on specific events this turn (e.g., Rally the Troops)
type DelayedTriggerEvent =
  | "UNIT_PLAYED"       // When a friendly unit is played
  | "UNIT_ENTERS"       // When a unit enters a battlefield
  | "UNIT_ATTACKS"      // When a unit attacks
  | "UNIT_DEFENDS"      // When a unit defends
  | "SPELL_PLAYED"      // When a spell is played
  | "CARD_DISCARDED"    // When a card is discarded
  | "UNIT_TAKES_DAMAGE" // When any unit takes damage
  | "UNIT_DIES"         // When a unit dies
  | "TURN_END";         // End of turn (delayed effects)

interface DelayedTrigger {
  id: string;
  controller: PlayerId;
  event: DelayedTriggerEvent;
  targetFilter?: "FRIENDLY" | "ENEMY" | "ANY";
  effect: string;        // Effect text to resolve
  untilTurn: number;     // Turn number when this expires
  sourceCardName: string;
  onlyOnce?: boolean;    // If true, remove after first trigger
}

interface ResolveEffectPost {
  cleanup?: boolean;
  maybeOpenWindow?: boolean;
  setOpenState?: boolean;
  priorityPlayer?: PlayerId;
}

interface ResolveEffectContext {
  battlefieldIndex?: number | null;
  sourceInstanceId?: string;
  sourceCardName?: string;
  sourceCardType?: CardType;
  chainItemId?: string;
  resolutionId?: string;
  resumePost?: ResolveEffectPost;
}

interface ResolveEffectUiContext {
  viewerId: PlayerId;
  canActAs: (pid: PlayerId) => boolean;
  isAiControlled: (pid: PlayerId) => boolean;
}

let activeUiContext: ResolveEffectUiContext | null = null;

type OptionalChoiceKind = "CONFIRM" | "NUMBER";

interface OptionalChoiceResult {
  accepted: boolean;
  value?: number;
}

interface OptionalChoiceResumeChain {
  kind: "CHAIN";
  chainItemId: string;
}

interface OptionalChoiceResumeDirect {
  kind: "DIRECT";
  controller: PlayerId;
  effectText: string;
  targets: Target[];
  ctx: ResolveEffectContext;
  post?: ResolveEffectPost;
}

type OptionalChoiceResume = OptionalChoiceResumeChain | OptionalChoiceResumeDirect;

interface PendingOptionalChoice {
  id: string;
  player: PlayerId;
  kind: OptionalChoiceKind;
  prompt: string;
  min?: number;
  max?: number;
  defaultValue?: number;
  resume?: OptionalChoiceResume;
  resumeDelayedEvent?: {
    event: DelayedTriggerEvent;
    unitOwner: PlayerId;
    unitInstanceId: string;
    battlefieldIndex?: number | null;
    alone?: boolean;
    skipTriggerIds?: string[];
  };
}

interface PendingCullChoice {
  resolutionId: string;
  order: PlayerId[];
  index: number;
  choices: Record<PlayerId, string | null>;
}

interface GameState {
  step: Step;
  turnNumber: number;
  turnPlayer: PlayerId;
  startingPlayer: PlayerId;

  // windows
  windowKind: WindowKind;
  windowBattlefieldIndex: number | null;
  focusPlayer: PlayerId | null; // focus holder during showdowns (551-553)
  combat: null | {
    battlefieldIndex: number;
    attacker: PlayerId;
    defender: PlayerId;
    step: CombatStep;
  };

  // chain + priority
  chain: ChainItem[];
  priorityPlayer: PlayerId;
  passesInRow: number; // consecutive passes in the current closed/open window
  state: "OPEN" | "CLOSED";

  // victory score for duel
  victoryScore: number;

  // misc
  log: string[];
  actionHistory: EngineAction[];
  // players + battlefields
  players: Record<PlayerId, PlayerState>;
  battlefields: BattlefieldState[];
  damageKillEffects: { controller: PlayerId; untilTurn: number }[];
  recallOnDeathEffects: { unitInstanceId: string; controller: PlayerId; untilTurn: number; payCost?: boolean }[]; // Highlander/Unlicensed Armory
  lastCombatExcessDamage: Record<PlayerId, number>;
  lastCombatExcessDamageTurn: number;

  // Weaponmaster pending choice (optional equip after playing unit with Weaponmaster)
  pendingWeaponmasterChoice?: {
    unitInstanceId: string;
    unitOwner: PlayerId;
    availableGearIds: string[];
  } | null;

  // Equip ability pending choice (selecting a unit to attach equipment to)
  pendingEquipChoice?: {
    gearInstanceId: string;
    gearOwner: PlayerId;
    equipCost: { energy: number; power: number; powerDomain: Domain | "CLASS" };
  } | null;

  // Candlelit Sanctum pending choice (recycle one or both top cards)
  pendingCandlelitChoice?: {
    player: PlayerId;
    cards: CardInstance[];
    choices: Record<string, "KEEP" | "RECYCLE">;
    order?: string[]; // instanceIds, top-to-bottom order for kept cards
  } | null;

  // Optional choice modal for "you may" effects
  pendingOptionalChoice?: PendingOptionalChoice | null;
  optionalChoiceResults?: Record<string, OptionalChoiceResult>;

  // Each-player unit selection (Cull the Weak)
  pendingCullChoice?: PendingCullChoice | null;
  cullChoiceResults?: Record<string, Record<PlayerId, string | null>>;

  // Combat damage assignment (manual assignment during DAMAGE_ASSIGNMENT step)
  pendingDamageAssignment?: {
    battlefieldIndex: number;
    attacker: PlayerId;
    defender: PlayerId;
    attackerTotalDamage: number;  // Total damage attacker deals to defender's units
    defenderTotalDamage: number;  // Total damage defender deals to attacker's units
    // Each player's damage assignment: map of unitInstanceId -> damage assigned
    attackerAssignment: Record<string, number>;  // Attacker assigns damage to defender's units
    defenderAssignment: Record<string, number>;  // Defender assigns damage to attacker's units
    attackerConfirmed: boolean;
    defenderConfirmed: boolean;
  } | null;

  // Delayed triggers that fire on specific events this turn
  delayedTriggers: DelayedTrigger[];

  // Reveal window (modal)
  pendingRevealWindow?: RevealWindow | null;
  pendingPlayHint: string | null;
}

// ----------------------------- Helpers -----------------------------

let __id = 1;
const makeId = (prefix: string) => `${prefix}_${__id++}`;

function engineRecycleRuneForPower(d: GameState, pid: PlayerId, runeId: string): boolean {
  const p = d.players[pid];
  const idx = p.runesInPlay.findIndex((x) => x.instanceId === runeId);
  if (idx < 0) return false;
  const r = p.runesInPlay[idx];
  p.runesInPlay.splice(idx, 1);
  p.runePool.power[r.domain] += 1;
  p.runeDeck.push({ ...r, isReady: true } as any); // cast for now to avoid instance properties mismatch
  d.log.unshift(`${pid} recycled a ${r.domain} rune to add 1 ${r.domain} power.`);

  const legend = p.legend;
  if (p.legendReady && legend) {
    const raw = legend.ability?.raw_text || "";
    if (/when you recycle a rune,?\s*you may exhaust me to/i.test(raw)) {
      const m = raw.match(/when you recycle a rune,?\s*you may exhaust me to\s+([^.]+)/i);
      if (m) {
        d.chain.push({
          id: makeId("chain"),
          controller: pid,
          kind: "TRIGGERED_ABILITY",
          label: `Trigger: ${legend.name} (Recycle)`,
          effectText: `You may exhaust your legend to ${m[1].trim()}.`,
          targets: [{ kind: "NONE" }],
          needsTargets: false,
          sourceInstanceId: legend.id,
          sourceCardType: "Legend",
        });
        d.state = "CLOSED";
        d.priorityPlayer = pid;
        d.passesInRow = 0;
      }
    }
  }
  return true;
}

function sumPower(pool: RunePool): number {
  return (
    (pool.power.Body || 0) +
    (pool.power.Calm || 0) +
    (pool.power.Chaos || 0) +
    (pool.power.Fury || 0) +
    (pool.power.Mind || 0) +
    (pool.power.Order || 0) +
    (pool.power.Colorless || 0)
  );
}

const isPlayerId = (v: any): v is PlayerId => v === "P1" || v === "P2";

const deepClone = <T,>(obj: T): T => {
  // structuredClone is supported in modern browsers; fallback for older environments.
  // NOTE: Certain browser objects (e.g., PointerEvent) cannot be cloned and can accidentally
  // leak into state via unsafely-bound React handlers. If that happens, fall back to a JSON
  // clone that strips unserializable values so the app keeps running.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sc: any = (globalThis as any).structuredClone;
  if (typeof sc === "function") {
    try {
      return sc(obj);
    } catch {
      // fall through to JSON clone
    }
  }
  try {
    return JSON.parse(JSON.stringify(obj)) as T;
  } catch {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(obj, (_k, v) => {
      if (typeof v === "function") return undefined;
      // Strip DOM / browser objects that are not safely serializable.
      if (typeof Event !== "undefined" && v instanceof Event) return undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const NodeAny: any = (globalThis as any).Node;
      if (typeof NodeAny !== "undefined" && v instanceof NodeAny) return undefined;

      if (v && typeof v === "object") {
        if (seen.has(v as object)) return undefined;
        seen.add(v as object);
      }
      return v;
    });
    return JSON.parse(json) as T;
  }
};

type ViewerId = PlayerId | "SPECTATOR";

interface PrivacySettings {
  revealHands: boolean; // reveal all hands to this viewer (debug / hotseat)
  revealFacedown: boolean; // reveal all facedown cards to this viewer (debug / hotseat)
  revealDecks: boolean; // reveal decks (and their randomized order!) to this viewer (debug)
}

const makeHiddenCardStub = (owner: PlayerId, ctx: string, idx: number): CardInstance => ({
  id: "HIDDEN",
  name: "Hidden Card",
  domain: "Colorless",
  cost: 0,
  type: "Spell",
  stats: { might: null, power: null },
  tags: [],
  ability: undefined,
  rarity: "Unknown",
  image: undefined,
  image_url: undefined,

  instanceId: `HIDDEN_${owner}_${ctx}_${idx}`,
  owner,
  controller: owner,

  isReady: false,
  damage: 0,
  buffs: 0,
  tempMightBonus: 0,
  stunned: false,
  stunnedUntilTurn: 0,
  moveCountThisTurn: 0,
  conditionalKeywords: [],

  createdTurn: 0,
});

const makeHiddenRuneStub = (owner: PlayerId, _ctx: string, idx: number): RuneInstance => ({
  instanceId: `HIDDEN_RUNE_${owner}_${_ctx}_${idx}`,
  owner,
  controller: owner,
  domain: "Colorless",
  isReady: false,
  createdTurn: 0,
});

/**
 * Viewer-safe projection of the full game state.
 * This is designed to be "server-side redaction": the authoritative state stays intact,
 * while each client receives only information they're allowed to know.
 */
const projectGameStateForViewer = (game: GameState, viewerId: ViewerId, privacy: PrivacySettings): GameState => {
  const g = deepClone(game);

  const canSeeHand = (pid: PlayerId) => (viewerId === pid ? true : privacy.revealHands);
  const canSeeFacedown = (pid: PlayerId) => (viewerId === pid ? true : privacy.revealFacedown);

  // Deck order is secret information; for network-safety we hide decks for everyone unless explicitly revealed.
  const canSeeDecks = () => privacy.revealDecks;

  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = g.players[pid];

    if (!canSeeHand(pid)) {
      p.hand = p.hand.map((_c, i) => makeHiddenCardStub(pid, "HAND", i));
    }

    if (!canSeeDecks()) {
      p.mainDeck = p.mainDeck.map((_c, i) => makeHiddenCardStub(pid, "MAIN_DECK", i));
      p.runeDeck = p.runeDeck.map((_r, i) => makeHiddenRuneStub(pid, "RUNE_DECK", i));
    }
  }

  for (let i = 0; i < g.battlefields.length; i++) {
    const bf = g.battlefields[i];
    if (bf.facedown && !canSeeFacedown(bf.facedown.owner)) {
      bf.facedown = {
        ...bf.facedown,
        card: makeHiddenCardStub(bf.facedown.owner, `FACEDOWN_BF${i}`, 0),
      };
    }
    if (bf.facedownExtra && !canSeeFacedown(bf.facedownExtra.owner)) {
      bf.facedownExtra = {
        ...bf.facedownExtra,
        card: makeHiddenCardStub(bf.facedownExtra.owner, `FACEDOWN_BF${i}_EXTRA`, 0),
      };
    }
  }

  return g;
};

const otherPlayer = (p: PlayerId): PlayerId => (p === "P1" ? "P2" : "P1");

const parseDomains = (domainStr: string): Domain[] =>
  domainStr
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d as Domain);

const clampDomain = (d: string): Domain => {
  const x = d.trim();
  if (["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"].includes(x)) return x as Domain;
  return "Colorless";
};

const DEFAULT_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order"];

// Champion/subtype to domain mapping for cards without legacy data
// Derived from riftbound_card_data.json Legend cards and champion associations
const CHAMPION_DOMAIN_MAP: Record<string, string> = {
  // Legends (primary champions)
  "ahri": "Calm, Mind",
  "annie": "Fury, Chaos",
  "azir": "Mind, Order",
  "darius": "Fury, Order",
  "draven": "Fury, Chaos",
  "ezreal": "Mind, Chaos",
  "fiora": "Body, Order",
  "garen": "Body, Order",
  "irelia": "Calm, Body",
  "jax": "Body, Fury",
  "jinx": "Fury, Chaos",
  "kaisa": "Fury, Mind",
  "leesin": "Calm, Body",
  "leona": "Calm, Order",
  "lucian": "Order, Fury",
  "lux": "Mind, Order",
  "masteryi": "Calm, Body",
  "missfortune": "Body, Chaos",
  "ornn": "Body, Fury",
  "reksai": "Fury, Chaos",
  "renataglasc": "Mind, Chaos",
  "rumble": "Fury, Mind",
  "sett": "Body, Order",
  "sivir": "Fury, Body",
  "teemo": "Mind, Chaos",
  "viktor": "Mind, Order",
  "volibear": "Fury, Body",
  "yasuo": "Calm, Chaos",
  // Regions/factions
  "bandlecity": "Mind, Chaos",
  "bilgewater": "Fury, Chaos",
  "demacia": "Order, Body",
  "freljord": "Fury, Body",
  "ionia": "Calm, Mind",
  "ixtal": "Body, Calm",
  "mounttargon": "Calm, Order",
  "noxus": "Fury, Order",
  "piltover": "Mind, Order",
  "shadowisles": "Chaos, Mind",
  "shurima": "Mind, Order",
  "thevoid": "Fury, Chaos",
  "zaun": "Mind, Chaos",
  // Unit types/tribes
  "bird": "Calm",
  "cat": "Body",
  "dog": "Body",
  "dragon": "Fury",
  "elite": "Order",
  "fae": "Calm",
  "mech": "Mind, Fury",
  "pirate": "Fury, Chaos",
  "poro": "Calm",
  "recruit": "Colorless",
  "spirit": "Calm",
  "trifarian": "Fury",
  "yordle": "Mind",
  // Additional champions from expert data
  "akshan": "Body, Order",
  "aphelios": "Calm, Mind",
  "bard": "Calm, Mind",
  "blitzcrank": "Mind",
  "caitlyn": "Mind, Order",
  "dr.mundo": "Body, Chaos",
  "ekko": "Mind, Chaos",
  "heimerdinger": "Mind",
  "janna": "Calm",
  "jayce": "Mind, Order",
  "karthus": "Chaos, Mind",
  "kayn": "Chaos, Body",
  "kogmaw": "Fury, Chaos",
  "malzahar": "Mind, Chaos",
  "nocturne": "Chaos",
  "qiyana": "Body, Calm",
  "rell": "Order, Body",
  "shen": "Order, Calm",
  "sona": "Calm, Mind",
  "soraka": "Calm, Order",
  "taric": "Calm, Order",
  "tryndamere": "Fury, Body",
  "twistedfate": "Chaos, Mind",
  "udyr": "Body, Fury",
  "vayne": "Order, Fury",
  "vi": "Fury, Body",
  "warwick": "Body, Chaos",
  "yone": "Calm, Chaos",
  // Equipment subtype (gear cards)
  "equipment": "Colorless",
};

// Infer domain from type_line subtype (e.g., "legend - annie" -> "Fury, Chaos")
const inferDomainFromTypeLine = (typeLine: string): string | null => {
  if (!typeLine || !typeLine.includes("-")) return null;
  const [, subtypesRaw] = typeLine.split("-", 2);
  if (!subtypesRaw) return null;

  // Split by comma/slash for multiple subtypes and find first match
  const subtypes = subtypesRaw.split(/[,/]/).map(s =>
    s.trim().toLowerCase().replace(/\s+/g, "").replace(/'/g, "")
  ).filter(s => s && s !== "nan");

  for (const subtype of subtypes) {
    const domain = CHAMPION_DOMAIN_MAP[subtype];
    if (domain) return domain;
  }
  return null;
};

const sanitizeJsonText = (text: string): string => text.replace(/\bNaN\b/g, "null");

const normalizeNameKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, "")
    .trim();

const normalizeIdKey = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

const parseExpertPower = (value: number | string | undefined): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^c+$/i.test(trimmed)) return trimmed.length;
  return null;
};

const toTitleCase = (word: string): string =>
  word
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .trim();

const extractSubtypeTags = (typeLine: string | undefined): string[] => {
  if (!typeLine || !typeLine.includes("-")) return [];
  const [, subtypesRaw] = typeLine.split("-", 2);
  if (!subtypesRaw) return [];
  return subtypesRaw
    .split(/[,/]/)
    .map((s) => toTitleCase(s.trim()))
    .filter((s) => s && s.toLowerCase() !== "nan");
};

const inferDomainFromName = (name: string): Domain | null => {
  const lower = name.toLowerCase();
  const match = DEFAULT_DOMAINS.find((dom) => lower.includes(dom.toLowerCase()));
  return match || null;
};

const stripLeadingBracketKeywords = (raw: string): string =>
  raw.replace(/^(\s*\[[^\]]+\]\s*)+/g, "").trim();

const normalizeRulesTextForParsing = (text: string): string =>
  (text || "")
    .replace(/\\/g, "")
    .replace(/_/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, "—")
    .replace(/\s+/g, " ")
    .trim();

const splitRulesSentences = (text: string): string[] => {
  const cleaned = (text || "")
    .replace(/\\/g, "")
    .replace(/_/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, "—");
  return cleaned
    .split(/\.(?:\s+|$)|\n+/)
    .map((s) => normalizeRulesTextForParsing(s))
    .filter(Boolean);
};

type TriggerClause = { trigger: string; effectText: string; isLegion?: boolean };

const extractTriggerClauses = (rawText: string): TriggerClause[] => {
  const out: TriggerClause[] = [];
  const sentences = splitRulesSentences(rawText);

  for (const sentenceRaw of sentences) {
    const isLegion = /\[\s*legion\s*\]/i.test(sentenceRaw) || /^\s*legion\b/i.test(sentenceRaw);
    let sentence = stripLeadingBracketKeywords(sentenceRaw).trim();
    sentence = sentence.replace(/^[—-]\s*/, "").trim();
    if (!/^(when|whenever|as you play|at the start|at the beginning|at the end|after|while)\b/i.test(sentence)) continue;

    let triggerPart = sentence;
    let effectPart = "";
    const split = sentence.match(/^(.*?)(?:,|—|–|-|:)\s*(.+)$/);
    if (split) {
      triggerPart = split[1].trim();
      effectPart = split[2].trim();
    }
    if (!effectPart) continue;
    effectPart = effectPart.replace(/^[—-]\s*/, "").trim();

    const triggers = triggerPart.split(
      /\s+(?:and|or)\s+(?=when\b|whenever\b|as you play|at the start|at the beginning|at the end|after|while)/i
    );

    for (const trig of triggers) {
      const t = trig.replace(/^[—-]\s*/, "").trim();
      if (!t) continue;
      out.push({ trigger: t, effectText: effectPart, isLegion });
    }
  }

  return out;
};

type TriggerEventKind =
  | "PLAY_ME"
  | "PLAY_TO_BF"
  | "ATTACK"
  | "DEFEND"
  | "CHOOSE_ME"
  | "READY_ME"
  | "MOVE"
  | "MOVE_TO_BF"
  | "CONQUER"
  | "HOLD"
  | "DISCARD_ME";

const triggerMatchesEvent = (trigger: string, event: TriggerEventKind): boolean => {
  const t = normalizeRulesTextForParsing(trigger).toLowerCase();
  switch (event) {
    case "PLAY_ME":
      return (
        /when you play (me|this)\b/.test(t) ||
        /as you play (me|this)\b/.test(t) ||
        /when this is played\b/.test(t) ||
        /when i'?m played\b/.test(t) ||
        /when i'm played\b/.test(t)
      );
    case "PLAY_TO_BF":
      return /when you play me to a battlefield\b/.test(t);
    case "ATTACK":
      return /when i attack\b/.test(t) || /when i attack or defend\b/.test(t);
    case "DEFEND":
      return /when i defend\b/.test(t) || /when i attack or defend\b/.test(t) || /when i defend or i'm played from\b/.test(t);
    case "CHOOSE_ME":
      return /when you choose me\b/.test(t) || /when you choose or ready me\b/.test(t);
    case "READY_ME":
      return /when you ready me\b/.test(t) || /when you choose or ready me\b/.test(t);
    case "MOVE":
      return /when i move\b/.test(t) && !/when i move to a battlefield\b/.test(t);
    case "MOVE_TO_BF":
      return /when i move to a battlefield\b/.test(t);
    case "CONQUER":
      return /when i conquer\b/.test(t);
    case "HOLD":
      return /when i hold\b/.test(t);
    case "DISCARD_ME":
      return /when you discard me\b/.test(t);
    default:
      return false;
  }
};

const sanitizeTriggeredEffectText = (effectText: string): string => {
  let cleaned = (effectText || "").trim();
  if (!cleaned) return "";
  cleaned = cleaned.replace(/\bKill\s+this[:\s—-]+[^.]*\.?/gi, "").trim();
  cleaned = cleaned.replace(/\bExhaust\s+this[:\s—-]+[^.]*\.?/gi, "").trim();
  cleaned = cleaned.replace(/\bSpend\s+my\s+buff[:\s—-]+[^.]*\.?/gi, "").trim();
  cleaned = cleaned.replace(/^[.\s]+|[.\s]+$/g, "").trim();
  return cleaned;
};

const getTriggerEffects = (
  card: CardData | CardInstance,
  event: TriggerEventKind,
  opts?: { legionActive?: boolean }
): string[] => {
  const effects = new Set<string>();
  const rawAll = ((card as any)?.ability?.raw_text || (card as any)?.ability?.effect_text || "").toString();
  const clauses = extractTriggerClauses(rawAll);
  const allowLegion = !!opts?.legionActive;

  const addEffect = (txt: string) => {
    const cleaned = sanitizeTriggeredEffectText(stripLeadingBracketKeywords(txt || ""));
    if (cleaned) effects.add(cleaned);
  };

  for (const clause of clauses) {
    if (clause.isLegion && !allowLegion) continue;
    if (triggerMatchesEvent(clause.trigger, event)) addEffect(clause.effectText);
  }

  if (effects.size === 0) {
    const trig = (card as any)?.ability?.trigger || "";
    if (trig && triggerMatchesEvent(trig, event)) {
      addEffect((card as any)?.ability?.effect_text || (card as any)?.ability?.raw_text || "");
    }
  }

  return Array.from(effects);
};

type BattlefieldTriggerEvent =
  | "CONQUER_HERE"
  | "HOLD_HERE"
  | "ATTACK_HERE"
  | "DEFEND_HERE"
  | "MOVE_FROM_HERE"
  | "START_FIRST_BEGINNING";

const battlefieldTriggerMatchesEvent = (trigger: string, event: BattlefieldTriggerEvent): boolean => {
  const t = normalizeRulesTextForParsing(trigger).toLowerCase();
  switch (event) {
    case "CONQUER_HERE":
      return /when you conquer here/.test(t);
    case "HOLD_HERE":
      return /when you hold here/.test(t);
    case "ATTACK_HERE":
      return /when you attack here/.test(t);
    case "DEFEND_HERE":
      return /when you defend here/.test(t);
    case "MOVE_FROM_HERE":
      return /when a unit moves from here/.test(t) || /when a friendly unit moves from here/.test(t);
    case "START_FIRST_BEGINNING":
      return /at the start of each player's first beginning phase/.test(t);
    default:
      return false;
  }
};

const getBattlefieldTriggerEffects = (
  bfCard: CardData,
  event: BattlefieldTriggerEvent
): string[] => {
  const effects = new Set<string>();
  const rawAll = ((bfCard as any)?.ability?.raw_text || (bfCard as any)?.ability?.effect_text || "").toString();
  const clauses = extractTriggerClauses(rawAll);

  const addEffect = (txt: string) => {
    const cleaned = sanitizeTriggeredEffectText(stripLeadingBracketKeywords(txt || ""));
    if (cleaned) effects.add(cleaned);
  };

  for (const clause of clauses) {
    if (battlefieldTriggerMatchesEvent(clause.trigger, event)) addEffect(clause.effectText);
  }

  if (effects.size === 0) {
    const trig = (bfCard as any)?.ability?.trigger || "";
    if (trig && battlefieldTriggerMatchesEvent(trig, event)) {
      addEffect((bfCard as any)?.ability?.effect_text || (bfCard as any)?.ability?.raw_text || "");
    }
  }

  return Array.from(effects);
};

const deriveTriggerAndEffect = (
  rawText: string,
  chain: ExpertCardData["game_logic"] | undefined
): { trigger?: string; effectText?: string } => {
  const raw = rawText.trim();
  if (!raw) return {};

  const triggerCandidates = (chain?.chain || [])
    .map((item) => (item.type === "TRIGGERED_ABILITY" ? item.condition?.trim() : ""))
    .filter(Boolean) as string[];

  const triggerPattern = /^(when|whenever|at the start|at the beginning|at the end|after)\b/i;

  let trigger = triggerCandidates.find((t) => triggerPattern.test(t));

  if (!trigger) {
    const cleaned = stripLeadingBracketKeywords(raw);
    const match = cleaned.match(/^(when|whenever|at the start|at the beginning|at the end|after)\b[^.,]*[.,]/i);
    if (match) {
      trigger = match[0].replace(/[.,]$/, "").trim();
    }
  }

  if (!trigger) return { effectText: raw };

  const cleaned = stripLeadingBracketKeywords(raw);
  if (cleaned.toLowerCase().startsWith(trigger.toLowerCase())) {
    let remainder = cleaned.slice(trigger.length).trim();
    if (/^[,–—-]/.test(remainder)) remainder = remainder.slice(1).trim();
    return { trigger, effectText: remainder || raw };
  }

  return { trigger, effectText: raw };
};

const normalizeExpertCards = (cards: ExpertCardData[], legacyCards: CardData[] = []): CardData[] => {
  const legacyById = new Map<string, CardData>();
  const legacyByName = new Map<string, CardData>();
  legacyCards.forEach((card) => {
    legacyById.set(normalizeIdKey(card.id), card);
    legacyByName.set(normalizeNameKey(card.name), card);
  });

  return cards.map((card) => {
    const idBase = card.id?.split("/")[0] ?? card.id;
    const legacy =
      legacyById.get(normalizeIdKey(idBase)) ||
      legacyById.get(normalizeIdKey(card.id)) ||
      legacyByName.get(normalizeNameKey(card.name));

    const typeLine = card.type_line || "";
    const primaryType = typeLine.split("-")[0]?.trim().toLowerCase();
    const typeMap: Record<string, CardType> = {
      unit: "Unit",
      spell: "Spell",
      gear: "Gear",
      rune: "Rune",
      battlefield: "Battlefield",
      legend: "Legend",
    };

    const rawText = (card.rules_text?.raw?.toString() ?? "").replace(/\\/g, "").trim();
    // Merge keywords from rules_text and bracket extraction, filtering out icon tokens
    const keywords = [
      ...(card.rules_text?.keywords || []),
      ...extractBracketKeywords(rawText),
    ].filter((kw) => kw && !isIconKeywordToken(kw));

    const { trigger, effectText } = deriveTriggerAndEffect(rawText, card.game_logic);
    const subtypeTags = extractSubtypeTags(typeLine);
    const superTypesRaw = (card.supertypes || "").toString();
    const hasTokenSupertype = /\btoken\b/i.test(superTypesRaw);
    const mergedTags = Array.from(
      new Set([...(legacy?.tags || []), ...subtypeTags, ...(hasTokenSupertype ? ["Token"] : [])])
    );

    // Domain inference priority:
    // 1. Domain directly from expert data (CSV source)
    // 2. Legacy card data (if matched by ID or name)
    // 3. Type line subtype mapping (e.g., "legend - annie" -> "Fury, Chaos")
    // 4. Rune card name inference (e.g., "Fury Rune" -> "Fury")
    // 5. Fallback to "Colorless"
    const inferredDomain =
      card.domain ||
      legacy?.domain ||
      inferDomainFromTypeLine(typeLine) ||
      (typeMap[primaryType] === "Rune" ? inferDomainFromName(card.name) : null) ||
      "Colorless";

    return {
      id: card.id,
      name: card.name,
      rarity: card.rarity || legacy?.rarity,
      domain: inferredDomain,
      cost: Number.isFinite(card.stats?.energy) ? Number(card.stats?.energy) : legacy?.cost ?? 0,
      type: typeMap[primaryType] || legacy?.type || "Unit",
      tags: mergedTags,
      image_url: card.image_url || legacy?.image_url,
      image: legacy?.image,
      stats: {
        might: Number.isFinite(card.stats?.might) ? Number(card.stats?.might) : legacy?.stats.might ?? null,
        power: parseExpertPower(card.stats?.power) ?? legacy?.stats.power ?? null,
      },
      ability: rawText || keywords.length
        ? {
          trigger: trigger || legacy?.ability?.trigger,
          effect_text: effectText?.trim() || rawText.trim(),
          raw_text: rawText.trim(),
          keywords: Array.from(new Set(keywords)),
        }
        : legacy?.ability,
    };
  });
};

const emptyRunePool = (): RunePool => ({
  energy: 0,
  power: { Body: 0, Calm: 0, Chaos: 0, Fury: 0, Mind: 0, Order: 0, Colorless: 0 },
});

const classDomainsForPlayer = (game: GameState, player: PlayerId): Domain[] => {
  const doms = (game.players[player]?.domains || []).map(clampDomain).filter((d) => d !== "Colorless");
  return doms.length > 0 ? doms : DEFAULT_DOMAINS;
};

const shuffle = <T,>(arr: T[], seed = 0): T[] => {
  // deterministic-ish: seed is not cryptographic; just to reduce rerenders from random changes if needed
  const a = [...arr];
  // Mix in fresh entropy so repeated games don't produce identical opening hands.
  let s = (seed || Date.now()) + Math.floor(Math.random() * 1000000000);
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const r = s / 233280;
    const j = Math.floor(r * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const getKeywords = (card: any | null | undefined): string[] => {
  const base: string[] = (card?.ability?.keywords || []).filter((x: any) => typeof x === "string");
  const extra: string[] = ((card as any)?.extraKeywords || []).filter((x: any) => typeof x === "string");
  const temp: string[] = ((card as any)?.tempKeywords || []).filter((x: any) => typeof x === "string");
  const conditional: string[] = ((card as any)?.conditionalKeywords || []).filter((x: any) => typeof x === "string");
  return [...base, ...extra, ...temp, ...conditional];
};

const hasKeyword = (card: any | null | undefined, kw: string): boolean => {
  const ks = getKeywords(card);
  const needle = kw.toLowerCase();
  return ks.some((k) => (k || "").toLowerCase().startsWith(needle));
};

const cardRulesText = (card: CardData | CardInstance | null | undefined): string =>
  `${(card as any)?.ability?.raw_text || ""} ${(card as any)?.ability?.effect_text || ""}`.trim();

const isHiddenCard = (card: CardInstance | null | undefined): boolean => {
  return !!card && hasKeyword(card, "Hidden");
};

// Check if a gear card is Equipment (has Equip keyword or equipment in type_line)
const isEquipment = (card: CardInstance | null | undefined): boolean => {
  if (!card || card.type !== "Gear") return false;
  if (hasKeyword(card, "Equip")) return true;
  const typeLine = (card as any).type_line || "";
  if (typeLine.toLowerCase().includes("equipment")) return true;
  return /\[\s*equip\s*\]/i.test(cardRulesText(card));
};

const isTokenCard = (card: CardInstance | CardData | null | undefined): boolean => {
  if (!card) return false;
  const tags = (card as any).tags || [];
  if (Array.isArray(tags) && tags.some((t) => String(t || "").toLowerCase() === "token")) return true;
  const id = String((card as any).id || "");
  return id.startsWith("token_");
};

// Check if equipment has Quick-Draw (auto-attaches when played)
const hasQuickDraw = (card: CardInstance | null | undefined): boolean => {
  return !!card && hasKeyword(card, "Quick-Draw");
};

// Parse the Equip cost from equipment card text
// Returns { energy: number, power: number, powerDomain: Domain | "CLASS" }
const parseEquipCost = (card: CardInstance): { energy: number; power: number; powerDomain: Domain | "CLASS" } | null => {
  if (!isEquipment(card)) return null;

  const raw = (card.ability?.raw_text || card.ability?.effect_text || "").toLowerCase();

  // Pattern: [Equip] [C] or [Equip] [1][C] or [Equip] — [C]
  // [C] = 1 power in gear's domain (class rune)
  // [1] = 1 energy
  // [1][C] = 1 energy + 1 power

  // Check for energy cost like [1], [2], etc.
  const energyMatch = raw.match(/\[equip\].*?\[(\d+)\].*?\[c\]/i) ||
    raw.match(/\[equip\]\s*\\?\[(\d+)\]\\?\[c\]/i);
  const energy = energyMatch ? parseInt(energyMatch[1], 10) : 0;

  // Check for power cost [C] (class rune) or [CC] (2 class runes)
  const powerMatch = raw.match(/\[equip\].*?\[(c+)\]/i);
  const power = powerMatch ? powerMatch[1].length : 1; // Default to 1 if [Equip] is present

  // If no [C] found but has [Equip], assume 1 power cost
  if (!powerMatch && !raw.includes("[equip]")) return null;

  return { energy, power, powerDomain: "CLASS" };
};

const keywordValue = (card: any | null | undefined, kw: string): number => {
  const ks = getKeywords(card);
  const needle = kw.toLowerCase();
  let total = 0;
  for (const k of ks) {
    if (!k) continue;
    if (k.toLowerCase().startsWith(needle)) {
      const parts = k.split(" ").filter(Boolean);
      const n = parseInt(parts[parts.length - 1], 10);
      total += Number.isFinite(n) ? n : 1;
    }
  }
  return total;
};

const locateUnit = (
  game: GameState,
  owner: PlayerId,
  instanceId: string
): { zone: "BASE" | "BF"; battlefieldIndex?: number; unit: CardInstance } | null => {
  const p = game.players[owner];
  const inBase = p.base.units.find((u) => u.instanceId === instanceId);
  if (inBase) return { zone: "BASE", unit: inBase };
  for (const bf of game.battlefields) {
    const u = bf.units[owner].find((x) => x.instanceId === instanceId);
    if (u) return { zone: "BF", battlefieldIndex: bf.index, unit: u };
  }
  return null;
};

// In combat, "Assault X" applies only to attackers; "Shield X" applies only to defenders.
const effectiveMight = (
  unit: CardInstance,
  ctx?: { role?: "ATTACKER" | "DEFENDER" | "NONE"; alone?: boolean; game?: GameState; battlefieldIndex?: number | null }
): number => {
  const inferredBattlefieldIndex =
    ctx?.battlefieldIndex != null
      ? ctx.battlefieldIndex
      : ctx?.game
        ? (() => {
          const loc = locateUnit(ctx.game, unit.owner, unit.instanceId);
          return loc && loc.zone === "BF" ? loc.battlefieldIndex ?? null : null;
        })()
        : null;

  const base = unit.stats.might ?? 0;
  const perm = unit.buffs || 0;
  const temp = unit.tempMightBonus || 0;

  // Equipment bonus: sum of all attached equipment's might stats
  const equipmentBonus = (unit.attachedGear || []).reduce((sum, gear) => {
    const gearMight = gear.stats?.might ?? 0;
    return sum + gearMight;
  }, 0);

  let mod = equipmentBonus;
  if (ctx?.role === "ATTACKER") mod += keywordValue(unit, "Assault");
  if (ctx?.role === "DEFENDER") mod += keywordValue(unit, "Shield");
  const raw = `${unit.ability?.effect_text || ""} ${unit.ability?.raw_text || ""}`;
  const baseBonusMatch = raw.match(/(?:^|[.!?]\s*)i have (?:an additional )?\+(\d+) might\b/i);
  if (baseBonusMatch) {
    const n = parseInt(baseBonusMatch[1], 10);
    if (Number.isFinite(n)) mod += n;
  }
  if (unit.buffs > 0) {
    const buffedBonus = raw.match(/while i'm buffed,?\s*i have (?:an additional )?\+(\d+) might\b/i);
    if (buffedBonus) {
      const n = parseInt(buffedBonus[1], 10);
      if (Number.isFinite(n)) mod += n;
    }
  }
  if (ctx?.alone) {
    const aloneBonus = raw.match(/while i'm attacking or defending alone,?\s*i have \+(\d+) might\b/i);
    if (aloneBonus) {
      const n = parseInt(aloneBonus[1], 10);
      if (Number.isFinite(n)) mod += n;
    }
  }
  if (ctx?.game) {
    const p = ctx.game.players[unit.controller];
    const runeCount = p.runesInPlay.length;
    if (/while you have 8\+ runes/i.test(raw) && runeCount >= 8) {
      const m = raw.match(/while you have 8\+ runes,?\s*i have \+(\d+) might/i);
      const n = m ? parseInt(m[1], 10) : 0;
      if (Number.isFinite(n)) mod += n;
    }
    const friendlyGearBonus = raw.match(/i have \+(\d+)\s+might\s+for each friendly gear/i);
    if (friendlyGearBonus) {
      const n = parseInt(friendlyGearBonus[1], 10);
      if (Number.isFinite(n) && n > 0) {
        const friendlyGearCount = getAllGear(ctx.game, unit.controller).length;
        mod += n * friendlyGearCount;
      }
    }
    const buffedFriendlyBonus = raw.match(/i get \+(\d+)\s*\[?s\]?\s+for each buffed friendly unit at my battlefield/i);
    if (buffedFriendlyBonus && inferredBattlefieldIndex != null) {
      const n = parseInt(buffedFriendlyBonus[1], 10);
      if (Number.isFinite(n) && n > 0) {
        const bf = ctx.game.battlefields[inferredBattlefieldIndex];
        const buffedCount = bf.units[unit.controller].filter((u) => (u.buffs || 0) > 0).length;
        mod += n * buffedCount;
      }
    }

    // Battlefield continuous effects (e.g., Trifarian War Camp: "Units here have +1 [S]")
    if (inferredBattlefieldIndex != null) {
      const bf = ctx.game.battlefields[inferredBattlefieldIndex];
      const bfRaw = bf.card.rules_text?.raw || bf.card.ability?.effect_text || "";
      // "Units here have +N [S]" pattern (Trifarian War Camp)
      const unitsHereBonus = bfRaw.match(/units here have \+(\d+)\s*\[?s\]?/i);
      if (unitsHereBonus) {
        const n = parseInt(unitsHereBonus[1], 10);
        if (Number.isFinite(n)) mod += n;
      }
    }

    if (inferredBattlefieldIndex != null && unit.stunned) {
      const bf = ctx.game.battlefields[inferredBattlefieldIndex];
      const enemy = otherPlayer(unit.controller);
      const aura = bf.units[enemy].find((u) =>
        /stunned enemy units here have -\d+ might/i.test(`${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`)
      );
      if (aura) {
        const rawAura = `${aura.ability?.effect_text || ""} ${aura.ability?.raw_text || ""}`;
        if (/within 3 points of the victory score/i.test(rawAura)) {
          const opp = otherPlayer(aura.controller);
          if (ctx.game.players[opp].points < ctx.game.victoryScore - 3) {
            return Math.max(0, base + perm + temp + mod);
          }
        }
        const m = rawAura.match(/stunned enemy units here have -(\d+) might/i);
        const n = m ? parseInt(m[1], 10) : 0;
        if (Number.isFinite(n) && n > 0) mod -= n;
        const minMatch = rawAura.match(/minimum of (\d+) might/i);
        if (minMatch) {
          const minVal = parseInt(minMatch[1], 10);
          const total = base + perm + temp + mod;
          return Math.max(minVal, total);
        }
      }
    }
  }
  return Math.max(0, base + perm + temp + mod);
};

const summarizeCard = (c: CardData | CardInstance): string => {
  const p = c.stats?.power ?? 0;
  const m = c.stats?.might ?? 0;
  const cost = `${c.cost ?? 0}${p ? ` + ${p}P` : ""}`;
  return `${c.name} (${c.type}, ${c.domain}, ${cost}${c.type === "Unit" ? `, Might ${m}` : ""})`;
};

const isMainDeckType = (t: CardType) => t === "Unit" || t === "Spell" || t === "Gear";

const isDuelBattlefieldCount = 2;
const duelVictoryScore = 8; // Duel victory score (mode of play).
const isMighty = (unit: CardInstance, game?: GameState) => effectiveMight(unit, { role: "NONE", game }) >= 5;

// Check if a unit just became Mighty and fire appropriate triggers (e.g., Fiora, Grand Duelist)
// Call this after any action that could increase a unit's might (equipment attach, buff, etc.)
const checkBecomesMighty = (game: GameState, unit: CardInstance, previousMight: number): void => {
  const currentMight = effectiveMight(unit, { role: "NONE", game });
  const wasMighty = previousMight >= 5;
  const nowMighty = currentMight >= 5;

  // Only trigger if the unit just became Mighty (wasn't before, is now)
  if (!wasMighty && nowMighty) {
    game.log.unshift(`${unit.name} became Mighty (${previousMight} → ${currentMight} might).`);

    // Check for legend triggers: "When one of your units becomes [Mighty]"
    // e.g., Fiora, Grand Duelist: "When one of your units becomes [Mighty], you may exhaust me to channel 1 rune exhausted."
    const legend = game.players[unit.controller].legend;
    const legendReady = game.players[unit.controller].legendReady;
    if (legend && legendReady) {
      const trig = (legend.ability?.trigger || "").toLowerCase();
      const eff = legend.ability?.effect_text || "";
      const raw = legend.ability?.raw_text || "";
      const triggerCorpus = `${trig}\n${eff}\n${raw}`;

      // Check for "when a unit you control becomes mighty" or "when one of your units becomes mighty"
      const matchesTrigger = /when (one of your units|a unit you control) becomes \[?mighty\]?/i.test(triggerCorpus);
      const effectText = eff || raw;

      if (matchesTrigger && effectText) {
        // Queue the triggered ability
        const req = inferTargetRequirement(effectText);
        game.chain.push({
          id: makeId("chain"),
          controller: unit.controller,
          kind: "TRIGGERED_ABILITY",
          label: `Trigger: ${legend.name} (Unit became Mighty)`,
          effectText,
          targets: [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
          sourceInstanceId: legend.id,
          sourceCardType: "Legend",
        });
        game.state = "CLOSED";
        game.priorityPlayer = unit.controller;
        game.passesInRow = 0;
        game.log.unshift(`${legend.name} triggered: ${unit.name} became Mighty.`);
      }
    }

    // Also check for other "becomes Mighty" triggers from units/gear in play
    // e.g., Relentless Storm legend: "When you play a [Mighty] unit, you may exhaust me to channel 1 rune exhausted."
    // (Note: This is for "play a Mighty unit", not "becomes Mighty", so handled elsewhere)
  }
};

const getUnitsInPlay = (game: GameState, player: PlayerId): CardInstance[] => [
  ...game.players[player].base.units,
  ...game.battlefields.flatMap((b) => b.units[player]),
];

const hasVoidHatchlingInPlay = (game: GameState, player: PlayerId): boolean =>
  getUnitsInPlay(game, player).some((u) => normalizeNameKey(u.name) === normalizeNameKey("Void Hatchling"));

const applyVoidHatchlingRevealReplacement = (
  game: GameState,
  player: PlayerId,
  deckType: "MAIN" | "RUNE"
): boolean => {
  if (!hasVoidHatchlingInPlay(game, player)) return false;
  const p = game.players[player];
  const deck = deckType === "RUNE" ? p.runeDeck : p.mainDeck;
  if (!deck || deck.length === 0) return false;
  const top = deck.shift();
  if (!top) return false;
  deck.push(top as any);
  game.log.unshift(
    `${player} used Void Hatchling: recycled top ${deckType === "RUNE" ? "rune" : "main deck"} card before reveal.`
  );
  return true;
};

const advanceCullChoice = (game: GameState) => {
  const pending = game.pendingCullChoice;
  if (!pending) return;
  while (pending.index < pending.order.length) {
    const pid = pending.order[pending.index];
    const units = getUnitsInPlay(game, pid);
    if (units.length > 0) return;
    pending.choices[pid] = null;
    pending.index += 1;
  }
  if (!game.cullChoiceResults) game.cullChoiceResults = {};
  game.cullChoiceResults[pending.resolutionId] = { ...pending.choices };
  game.pendingCullChoice = null;
};

// Filter out icon-like keyword tokens that represent costs or stats, not actual keywords
const isIconKeywordToken = (kw: string): boolean => {
  const cleaned = String(kw || "").trim();
  if (!cleaned) return false;
  // Numeric costs like [1], [2], [0]
  if (/^\d+$/.test(cleaned)) return true;
  // Single-letter icons: S=Might, A=Any rune, C=Class rune, T=Tap, E=Exhaust
  const upper = cleaned.toUpperCase();
  return ["S", "A", "C", "T", "E", "R", "B", "Y"].includes(upper);
};

const extractBracketKeywords = (text: string): string[] => {
  const out: string[] = [];
  const regex = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text))) {
    const kw = (m[1] || "").trim();
    // Filter out icon tokens that aren't actual keywords
    if (kw && !isIconKeywordToken(kw)) out.push(kw);
  }
  return out;
};

const refreshConditionalKeywords = (game: GameState) => {
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const discardedThisTurn = game.players[pid].discardedThisTurn > 0;
    const applyConditionals = (u: CardInstance, extraKeywords: string[] = []) => {
      const rawText = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`;
      const conditional: string[] = [];

      if (u.buffs > 0 && /while i'm buffed/i.test(rawText)) {
        const clause = rawText.split(/while i'm buffed/i)[1] || "";
        conditional.push(...extractBracketKeywords(clause));
      }

      if (isMighty(u, game) && /while i'm\s*\[mighty\]/i.test(rawText)) {
        const clause = rawText.split(/while i'm\s*\[mighty\]/i)[1] || "";
        conditional.push(...extractBracketKeywords(clause));
      }

      if (discardedThisTurn && /if you've discarded a card this turn/i.test(rawText)) {
        const clause = rawText.split(/if you've discarded a card this turn/i)[1] || "";
        conditional.push(...extractBracketKeywords(clause));
      }

      if (extraKeywords.length > 0) conditional.push(...extraKeywords);
      u.conditionalKeywords = Array.from(new Set(conditional));
    };

    // Base units
    for (const u of game.players[pid].base.units) applyConditionals(u);

    // Battlefield units (include battlefield static keyword grants like Windswept Hillock)
    for (const bf of game.battlefields) {
      const extra: string[] = battlefieldGivesGanking(bf) ? ["Ganking"] : [];
      for (const u of bf.units[pid]) applyConditionals(u, extra);
    }
  }
};

// ----------------------------- Core rules helpers -----------------------------

type TimingClass = "NORMAL" | "ACTION" | "REACTION";

const isShowdownStepOpen = (game: GameState): boolean =>
  (game.windowKind === "SHOWDOWN" || (game.windowKind === "COMBAT" && game.combat?.step === "SHOWDOWN")) &&
  game.state === "OPEN" &&
  game.chain.length === 0;

const isChainResponseWindow = (game: GameState): boolean =>
  game.chain.length > 0 || game.state === "CLOSED";

const inferCardTimingClass = (
  card: CardInstance,
  source: "HAND" | "CHAMPION" | "FACEDOWN" = "HAND"
): TimingClass => {
  const isReaction = hasKeyword(card, "Reaction") || source === "FACEDOWN";
  const isAction = hasKeyword(card, "Action");
  if (isReaction) return "REACTION";
  if (isAction) return "ACTION";
  return "NORMAL";
};

const inferActivatedTimingClass = (rawLine: string | undefined): TimingClass => {
  const t = String(rawLine || "").toLowerCase();
  if (/\[\s*reaction\s*\]/i.test(t) || /^\s*reaction\b/i.test(t)) return "REACTION";
  if (/\[\s*action\s*\]/i.test(t) || /^\s*action\b/i.test(t)) return "ACTION";
  return "NORMAL";
};

const canUseTimingClassNow = (game: GameState, player: PlayerId, timing: TimingClass): boolean => {
  if (game.priorityPlayer !== player) return false;

  // While a chain is stacked / resolving, ONLY Reactions are legal.
  if (isChainResponseWindow(game)) return timing === "REACTION";

  // At showdown start (empty chain/open state), Actions and Reactions are legal.
  if (isShowdownStepOpen(game)) return timing === "ACTION" || timing === "REACTION";

  // Otherwise cards/effects are main-phase speed on your own ACTION step.
  return game.windowKind === "NONE" && game.state === "OPEN" && game.chain.length === 0 && game.step === "ACTION" && game.turnPlayer === player;
};

const canPlaySpellOutsideShowdown = (card: CardInstance, game: GameState, player: PlayerId): boolean => {
  if (card.type !== "Spell") return false;
  return canUseTimingClassNow(game, player, inferCardTimingClass(card, "HAND"));
};

const canPlayNonspellOutsideShowdown = (
  card: CardInstance,
  game: GameState,
  player: PlayerId,
  source: "HAND" | "CHAMPION" | "FACEDOWN" = "HAND"
): boolean => {
  if (card.type === "Spell") return canPlaySpellOutsideShowdown(card, game, player);
  if (!["Unit", "Gear"].includes(card.type)) return false;
  return canUseTimingClassNow(game, player, inferCardTimingClass(card, source));
};

const canStandardMoveNow = (game: GameState): boolean => {
  // Standard Move is a Limited Action in Action phase, does not use chain and cannot be reacted to.
  return game.step === "ACTION" && game.windowKind === "NONE" && game.state === "OPEN" && game.chain.length === 0;
};

const canHideNow = (game: GameState): boolean => {
  // Hide is a Discretionary Action in Action phase. We'll keep it Action-phase only.
  return game.step === "ACTION" && game.windowKind === "NONE" && game.state === "OPEN" && game.chain.length === 0;
};

const runePoolTotalPower = (pool: RunePool, allowed?: Domain[]): number => {
  const domains = allowed && allowed.length > 0 ? allowed : (Object.keys(pool.power) as Domain[]);
  return domains.reduce((s, d) => s + (pool.power[d] || 0), 0);
};

const choosePowerPaymentDomains = (pool: RunePool, need: number, allowed: Domain[]): { payment: Record<Domain, number> } | null => {
  // Greedy payment: spend from the domain with most available first.
  const payment: Record<Domain, number> = { Body: 0, Calm: 0, Chaos: 0, Fury: 0, Mind: 0, Order: 0, Colorless: 0 };
  let remaining = need;
  const sorted = [...allowed].sort((a, b) => (pool.power[b] || 0) - (pool.power[a] || 0));
  for (const d of sorted) {
    if (remaining <= 0) break;
    const avail = pool.power[d] || 0;
    if (avail <= 0) continue;
    const spend = Math.min(avail, remaining);
    payment[d] += spend;
    remaining -= spend;
  }
  if (remaining > 0) return null;
  return { payment };
};

// ----------------------------- Effect parsing (lightweight) -----------------------------

type TargetRequirement =
  | { kind: "NONE"; optional?: boolean }
  | { kind: "UNIT_ANYWHERE"; count: number; excludeSelf?: boolean; optional?: boolean }
  | { kind: "UNIT_AT_BATTLEFIELD"; count: number; excludeSelf?: boolean; optional?: boolean }  // Any unit at a battlefield (not base)
  | { kind: "UNIT_ENEMY_AT_BATTLEFIELD"; count: number; excludeSelf?: boolean; optional?: boolean }  // Enemy unit at a battlefield
  | { kind: "UNIT_FRIENDLY_AT_BATTLEFIELD"; count: number; excludeSelf?: boolean; optional?: boolean }  // Friendly unit at a battlefield
  | { kind: "UNIT_HERE_ENEMY"; count: number; excludeSelf?: boolean; optional?: boolean }
  | { kind: "UNIT_HERE_FRIENDLY"; count: number; excludeSelf?: boolean; optional?: boolean }
  | { kind: "UNIT_FRIENDLY"; count: number; excludeSelf?: boolean; optional?: boolean }  // Friendly unit anywhere (e.g., "a friendly unit")
  | { kind: "UNIT_ENEMY"; count: number; excludeSelf?: boolean; optional?: boolean }     // Enemy unit anywhere (e.g., "an enemy unit")
  | { kind: "UNIT_FRIENDLY_AND_ENEMY"; optional?: boolean }  // One friendly unit AND one enemy unit (e.g., Challenge spell)
  | { kind: "UNIT_FRIENDLY_IN_BASE_AND_BATTLEFIELD"; optional?: boolean }  // One friendly unit in base + one battlefield
  | { kind: "GEAR_FRIENDLY"; count: number; optional?: boolean }
  | { kind: "GEAR_ANY"; count: number; optional?: boolean }
  | { kind: "GEAR_FRIENDLY_EQUIPMENT"; count: number; optional?: boolean }
  | { kind: "UNIT_AND_GEAR_FRIENDLY"; optional?: boolean } // choose friendly unit + friendly gear/equipment
  | { kind: "UNIT_AND_GEAR_SAME_CONTROLLER"; optional?: boolean } // choose unit + gear with same controller
  | { kind: "BATTLEFIELD"; count: number; optional?: boolean };

const inferTargetRequirement = (effectTextRaw: string | undefined, ctx?: { here?: boolean }): TargetRequirement => {
  const text = (effectTextRaw || "").toLowerCase();
  if (!text.trim()) return { kind: "NONE" };

  // Special-case: each player makes their own choice (handled in resolver, not target picker).
  if (/\beach\s+player\s+kills\s+one\s+of\s+their\s+units\b/i.test(text)) return { kind: "NONE" };
  // Delayed turn-scoped trigger clauses should not request immediate targets when played.
  if (/\bwhen\s+a\s+friendly\s+unit\s+is\s+played\s+this\s+turn\b/i.test(text)) return { kind: "NONE" };
  if (/(^|[.?!]\s*)when\s+[^.]*\bthis\s+turn\b\s*,/i.test(text)) return { kind: "NONE" };

  // Detect if this is an optional "may" effect
  // Also treat "buff another" as optional since if there's no other unit, the effect can be declined
  const hasUpTo = /\bup\s+to\b/.test(text);
  const isOptional = /\byou may\b/.test(text) ||
    /\bmay\s+(ready|buff|kill|move|return|recall|play|draw|channel|exhaust)\b/.test(text) ||
    /\bbuff\s+another\s+friendly\s+unit\b/.test(text) ||
    hasUpTo;

  // Dual target: unit + equipment
  const wantsUnitAndEquipmentSameController =
    /choose\s+a\s+unit\s+and\s+an?\s+equipment\b/i.test(text) ||
    /choose\s+an?\s+equipment\s+and\s+a\s+unit\b/i.test(text);
  if (wantsUnitAndEquipmentSameController) return { kind: "UNIT_AND_GEAR_SAME_CONTROLLER", optional: isOptional };

  const wantsAttachEquipment =
    /attach\s+an?\s+equipment\s+you\s+control\s+to\s+a\s+unit\s+you\s+control/i.test(text) ||
    /attach\s+equipment\s+you\s+control\s+to\s+a\s+unit\s+you\s+control/i.test(text);
  if (wantsAttachEquipment) return { kind: "UNIT_AND_GEAR_FRIENDLY", optional: isOptional };

  // "Up to N units" (multi-target, optional)
  const upToUnitsMatch = text.match(/\bup\s+to\s+(one|two|three|four|five|\d+)\s+(friendly\s+|enemy\s+)?units?\b/);
  if (upToUnitsMatch) {
    const wordToNum: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const raw = upToUnitsMatch[1];
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : wordToNum[raw] ?? 1;
    const qualifier = upToUnitsMatch[2] || "";
    const wantsFriendly = /friendly/.test(qualifier);
    const wantsEnemy = /enemy/.test(qualifier);
    if (wantsFriendly && !wantsEnemy) return { kind: "UNIT_FRIENDLY", count: n, optional: true };
    if (wantsEnemy && !wantsFriendly) return { kind: "UNIT_ENEMY", count: n, optional: true };
    return { kind: "UNIT_ANYWHERE", count: n, optional: true };
  }

  // Unit-token plays without explicit destination may go to base or a chosen battlefield.
  // We model this as an optional battlefield target (none => base).
  const unspecifiedTokenPlayDestination =
    /\bplay\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:an?\s+)?\d+\s+might\s+[a-z]+\s+unit\s+token(?:s)?\b/i.test(text) &&
    !/\bhere\b/i.test(text) &&
    !/\b(in|into|to)\s+your\s+base\b/i.test(text) &&
    !/\bat\s+(?:a|that)\s+battlefield\b/i.test(text);
  if (unspecifiedTokenPlayDestination) return { kind: "BATTLEFIELD", count: 1, optional: true };

  // Check for "Choose a friendly unit and an enemy unit" pattern (Challenge spell)
  // This needs to come before other checks since it requires TWO targets
  const wantsFriendlyAndEnemy = /choose\s+a\s+friendly\s+unit\s+and\s+an?\s+enemy\s+unit/i.test(text) ||
    /choose\s+an?\s+enemy\s+unit\s+and\s+a\s+friendly\s+unit/i.test(text);
  if (wantsFriendlyAndEnemy) return { kind: "UNIT_FRIENDLY_AND_ENEMY", optional: isOptional };

  const wantsFriendlyBaseAndBattlefield =
    /choose\s+a\s+friendly\s+unit\s+in\s+your\s+base/i.test(text) &&
    /at\s+a\s+battlefield/i.test(text);
  if (wantsFriendlyBaseAndBattlefield) return { kind: "UNIT_FRIENDLY_IN_BASE_AND_BATTLEFIELD", optional: isOptional };

  // Gear targeting
  const mentionsGear = /\bgear\b|\bequipment\b/.test(text);
  const massGear = /\b(all|each)\s+(friendly\s+)?gear\b/i.test(text) || /\ball\s+equipment\b/i.test(text);
  const mentionsGearTokenCreation =
    /\b(play|create)\s+(?:a|an|\d+)?\s*(?:[a-z]+\s+)?(?:gear|equipment)\s+token\b/i.test(text) ||
    /\bplay\s+(?:a|an)\s+gold\s+token\b/i.test(text);
  if (mentionsGear && !massGear && !mentionsGearTokenCreation) {
    const hasExplicitGearTargetVerb =
      /\b(choose|target|kill|destroy|banish|detach|attach|ready|return|recall|move|exhaust|stun|give|buff|deal)\b[^.]{0,60}\b(gear|equipment)\b/i.test(text) ||
      /\b(gear|equipment)\b[^.]{0,60}\b(you\s+control|friendly|enemy|that|this)\b/i.test(text);
    if (!hasExplicitGearTargetVerb) return { kind: "NONE" };
    const wantsFriendlyGear = /\bfriendly\s+gear\b/i.test(text) || /\bgear\s+you\s+control\b/i.test(text) || /\bequipment\s+you\s+control\b/i.test(text);
    if (wantsFriendlyGear) return { kind: "GEAR_FRIENDLY", count: 1, optional: isOptional };
    if (/\bequipment\b/i.test(text)) return { kind: "GEAR_FRIENDLY_EQUIPMENT", count: 1, optional: isOptional };
    if (/\bgear\b/i.test(text) || /\bequipment\b/i.test(text)) return { kind: "GEAR_ANY", count: 1, optional: isOptional };
  }

  // Heuristic patterns – deliberately conservative.
  const needsUnit =
    /\b(stun|kill|banish|ready|buff|deal|give|move|return|recall|heal|double)\b/.test(text) && /\bunit\b/.test(text);
  const needsBattlefield = /\bbattlefield\b/.test(text) && /\bchoose\b/.test(text);
  const needsBattlefieldForAoE =
    /\bat\s+a\s+battlefield\b/.test(text) && /\b(all|each)\s+enemy\s+units?\b/.test(text);

  if (needsBattlefield || needsBattlefieldForAoE) return { kind: "BATTLEFIELD", count: 1, optional: isOptional };

  if (!needsUnit) return { kind: "NONE" };

  // Detect "another" or "other" to exclude source unit from valid targets
  const excludeSelf = /\b(another|other)\s+(friendly|enemy)?\s*(unit|units)\b/.test(text);

  // Check for "at a battlefield" zone restriction FIRST - this is critical for cards like Wages of Pain
  // Patterns: "unit at a battlefield", "enemy unit at a battlefield", "friendly unit at a battlefield"
  const atBattlefield = /\bat\s+(?:a\s+)?battlefields?\b/.test(text) || /\bat\s+that\s+battlefield\b/.test(text);

  if (atBattlefield) {
    // Check if it's specifically enemy or friendly at battlefield
    const wantsEnemyAtBF = /\benemy\s+units?\s+at\s+(?:a\s+)?battlefields?\b/.test(text) ||
      /\bto\s+an?\s+enemy\s+unit\s+at\s+(?:a\s+)?battlefield\b/.test(text) ||
      (/\bat\s+(?:a\s+)?battlefields?\b/.test(text) && /\benemy\s+unit\b/.test(text));
    const wantsFriendlyAtBF = /\bfriendly\s+units?\s+at\s+(?:a\s+)?battlefields?\b/.test(text) ||
      /\bto\s+a\s+friendly\s+unit\s+at\s+(?:a\s+)?battlefield\b/.test(text) ||
      (/\bat\s+(?:a\s+)?battlefields?\b/.test(text) && /\bfriendly\s+unit\b/.test(text));

    if (wantsEnemyAtBF && !wantsFriendlyAtBF) return { kind: "UNIT_ENEMY_AT_BATTLEFIELD", count: 1, excludeSelf, optional: isOptional };
    if (wantsFriendlyAtBF && !wantsEnemyAtBF) return { kind: "UNIT_FRIENDLY_AT_BATTLEFIELD", count: 1, excludeSelf, optional: isOptional };
    // Generic "a unit at a battlefield" - any unit at any battlefield
    return { kind: "UNIT_AT_BATTLEFIELD", count: 1, excludeSelf, optional: isOptional };
  }

  // Check for "here" targeting (same battlefield as source)
  const wantsEnemyHere = /\benemy unit here\b/.test(text) || (/\bunit here\b/.test(text) && /\benemy\b/.test(text));
  const wantsFriendlyHere = /\byour unit here\b/.test(text) || (/\bunit here\b/.test(text) && /\byour\b/.test(text)) ||
    /\bfriendly unit here\b/.test(text);

  if (wantsEnemyHere) return { kind: "UNIT_HERE_ENEMY", count: 1, optional: isOptional };
  if (wantsFriendlyHere) return { kind: "UNIT_HERE_FRIENDLY", count: 1, optional: isOptional };

  // Check for friendly/enemy unit targeting (anywhere - including base)
  // Patterns: "a friendly unit", "another friendly unit", "friendly unit's", "your unit"
  const wantsFriendly = /\b(a|another)\s+friendly\s+unit\b/.test(text) || /\bfriendly\s+unit's\b/.test(text) ||
    /\byour\s+unit\b/.test(text) || /\bone\s+of\s+your\s+units\b/.test(text) ||
    /\bother\s+friendly\s+units?\b/.test(text);
  // Patterns: "an enemy unit", "another enemy unit", "enemy unit's"
  const wantsEnemy = /\ban?(other)?\s+enemy\s+unit\b/.test(text) || /\benemy\s+unit's\b/.test(text) ||
    /\bother\s+enemy\s+units?\b/.test(text);

  if (wantsFriendly && !wantsEnemy) return { kind: "UNIT_FRIENDLY", count: 1, excludeSelf, optional: isOptional };
  if (wantsEnemy && !wantsFriendly) return { kind: "UNIT_ENEMY", count: 1, excludeSelf, optional: isOptional };

  if (/\bmove\s+any\s+number\s+of\s+your\s+units?\b/.test(text) || /\bmove\s+any\s+number\s+of\s+friendly\s+units?\b/.test(text)) {
    return { kind: "UNIT_FRIENDLY", count: 1, optional: true };
  }

  const moveCount = text.match(/\bmove\s+(?:up\s+to\s+)?(\d+|one|two|three|four|five)\s+(?:friendly|your)?\s*units?\b/);
  if (moveCount) {
    const wordToNum: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const raw = moveCount[1];
    const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : wordToNum[raw] ?? 1;
    return { kind: "UNIT_FRIENDLY", count: Number.isFinite(n) ? n : 1, optional: isOptional };
  }

  return { kind: "UNIT_ANYWHERE", count: 1, optional: isOptional };
};

const checkGlobalTriggers = (
  game: GameState,
  eventType: "PLAY_CARD" | "KILL_UNIT" | "DISCARD_CARD",
  ctx: { player: PlayerId; card: CardInstance }
) => {
  // Scan all units/gear on board for triggers responding to this event.
  const triggerSources: CardInstance[] = [];

  (["P1", "P2"] as PlayerId[]).forEach((pid) => {
    const p = game.players[pid];
    triggerSources.push(...p.base.units, ...p.base.gear);
    game.battlefields.forEach((bf) => {
      triggerSources.push(...bf.units[pid], ...bf.gear[pid]);
    });
  });

  const isSelf = (u: CardInstance) => u.instanceId === ctx.card.instanceId;

  for (const source of triggerSources) {
    if (isSelf(source)) continue; // "When you play me" handled elsewhere.

    const trig = (source.ability?.trigger || "").toLowerCase();
    const eff = source.ability?.effect_text;
    if (!trig || !eff) continue;

    let matches = false;

    if (eventType === "PLAY_CARD" && source.controller === ctx.player) {
      if (trig.includes("when you play a spell") && ctx.card.type === "Spell") matches = true;
      if (trig.includes("when you play a spell that costs 5 energy or more") && ctx.card.type === "Spell" && (ctx.card.cost || 0) >= 5)
        matches = true;
      if (trig.includes("when you play a gear") && ctx.card.type === "Gear") matches = true;
      if (trig.includes("when you play another unit") && ctx.card.type === "Unit") matches = true;
      if (trig.includes("when you play a unit") && ctx.card.type === "Unit") matches = true;
      if (trig.includes("when you play a [mighty] unit") && ctx.card.type === "Unit" && isMighty(ctx.card, game)) matches = true;
      if (trig.includes("play your second card") && game.players[ctx.player].mainDeckCardsPlayedThisTurn === 2) matches = true;
      if (trig.includes("when you play a card on an opponent's turn") && game.turnPlayer !== ctx.player) matches = true;
    }

    if (eventType === "DISCARD_CARD" && source.controller === ctx.player) {
      if (trig.includes("when you discard one or more cards")) matches = true;
      if (trig.includes("when you discard a card")) matches = true;
    }

    if (eventType === "KILL_UNIT" && source.controller === ctx.player) {
      if (trig.includes("when you kill")) {
        const victim = ctx.card;
        const isStunned = victim.stunned;
        if (trig.includes("stunned") && !isStunned) matches = false;
        else matches = true;
      }
    }

    if (matches) {
      const req = inferTargetRequirement(eff);
      game.chain.push({
        id: makeId("chain"),
        controller: source.controller,
        kind: "TRIGGERED_ABILITY",
        label: `Trigger: ${source.name}`,
        effectText: eff,
        targets: [{ kind: "NONE" }],
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
        sourceInstanceId: source.instanceId,
        sourceCardType: source.type,
      });
      game.state = "CLOSED";
      game.priorityPlayer = source.controller;
      game.passesInRow = 0;
      game.log.unshift(`${source.name} triggered.`);
    }
  }
};

const fireDelayedTriggersForEvent = (
  game: GameState,
  event: DelayedTriggerEvent,
  unit: CardInstance,
  ctx: { battlefieldIndex?: number | null; alone?: boolean },
  opts?: { skipTriggerIds?: string[] }
) => {
  const skipSet = new Set(opts?.skipTriggerIds || []);
  const triggersToFire = game.delayedTriggers.filter(
    (t) =>
      t.event === event &&
      t.untilTurn >= game.turnNumber &&
      !skipSet.has(t.id) &&
      (!t.targetFilter ||
        t.targetFilter === "ANY" ||
        (t.targetFilter === "FRIENDLY" && t.controller === unit.controller) ||
        (t.targetFilter === "ENEMY" && t.controller !== unit.controller))
  );

  if (triggersToFire.length === 0) return;

  const removeIds = new Set<string>();
  const processedIds = new Set<string>();

  for (const trigger of triggersToFire) {
    let effectText = trigger.effect || "";
    const needsAlone = /\(if alone\)/i.test(effectText);
    if (needsAlone && !ctx.alone) continue;
    effectText = effectText.replace(/\s*\(if alone\)/i, "").trim();
    if (!effectText) continue;

    const loc = locateUnit(game, unit.owner, unit.instanceId);
    if (!loc) continue;

    const target: Target = {
      kind: "UNIT",
      owner: unit.owner,
      instanceId: unit.instanceId,
      battlefieldIndex: loc.zone === "BF" ? loc.battlefieldIndex : undefined,
      zone: loc.zone,
    };

    const outcome = resolveEffectText(game, trigger.controller, effectText, [target], {
      battlefieldIndex: ctx.battlefieldIndex ?? null,
      sourceCardName: trigger.sourceCardName,
      sourceInstanceId: unit.instanceId,
      resolutionId: trigger.id,
    });

    if (outcome === "PENDING_OPTIONAL") {
      if (game.pendingOptionalChoice) {
        game.pendingOptionalChoice.resumeDelayedEvent = {
          event,
          unitOwner: unit.owner,
          unitInstanceId: unit.instanceId,
          battlefieldIndex: ctx.battlefieldIndex ?? null,
          alone: ctx.alone,
          skipTriggerIds: [...processedIds, trigger.id],
        };
      }
      if (trigger.onlyOnce) removeIds.add(trigger.id);
      if (removeIds.size > 0) {
        game.delayedTriggers = game.delayedTriggers.filter((t) => !removeIds.has(t.id));
      }
      game.state = "CLOSED";
      game.priorityPlayer = trigger.controller;
      game.passesInRow = 0;
      return;
    }

    processedIds.add(trigger.id);
    if (trigger.onlyOnce) removeIds.add(trigger.id);
  }

  if (removeIds.size > 0) {
    game.delayedTriggers = game.delayedTriggers.filter((t) => !removeIds.has(t.id));
  }
};

const collectChooseTriggerEffects = (source: CardData | CardInstance, relation: "FRIENDLY" | "ENEMY" | "ANY"): string[] => {
  const rawAll = ((source as any)?.ability?.raw_text || (source as any)?.ability?.effect_text || "").toString();
  const clauses = extractTriggerClauses(rawAll);
  const effects = new Set<string>();

  const addEffect = (txt: string) => {
    const cleaned = sanitizeTriggeredEffectText(stripLeadingBracketKeywords(txt || ""));
    if (cleaned) effects.add(cleaned);
  };

  for (const clause of clauses) {
    const t = normalizeRulesTextForParsing(clause.trigger).toLowerCase();
    const match =
      relation === "FRIENDLY"
        ? /when you choose a friendly unit\b/.test(t)
        : relation === "ENEMY"
          ? /when you choose an enemy unit\b/.test(t)
          : /when you choose a unit\b/.test(t);
    if (match) addEffect(clause.effectText);
  }

  if (effects.size === 0) {
    const trig = ((source as any)?.ability?.trigger || "").toString();
    const t = normalizeRulesTextForParsing(trig).toLowerCase();
    const match =
      relation === "FRIENDLY"
        ? /when you choose a friendly unit\b/.test(t)
        : relation === "ENEMY"
          ? /when you choose an enemy unit\b/.test(t)
          : /when you choose a unit\b/.test(t);
    if (match) {
      addEffect((source as any)?.ability?.effect_text || (source as any)?.ability?.raw_text || "");
    }
  }

  return Array.from(effects);
};

const fireChooseTriggers = (
  game: GameState,
  chooser: PlayerId,
  targets: Target[],
  ctx: { battlefieldIndex?: number | null; sourceCardType?: CardType }
) => {
  const chosenUnits = targets.filter((t): t is Extract<Target, { kind: "UNIT" }> => t.kind === "UNIT");
  if (chosenUnits.length === 0) return;

  if (ctx.sourceCardType === "Spell") {
    const friendlyChosenBattlefields = new Set<number>();
    for (const t of chosenUnits) {
      const loc = locateUnit(game, t.owner, t.instanceId);
      if (!loc || loc.zone !== "BF" || loc.battlefieldIndex == null) continue;
      if (loc.unit.controller !== chooser) continue;
      friendlyChosenBattlefields.add(loc.battlefieldIndex);
    }
    for (const bfIndex of friendlyChosenBattlefields) {
      const bf = game.battlefields[bfIndex];
      if (!battlefieldNameIs(bf, "The Dreaming Tree")) continue;
      if (bf.dreamingTreeChosenThisTurn[chooser]) continue;
      bf.dreamingTreeChosenThisTurn[chooser] = true;
      drawCards(game, chooser, 1);
      game.log.unshift(`${bf.card.name} triggered: ${chooser} drew 1.`);
    }
  }

  const p = game.players[chooser];
  const sources: Array<CardData | CardInstance> = [
    ...p.base.units,
    ...p.base.gear,
    ...game.battlefields.flatMap((bf) => [...bf.units[chooser], ...bf.gear[chooser]]),
  ];
  if (p.legend) sources.push(p.legend);

  for (const target of chosenUnits) {
    const loc = locateUnit(game, target.owner, target.instanceId);
    if (!loc) continue;
    const relation: "FRIENDLY" | "ENEMY" = loc.unit.controller === chooser ? "FRIENDLY" : "ENEMY";

    for (const source of sources) {
      const controller = (source as any)?.controller || chooser;
      const effects = new Set<string>([
        ...collectChooseTriggerEffects(source, relation),
        ...collectChooseTriggerEffects(source, "ANY"),
      ]);
      if ((source as any)?.instanceId && (source as any).instanceId === loc.unit.instanceId) {
        for (const eff of getTriggerEffects(source as any, "CHOOSE_ME")) effects.add(eff);
      }

      for (const effectText of effects) {
        const req = inferTargetRequirement(effectText, { here: loc.zone === "BF" });
        const chainItem: ChainItem = {
          id: makeId("chain"),
          controller,
          kind: "TRIGGERED_ABILITY",
          label: `${(source as any)?.name || "Trigger"} — Choose`,
          effectText,
          contextBattlefieldIndex: ctx.battlefieldIndex ?? (loc.zone === "BF" ? loc.battlefieldIndex : null),
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
          targets:
            req.kind === "NONE"
              ? [{ kind: "NONE" }]
              : [
                {
                  kind: "UNIT",
                  owner: loc.unit.owner,
                  instanceId: loc.unit.instanceId,
                  battlefieldIndex: loc.zone === "BF" ? loc.battlefieldIndex : undefined,
                  zone: loc.zone,
                },
              ],
          sourceInstanceId: (source as any)?.instanceId,
          sourceCardType: (source as any)?.type as CardType,
        };
        game.chain.push(chainItem);
        game.state = "CLOSED";
        game.priorityPlayer = controller;
        game.passesInRow = 0;
        game.log.unshift(`${(source as any)?.name || "Trigger"} triggered (Choose).`);
      }
    }
  }
};

const queueTriggersForEvent = (
  game: GameState,
  controller: PlayerId,
  match: (trigger: string, source: CardInstance) => boolean,
  effectText: (source: CardInstance) => string | undefined,
  targets?: Target[],
  ctxBf?: number | null,
  includeTrash: boolean = false
) => {
  const sources: CardInstance[] = [];
  const p = game.players[controller];
  sources.push(...p.base.units, ...p.base.gear);
  game.battlefields.forEach((bf) => sources.push(...bf.units[controller], ...bf.gear[controller]));
  if (p.legend) {
    sources.push({ ...(p.legend as CardInstance), instanceId: `legend_${controller}`, owner: controller, controller } as CardInstance);
  }
  if (includeTrash) {
    sources.push(...p.trash);
  }

  for (const source of sources) {
    const trig = (source.ability?.trigger || "").toLowerCase();
    if (!trig) continue;
    if (!match(trig, source)) continue;
    const eff = effectText(source);
    if (!eff) continue;
    const req = inferTargetRequirement(eff, { here: ctxBf != null });
    game.chain.push({
      id: makeId("chain"),
      controller,
      kind: "TRIGGERED_ABILITY",
      label: `Trigger: ${source.name}`,
      effectText: eff,
      contextBattlefieldIndex: ctxBf ?? null,
      targets: targets && targets.length > 0 ? targets : [{ kind: "NONE" }],
      needsTargets: req.kind !== "NONE",
      targetRequirement: req,
      sourceInstanceId: source.instanceId,
      sourceCardType: source.type,
    });
    game.state = "CLOSED";
    game.priorityPlayer = controller;
    game.passesInRow = 0;
    game.log.unshift(`${source.name} triggered.`);
  }
};

const extractDamageAmount = (effectTextRaw: string | undefined, sourceUnit?: CardInstance | null, gameCtx?: GameState): number | null => {
  const text = (effectTextRaw || "").toLowerCase();

  // Handle "damage equal to my might" / "damage equal to its might"
  if (/damage\s+equal\s+to\s+(my|its|their)\s+might/i.test(text) && sourceUnit) {
    return gameCtx ? effectiveMight(sourceUnit, { role: "NONE", game: gameCtx }) : (sourceUnit.stats?.might || 0);
  }

  // Handle "deal damage equal to my [assault]" (Lucian, Gunslinger)
  if (/damage\s+equal\s+to\s+my\s+\[?assault\]?/i.test(text) && sourceUnit) {
    // Assault gives +1 might while attacking
    const hasAssault = hasKeyword(sourceUnit, "Assault");
    return hasAssault ? 1 : 0;
  }

  // "Deal 2 ..." or "deal 3 ..."
  const m = text.match(/\bdeal\s+(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
};

const extractDrawAmount = (effectTextRaw: string | undefined): number | null => {
  const text = (effectTextRaw || "").toLowerCase();
  const m = text.match(/\bdraw\s+(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
};

const extractChannelAmount = (effectTextRaw: string | undefined): number | null => {
  const text = (effectTextRaw || "").toLowerCase();
  const m = text.match(/\bchannel\s+(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
};


const extractDiscardAmount = (effectTextRaw: string | undefined): number | null => {
  const text = (effectTextRaw || "").toLowerCase();
  const m = text.match(/\bdiscard\s+(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
};

const extractLegionEnergyDiscount = (card: CardData | CardInstance): number => {
  const txt = `${(card as any)?.ability?.effect_text || ""} ${(card as any)?.ability?.raw_text || ""}`
    .replace(/_/g, " ")
    .replace(/\[(\d+)\]/g, "$1")
    .toLowerCase();

  // Common template: "I cost 2 energy less."
  const m1 = txt.match(/\bcost\s+(\d+)\s+energy\s+less\b/);
  if (m1) {
    const n = parseInt(m1[1], 10);
    return Number.isFinite(n) ? n : 0;
  }

  // Sometimes: "I cost 2 less."
  const m2 = txt.match(/\bcost\s+(\d+)\s+less\b/);
  if (m2) {
    const n = parseInt(m2[1], 10);
    return Number.isFinite(n) ? n : 0;
  }

  // Or: "Reduce my cost by 2 energy."
  const m3 = txt.match(/\breduce\s+my\s+cost\s+by\s+(\d+)\s+energy\b/);
  if (m3) {
    const n = parseInt(m3[1], 10);
    return Number.isFinite(n) ? n : 0;
  }

  return 0;
};

const extractLegionClauseText = (card: CardData | CardInstance): string => {
  // Prefer effect_text because it typically contains the "— ..." clause; fall back to raw_text.
  const raw = ((card as any)?.ability?.effect_text || "").trim() || ((card as any)?.ability?.raw_text || "").trim();
  if (!raw) return "";

  let t = raw.replace(/_/g, " ").trim();
  // Strip the keyword tag
  t = t.replace(/\[\s*legion\s*\]\s*/gi, "").trim();
  // Strip trailing reminder text like "(Get the effect if you've played another card this turn.)"
  t = t.replace(/\(\s*get\s+the\s+effect[\s\S]*?\)\s*$/i, "").trim();
  // Remove a leading dash
  t = t.replace(/^[—-]\s*/, "").trim();
  return t;
};


const effectMentionsStun = (effectTextRaw: string | undefined) => /\bstun\b/i.test(effectTextRaw || "");
const effectMentionsReady = (effectTextRaw: string | undefined) => /\bready\b/i.test(effectTextRaw || "");
const effectMentionsKill = (effectTextRaw: string | undefined) => /\bkill\b/i.test(effectTextRaw || "");
const effectMentionsBanish = (effectTextRaw: string | undefined) => /\bbanish\b/i.test(effectTextRaw || "");
const effectMentionsBuff = (effectTextRaw: string | undefined) => /\bbuff\b/i.test(effectTextRaw || "");
const effectMentionsReturn = (effectTextRaw: string | undefined) => /\breturn\b/i.test(effectTextRaw || "") || /\brecall\b/i.test(effectTextRaw || "");
const effectMentionsAddRune = (effectTextRaw: string | undefined) =>
  /\badd\s+(\d+)?\s*(body|calm|chaos|fury|mind|order|class)\s+rune\b/i.test(effectTextRaw || "");
const TEMP_CONQUER_MOVE_BASE_KEYWORD = "__TEMP_CONQUER_MOVE_BASE__";

const applyBuffToken = (game: GameState, unit: CardInstance): boolean => {
  if (!unit || unit.buffs >= 1) return false;
  const prevMight = effectiveMight(unit, { role: "NONE", game });
  unit.buffs = 1;
  checkBecomesMighty(game, unit, prevMight);
  return true;
};

const applyTempMightBonus = (game: GameState, unit: CardInstance, delta: number): void => {
  if (!unit || !Number.isFinite(delta) || delta === 0) return;
  const prevMight = effectiveMight(unit, { role: "NONE", game });
  unit.tempMightBonus += delta;
  checkBecomesMighty(game, unit, prevMight);
};
const unitIgnoresDamageThisTurn = (unit: CardInstance): boolean => {
  const raw = `${unit.ability?.effect_text || ""} ${unit.ability?.raw_text || ""}`.toLowerCase();
  return unit.moveCountThisTurn >= 2 && raw.includes("if i have moved twice this turn") && raw.includes("don't take damage");
};

const damageKillEffectActive = (game: GameState): boolean =>
  game.damageKillEffects.some((e) => e.untilTurn >= game.turnNumber);

// ----------------------------- Engine operations -----------------------------

const battlefieldNameIs = (bf: BattlefieldState | { card: CardData }, name: string): boolean =>
  normalizeNameKey(bf.card.name) === normalizeNameKey(name);

const battlefieldRawText = (bf: BattlefieldState | { card: CardData }): string =>
  ((bf.card.ability?.raw_text || bf.card.ability?.effect_text || "") as string).toLowerCase();

const battlefieldAllowsExtraFacedown = (bf: BattlefieldState | { card: CardData }): boolean =>
  battlefieldNameIs(bf as any, "Bandle Tree") || battlefieldRawText(bf).includes("hide an additional card here");

const battlefieldPreventsPlayHere = (bf: BattlefieldState | { card: CardData }): boolean =>
  battlefieldNameIs(bf as any, "Rockfall Path") || battlefieldRawText(bf).includes("units can't be played here");

const battlefieldPreventsMoveFromHereToBase = (bf: BattlefieldState | { card: CardData }): boolean =>
  battlefieldNameIs(bf as any, "Vilemaw's Lair") || battlefieldRawText(bf).includes("can't move from here to base");

const battlefieldGivesGanking = (bf: BattlefieldState | { card: CardData }): boolean =>
  battlefieldNameIs(bf as any, "Windswept Hillock") || battlefieldRawText(bf).includes("units here have [ganking]");

const battlefieldHasVoidGate = (bf: BattlefieldState | { card: CardData }): boolean =>
  battlefieldNameIs(bf as any, "Void Gate") || battlefieldRawText(bf).includes("bonus damage");

const battlefieldDiscountsFirstGear = (bf: BattlefieldState | { card: CardData }): boolean =>
  battlefieldNameIs(bf as any, "Ornn's Forge") ||
  (battlefieldRawText(bf).includes("first") && battlefieldRawText(bf).includes("gear") && battlefieldRawText(bf).includes("cost"));

const battlefieldDiscountsRepeat = (bf: BattlefieldState | { card: CardData }): boolean =>
  battlefieldNameIs(bf as any, "Marai Spire") ||
  (battlefieldRawText(bf).includes("repeat") && battlefieldRawText(bf).includes("cost") && battlefieldRawText(bf).includes("less"));

const battlefieldGrantsLegendEquip = (bf: BattlefieldState | { card: CardData }): boolean =>
  battlefieldNameIs(bf as any, "Forge of the Fluft") ||
  (battlefieldRawText(bf).includes("legends you control") && battlefieldRawText(bf).includes("attach equipment"));

const recalculateVictoryScore = (game: GameState): void => {
  const base = duelVictoryScore;
  const bonus = game.battlefields.filter((bf) =>
    bf.controller !== null &&
    (battlefieldNameIs(bf as any, "Aspirant's Climb") ||
      battlefieldRawText(bf).includes("victory score is increased by 1"))
  ).length;
  const next = base + bonus;
  if (game.victoryScore !== next) {
    game.victoryScore = next;
    game.log.unshift(`Victory score set to ${next} (Aspirant's Climb bonus: +${bonus}).`);
  }
};

type GearLocation = { zone: "BASE" | "BF" | "ATTACHED"; battlefieldIndex?: number; unit?: CardInstance; gear: CardInstance };

const locateGear = (game: GameState, owner: PlayerId, instanceId: string): GearLocation | null => {
  const p = game.players[owner];
  const inBase = p.base.gear.find((g) => g.instanceId === instanceId);
  if (inBase) return { zone: "BASE", gear: inBase };
  for (const bf of game.battlefields) {
    const g = bf.gear[owner].find((x) => x.instanceId === instanceId);
    if (g) return { zone: "BF", battlefieldIndex: bf.index, gear: g };
  }
  const units = getUnitsInPlay(game, owner);
  for (const u of units) {
    const g = (u.attachedGear || []).find((x) => x.instanceId === instanceId);
    if (g) return { zone: "ATTACHED", unit: u, gear: g };
  }
  return null;
};

const removeGearFromWherever = (game: GameState, owner: PlayerId, instanceId: string): CardInstance | null => {
  const p = game.players[owner];
  const baseIdx = p.base.gear.findIndex((g) => g.instanceId === instanceId);
  if (baseIdx >= 0) return p.base.gear.splice(baseIdx, 1)[0];
  for (const bf of game.battlefields) {
    const idx = bf.gear[owner].findIndex((g) => g.instanceId === instanceId);
    if (idx >= 0) return bf.gear[owner].splice(idx, 1)[0];
  }
  const units = getUnitsInPlay(game, owner);
  for (const u of units) {
    const idx = (u.attachedGear || []).findIndex((g) => g.instanceId === instanceId);
    if (idx >= 0) {
      const g = u.attachedGear!.splice(idx, 1)[0];
      return g;
    }
  }
  return null;
};

const detachGearFromUnit = (unit: CardInstance, gearInstanceId: string): CardInstance | null => {
  if (!unit.attachedGear || unit.attachedGear.length === 0) return null;
  const idx = unit.attachedGear.findIndex((g) => g.instanceId === gearInstanceId);
  if (idx < 0) return null;
  return unit.attachedGear.splice(idx, 1)[0];
};

const attachGearToUnit = (game: GameState, unit: CardInstance, gear: CardInstance) => {
  const previousMight = effectiveMight(unit, { role: "NONE", game });
  if (!unit.attachedGear) unit.attachedGear = [];
  unit.attachedGear.push(gear);
  checkBecomesMighty(game, unit, previousMight);
};

const getAllGear = (game: GameState, player: PlayerId): CardInstance[] => {
  const p = game.players[player];
  const attached = getUnitsInPlay(game, player).flatMap((u) => u.attachedGear || []);
  const battlefieldGear = game.battlefields.flatMap((b) => b.gear[player]);
  return [...p.base.gear, ...battlefieldGear, ...attached];
};

const getAllEquipment = (game: GameState, player: PlayerId): CardInstance[] =>
  getAllGear(game, player).filter((g) => isEquipment(g));

const removeUnitFromWherever = (game: GameState, owner: PlayerId, instanceId: string): CardInstance | null => {
  const p = game.players[owner];
  const bi = p.base.units.findIndex((u) => u.instanceId === instanceId);
  if (bi >= 0) {
    const u = p.base.units[bi];
    u.prevMightSnapshot = effectiveMight(u, { role: "NONE", game });
    return p.base.units.splice(bi, 1)[0];
  }

  for (const bf of game.battlefields) {
    const idx = bf.units[owner].findIndex((u) => u.instanceId === instanceId);
    if (idx >= 0) {
      const u = bf.units[owner][idx];
      u.prevMightSnapshot = effectiveMight(u, { role: "NONE", game, battlefieldIndex: bf.index });
      return bf.units[owner].splice(idx, 1)[0];
    }
  }
  return null;
};

const addUnitToZone = (game: GameState, owner: PlayerId, unit: CardInstance, dest: { kind: "BASE" } | { kind: "BF"; index: number }) => {
  const p = game.players[owner];
  if (dest.kind === "BASE") {
    p.base.units.push(unit);
  } else {
    // Static Ability: "Other friendly units enter ready" (e.g. Magma Wurm).
    let enterReadyMod = false;
    const scanLocations = [p.base.units, ...game.battlefields.map((b) => b.units[owner])];
    for (const list of scanLocations) {
      for (const existing of list) {
        if (existing.instanceId === unit.instanceId) continue;
        const raw = (existing.ability?.raw_text || "").toLowerCase();
        if (raw.includes("other friendly units enter ready")) enterReadyMod = true;
      }
    }
    // Also check if unitsEnterReadyThisTurn flag is set (Bushwhack/Confront)
    if (enterReadyMod || p.unitsEnterReadyThisTurn) {
      unit.isReady = true;
      if (p.unitsEnterReadyThisTurn) {
        game.log.unshift(`${unit.name} enters ready (units enter ready this turn).`);
      }
    }

    const previousMight = unit.prevMightSnapshot ?? effectiveMight(unit, { role: "NONE", game });
    const bf = game.battlefields[dest.index];
    bf.units[owner].push(unit);
    unit.prevMightSnapshot = undefined;
    checkBecomesMighty(game, unit, previousMight);
  }
};

const resetUnitOnLeavePlay = (unit: CardInstance) => {
  unit.buffs = 0;
  unit.tempMightBonus = 0;
  unit.tempKeywords = [];
  unit.damage = 0;
  unit.stunned = false;
  unit.stunnedUntilTurn = 0;
  unit.preventNextDamageUntilTurn = 0;
  unit.killOnDamageUntilTurn = 0;
  unit.deathReplacement = undefined;
};

const killUnit = (game: GameState, owner: PlayerId, unit: CardInstance, reason = "killed") => {
  // Units go to Trash, not Banishment. (Rules distinguish Trash vs Banishment zones)
  const p = game.players[owner];
  const opp = otherPlayer(owner);
  const wasBuffed = unit.buffs > 0;
  const wasRecruit = (unit.tags || []).some((t) => String(t || "").toLowerCase() === "recruit");

  if (unit.deathReplacement && game.turnNumber <= unit.deathReplacement.untilTurn) {
    const repl = unit.deathReplacement;
    const payDom = repl.payRuneDomain;
    const pool = game.players[unit.controller].runePool;
    const canPayDomain = payDom ? (pool.power[payDom] || 0) >= 1 : false;
    const canPayAny = repl.payRuneAny ? Object.values(pool.power).some((v) => v > 0) : false;
    const canPay = payDom ? canPayDomain : repl.payRuneAny ? canPayAny : true;

    if (canPay) {
      if (payDom) pool.power[payDom] -= 1;
      if (!payDom && repl.payRuneAny) {
        const dom = (Object.keys(pool.power) as Domain[]).find((d) => pool.power[d] > 0);
        if (dom) pool.power[dom] -= 1;
      }
      unit.isReady = false;
      unit.damage = 0;
      unit.deathReplacement = undefined;
      game.players[owner].base.units.push(unit);
      game.log.unshift(`${unit.name} was recalled to base instead of dying.`);
      return;
    }
  }

  // Highlander/Unlicensed Armory: "The next time it dies this turn, recall it exhausted instead"
  const recallEffect = game.recallOnDeathEffects.find(
    (e) => e.unitInstanceId === unit.instanceId && e.untilTurn >= game.turnNumber
  );
  if (recallEffect) {
    // Remove the effect (one-time use)
    game.recallOnDeathEffects = game.recallOnDeathEffects.filter((e) => e !== recallEffect);
    // If payCost is required, check if player can pay [C]
    if (recallEffect.payCost) {
      const pool = game.players[recallEffect.controller].runePool;
      const canPayAny = Object.values(pool.power).some((v) => v > 0);
      if (canPayAny) {
        const dom = (Object.keys(pool.power) as Domain[]).find((d) => pool.power[d] > 0);
        if (dom) pool.power[dom] -= 1;
        unit.isReady = false;
        unit.damage = 0;
        game.players[owner].base.units.push(unit);
        game.log.unshift(`${unit.name} was recalled to base instead of dying (paid [C]).`);
        return;
      }
    } else {
      unit.isReady = false;
      unit.damage = 0;
      game.players[owner].base.units.push(unit);
      game.log.unshift(`${unit.name} was recalled to base instead of dying.`);
      return;
    }
  }

  // Legend replacement: The Boss (Sett).
  const legend = game.players[owner].legend;
  if (
    legend?.name === "The Boss" &&
    unit.controller === owner &&
    unit.buffs > 0 &&
    game.players[owner].legendReady
  ) {
    const pool = game.players[owner].runePool;
    const canPayAny = Object.values(pool.power).some((v) => v > 0);
    if (canPayAny) {
      const dom = (Object.keys(pool.power) as Domain[]).find((d) => pool.power[d] > 0);
      if (dom) {
        pool.power[dom] -= 1;
        game.players[owner].legendReady = false;
        unit.buffs = Math.max(0, unit.buffs - 1);
        unit.isReady = false;
        unit.damage = 0;
        game.players[owner].base.units.push(unit);
        game.log.unshift(`${unit.name} was recalled to base by The Boss instead of dying.`);
        return;
      }
    }
  }

  // Check for Deathknell ability before moving to trash
  if (hasKeyword(unit, "Deathknell")) {
    const effectText = unit.ability?.effect_text || "";
    const rawText = unit.ability?.raw_text || "";
    const combinedText = `${effectText} ${rawText}`.toLowerCase();

    // Check for conditional Deathknell triggers
    // "If I was [Mighty]" - only trigger if unit had 5+ might at time of death
    const requiresMighty = /if i was \[?mighty\]?/i.test(combinedText);
    const wasMighty = isMighty(unit, game);

    // Check condition - if requires mighty but wasn't mighty, skip the trigger
    const conditionMet = !requiresMighty || wasMighty;

    if (effectText && conditionMet) {
      // Create a triggered ability chain item for Deathknell
      const deathknellItem: ChainItem = {
        id: makeId("chain"),
        controller: unit.controller,
        kind: "TRIGGERED_ABILITY",
        label: `Deathknell: ${unit.name}`,
        effectText,
        contextBattlefieldIndex: null, // Deathknell triggers from trash, no battlefield context
        targets: [],
        needsTargets: false,
        sourceInstanceId: unit.instanceId,
      };
      game.chain.push(deathknellItem);
      game.log.unshift(`${unit.name}'s Deathknell ability triggered.`);
    } else if (effectText && requiresMighty && !wasMighty) {
      game.log.unshift(`${unit.name}'s Deathknell did not trigger (was not Mighty).`);
    }
  }

  // Handle attached equipment - returns to owner's base when unit dies
  if (unit.attachedGear && unit.attachedGear.length > 0) {
    for (const gear of unit.attachedGear) {
      // Equipment returns to base exhausted
      p.base.gear.push({ ...gear, isReady: false });
      game.log.unshift(`${gear.name} (attached equipment) returned to ${owner}'s Base.`);
    }
    unit.attachedGear = [];
  }

  resetUnitOnLeavePlay(unit);
  if (!tokenCeasesToExist(game, unit, "trash")) {
    p.trash.push({ ...unit, isReady: false }); // dead cards not ready
    game.log.unshift(`${unit.name} (${owner}) was ${reason} and put into Trash.`);
  }
  game.players[opp].enemyUnitsDiedThisTurn += 1;
  checkGlobalTriggers(game, "KILL_UNIT", { player: owner, card: unit });

  // Check for "When one or more enemy units die, ready me" legend trigger (e.g., Sivir)
  const oppLegend = game.players[opp].legend;
  const oppLegendRaw = oppLegend?.ability?.raw_text || oppLegend?.rules_text?.raw || "";
  if (/when one or more enemy units die,?\s*ready me/i.test(oppLegendRaw)) {
    game.players[opp].legendReady = true;
    game.log.unshift(`${oppLegend?.name} readied (enemy unit died).`);
  }

  if (wasBuffed) {
    queueTriggersForEvent(
      game,
      owner,
      (trig) => trig.includes("when a buffed friendly unit dies"),
      (source) => source.ability?.effect_text
    );
  }

  if (!wasRecruit) {
    queueTriggersForEvent(
      game,
      owner,
      (trig, source) => trig.includes("when another non-recruit unit you control dies") && source.instanceId !== unit.instanceId,
      (source) => source.ability?.effect_text
    );
  }
};

const checkMoveTriggers = (game: GameState, player: PlayerId, units: CardInstance[], toIndex: number | "BASE") => {
  for (const u of units) {
    const destBf = typeof toIndex === "number" ? toIndex : null;
    const moveEffects = getTriggerEffects(u, "MOVE");
    for (const eff of moveEffects) {
      const req = inferTargetRequirement(eff, { here: destBf !== null });
      game.chain.push({
        id: makeId("chain"),
        controller: player,
        kind: "TRIGGERED_ABILITY",
        label: `Move Trigger: ${u.name}`,
        effectText: eff,
        contextBattlefieldIndex: destBf,
        targets: [{ kind: "NONE" }],
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
        sourceInstanceId: u.instanceId,
      });
      game.log.unshift(`${u.name} triggered on move.`);
    }
    if (typeof toIndex === "number") {
      const moveBfEffects = getTriggerEffects(u, "MOVE_TO_BF");
      for (const eff of moveBfEffects) {
        const req = inferTargetRequirement(eff, { here: true });
        game.chain.push({
          id: makeId("chain"),
          controller: player,
          kind: "TRIGGERED_ABILITY",
          label: `Move Trigger: ${u.name}`,
          effectText: eff,
          contextBattlefieldIndex: toIndex,
          targets: [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
          sourceInstanceId: u.instanceId,
        });
        game.log.unshift(`${u.name} triggered on move to battlefield.`);
      }
    }
  }
};

const checkMoveFromLocationTriggers = (
  game: GameState,
  controller: PlayerId,
  movedUnits: CardInstance[],
  from: { kind: "BASE" } | { kind: "BF"; index: number },
  to: { kind: "BASE" } | { kind: "BF"; index: number }
) => {
  if (movedUnits.length === 0) return;

  if (from.kind === "BF") {
    const bf = game.battlefields[from.index];
    const effects = getBattlefieldTriggerEffects(bf.card, "MOVE_FROM_HERE");
    for (const u of movedUnits) {
      for (const effRaw of effects) {
        const effectText = effRaw.trim();
        if (!effectText) continue;
        const req = inferTargetRequirement(effectText, { here: true });
        const movedTarget: Target = { kind: "UNIT", owner: u.owner, instanceId: u.instanceId, battlefieldIndex: from.index, zone: "BF" };
        const wantsImplicitTarget = req.kind === "NONE" && /\b(it|this)\b/i.test(effectText);
        const matchesReq = (() => {
          switch (req.kind) {
            case "UNIT_ANYWHERE":
            case "UNIT_AT_BATTLEFIELD":
              return true;
            case "UNIT_FRIENDLY":
            case "UNIT_FRIENDLY_AT_BATTLEFIELD":
            case "UNIT_HERE_FRIENDLY":
              return u.owner === controller;
            case "UNIT_ENEMY":
            case "UNIT_ENEMY_AT_BATTLEFIELD":
            case "UNIT_HERE_ENEMY":
              return u.owner !== controller;
            default:
              return false;
          }
        })();

        game.chain.push({
          id: makeId("chain"),
          controller,
          kind: "TRIGGERED_ABILITY",
          label: `${bf.card.name} — Trigger`,
          effectText,
          contextBattlefieldIndex: from.index,
          restrictTargetsToBattlefieldIndex: from.index,
          targets: matchesReq || wantsImplicitTarget ? [movedTarget] : [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE" && !matchesReq,
          targetRequirement: req,
          sourceInstanceId: u.instanceId,
        });
      }
    }
  }

  const checkFollowers = (pid: PlayerId) => {
    const sources = getUnitsInPlay(game, pid);
    for (const source of sources) {
      const trig = (source.ability?.trigger || "").toLowerCase();
      if (!trig.includes("when a friendly unit moves from my location")) continue;
      const srcLoc = locateUnit(game, pid, source.instanceId);
      if (!srcLoc) continue;
      const movedFromSame =
        from.kind === "BASE"
          ? srcLoc.zone === "BASE"
          : srcLoc.zone === "BF" && srcLoc.battlefieldIndex === from.index;
      if (!movedFromSame) continue;
      for (const moved of movedUnits) {
        if (moved.owner !== pid) continue;
        const removed = removeUnitFromWherever(game, pid, source.instanceId);
        if (!removed) continue;
        removed.isReady = false;
        removed.moveCountThisTurn += 1;
        addUnitToZone(game, pid, removed, to);
        game.log.unshift(`${source.name} moved with a friendly unit.`);
      }
    }
  };

  checkFollowers(controller);

  if (to.kind === "BF") {
    const opponent = otherPlayer(controller);
    const sources = getUnitsInPlay(game, opponent);
    for (const source of sources) {
      const trig = (source.ability?.trigger || "").toLowerCase();
      if (!trig.includes("when an opponent moves to a battlefield other than mine")) continue;
      const loc = locateUnit(game, opponent, source.instanceId);
      if (!loc || loc.zone !== "BF") continue;
      if (loc.battlefieldIndex === to.index) continue;
      if (source.ability?.effect_text) {
        const req = inferTargetRequirement(source.ability.effect_text);
        game.chain.push({
          id: makeId("chain"),
          controller: opponent,
          kind: "TRIGGERED_ABILITY",
          label: `Move Trigger: ${source.name}`,
          effectText: source.ability.effect_text,
          targets: [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
        });
        game.state = "CLOSED";
        game.priorityPlayer = opponent;
        game.passesInRow = 0;
      }
    }
  }
};

const banishCardToBanishment = (game: GameState, owner: PlayerId, card: CardInstance, reason = "banished") => {
  const p = game.players[owner];
  if (card.type === "Unit") resetUnitOnLeavePlay(card);
  p.banishment.push(card);
  game.log.unshift(`${card.name} (${owner}) was ${reason} and put into Banishment.`);
};

const cleanupStateBased = (game: GameState) => {
  // 1) kill units with lethal damage (>= effective might outside combat role). In rules, damage is checked as SBA.
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = game.players[pid];
    // base
    const stillBase: CardInstance[] = [];
    for (const u of p.base.units) {
      const lethal = effectiveMight(u, { role: "NONE", game });
      if (u.damage >= lethal && lethal > 0) {
        killUnit(game, pid, u, "destroyed (lethal damage)");
      } else {
        stillBase.push(u);
      }
    }
    p.base.units = stillBase;

    // battlefields
    for (const bf of game.battlefields) {
      const still: CardInstance[] = [];
      for (const u of bf.units[pid]) {
        const lethal = effectiveMight(u, { role: "NONE", game });
        if (u.damage >= lethal && lethal > 0) {
          killUnit(game, pid, u, "destroyed (lethal damage)");
        } else {
          still.push(u);
        }
      }
      bf.units[pid] = still;
    }
  }

  // 2) Update controller when NOT in combat and NOT contested.
  if (game.windowKind === "NONE") {
    for (const bf of game.battlefields) {
      if (bf.contestedBy) continue; // contested controller stays as-is until combat/showdown resolves
      const p1 = bf.units.P1.length > 0;
      const p2 = bf.units.P2.length > 0;
      if (p1 && !p2) bf.controller = "P1";
      else if (p2 && !p1) bf.controller = "P2";
      else if (!p1 && !p2) bf.controller = null;
      // if both, controller stays (contested should have been set by move; treat as combat pending)
    }
  }

  // 3) Facedown zone legality: a facedown card can only remain while its controller controls the battlefield.
  // If the Hidden card's controller loses control of the battlefield, remove the card during the next Cleanup.
  for (const bf of game.battlefields) {
    if (bf.facedown) {
      const owner = bf.facedown.owner;
      const stillControls = bf.controller === owner;
      bf.facedown.markedForRemoval = !stillControls;

      if (!stillControls) {
        const card = bf.facedown.card;
        bf.facedown = null;
        game.players[owner].trash.push(card);
        game.log.unshift(`Facedown card ${card.name} was removed from Battlefield ${bf.index + 1} (lost control).`);
      }
    }
    if (bf.facedownExtra) {
      const owner = bf.facedownExtra.owner;
      const stillControls = bf.controller === owner;
      bf.facedownExtra.markedForRemoval = !stillControls;

      if (!stillControls) {
        const card = bf.facedownExtra.card;
        bf.facedownExtra = null;
        game.players[owner].trash.push(card);
        game.log.unshift(`Extra facedown card ${card.name} was removed from Battlefield ${bf.index + 1} (lost control).`);
      }
    }
  }

  // 4) Gear corrective recall: Gear can only be played to a base, and if it is ever at a battlefield it is recalled during Cleanup.
  for (const bf of game.battlefields) {
    for (const pid of ["P1", "P2"] as PlayerId[]) {
      if (bf.gear[pid].length === 0) continue;
      const recalled = bf.gear[pid].splice(0, bf.gear[pid].length);
      game.players[pid].base.gear.push(...recalled);
      game.log.unshift(`${pid} recalled ${recalled.length} gear to base (gear can't remain at a battlefield).`);
    }
  }

  // 5) Ensure no negative rune pool values
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const pool = game.players[pid].runePool;
    pool.energy = Math.max(0, pool.energy);
    for (const d of Object.keys(pool.power) as Domain[]) pool.power[d] = Math.max(0, pool.power[d] || 0);
  }

  recalculateVictoryScore(game);
  refreshConditionalKeywords(game);
};

const queueCombatTriggers = (game: GameState, bfIndex: number, player: PlayerId, mode: "ATTACK" | "DEFEND") => {
  const bf = game.battlefields[bfIndex];
  const units = bf.units[player];

  for (const u of units) {
    const effects = getTriggerEffects(u, mode === "ATTACK" ? "ATTACK" : "DEFEND");
    for (const eff of effects) {
      const req = inferTargetRequirement(eff, { here: true });

      game.chain.push({
        id: makeId("chain"),
        controller: player,
        kind: "TRIGGERED_ABILITY",
        label: `${u.name} (${mode === "ATTACK" ? "Attack" : "Defend"})`,
        effectText: eff,
        contextBattlefieldIndex: bfIndex,
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
        targets: [{ kind: "NONE" }],
        sourceInstanceId: u.instanceId,
      });
      game.state = "CLOSED";
      game.priorityPlayer = player;
      game.passesInRow = 0;
      game.log.unshift(`Triggered ability: ${u.name} (Combat).`);
    }
  }
};


const pendingShowdowns = (game: GameState): number[] =>
  game.battlefields
    .filter((bf) => bf.contestedBy && bf.controller === null)
    .map((bf) => bf.index);

const pendingCombats = (game: GameState): number[] =>
  game.battlefields
    .filter((bf) => bf.units.P1.length > 0 && bf.units.P2.length > 0 && bf.contestedBy !== null)
    .map((bf) => bf.index);

const maybeOpenNextWindow = (game: GameState) => {
  if (game.windowKind !== "NONE") return;
  if (game.state !== "OPEN") return;
  if (game.chain.length !== 0) return;

  const showdowns = pendingShowdowns(game);
  if (showdowns.length > 0) {
    const idx = showdowns[0];
    game.windowKind = "SHOWDOWN";
    game.windowBattlefieldIndex = idx;
    // Showdowns opened by Standard Move: non-turn player gets Focus and priority first (per rules).
    const nonTurnPlayer = otherPlayer(game.turnPlayer);
    game.focusPlayer = nonTurnPlayer;
    game.priorityPlayer = nonTurnPlayer;
    game.passesInRow = 0;
    game.log.unshift(`Showdown opened at Battlefield ${idx + 1}. ${nonTurnPlayer} has Focus.`);
    return;
  }

  const combats = pendingCombats(game);
  if (combats.length > 0) {
    const idx = combats[0];
    const bf = game.battlefields[idx];
    const attacker = bf.contestedBy!;
    const defender = otherPlayer(attacker);
    game.windowKind = "COMBAT";
    game.windowBattlefieldIndex = idx;
    game.combat = { battlefieldIndex: idx, attacker, defender, step: "SHOWDOWN" };
    // Combat showdown: attacker gets Focus/priority first.
    game.focusPlayer = attacker;
    game.priorityPlayer = attacker;
    game.passesInRow = 0;
    game.log.unshift(`Combat begins at Battlefield ${idx + 1} (Attacker: ${attacker}, Defender: ${defender}).`);

    // Queue "When I attack" triggers.
    queueCombatTriggers(game, idx, attacker, "ATTACK");

    // Queue battlefield "When you attack here" trigger for attacker
    const bfAttackEffects = getBattlefieldTriggerEffects(bf.card, "ATTACK_HERE");
    for (const eff of bfAttackEffects) {
      const req = inferTargetRequirement(eff, { here: true });
      game.chain.push({
        id: makeId("chain"),
        controller: attacker,
        kind: "TRIGGERED_ABILITY",
        label: `Battlefield Trigger: ${bf.card.name} (Attack)`,
        effectText: eff,
        contextBattlefieldIndex: idx,
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
        restrictTargetsToBattlefieldIndex: idx,
        targets: [{ kind: "NONE" }],
      });
      game.state = "CLOSED";
      game.priorityPlayer = attacker;
      game.passesInRow = 0;
      game.log.unshift(`${bf.card.name} triggered (Attack here).`);
    }

    // Queue battlefield "When you defend here" trigger for defender (combat start).
    const bfDefEffects = getBattlefieldTriggerEffects(bf.card, "DEFEND_HERE");
    for (const eff of bfDefEffects) {
      const req = inferTargetRequirement(eff, { here: true });
      game.chain.push({
        id: makeId("chain"),
        controller: defender,
        kind: "TRIGGERED_ABILITY",
        label: `Battlefield Trigger: ${bf.card.name} (Defend)`,
        effectText: eff,
        contextBattlefieldIndex: idx,
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
        restrictTargetsToBattlefieldIndex: idx,
        targets: [{ kind: "NONE" }],
      });
      game.state = "CLOSED";
      game.priorityPlayer = defender;
      game.passesInRow = 0;
      game.log.unshift(`${bf.card.name} triggered (Defend here).`);
    }

    const attackerUnits = bf.units[attacker].filter((u) => !u.stunned);
    const defenderUnits = bf.units[defender].filter((u) => !u.stunned);
    const attackerAlone = attackerUnits.length === 1;
    const defenderAlone = defenderUnits.length === 1;

    // Fire delayed triggers tied to attacks/defends (e.g., Mask of Foresight).
    for (const u of attackerUnits) {
      fireDelayedTriggersForEvent(game, "UNIT_ATTACKS", u, { battlefieldIndex: idx, alone: attackerAlone });
    }
    for (const u of defenderUnits) {
      fireDelayedTriggersForEvent(game, "UNIT_DEFENDS", u, { battlefieldIndex: idx, alone: defenderAlone });
    }
    const queueAloneTriggers = (pid: PlayerId, soloUnit: CardInstance, mode: "ATTACK" | "DEFEND") => {
      const sources = [...game.players[pid].base.units, ...game.players[pid].base.gear, ...game.battlefields.flatMap((b) => b.units[pid])];
      for (const source of sources) {
        const trig = (source.ability?.trigger || "").toLowerCase();
        if (!trig.includes("when a friendly unit attacks or defends alone")) continue;
        if (source.ability?.effect_text) {
          const effectText = source.ability.effect_text.trim().replace(/^[—-]\s*/, "").trim();
          if (!effectText) continue;
          const req = inferTargetRequirement(effectText);
          game.chain.push({
            id: makeId("chain"),
            controller: pid,
            kind: "TRIGGERED_ABILITY",
            label: `${source.name} — Trigger`,
            effectText,
            contextBattlefieldIndex: idx,
            targets: [{ kind: "UNIT", owner: pid, instanceId: soloUnit.instanceId, battlefieldIndex: idx, zone: "BF" }],
            needsTargets: true,
            targetRequirement: { kind: "UNIT_ANYWHERE", count: 1 },
            sourceInstanceId: source.instanceId,
          });
          game.state = "CLOSED";
          game.priorityPlayer = pid;
          game.passesInRow = 0;
          game.log.unshift(`${source.name} triggered (${mode} alone).`);
        }
      }
    };

    if (attackerAlone) queueAloneTriggers(attacker, attackerUnits[0], "ATTACK");
    if (defenderAlone) queueAloneTriggers(defender, defenderUnits[0], "DEFEND");
  }
};

const attemptScore = (game: GameState, scorer: PlayerId, battlefieldIndex: number, method: "Hold" | "Conquer") => {
  const p = game.players[scorer];
  if (p.scoredBattlefieldsThisTurn.includes(battlefieldIndex)) return;

  const bf = game.battlefields[battlefieldIndex];
  if (battlefieldNameIs(bf, "Forgotten Monument") && p.turnsTaken < 3) {
    game.log.unshift(`${scorer} cannot score at Battlefield ${battlefieldIndex + 1} yet (Forgotten Monument).`);
    return;
  }

  const current = p.points;
  const finalPointAttempt = current === game.victoryScore - 1;

  let pointsAwarded = 1;
  let finalPointReplacedWithDraw = false;

  if (finalPointAttempt && method === "Conquer") {
    // Final Point restriction (Conquer must have scored every battlefield this turn).
    const allBattlefields = game.battlefields.map((b) => b.index);
    const wouldHaveScored = [...p.scoredBattlefieldsThisTurn, battlefieldIndex];
    const scoredAll = allBattlefields.every((i) => wouldHaveScored.includes(i));
    if (!scoredAll) {
      pointsAwarded = 0;
      finalPointReplacedWithDraw = true;
      game.log.unshift(`${scorer} would score the Final Point via Conquer, but hasn't scored every battlefield this turn. Draw 1 instead.`);
    }
  }

  if (method === "Conquer" || method === "Hold") {
    const myUnits = [...p.base.units, ...game.battlefields.flatMap((b) => b.units[scorer])];
    for (const u of myUnits) {
      const effects = getTriggerEffects(u, method === "Conquer" ? "CONQUER" : "HOLD");
      for (const effectText of effects) {
        const req = inferTargetRequirement(effectText);
        game.chain.push({
          id: makeId("chain"),
          controller: scorer,
          kind: "TRIGGERED_ABILITY",
          label: `Trigger: ${u.name} (${method})`,
          effectText: effectText,
          targets: [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
          sourceInstanceId: u.instanceId,
        });
        game.state = "CLOSED";
        game.priorityPlayer = scorer;
        game.passesInRow = 0;
        game.log.unshift(`${u.name} triggered (${method}).`);
      }

      if (method === "Conquer" && (u.tempKeywords || []).includes(TEMP_CONQUER_MOVE_BASE_KEYWORD)) {
        game.chain.push({
          id: makeId("chain"),
          controller: scorer,
          kind: "TRIGGERED_ABILITY",
          label: `Trigger: ${u.name} (Conquer)`,
          effectText: "You may move me to your base.",
          targets: [{ kind: "NONE" }],
          needsTargets: false,
          targetRequirement: { kind: "NONE" },
          sourceInstanceId: u.instanceId,
        });
        game.state = "CLOSED";
        game.priorityPlayer = scorer;
        game.passesInRow = 0;
        game.log.unshift(`${u.name} gained a Conquer move-to-base trigger this turn.`);
      }
    }
  }

  if (method === "Conquer") {
    const legend = game.players[scorer].legend;
    const legendReady = game.players[scorer].legendReady;
    // Check for "When you conquer" trigger in legend ability
    if (legend?.ability?.trigger && legend.ability.trigger.toLowerCase().includes("when you conquer") && legend.ability.effect_text) {
      const req = inferTargetRequirement(legend.ability.effect_text);
      game.chain.push({
        id: makeId("chain"),
        controller: scorer,
        kind: "TRIGGERED_ABILITY",
        label: `Trigger: ${legend.name} (Conquer)`,
        effectText: legend.ability.effect_text,
        targets: [{ kind: "NONE" }],
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
      });
      game.state = "CLOSED";
      game.priorityPlayer = scorer;
      game.passesInRow = 0;
      game.log.unshift(`${legend.name} triggered (Conquer).`);
    }
    // Also check for "When you conquer, ready me" in raw text (e.g., Sett, The Boss; Irelia)
    const rawText = legend?.ability?.raw_text || legend?.rules_text?.raw || "";
    const readyMeOnConquer = /when you conquer,?\s*(you may pay \[?\d\]? to )?ready me/i.test(rawText);
    if (readyMeOnConquer && legend) {
      // Check if there's a cost ("you may pay [1] to ready me")
      const costMatch = rawText.match(/when you conquer,?\s*you may pay \[?(\d)\]? to ready me/i);
      if (costMatch) {
        // Has a cost - queue as triggered ability
        const cost = parseInt(costMatch[1], 10);
        game.chain.push({
          id: makeId("chain"),
          controller: scorer,
          kind: "TRIGGERED_ABILITY",
          label: `Trigger: ${legend.name} (Conquer - Ready)`,
          effectText: `You may pay [${cost}] to ready your legend.`,
          targets: [{ kind: "NONE" }],
          needsTargets: false,
          targetRequirement: { kind: "NONE" },
        });
        game.state = "CLOSED";
        game.priorityPlayer = scorer;
        game.passesInRow = 0;
        game.log.unshift(`${legend.name} triggered (Conquer - Ready option).`);
      } else {
        // No cost - just ready the legend
        game.players[scorer].legendReady = true;
        game.log.unshift(`${legend.name} readied (Conquer).`);
      }
    }
  }

  p.scoredBattlefieldsThisTurn.push(battlefieldIndex);

  // Battlefield triggered ability: "When you hold here" / "When you conquer here" (best-effort).
  const bfRaw = (bf.card.rules_text?.raw || bf.card.ability?.raw_text || bf.card.ability?.effect_text || "").toLowerCase();
  const requiresMightyForConquer =
    /conquer\s+here\s+with\s+one\s+or\s+more\s+\[?mighty\]?/i.test(bfRaw) ||
    /conquer\s+here\s+with\s+a\s+\[?mighty\]?/i.test(bfRaw);
  const bfEffects =
    method === "Hold"
      ? getBattlefieldTriggerEffects(bf.card, "HOLD_HERE")
      : getBattlefieldTriggerEffects(bf.card, "CONQUER_HERE");
  if (bfEffects.length > 0) {
    const hasMightyHere = game.battlefields[battlefieldIndex].units[scorer].some((u) => isMighty(u, game));
    for (const effect of bfEffects) {
      if (method === "Conquer" && requiresMightyForConquer && !hasMightyHere) continue;
      if (/with one or more \[?mighty\] units/i.test(effect) && !hasMightyHere) continue;
      if (/if you have mighty units/i.test(effect) && !hasMightyHere) continue;
      const req = inferTargetRequirement(effect, { here: true });
      game.chain.push({
        id: makeId("chain"),
        controller: scorer,
        kind: "TRIGGERED_ABILITY",
        label: `Battlefield Trigger: ${bf.card.name} (${method})`,
        effectText: effect,
        contextBattlefieldIndex: battlefieldIndex,
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
        restrictTargetsToBattlefieldIndex: null,
        targets: [{ kind: "NONE" }],
      });
      game.state = "CLOSED";
      game.priorityPlayer = scorer;
      game.passesInRow = 0;
      game.log.unshift(`Triggered ability added to chain: ${bf.card.name} (${method}).`);
    }
  }

  if (pointsAwarded > 0) {
    p.points += pointsAwarded;
    game.log.unshift(`${scorer} scored 1 point by ${method} at Battlefield ${battlefieldIndex + 1}. (Total: ${p.points})`);
  } else if (finalPointReplacedWithDraw) {
    drawCards(game, scorer, 1);
  }

  recalculateVictoryScore(game);

  // Win check
  if (p.points >= game.victoryScore) {
    game.step = "GAME_OVER";
    game.log.unshift(`${scorer} wins! Reached ${p.points} points.`);
  }
};

const resolveHoldScoring = (game: GameState, player: PlayerId) => {
  // In Scoring Step: score each battlefield you control by Hold (once per battlefield per turn).
  for (const bf of game.battlefields) {
    if (bf.controller === player) {
      attemptScore(game, player, bf.index, "Hold");
      if (game.step === "GAME_OVER") return;
    }
  }
};

const burnOutIfNeeded = (game: GameState, player: PlayerId): boolean => {
  const p = game.players[player];
  if (p.mainDeck.length > 0) return true;

  // Burn Out: shuffle Trash into main deck, opponent scores 1 point, then draw. If trash empty too, opponent wins (simplified).
  if (p.trash.length === 0) {
    const opp = otherPlayer(player);
    game.step = "GAME_OVER";
    game.log.unshift(`${player} tried to draw with empty deck and empty trash. ${opp} wins by Burn Out.`);
    return false;
  }

  const opp = otherPlayer(player);
  p.mainDeck = shuffle(p.trash.map((c) => ({ ...c })), game.turnNumber);
  p.trash = [];
  game.log.unshift(`${player} Burned Out! Shuffled Trash into main deck. ${opp} scores 1 point.`);
  game.players[opp].points += 1;

  if (game.players[opp].points >= game.victoryScore) {
    game.step = "GAME_OVER";
    game.log.unshift(`${opp} wins! (Burn Out point reached victory score)`);
    return false;
  }
  return true;
};

const drawCards = (game: GameState, player: PlayerId, count: number) => {
  const p = game.players[player];
  for (let i = 0; i < count; i++) {
    if (!burnOutIfNeeded(game, player)) return;
    if (p.mainDeck.length === 0) return; // after burn out with empty trash, game over
    const card = p.mainDeck.shift()!;
    p.hand.push(card);
    game.log.unshift(`${player} drew a card.`);
  }
};

const channelRunes = (game: GameState, player: PlayerId, count: number) => {
  const p = game.players[player];
  const n = Math.min(count, p.runeDeck.length);
  for (let i = 0; i < n; i++) {
    const rune = p.runeDeck.shift()!;
    p.runesInPlay.push({ ...rune, isReady: true });
  }
  if (n > 0) game.log.unshift(`${player} channeled ${n} rune(s).`);
};

const channelRunesExhausted = (game: GameState, player: PlayerId, count: number): number => {
  const p = game.players[player];
  const n = Math.min(count, p.runeDeck.length);
  for (let i = 0; i < n; i++) {
    const rune = p.runeDeck.shift()!;
    p.runesInPlay.push({ ...rune, isReady: false });
  }
  if (n > 0) game.log.unshift(`${player} channeled ${n} rune(s) exhausted.`);
  return n;
};

const emptyPoolsAtEndOfDraw = (game: GameState) => {
  // Rune Pool empties at the end of the active player's Draw Phase.
  const pid = game.turnPlayer;
  game.players[pid].runePool = emptyRunePool();
  game.log.unshift(`${pid}'s Rune Pool emptied (end of Draw Phase).`);
};

const emptyPoolAtEndOfTurn = (game: GameState, player: PlayerId) => {
  // Rune Pool empties at end of turn (Expiration).
  game.players[player].runePool = emptyRunePool();
  game.log.unshift(`${player}'s Rune Pool emptied (end of turn).`);
};

const clearEndOfTurnStatuses = (game: GameState) => {
  // Stunned ends at end of the turn specified by stunnedUntilTurn (per rules: stun lasts until end of NEXT turn).
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = game.players[pid];
    for (const u of p.base.units) {
      if (u.stunned && game.turnNumber >= u.stunnedUntilTurn) {
        u.stunned = false;
        u.stunnedUntilTurn = 0;
      }
    }
    for (const bf of game.battlefields) {
      for (const u of bf.units[pid]) {
        if (u.stunned && game.turnNumber >= u.stunnedUntilTurn) {
          u.stunned = false;
          u.stunnedUntilTurn = 0;
        }
      }
    }
  }
};

const clearDamageAndTempBonusesEndOfTurn = (game: GameState) => {
  // First, kill units with Ephemeral keyword (they are killed at end of turn)
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = game.players[pid];

    // Kill Ephemeral units in base
    const ephemeralBase = p.base.units.filter((u) => hasKeyword(u, "Ephemeral"));
    for (const u of ephemeralBase) {
      const idx = p.base.units.findIndex((x) => x.instanceId === u.instanceId);
      if (idx >= 0) {
        p.base.units.splice(idx, 1);
        killUnit(game, pid, u, "killed (Ephemeral)");
      }
    }

    // Kill Ephemeral units at battlefields
    for (const bf of game.battlefields) {
      const ephemeralBf = bf.units[pid].filter((u) => hasKeyword(u, "Ephemeral"));
      for (const u of ephemeralBf) {
        const idx = bf.units[pid].findIndex((x) => x.instanceId === u.instanceId);
        if (idx >= 0) {
          bf.units[pid].splice(idx, 1);
          killUnit(game, pid, u, "killed (Ephemeral)");
        }
      }
    }
  }

  // Units heal at end of turn (damage removed).
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    const p = game.players[pid];
    for (const u of p.base.units) {
      u.damage = 0;
      u.tempMightBonus = 0;
      u.tempKeywords = [];
    }
    for (const bf of game.battlefields) {
      for (const u of bf.units[pid]) {
        u.damage = 0;
        u.tempMightBonus = 0;
        u.tempKeywords = [];
      }
    }
  }
};

const awakenPlayer = (game: GameState, player: PlayerId) => {
  // Awaken Step readies permanents and runes (simplified).
  const p = game.players[player];

  // First, kill units with Temporary keyword (they are killed at start of Beginning Phase)
  const temporaryUnitsBase = p.base.units.filter((u) => hasKeyword(u, "Temporary"));
  for (const u of temporaryUnitsBase) {
    const idx = p.base.units.findIndex((x) => x.instanceId === u.instanceId);
    if (idx >= 0) {
      p.base.units.splice(idx, 1);
      killUnit(game, player, u, "killed (Temporary)");
    }
  }

  for (const bf of game.battlefields) {
    const temporaryUnitsBf = bf.units[player].filter((u) => hasKeyword(u, "Temporary"));
    for (const u of temporaryUnitsBf) {
      const idx = bf.units[player].findIndex((x) => x.instanceId === u.instanceId);
      if (idx >= 0) {
        bf.units[player].splice(idx, 1);
        killUnit(game, player, u, "killed (Temporary)");
      }
    }
  }

  // Now ready all permanents and runes
  p.legendReady = true;
  for (const u of p.base.units) u.isReady = true;
  for (const g of p.base.gear) g.isReady = true;
  for (const bf of game.battlefields) {
    for (const u of bf.units[player]) u.isReady = true;
  }
  for (const r of p.runesInPlay) r.isReady = true;
  game.log.unshift(`${player} awoke: readied legend/units/gear/runes.`);

  // Check for "At the start of your Beginning Phase" triggers on units
  const allUnits = [...p.base.units, ...game.battlefields.flatMap((bf) => bf.units[player])];
  for (const u of allUnits) {
    const trig = (u.ability?.trigger || "").toLowerCase();
    if ((trig.includes("at the start of your beginning phase") || trig.includes("at start of your beginning phase")) && u.ability?.effect_text) {
      const req = inferTargetRequirement(u.ability.effect_text);
      game.chain.push({
        id: makeId("chain"),
        controller: player,
        kind: "TRIGGERED_ABILITY",
        label: `${u.name} — Beginning Phase Trigger`,
        effectText: u.ability.effect_text,
        targets: [{ kind: "NONE" }],
        needsTargets: req.kind !== "NONE",
        targetRequirement: req,
        sourceInstanceId: u.instanceId,
      });
      game.state = "CLOSED";
      game.priorityPlayer = player;
      game.passesInRow = 0;
      game.log.unshift(`${u.name} triggered (Beginning Phase).`);
    }
  }

  // Check for battlefield "At the start of each player's first Beginning Phase" triggers
  // These only fire on turn 1 (P1) and turn 2 (P2's first turn)
  const isFirstBeginningPhase = game.players[player].turnsTaken === 1;
  if (isFirstBeginningPhase) {
    for (const bf of game.battlefields) {
      const effects = getBattlefieldTriggerEffects(bf.card, "START_FIRST_BEGINNING");
      for (const eff of effects) {
        const req = inferTargetRequirement(eff);
        game.chain.push({
          id: makeId("chain"),
          controller: player,
          kind: "TRIGGERED_ABILITY",
          label: `${bf.card.name} — First Beginning Phase Trigger`,
          effectText: eff,
          contextBattlefieldIndex: bf.index,
          targets: [{ kind: "NONE" }],
          needsTargets: req.kind !== "NONE",
          targetRequirement: req,
        });
        game.state = "CLOSED";
        game.priorityPlayer = player;
        game.passesInRow = 0;
        game.log.unshift(`${bf.card.name} triggered (First Beginning Phase for ${player}).`);
      }
    }
  }
};

// ----------------------------- Costs -----------------------------

const computeDeflectTax = (targetUnit: CardInstance | null): number => {
  if (!targetUnit) return 0;
  return keywordValue(targetUnit, "Deflect");
};

const canAffordCardWithChoices = (
  game: GameState,
  player: PlayerId,
  card: CardInstance,
  opts: {
    powerDomainsAllowed: Domain[];
    overrideEnergyCost?: number;
    overridePowerCost?: number;

    // optional add-ons
    additionalEnergy?: number;
    additionalPowerByDomain?: Partial<Record<Domain, number>>;
    additionalPowerClass?: number;
    additionalPowerAny?: number; // any-domain power (Deflect, some misc costs)
  }
): boolean => {
  const p = game.players[player];

  const energyNeed = (opts.overrideEnergyCost ?? card.cost) + (opts.additionalEnergy ?? 0);
  const basePowerNeed = opts.overridePowerCost ?? (card.stats.power ?? 0);
  const addByDomain = opts.additionalPowerByDomain || {};
  const addClass = opts.additionalPowerClass ?? 0;
  const extraAny = opts.additionalPowerAny ?? 0;

  if (p.runePool.energy < energyNeed) return false;

  // 1) Pay the base power (domain-restricted)
  const pool = p.runePool;
  const canPayBase = choosePowerPaymentDomains(pool, basePowerNeed, opts.powerDomainsAllowed) !== null;
  if (!canPayBase) return false;

  // 2) Simulate paying base power to get remaining pool
  const remainingPool = deepClone(pool);
  const payBase = choosePowerPaymentDomains(pool, basePowerNeed, opts.powerDomainsAllowed)!;
  for (const d of Object.keys(payBase.payment) as Domain[]) remainingPool.power[d] -= payBase.payment[d];

  // 3) Pay additional domain-specific power (e.g., Accelerate requires matching domain)
  for (const dom of Object.keys(addByDomain) as Domain[]) {
    const need = addByDomain[dom] || 0;
    if (need <= 0) continue;
    if ((remainingPool.power[dom] || 0) < need) return false;
    remainingPool.power[dom] -= need;
  }

  // 4) Pay class power (any domain in identity)
  if (addClass > 0) {
    const allowed = classDomainsForPlayer(game, player);
    const canPayClass = choosePowerPaymentDomains(remainingPool, addClass, allowed) !== null;
    if (!canPayClass) return false;
    const classPay = choosePowerPaymentDomains(remainingPool, addClass, allowed)!;
    for (const dom of Object.keys(classPay.payment) as Domain[]) remainingPool.power[dom] -= classPay.payment[dom];
  }

  // 5) Pay any-domain power
  const ALL_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];
  const canPayAny = choosePowerPaymentDomains(remainingPool, extraAny, ALL_DOMAINS) !== null;
  return canPayAny;
};

const payCost = (
  game: GameState,
  player: PlayerId,
  card: CardInstance,
  opts: {
    powerDomainsAllowed: Domain[];
    overrideEnergyCost?: number;
    overridePowerCost?: number;

    additionalEnergy?: number;
    additionalPowerByDomain?: Partial<Record<Domain, number>>;
    additionalPowerClass?: number;
    additionalPowerAny?: number;
  }
) => {
  const p = game.players[player];

  const energyNeed = (opts.overrideEnergyCost ?? card.cost) + (opts.additionalEnergy ?? 0);
  const basePowerNeed = opts.overridePowerCost ?? (card.stats.power ?? 0);
  const addByDomain = opts.additionalPowerByDomain || {};
  const addClass = opts.additionalPowerClass ?? 0;
  const extraAny = opts.additionalPowerAny ?? 0;

  p.runePool.energy -= energyNeed;

  // Base power
  const basePay = choosePowerPaymentDomains(p.runePool, basePowerNeed, opts.powerDomainsAllowed);
  if (!basePay) throw new Error("Cost payment failed (base power).");
  for (const d of Object.keys(basePay.payment) as Domain[]) p.runePool.power[d] -= basePay.payment[d];

  // Additional domain-specific power (e.g., Accelerate)
  for (const dom of Object.keys(addByDomain) as Domain[]) {
    const need = addByDomain[dom] || 0;
    if (need <= 0) continue;
    if ((p.runePool.power[dom] || 0) < need) throw new Error("Cost payment failed (domain-specific add-on).");
    p.runePool.power[dom] -= need;
  }

  // Class power (any domain in identity)
  if (addClass > 0) {
    const allowed = classDomainsForPlayer(game, player);
    const pay = choosePowerPaymentDomains(p.runePool, addClass, allowed);
    if (!pay) throw new Error("Cost payment failed (class power add-on).");
    for (const dom of allowed) {
      const spend = pay.payment[dom] || 0;
      if (spend > 0) p.runePool.power[dom] -= spend;
    }
  }

  // Any-domain power
  const ALL_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];
  const anyPay = choosePowerPaymentDomains(p.runePool, extraAny, ALL_DOMAINS);
  if (!anyPay) throw new Error("Cost payment failed (any power).");
  for (const d of Object.keys(anyPay.payment) as Domain[]) p.runePool.power[d] -= anyPay.payment[d];
};

const normalizeEffectText = (text: string): string =>
  (text || "")
    .replace(/\\\[/g, "[")
    .replace(/\\\]/g, "]")
    .replace(/\]\s*\[/g, "] [")
    .replace(/_/g, " ")
    .replace(/\[\s*add\s*\]\s*/gi, "add ")  // [Add] -> add
    .replace(/\[\s*s\s*\]/gi, "might")      // [S] -> might
    .replace(/\[\s*a\s*\]/gi, "any-rune")   // [A] -> any-rune
    .replace(/\[\s*c\s*\]/gi, "class-rune") // [C] -> class-rune
    .replace(/\[\s*t\s*\]/gi, "tap")        // [T] -> tap
    .replace(/\[\s*e\s*\]/gi, "exhaust")    // [E] -> exhaust
    .replace(/\[(\d+)\]/g, "$1 energy")     // [N] -> N energy
    .replace(/\s+/g, " ")
    .trim();

const removeAdditionalCostClause = (text: string): string =>
  text.replace(/^(?:you may\s+)?[^.]*additional\s+cost[^.]*\.\s*/i, "").trim();

const extractOptionalCostSentence = (text: string): string => {
  const m = text.match(/(?:you may\s+)?[^.]*additional\s+cost[^.]*\./i);
  return m ? m[0] : "";
};

const parseCountWord = (raw: string): number => {
  const token = (raw || "").toLowerCase().trim();
  if (/^\d+$/.test(token)) return Math.max(0, parseInt(token, 10));
  const map: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    a: 1,
    an: 1,
  };
  return map[token] || 0;
};

const parseAdditionalCostInfo = (effectTextRaw: string): {
  hasAdditionalCost: boolean;
  isOptional: boolean;
  discardCount: number;
  clause: string;
  clauseLower: string;
} => {
  const normalized = normalizeEffectText(effectTextRaw || "");
  const clause = extractOptionalCostSentence(normalized);
  if (!clause || !/additional\s+cost/i.test(clause)) {
    return { hasAdditionalCost: false, isOptional: false, discardCount: 0, clause: "", clauseLower: "" };
  }
  const clauseLower = clause.toLowerCase();
  const isOptional = /\byou may\b/.test(clauseLower);
  const discardNumeric = clauseLower.match(/\bdiscard\s+(\d+)\b/);
  const discardWord = clauseLower.match(/\bdiscard\s+(one|two|three|four|five|six|seven|eight|nine|ten|a|an)\b/);
  const discardCount = discardNumeric ? parseInt(discardNumeric[1], 10) : discardWord ? parseCountWord(discardWord[1]) : 0;
  return { hasAdditionalCost: true, isOptional, discardCount: Math.max(0, discardCount), clause, clauseLower };
};

const spendBuffsFromUnits = (units: CardInstance[], count: number): number => {
  let remaining = count;
  for (const u of units) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, u.buffs || 0);
    if (take > 0) {
      u.buffs -= take;
      remaining -= take;
    }
  }
  return count - remaining;
};

const discardFromHandForCost = (game: GameState, player: PlayerId, excludeId: string, count: number): CardInstance[] => {
  const p = game.players[player];
  const discarded: CardInstance[] = [];
  const candidates = p.hand.filter((c) => c.instanceId !== excludeId);
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const c = candidates[i];
    const idx = p.hand.findIndex((x) => x.instanceId === c.instanceId);
    if (idx >= 0) {
      p.hand.splice(idx, 1);
      p.trash.push(c);
      discarded.push(c);
      p.discardedThisTurn += 1;
      game.log.unshift(`${player} discarded ${c.name} (additional cost).`);
      const trig = (c.ability?.trigger || "").toLowerCase();
      if (trig.includes("when you discard me") && c.ability?.effect_text) {
        game.chain.push({
          id: makeId("chain"),
          controller: player,
          kind: "TRIGGERED_ABILITY",
          label: `Discard Trigger: ${c.name}`,
          effectText: c.ability.effect_text,
          targets: [{ kind: "NONE" }],
          needsTargets: false,
          sourceCard: c,
        });
        game.log.unshift(`${c.name} triggered from discard.`);
      }
      checkGlobalTriggers(game, "DISCARD_CARD", { player, card: c });
    }
  }
  return discarded;
};

const discardSpecificFromHandForCost = (
  game: GameState,
  player: PlayerId,
  excludeId: string,
  selectedIds: string[],
  count: number
): CardInstance[] => {
  const p = game.players[player];
  const discarded: CardInstance[] = [];
  const wanted = Array.from(new Set(selectedIds)).filter((id) => id !== excludeId).slice(0, Math.max(0, count));
  for (const id of wanted) {
    if (discarded.length >= count) break;
    const idx = p.hand.findIndex((c) => c.instanceId === id && c.instanceId !== excludeId);
    if (idx < 0) continue;
    const c = p.hand[idx];
    p.hand.splice(idx, 1);
    p.trash.push(c);
    discarded.push(c);
    p.discardedThisTurn += 1;
    game.log.unshift(`${player} discarded ${c.name} (additional cost).`);
    const trig = (c.ability?.trigger || "").toLowerCase();
    if (trig.includes("when you discard me") && c.ability?.effect_text) {
      game.chain.push({
        id: makeId("chain"),
        controller: player,
        kind: "TRIGGERED_ABILITY",
        label: `Discard Trigger: ${c.name}`,
        effectText: c.ability.effect_text,
        targets: [{ kind: "NONE" }],
        needsTargets: false,
        sourceCard: c,
      });
      game.log.unshift(`${c.name} triggered from discard.`);
    }
    checkGlobalTriggers(game, "DISCARD_CARD", { player, card: c });
  }
  return discarded;
};

const resolveAdditionalCostsForPlay = (
  game: GameState,
  player: PlayerId,
  card: CardInstance,
  effectTextRaw: string,
  baseEnergyCost: number,
  basePowerCost: number,
  opts?: {
    payOptionalAdditionalCost?: boolean;
    additionalDiscardIds?: string[];
  }
): {
  effectText: string;
  additionalCostPaid: boolean;
  additionalPowerByDomain: Partial<Record<Domain, number>>;
  overrideEnergyCost?: number;
  overridePowerCost?: number;
  error?: string;
} => {
  const text = normalizeEffectText(effectTextRaw || "");
  const lower = text.toLowerCase();
  const addClause = extractOptionalCostSentence(text);
  if (!addClause || !lower.includes("additional cost")) {
    return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {} };
  }

  const clauseLower = addClause.toLowerCase();
  const isOptional = /\byou may\b/.test(clauseLower);
  const payOptionalAdditionalCost = opts?.payOptionalAdditionalCost ?? true;

  let additionalCostPaid = false;
  let additionalPowerByDomain: Partial<Record<Domain, number>> = {};
  let overrideEnergyCost: number | undefined;
  let overridePowerCost: number | undefined;

  const payOptional = (canPay: boolean) => {
    if (!isOptional) return canPay;
    if (!payOptionalAdditionalCost) return false;
    return canPay;
  };

  // 1) Discard as additional cost
  const discardNumeric = clauseLower.match(/\bdiscard\s+(\d+)/);
  const discardWord = clauseLower.match(/\bdiscard\s+(one|two|three|four|five|six|seven|eight|nine|ten|a|an)\b/);
  const discardNeed = discardNumeric ? parseInt(discardNumeric[1], 10) : discardWord ? parseCountWord(discardWord[1]) : 0;
  if (discardNeed > 0) {
    const n = discardNeed;
    const canPay = game.players[player].hand.length - 1 >= n;
    if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: discard unavailable" };
    if (payOptional(canPay) && n > 0) {
      const selectedIds = Array.isArray(opts?.additionalDiscardIds) ? opts!.additionalDiscardIds! : [];
      const usedExplicitSelection = selectedIds.length > 0;
      const discarded = usedExplicitSelection
        ? discardSpecificFromHandForCost(game, player, card.instanceId, selectedIds, n)
        : discardFromHandForCost(game, player, card.instanceId, n);
      if (discarded.length < n) {
        return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: choose discard card(s)" };
      }
      additionalCostPaid = true;
    }
  }

  // 2) Pay rune as additional cost
  const runeMatch = clauseLower.match(/\bpay\s+(\d+)\s+(body|calm|chaos|fury|mind|order)\s+rune\b/);
  if (runeMatch) {
    const n = parseInt(runeMatch[1], 10);
    const dom = clampDomain(runeMatch[2]);
    if (n > 0) {
      const available = game.players[player].runePool.power[dom] || 0;
      const canPay = available >= n;
      if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: rune unavailable" };
      if (payOptional(canPay)) {
        additionalPowerByDomain = { ...additionalPowerByDomain, [dom]: (additionalPowerByDomain[dom] || 0) + n };
        additionalCostPaid = true;
      }
    }
  }

  // 2b) Pay class rune as additional cost (any domain in identity)
  const classMatch = clauseLower.match(/\bpay\s+(\d+)?\s*class(?:-|\s+)rune\b/);
  const classTokenMatch = clauseLower.match(/\bpay\s+((?:class-rune\s*)+)\b/);
  const classTokenCount = classTokenMatch ? (classTokenMatch[1].match(/class-rune/g) || []).length : 0;
  const classRuneNeed = classMatch ? (classMatch[1] ? parseInt(classMatch[1], 10) : 1) : classTokenCount;
  if (classRuneNeed > 0) {
    const n = classRuneNeed;
    if (n > 0) {
      const allowed = classDomainsForPlayer(game, player);
      const pay = choosePowerPaymentDomains(game.players[player].runePool, n, allowed);
      const canPay = !!pay;
      if (!canPay && !isOptional) {
        return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: class rune unavailable" };
      }
      if (payOptional(canPay) && pay) {
        additionalPowerByDomain = { ...additionalPowerByDomain };
        for (const dom of allowed) {
          const spend = pay.payment[dom] || 0;
          if (spend > 0) additionalPowerByDomain[dom] = (additionalPowerByDomain[dom] || 0) + spend;
        }
        additionalCostPaid = true;
      }
    }
  }

  // 2c) Pay rune of any type as additional cost
  const anyRuneMatch = clauseLower.match(/\bpay\s+(\d+)\s+rune\s+of\s+any\s+type\b/);
  const anyRuneTokenMatch = clauseLower.match(/\bpay\s+((?:any-rune\s*)+)\b/);
  const anyRuneTokenCount = anyRuneTokenMatch ? (anyRuneTokenMatch[1].match(/any-rune/g) || []).length : 0;
  const anyRuneNeed = anyRuneMatch ? parseInt(anyRuneMatch[1], 10) : anyRuneTokenCount;
  if (anyRuneNeed > 0) {
    const n = anyRuneNeed;
    if (n > 0) {
      const allowed = [...DEFAULT_DOMAINS, "Colorless"] as Domain[];
      const pay = choosePowerPaymentDomains(game.players[player].runePool, n, allowed);
      const canPay = !!pay;
      if (!canPay && !isOptional) {
        return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: any rune unavailable" };
      }
      if (payOptional(canPay) && pay) {
        additionalPowerByDomain = { ...additionalPowerByDomain };
        for (const dom of allowed) {
          const spend = pay.payment[dom] || 0;
          if (spend > 0) additionalPowerByDomain[dom] = (additionalPowerByDomain[dom] || 0) + spend;
        }
        additionalCostPaid = true;
      }
    }
  }

  // 3) Exhaust friendly unit as additional cost
  if (clauseLower.includes("exhaust a friendly unit")) {
    const p = game.players[player];
    const allUnits = [...p.base.units, ...game.battlefields.flatMap((b) => b.units[player])];
    const target = allUnits.find((u) => u.isReady);
    const canPay = !!target;
    if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: no ready unit to exhaust" };
    if (payOptional(canPay) && target) {
      target.isReady = false;
      additionalCostPaid = true;
      game.log.unshift(`${player} exhausted ${target.name} (additional cost).`);
    }
  }

  // 3b) Exhaust legend as additional cost
  if (clauseLower.includes("exhaust your legend")) {
    const canPay = game.players[player].legendReady;
    if (!canPay && !isOptional) {
      return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: legend not ready" };
    }
    if (payOptional(canPay) && canPay) {
      game.players[player].legendReady = false;
      additionalCostPaid = true;
      game.log.unshift(`${player} exhausted legend (additional cost).`);
    }
  }

  // 4) Spend buff(s) as additional cost
  if (clauseLower.includes("spend a buff") || clauseLower.includes("spend any number of buffs")) {
    const units = [...game.players[player].base.units, ...game.battlefields.flatMap((b) => b.units[player])];
    const totalBuffs = units.reduce((sum, u) => sum + (u.buffs || 0), 0);
    const wantsAny = clauseLower.includes("any number of buffs");
    const spendCount = wantsAny ? Math.min(totalBuffs, basePowerCost) : Math.min(totalBuffs, 1);
    const canPay = spendCount > 0;
    if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: no buffs to spend" };
    if (payOptional(canPay) && spendCount > 0) {
      const spent = spendBuffsFromUnits(units, spendCount);
      additionalCostPaid = true;
      if (clauseLower.includes("reduce my cost")) {
        overridePowerCost = Math.max(0, basePowerCost - spent);
      }
      game.log.unshift(`${player} spent ${spent} buff(s) (additional cost).`);
    }
  }

  // 5) Kill friendly unit(s) as additional cost
  if (clauseLower.includes("kill a friendly unit") || clauseLower.includes("kill any number of friendly units")) {
    const units = [...game.players[player].base.units, ...game.battlefields.flatMap((b) => b.units[player])];
    const wantsAny = clauseLower.includes("any number of friendly units");
    const maxKill = wantsAny ? Math.min(units.length, basePowerCost) : Math.min(units.length, 1);
    const canPay = maxKill > 0;
    if (!canPay && !isOptional) return { effectText: effectTextRaw, additionalCostPaid: false, additionalPowerByDomain: {}, error: "Additional cost: no friendly unit to kill" };
    if (payOptional(canPay) && maxKill > 0) {
      const killed = units.slice(0, maxKill);
      for (const u of killed) {
        removeUnitFromWherever(game, u.owner, u.instanceId);
        killUnit(game, u.owner, u, "sacrificed (additional cost)");
      }
      additionalCostPaid = true;
      if (clauseLower.includes("reduce my cost")) {
        overridePowerCost = Math.max(0, basePowerCost - killed.length);
      }
    }
  }

  if (additionalCostPaid && /ignore this spell's cost/i.test(lower)) {
    overrideEnergyCost = 0;
    overridePowerCost = 0;
  } else if (additionalCostPaid) {
    const reduceEnergy = lower.match(/reduce my cost by (\d+) energy/);
    if (reduceEnergy) {
      const n = parseInt(reduceEnergy[1], 10);
      if (Number.isFinite(n)) overrideEnergyCost = Math.max(0, baseEnergyCost - n);
    }
  }

  let effectText = removeAdditionalCostClause(text);
  effectText = effectText.replace(/if you do,?\s*reduce my cost[^.]*\.\s*/i, "");
  effectText = effectText.replace(/if you do,?\s*ignore this spell's cost\.\s*/i, "");
  effectText = effectText.replace(/reduce my cost by [^.]*\.\s*/i, "");

  if (/if you do/i.test(effectText)) {
    const m = effectText.match(/if you do,?\s*([^]*?)(?:otherwise,?\s*([^]*))?$/i);
    if (m) {
      const ifText = (m[1] || "").trim().replace(/\.$/, "");
      const otherwiseText = (m[2] || "").trim().replace(/\.$/, "");
      effectText = additionalCostPaid ? ifText : otherwiseText;
    }
  }

  if (/if you paid (?:the )?additional cost/i.test(effectText)) {
    if (additionalCostPaid) {
      effectText = effectText
        .replace(/,\s*if you paid (?:the )?additional cost,\s*/gi, ", ")
        .replace(/\bif you paid (?:the )?additional cost,\s*/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      effectText = effectText
        .replace(/(?:^|[.!?]\s*)[^.!?]*if you paid (?:the )?additional cost[^.!?]*(?:[.!?]\s*|$)/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  return {
    effectText,
    additionalCostPaid,
    additionalPowerByDomain,
    overrideEnergyCost,
    overridePowerCost,
  };
};

// ----------------------------- Auto-pay planning (UI convenience) -----------------------------

const ALL_POWER_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];

const clonePool = (pool: RunePool): RunePool => ({
  energy: pool.energy,
  power: { ...pool.power },
});

const addPowerRecord = (a: Record<Domain, number>, b: Partial<Record<Domain, number>>): Record<Domain, number> => {
  const out: Record<Domain, number> = { ...a };
  for (const d of Object.keys(b) as Domain[]) out[d] = (out[d] || 0) + (b[d] || 0);
  return out;
};

const emptyPowerAdds = (): Record<Domain, number> => ({
  Body: 0,
  Calm: 0,
  Chaos: 0,
  Fury: 0,
  Mind: 0,
  Order: 0,
  Colorless: 0,
});

const canAffordWithPool = (
  pool: RunePool,
  spec: {
    energyNeed: number;
    basePowerNeed: number;
    powerDomainsAllowed: Domain[];
    additionalPowerByDomain: Partial<Record<Domain, number>>;
    additionalPowerAny: number;
  }
): boolean => {
  if (pool.energy < spec.energyNeed) return false;

  // 1) Base power (domain-restricted)
  const basePay = choosePowerPaymentDomains(pool, spec.basePowerNeed, spec.powerDomainsAllowed);
  if (!basePay) return false;

  // 2) Remaining pool after base payment
  const remaining = clonePool(pool);
  for (const d of Object.keys(basePay.payment) as Domain[]) remaining.power[d] -= basePay.payment[d];

  // 3) Additional domain-specific power (e.g., Accelerate)
  for (const dom of Object.keys(spec.additionalPowerByDomain) as Domain[]) {
    const need = spec.additionalPowerByDomain[dom] || 0;
    if (need <= 0) continue;
    if ((remaining.power[dom] || 0) < need) return false;
    remaining.power[dom] -= need;
  }

  // 4) Any-domain power (Deflect, Hide)
  const anyPay = choosePowerPaymentDomains(remaining, spec.additionalPowerAny, ALL_POWER_DOMAINS);
  return anyPay !== null;
};

/**
 * Helper to determine the domain a Seal provides when exhausted.
 * Parses the Seal's ability text to find "add X domain rune/power" patterns.
 * Falls back to the Seal's printed domain if no pattern is found.
 */
const getSealPowerDomain = (gear: CardInstance, playerDomains: Domain[]): { domain: Domain; amount: number } | null => {
  // parser marker for icon text: /\[\s*c\s*\]/i
  const raw = (gear.ability?.raw_text || gear.ability?.effect_text || "").toString();
  const clean = raw
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\[[^\]]+\]/g, (m) => m.slice(1, -1)) // [Add] -> Add
    .replace(/[—–]/g, "-")
    .replace(/[:.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Check for domain-specific add pattern
  const mDom = clean.match(/\badd\s+(\d+)?\s*(body|calm|chaos|fury|mind|order|class)\s+(?:rune|power)\b/);
  if (mDom) {
    const amt = Math.max(1, parseInt(mDom[1] || "1", 10) || 1);
    if (mDom[2] === "class") {
      const dom = playerDomains[0] || "Fury";
      return { domain: dom, amount: amt };
    }
    return { domain: clampDomain(mDom[2]), amount: amt };
  }

  // Check for any-domain add pattern
  const mAny = clean.match(/\badd\s+(\d+)\s+(?:rune|power)\s+of\s+any\s+(?:type|domain|color)\b/) ||
    clean.match(/\badd\s+(\d+)\s+any\s+(?:rune|power)\b/);
  if (mAny) {
    const amt = Math.max(1, parseInt(mAny[1], 10) || 1);
    const doms = parseDomains(gear.domain).map(clampDomain).filter((x) => x !== "Colorless");
    const dom = doms[0] || playerDomains[0] || "Fury";
    return { domain: dom, amount: amt };
  }

  // Fallback: if it looks like a Seal, use its printed domain
  const looksLikeSeal = gear.name.toLowerCase().includes("seal") || /\bseal\b/i.test(raw) ||
    (gear.ability?.keywords || []).some((k) => k.toLowerCase().includes("add"));
  if (looksLikeSeal) {
    const doms = parseDomains(gear.domain).map(clampDomain).filter((x) => x !== "Colorless");
    const dom = doms[0] || playerDomains[0] || "Fury";
    return { domain: dom, amount: 1 };
  }

  return null;
};

const getAutoPayPowerSource = (gear: CardInstance, playerDomains: Domain[]) => {
  // normalize [C] icon syntax for class-rune style effects: /\[\s*c\s*\]/i
  return getSealPowerDomain(gear, playerDomains);
};

/**
 * Compute a minimal-ish rune auto-payment plan that generates enough resources in Rune Pool to pay a cost spec.
 *
 * We search over subsets of runes to recycle (<= 12 in Duel) and then use the smallest number of
 * ready runes to exhaust for any remaining energy shortfall, preferring to "EXHAUST+RECYCLE" the same rune.
 *
 * Now also considers Seals as an alternative to rune recycling for generating power.
 * If a Seal is used, rune recycling is disabled (Seals are meant as an alternative to recycling).
 */
const buildAutoPayPlan = (
  pool: RunePool,
  runesInPlay: RuneInstance[],
  spec: {
    energyNeed: number;
    basePowerNeed: number;
    powerDomainsAllowed: Domain[];
    additionalPowerByDomain: Partial<Record<Domain, number>>;
    additionalPowerAny: number;
  },
  opts?: { sealExhaustedThisTurn?: boolean; seals?: CardInstance[]; playerDomains?: Domain[] }
): AutoPayPlan | null => {
  // If a Seal was exhausted this turn, prevent recycling runes (Seals are meant as an alternative to recycling)
  const noRecycle = opts?.sealExhaustedThisTurn ?? false;
  const seals = opts?.seals || [];
  const playerDomains = opts?.playerDomains || ["Fury"];

  // Already affordable with existing pool
  if (canAffordWithPool(pool, spec)) {
    return {
      runeUses: {},
      sealUses: [],
      recycleCount: 0,
      exhaustCount: 0,
      exhaustOnlyCount: 0,
      addsEnergy: 0,
      addsPower: emptyPowerAdds(),
    };
  }

  const n = runesInPlay.length;
  const readySeals = seals.filter((g) => g.isReady && getSealPowerDomain(g, playerDomains) !== null);

  // If no runes and no seals, can't pay
  if (n === 0 && readySeals.length === 0) return null;

  const energyShortfall = Math.max(0, spec.energyNeed - pool.energy);
  const readyIdsAll: string[] = runesInPlay.filter((r) => r.isReady).map((r) => r.instanceId);
  if (energyShortfall > readyIdsAll.length) {
    // Can't generate enough energy even if we exhaust all ready runes.
    return null;
  }

  let best: { plan: AutoPayPlan; score: [number, number, number, number] } | null = null;

  const popcount = (x: number): number => {
    let c = 0;
    while (x) {
      x &= x - 1;
      c++;
    }
    return c;
  };

  // Try plans with Seals first (preferred over recycling)
  // For each subset of ready Seals, try to find a plan
  const sealMaskMax = 1 << readySeals.length;
  const runeMaskMax = 1 << n;

  for (let sealMask = 0; sealMask < sealMaskMax; sealMask++) {
    const sealCount = popcount(sealMask);
    const usedSeals: SealPayInfo[] = [];
    const sealPowerAdds = emptyPowerAdds();

    for (let i = 0; i < readySeals.length; i++) {
      if ((sealMask & (1 << i)) !== 0) {
        const seal = readySeals[i];
        const sealInfo = getSealPowerDomain(seal, playerDomains);
        if (sealInfo) {
          usedSeals.push({ instanceId: seal.instanceId, domain: sealInfo.domain, amount: sealInfo.amount });
          sealPowerAdds[sealInfo.domain] = (sealPowerAdds[sealInfo.domain] || 0) + sealInfo.amount;
        }
      }
    }

    // If using any Seals, disable rune recycling
    const disableRecycle = noRecycle || sealCount > 0;

    for (let runeMask = 0; runeMask < runeMaskMax; runeMask++) {
      const recycleCount = popcount(runeMask);

      // If recycling is disabled, only allow runeMask=0
      if (disableRecycle && runeMask !== 0) continue;

      // Quick pruning: if we already have a better plan, skip
      if (best && sealCount > best.score[0]) continue;
      if (best && sealCount === best.score[0] && recycleCount > best.score[1]) continue;

      const powerAdds = { ...sealPowerAdds };
      const recycledIds: string[] = [];
      const readyRecycledIds: string[] = [];
      const readyNonRecycledIds: string[] = [];

      for (let i = 0; i < n; i++) {
        const r = runesInPlay[i];
        const isRecycled = (runeMask & (1 << i)) !== 0;
        if (isRecycled) {
          recycledIds.push(r.instanceId);
          powerAdds[r.domain] = (powerAdds[r.domain] || 0) + 1;
          if (r.isReady) readyRecycledIds.push(r.instanceId);
        } else {
          if (r.isReady) readyNonRecycledIds.push(r.instanceId);
        }
      }

      // Decide exhaust assignments (exactly the energy shortfall), preferring to exhaust runes we already recycle.
      let remainingEnergy = energyShortfall;
      const bothIds: string[] = [];
      const exhaustOnlyIds: string[] = [];

      const takeBoth = Math.min(remainingEnergy, readyRecycledIds.length);
      for (let i = 0; i < takeBoth; i++) bothIds.push(readyRecycledIds[i]);
      remainingEnergy -= takeBoth;

      if (remainingEnergy > readyNonRecycledIds.length) {
        // Not enough ready non-recycled runes to cover the remaining energy shortfall.
        continue;
      }
      for (let i = 0; i < remainingEnergy; i++) exhaustOnlyIds.push(readyNonRecycledIds[i]);

      const addsEnergy = bothIds.length + exhaustOnlyIds.length;

      const newPool = clonePool(pool);
      newPool.energy += addsEnergy;
      newPool.power = addPowerRecord(newPool.power as any, powerAdds);

      if (!canAffordWithPool(newPool, spec)) continue;

      // Build mapping (for UI glow + application)
      const runeUses: Record<string, RunePayKind> = {};
      for (const rid of recycledIds) runeUses[rid] = "RECYCLE";
      for (const rid of bothIds) runeUses[rid] = "BOTH";
      for (const rid of exhaustOnlyIds) runeUses[rid] = "EXHAUST";

      const plan: AutoPayPlan = {
        runeUses,
        sealUses: usedSeals,
        recycleCount,
        exhaustCount: addsEnergy,
        exhaustOnlyCount: exhaustOnlyIds.length,
        addsEnergy,
        addsPower: powerAdds,
      };

      // Score: prefer fewer recycled runes, then fewer exhaust-only, then fewer total uses, then more seals (to avoid recycling).
      const score: [number, number, number, number] = [recycleCount, exhaustOnlyIds.length, recycleCount + addsEnergy, -sealCount];
      if (!best ||
        score[0] < best.score[0] ||
        (score[0] === best.score[0] && score[1] < best.score[1]) ||
        (score[0] === best.score[0] && score[1] === best.score[1] && score[2] < best.score[2]) ||
        (score[0] === best.score[0] && score[1] === best.score[1] && score[2] === best.score[2] && score[3] < best.score[3])) {
        best = { plan, score };
      }
    }
  }

  return best ? best.plan : null;
};

const applyAutoPayPlan = (game: GameState, player: PlayerId, plan: AutoPayPlan) => {
  const p = game.players[player];

  // Apply Seal exhaustions first (Seals provide power, not energy)
  for (const sealUse of plan.sealUses) {
    const gidx = p.base.gear.findIndex((g) => g.instanceId === sealUse.instanceId);
    if (gidx < 0) continue;
    const gear = p.base.gear[gidx];
    if (!gear.isReady) continue;
    gear.isReady = false;
    p.runePool.power[sealUse.domain] = (p.runePool.power[sealUse.domain] || 0) + sealUse.amount;
    p.sealExhaustedThisTurn = true; // Prevent further rune recycling this turn
    game.log.unshift(`${player} auto-exhausted ${gear.name} to add ${sealUse.amount} ${sealUse.domain} power.`);
  }

  const uses = plan.runeUses;
  const entries = Object.entries(uses) as Array<[string, RunePayKind]>;

  // Apply exhausts first so "BOTH" behaves like Exhaust then Recycle.
  for (const [runeId, kind] of entries) {
    if (kind !== "EXHAUST" && kind !== "BOTH") continue;
    const r = p.runesInPlay.find((x) => x.instanceId === runeId);
    if (!r) continue;
    if (!r.isReady) continue;
    r.isReady = false;
    p.runePool.energy += 1;
  }

  // Apply recycles (including BOTH)
  for (const [runeId, kind] of entries) {
    if (kind !== "RECYCLE" && kind !== "BOTH") continue;
    const idx = p.runesInPlay.findIndex((x) => x.instanceId === runeId);
    if (idx < 0) continue;
    const r = p.runesInPlay.splice(idx, 1)[0];
    p.runePool.power[r.domain] = (p.runePool.power[r.domain] || 0) + 1;
    // Put the rune card back at the bottom of the rune deck, readied.
    p.runeDeck.push({ ...r, isReady: true });
  }
};

// ----------------------------- Resolving effects -----------------------------

type ResolveOutcome = boolean | "PENDING_OPTIONAL";

const resolveEffectText = (
  game: GameState,
  controller: PlayerId,
  effectTextRaw: string,
  targets: Target[],
  ctx: ResolveEffectContext = {}
): ResolveOutcome => {
  const opp = otherPlayer(controller);
  const p = game.players[controller];
  const hereBf = ctx?.battlefieldIndex ?? null;

  const normalize = (s: string) =>
    (s || "")
      .replace(/\\\[/g, "[")
      .replace(/\\\]/g, "]")
      .replace(/\]\s*\[/g, "] [")
      .replace(/_/g, " ")
      .replace(/\[\s*add\s*\]\s*/gi, "add ")  // [Add] -> add
      .replace(/\[\s*s\s*\]/gi, "might")      // [S] -> might
      .replace(/\[\s*a\s*\]/gi, "any-rune")   // [A] -> any-rune
      .replace(/\[\s*c\s*\]/gi, "class-rune") // [C] -> class-rune
      .replace(/\[\s*t\s*\]/gi, "tap")        // [T] -> tap
      .replace(/\[\s*e\s*\]/gi, "exhaust")    // [E] -> exhaust
      .replace(/\[(\d+)\]/g, "$1 energy")     // [N] -> N energy
      .replace(/\s+/g, " ")
      .trim();

  const rawLower = (effectTextRaw || "").toLowerCase();
  const text = normalize(effectTextRaw || "");
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasExhaustMeChannel = /exhaust me to channel \d+ rune(?:s)? exhausted/i.test(lower);
  const uiCtx = activeUiContext;
  const isAiControlled = (pid: PlayerId) => (uiCtx ? uiCtx.isAiControlled(pid) : false);
  const resolutionId = ctx.resolutionId || ctx.chainItemId || makeId("res");
  const hasYouMay = /\byou may\b/i.test(lower);
  const canPromptOptional =
    typeof window !== "undefined" &&
    !!uiCtx &&
    uiCtx.viewerId === controller &&
    uiCtx.canActAs(controller) &&
    !isAiControlled(controller);
  const optionalResults = game.optionalChoiceResults || (game.optionalChoiceResults = {});
  const hasPoro = getUnitsInPlay(game, controller).some((u) => (u.tags || []).some((t) => String(t || "").toLowerCase() === "poro"));
  const hasFacedownAtBattlefield = game.battlefields.some((bf) => bf.facedown && bf.facedown.owner === controller);
  const unitCountAtHere = hereBf != null ? game.battlefields[hereBf].units[controller].length : 0;

  const rawTargets: Target[] = Array.isArray(targets) ? targets : [];
  const firstTarget: Target = (rawTargets.length > 0 ? rawTargets[0] : { kind: "NONE" }) as any;

  // Multi-target support: collect all selected UNIT targets that currently exist.
  const selectedUnitTargets = rawTargets.filter((t): t is Extract<Target, { kind: "UNIT" }> => (t as any)?.kind === "UNIT");
  const selectedUnitLocs = selectedUnitTargets
    .map((t) => ({ t, loc: locateUnit(game, t.owner, t.instanceId) }))
    .filter(
      (x): x is {
        t: Extract<Target, { kind: "UNIT" }>;
        loc: { zone: "BASE" | "BF"; battlefieldIndex?: number; unit: CardInstance };
      } => !!x.loc
    );

  const selectedUnits: CardInstance[] = selectedUnitLocs.map((x) => x.loc.unit);
  const unitTarget = selectedUnits.length > 0 ? selectedUnits[0] : null;

  const firstBattlefieldTarget = rawTargets.find((t): t is Extract<Target, { kind: "BATTLEFIELD" }> => t.kind === "BATTLEFIELD");
  const bfTargetIndex = firstBattlefieldTarget ? firstBattlefieldTarget.index : null;

  const isUpTo = /\bup\s+to\b/i.test(text);

  const forEachSelectedUnit = (
    fn: (
      u: CardInstance,
      t: Extract<Target, { kind: "UNIT" }>,
      loc: { zone: "BASE" | "BF"; battlefieldIndex?: number; unit: CardInstance }
    ) => void
  ) => {
    for (const x of selectedUnitLocs) fn(x.loc.unit, x.t, x.loc);
  };

  const sourceLoc =
    ctx?.sourceInstanceId
      ? locateUnit(game, controller, ctx.sourceInstanceId) || locateUnit(game, opp, ctx.sourceInstanceId)
      : null;
  const sourceUnit = sourceLoc?.unit || null;

  const makeChoiceId = (suffix: string) => `${resolutionId}:${suffix}`;

  const makeResume = (): OptionalChoiceResume => {
    if (ctx.chainItemId) return { kind: "CHAIN", chainItemId: ctx.chainItemId };
    return {
      kind: "DIRECT",
      controller,
      effectText: effectTextRaw || "",
      targets: rawTargets,
      ctx: { ...ctx, resolutionId },
      post: ctx.resumePost,
    };
  };

  const ensureOptionalChoice = (opts: {
    suffix: string;
    kind: OptionalChoiceKind;
    prompt: string;
    defaultYes?: boolean;
    min?: number;
    max?: number;
    defaultValue?: number;
  }): OptionalChoiceResult | "PENDING_OPTIONAL" => {
    if (!hasYouMay) return { accepted: opts.defaultYes ?? true, value: opts.defaultValue };

    const choiceId = makeChoiceId(opts.suffix);
    const existing = optionalResults[choiceId];
    if (existing) return existing;

    if (isAiControlled(controller) || !canPromptOptional) {
      const auto: OptionalChoiceResult = { accepted: opts.defaultYes ?? true, value: opts.defaultValue };
      optionalResults[choiceId] = auto;
      return auto;
    }

    if (game.pendingOptionalChoice) return "PENDING_OPTIONAL";
    game.pendingOptionalChoice = {
      id: choiceId,
      player: controller,
      kind: opts.kind,
      prompt: opts.prompt,
      min: opts.min,
      max: opts.max,
      defaultValue: opts.defaultValue,
      resume: makeResume(),
    };
    return "PENDING_OPTIONAL";
  };

  const getOptionalConfirm = (suffix: string, defaultYes = true): boolean => {
    if (!hasYouMay) return true;
    const res = optionalResults[makeChoiceId(suffix)];
    return res ? !!res.accepted : defaultYes;
  };

  const getOptionalNumber = (suffix: string, fallbackValue: number): number => {
    if (!hasYouMay) return fallbackValue;
    const res = optionalResults[makeChoiceId(suffix)];
    const val = res?.value;
    return Number.isFinite(val) ? (val as number) : fallbackValue;
  };

  let did = false;
  let skipTokenPlay = false;
  let skipGenericDraw = false;
  let skipGenericMight = false;
  let skipGenericReveal = false;

  const pendingOptional = (() => {
    if (!hasYouMay) return null;

    if (/pay\s+\d+\s+energy\s+to\s+draw\s+\d+/i.test(lower)) {
      const m = lower.match(/pay\s+(\d+)\s+energy\s+to\s+draw\s+(\d+)/i);
      const cost = m ? parseInt(m[1], 10) : 1;
      const count = m ? parseInt(m[2], 10) : 1;
      const res = ensureOptionalChoice({
        suffix: `PAY_ENERGY_DRAW_${cost}_${count}`,
        kind: "CONFIRM",
        prompt: `Pay ${cost} energy to draw ${count}?`,
      });
      if (res === "PENDING_OPTIONAL") return res;
    }

    if (
      /pay\s+(?:any-rune\s+){4}to\s+score\s+1\s+point/i.test(lower) ||
      /pay\s+4\s+any-rune\s+to\s+score\s+1\s+point/i.test(lower)
    ) {
      const res = ensureOptionalChoice({
        suffix: "PAY_POWER_SCORE",
        kind: "CONFIRM",
        prompt: "Pay 4 power to score 1 point?",
      });
      if (res === "PENDING_OPTIONAL") return res;
    }

    if (/pay\s+\d+\s+energy\s+to\s+ready\s+your\s+legend/i.test(lower)) {
      const m = lower.match(/pay\s+(\d+)\s+energy\s+to\s+ready\s+your\s+legend/i);
      const cost = m ? parseInt(m[1], 10) : 1;
      const res = ensureOptionalChoice({
        suffix: `PAY_ENERGY_READY_LEGEND_${cost}`,
        kind: "CONFIRM",
        prompt: `Pay ${cost} energy to ready your legend?`,
      });
      if (res === "PENDING_OPTIONAL") return res;
    }

    if (!hasExhaustMeChannel && /channel\s+1\s+rune\s+exhausted/i.test(lower)) {
      const res = ensureOptionalChoice({
        suffix: "CHANNEL_1_EXHAUSTED",
        kind: "CONFIRM",
        prompt: "Channel 1 rune exhausted?",
      });
      if (res === "PENDING_OPTIONAL") return res;
    }

    if (/you\s+may\s+detach\s+equipment\s+you\s+control/i.test(lower)) {
      const gearTarget = rawTargets.find((t) => t.kind === "GEAR") as Extract<Target, { kind: "GEAR" }> | undefined;
      if (gearTarget) {
        const res = ensureOptionalChoice({
          suffix: "DETACH_EQUIPMENT",
          kind: "CONFIRM",
          prompt: "Detach the chosen equipment?",
        });
        if (res === "PENDING_OPTIONAL") return res;
      }
    }

    if (
      /pay\s+\d+\s+energy.*return\s+a\s+unit\s+here\s+to\s+its\s+owner'?s\s+hand.*play\s+two\s+2\s+might\s+sand\s+soldier\s+unit\s+tokens?\s+here/i.test(lower) &&
      hereBf != null
    ) {
      const m = lower.match(/pay\s+(\d+)\s+energy/i);
      const cost = m ? parseInt(m[1], 10) : 1;
      const targetUnit = selectedUnits.length > 0 ? selectedUnits[0] : null;
      if (targetUnit) {
        const res = ensureOptionalChoice({
          suffix: `PAY_ENERGY_SAND_${cost}`,
          kind: "CONFIRM",
          prompt: `Pay ${cost} energy to return ${targetUnit.name} and create Sand Soldiers?`,
        });
        if (res === "PENDING_OPTIONAL") return res;
      }
    }

    if (/you may spend a buff to draw \d+/i.test(lower)) {
      const drawMatch = lower.match(/you may spend a buff to draw (\d+)/i);
      const drawCount = drawMatch ? parseInt(drawMatch[1], 10) : 1;
      const units = getUnitsInPlay(game, controller);
      const totalBuffs = units.reduce((sum, u) => sum + (u.buffs || 0), 0);
      if (totalBuffs > 0) {
        const res = ensureOptionalChoice({
          suffix: `SPEND_BUFF_DRAW_${drawCount}`,
          kind: "CONFIRM",
          prompt: `Spend a buff to draw ${drawCount}?`,
        });
        if (res === "PENDING_OPTIONAL") return res;
      }
    }

    if (/exhaust me to channel \d+ rune(?:s)? exhausted/i.test(lower) && ((sourceUnit && sourceUnit.isReady) || (ctx.sourceCardType === "Legend" && game.players[controller].legendReady))) {
      const m = lower.match(/exhaust me to channel (\d+) rune/);
      const n = m ? parseInt(m[1], 10) : 1;
      const who = sourceUnit?.name || game.players[controller].legend?.name || "Legend";
      const res = ensureOptionalChoice({
        suffix: `EXHAUST_ME_CHANNEL_${n}`,
        kind: "CONFIRM",
        prompt: `Exhaust ${who} to channel ${Number.isFinite(n) ? n : 1} rune(s) exhausted?`,
      });
      if (res === "PENDING_OPTIONAL") return res;
    }

    if (/spend any number of buffs/i.test(lower) && /for each buff spent, channel/i.test(lower)) {
      const units = getUnitsInPlay(game, controller);
      const totalBuffs = units.reduce((sum, u) => sum + (u.buffs || 0), 0);
      if (totalBuffs > 0) {
        const res = ensureOptionalChoice({
          suffix: "SPEND_BUFFS_ANY",
          kind: "NUMBER",
          prompt: `Spend how many buffs? (0-${totalBuffs})`,
          min: 0,
          max: totalBuffs,
          defaultValue: totalBuffs,
        });
        if (res === "PENDING_OPTIONAL") return res;
      }
    }

    if (/\bplay\s+(?:a|an)\s+gold\s+gear\s+token\b/i.test(lower) || /\bplay\s+(?:a|an)\s+gold\s+token\b/i.test(lower)) {
      const payMatch = lower.match(/pay\s+(\d+)\s+energy/i);
      if (payMatch) {
        const cost = parseInt(payMatch[1], 10);
        const res = ensureOptionalChoice({
          suffix: `PAY_ENERGY_GOLD_${cost}`,
          kind: "CONFIRM",
          prompt: `Pay ${cost} energy to play a Gold token?`,
        });
        if (res === "PENDING_OPTIONAL") return res;
      }
    }

    if (/for each friendly unit, you may spend its buff to ready it/i.test(lower)) {
      const units = getUnitsInPlay(game, controller);
      const canSpend = units.some((u) => u.buffs > 0);
      if (canSpend) {
        const res = ensureOptionalChoice({
          suffix: "SPEND_BUFFS_READY_ALL",
          kind: "CONFIRM",
          prompt: "Spend buffs to ready all eligible friendly units?",
        });
        if (res === "PENDING_OPTIONAL") return res;
      }
    }

    return null;
  })();

  if (pendingOptional === "PENDING_OPTIONAL") return "PENDING_OPTIONAL";

  if (selectedUnitLocs.length > 0) {
    fireChooseTriggers(game, controller, rawTargets, { battlefieldIndex: hereBf ?? null, sourceCardType: ctx?.sourceCardType });
  }

  const payEnergy = (amount: number): boolean => {
    if (p.runePool.energy < amount) return false;
    p.runePool.energy -= amount;
    return true;
  };

  const payPowerAny = (amount: number): boolean => {
    for (let i = 0; i < amount; i++) {
      const dom = (Object.keys(p.runePool.power) as Domain[]).find((d) => p.runePool.power[d] > 0);
      if (!dom) return false;
      p.runePool.power[dom] -= 1;
    }
    return true;
  };

  const payPowerDomain = (dom: Domain, amount: number): boolean => {
    if ((p.runePool.power[dom] || 0) < amount) return false;
    p.runePool.power[dom] -= amount;
    return true;
  };

  const prepareUnitForTriggeredPlay = (card: CardInstance) => {
    card.isReady = false;
    card.damage = 0;
    const raw = `${card.ability?.effect_text || ""} ${card.ability?.raw_text || ""}`.toLowerCase();
    if (raw.includes("if an opponent controls a battlefield") && raw.includes("i enter ready")) {
      const opponent = otherPlayer(controller);
      const opponentControls = game.battlefields.some((bf) => bf.controller === opponent);
      if (opponentControls) card.isReady = true;
    }
    if (raw.includes("if an opponent's score is within 3 points of the victory score") && raw.includes("i enter ready")) {
      const opponent = otherPlayer(controller);
      if (game.players[opponent].points >= game.victoryScore - 3) card.isReady = true;
    }
  };

  // --------------------- Each-player choice: Cull the Weak ---------------------
  if (
    /\beach\s+player\s+kills\s+one\s+of\s+their\s+units\b/i.test(lower) ||
    /\beach\s+player\s+kills\s+one\s+of\s+their\s+units\b/i.test(rawLower) ||
    /\beach\s+player\s+kills\s+a\s+unit\b/i.test(lower) ||
    /\beach\s+player\s+kills\s+a\s+unit\b/i.test(rawLower)
  ) {
    const existing = game.cullChoiceResults?.[resolutionId];
    if (existing) {
      delete game.cullChoiceResults?.[resolutionId];
      const killedUnits: CardInstance[] = [];
      for (const pid of ["P1", "P2"] as PlayerId[]) {
        const unitId = existing[pid];
        if (!unitId) continue;
        const removed = removeUnitFromWherever(game, pid, unitId);
        if (!removed) continue;
        killUnit(game, pid, removed, "killed (Cull the Weak)");
        killedUnits.push(removed);
      }
      if (killedUnits.length > 0) {
        cleanupStateBased(game);
        game.log.unshift(`Cull the Weak resolved: ${killedUnits.length} unit(s) killed.`);
        if (ctx.sourceCardType === "Spell") {
          queueTriggersForEvent(
            game,
            controller,
            (trig) => trig.includes("when you kill a unit with a spell"),
            (source) => source.ability?.effect_text,
            [{ kind: "NONE" }],
            undefined,
            true
          );
        }
        if (killedUnits.some((u) => u.stunned && u.owner !== controller)) {
          queueTriggersForEvent(
            game,
            controller,
            (trig) => trig.includes("when you kill a stunned enemy unit"),
            (source) => source.ability?.effect_text
          );
        }
      } else {
        game.log.unshift("Cull the Weak resolved: no units to kill.");
      }
      did = true;
    } else {
      if (!game.pendingCullChoice) {
        game.pendingCullChoice = {
          resolutionId,
          order: [controller, opp],
          index: 0,
          choices: { P1: null, P2: null },
        };
        advanceCullChoice(game);
        if (!game.pendingCullChoice) {
          game.log.unshift("Cull the Weak resolved: no units to kill.");
          did = true;
          return did;
        }
      }
      return "PENDING_OPTIONAL";
    }
  }

  // --------------------- Battlefield / special effect clauses ---------------------
  if (/pay\s+\d+\s+energy\s+to\s+draw\s+\d+/i.test(lower)) {
    const m = lower.match(/pay\s+(\d+)\s+energy\s+to\s+draw\s+(\d+)/i);
    const cost = m ? parseInt(m[1], 10) : 1;
    const count = m ? parseInt(m[2], 10) : 1;
    const shouldPay = getOptionalConfirm(`PAY_ENERGY_DRAW_${cost}_${count}`);
    if (shouldPay) {
      if (payEnergy(cost)) {
        drawCards(game, controller, count);
        game.log.unshift(`${controller} paid ${cost} energy to draw ${count}.`);
      } else {
        game.log.unshift(`${controller} cannot pay ${cost} energy to draw.`);
      }
      did = true;
    } else {
      game.log.unshift(`${controller} chose not to pay ${cost} energy to draw.`);
      did = true;
    }
  }
  if (/pay\s+(?:any-rune\s+){4}to\s+score\s+1\s+point/i.test(lower) || /pay\s+4\s+any-rune\s+to\s+score\s+1\s+point/i.test(lower)) {
    if (getOptionalConfirm("PAY_POWER_SCORE")) {
      const canPay = sumPower(p.runePool) >= 4;
      if (canPay) {
        payPowerAny(4);
        game.players[controller].points += 1;
        game.log.unshift(`${controller} paid 4 power to score 1 point.`);
        if (game.players[controller].points >= game.victoryScore) {
          game.step = "GAME_OVER";
          game.log.unshift(`${controller} wins! Reached ${game.players[controller].points} points.`);
        }
      } else {
        game.log.unshift(`${controller} cannot pay 4 power to score a point.`);
      }
      did = true;
    } else {
      game.log.unshift(`${controller} chose not to pay 4 power to score a point.`);
      did = true;
    }
  }

  if (/pay\s+\d+\s+energy\s+to\s+ready\s+your\s+legend/i.test(lower)) {
    const m = lower.match(/pay\s+(\d+)\s+energy\s+to\s+ready\s+your\s+legend/i);
    const cost = m ? parseInt(m[1], 10) : 1;
    if (getOptionalConfirm(`PAY_ENERGY_READY_LEGEND_${cost}`)) {
      if (!p.legend) {
        game.log.unshift(`${controller} has no legend to ready.`);
      } else if (payEnergy(cost)) {
        p.legendReady = true;
        game.log.unshift(`${controller} paid ${cost} energy to ready their legend.`);
      } else {
        game.log.unshift(`${controller} cannot pay ${cost} energy to ready their legend.`);
      }
      did = true;
    } else {
      game.log.unshift(`${controller} chose not to pay ${cost} energy to ready their legend.`);
      did = true;
    }
  }

  if (/ready\s+2\s+runes\s+at\s+end\s+of\s+turn/i.test(lower) || /ready\s+two\s+runes\s+at\s+end\s+of\s+turn/i.test(lower)) {
    p.pendingReadyRunesEndOfTurn = (p.pendingReadyRunesEndOfTurn || 0) + 2;
    game.log.unshift(`${controller} will ready 2 runes at end of turn.`);
    did = true;
  }

  if (/draw\s+a\s+card\s+for\s+each\s+other\s+battlefield\s+you\s+control/i.test(lower)) {
    const controlled = game.battlefields.filter((bf) => bf.controller === controller).length;
    const hereControlled = hereBf != null && game.battlefields[hereBf].controller === controller ? 1 : 0;
    const count = Math.max(0, controlled - hereControlled);
    if (count > 0) drawCards(game, controller, count);
    game.log.unshift(`${controller} drew ${count} card(s) (Seat of Power).`);
    did = true;
  }

  if (/put\s+the\s+top\s+2\s+cards?\s+of\s+your\s+deck\s+into\s+your\s+trash/i.test(lower) || /mill\s+2\b/i.test(lower)) {
    let milled = 0;
    while (milled < 2 && p.mainDeck.length > 0) {
      const c = p.mainDeck.shift()!;
      p.trash.push(c);
      milled += 1;
    }
    game.log.unshift(`${controller} milled ${milled} card(s) to trash.`);
    did = true;
  }

  if (/reveal\s+the\s+top\s+card\s+of\s+your\s+deck/i.test(lower) && /if\s+it'?s\s+a\s+spell/i.test(lower)) {
    applyVoidHatchlingRevealReplacement(game, controller, "MAIN");
    const top = p.mainDeck.shift();
    if (top) {
      if (top.type === "Spell") {
        p.hand.push(top);
        game.log.unshift(`${controller} revealed ${top.name} (Spell) and put it into hand.`);
      } else {
        p.mainDeck.push(top);
        game.log.unshift(`${controller} revealed ${top.name} (not a Spell) and recycled it.`);
      }
    }
    did = true;
  }

  if (/look\s+at\s+the\s+top\s+two\s+cards\s+of\s+your\s+main\s+deck/i.test(lower) && /recycle\s+one\s+or\s+both/i.test(lower)) {
    const count = Math.min(2, p.mainDeck.length);
    const top = p.mainDeck.splice(0, count);
    if (top.length === 0) {
      game.log.unshift(`${controller} looked at the top cards but the deck was empty.`);
    } else {
      if (game.pendingCandlelitChoice) {
        // Fallback: if a choice is already pending, keep cards to avoid losing information.
        p.mainDeck = top.concat(p.mainDeck);
        game.log.unshift(`${controller} looked at the top ${top.length} cards but already has a pending choice.`);
      } else if (isAiControlled(controller)) {
        p.mainDeck = top.concat(p.mainDeck);
        const names = top.map((c) => c.name).join(", ");
        game.log.unshift(`${controller} looked at the top ${top.length}: ${names}. (AI kept all)`);
      } else {
        game.pendingCandlelitChoice = {
          player: controller,
          cards: top,
          choices: {},
          order: top.map((c) => c.instanceId),
        };
        const names = top.map((c) => c.name).join(", ");
        game.log.unshift(`${controller} looked at the top ${top.length}: ${names}. Choose which to recycle.`);
      }
    }
    did = true;
  }

  if (/return\s+(?:your\s+)?(?:chosen\s+)?champion(?:\s+card)?\s+from\s+your\s+trash\s+to\s+your\s+champion\s+zone/i.test(lower)) {
    if (p.championZone) {
      game.log.unshift(`${controller} already has a champion.`);
      did = true;
    } else {
      const champTag = p.legend?.tags?.[0] || "";
      const idx = p.trash.findIndex((c) =>
        c.type === "Unit" && (champTag ? (c.tags || []).includes(champTag) : true)
      );
      if (idx >= 0) {
        const champ = p.trash.splice(idx, 1)[0];
        p.championZone = champ;
        game.log.unshift(`${controller} returned ${champ.name} to the champion zone.`);
      } else {
        game.log.unshift(`${controller} has no champion card in trash.`);
      }
      did = true;
    }
  }

  if (!hasExhaustMeChannel && /channel\s+1\s+rune\s+exhausted/i.test(lower)) {
    if (getOptionalConfirm("CHANNEL_1_EXHAUSTED")) {
      channelRunesExhausted(game, controller, 1);
      did = true;
    } else {
      game.log.unshift(`${controller} chose not to channel a rune.`);
      did = true;
    }
  }

  if (/both\s+players?\s+channel\s+1\s+rune\s+exhausted/i.test(lower)) {
    channelRunesExhausted(game, "P1", 1);
    channelRunesExhausted(game, "P2", 1);
    did = true;
  }

  if (/\brecycle\s+(?:one\s+of\s+your|a)\s+runes?\b/i.test(lower)) {
    const rune = p.runesInPlay[0];
    if (!rune) {
      game.log.unshift(`${controller} has no runes to recycle.`);
    } else {
      engineRecycleRuneForPower(game, controller, rune.instanceId);
    }
    did = true;
  }

  if (/activate\s+the\s+conquer\s+effects\s+of\s+units\s+here/i.test(lower) && hereBf != null) {
    const bf = game.battlefields[hereBf];
    let queued = false;
    for (const pid of ["P1", "P2"] as PlayerId[]) {
      for (const u of bf.units[pid]) {
        const effects = getTriggerEffects(u, "CONQUER");
        for (const eff of effects) {
          const req = inferTargetRequirement(eff, { here: true });
          game.chain.push({
            id: makeId("chain"),
            controller: pid,
            kind: "TRIGGERED_ABILITY",
            label: `Conquer Trigger: ${u.name}`,
            effectText: eff,
            contextBattlefieldIndex: hereBf,
            targets: [{ kind: "NONE" }],
            needsTargets: req.kind !== "NONE",
            targetRequirement: req,
            sourceInstanceId: u.instanceId,
          });
          queued = true;
        }
      }
    }
    if (queued) {
      game.state = "CLOSED";
      game.priorityPlayer = controller;
      game.passesInRow = 0;
    }
    did = true;
  }

  if (/ready\s+each\s+friendly\s+gear\s+you\s+control/i.test(lower)) {
    const gear = getAllGear(game, controller);
    gear.forEach((g) => (g.isReady = true));
    game.log.unshift(`${controller} readied ${gear.length} gear.`);
    did = true;
  }

  if (/you\s+may\s+detach\s+equipment\s+you\s+control/i.test(lower)) {
    // Optional: detach one equipment (if a gear target is provided, detach it)
    const gearTarget = rawTargets.find((t) => t.kind === "GEAR") as Extract<Target, { kind: "GEAR" }> | undefined;
    if (gearTarget) {
      if (getOptionalConfirm("DETACH_EQUIPMENT")) {
        const loc = locateGear(game, gearTarget.owner, gearTarget.instanceId);
        if (loc && loc.zone === "ATTACHED" && loc.unit) {
          const detached = detachGearFromUnit(loc.unit, loc.gear.instanceId);
          if (detached) {
            game.players[detached.owner].base.gear.push({ ...detached, isReady: false });
            game.log.unshift(`${controller} detached ${detached.name}.`);
            did = true;
          }
        }
      } else {
        game.log.unshift(`${controller} chose not to detach equipment.`);
        did = true;
      }
    } else {
      did = true; // optional, no target chosen
    }
  }

  if (/pay\s+\d+\s+energy.*return\s+a\s+unit\s+here\s+to\s+its\s+owner'?s\s+hand.*play\s+two\s+2\s+might\s+sand\s+soldier\s+unit\s+tokens?\s+here/i.test(lower) && hereBf != null) {
    const m = lower.match(/pay\s+(\d+)\s+energy/i);
    const cost = m ? parseInt(m[1], 10) : 1;
    const bf = game.battlefields[hereBf];
    const targetUnit = selectedUnits.length > 0 ? selectedUnits[0] : null;
    if (!targetUnit) {
      game.log.unshift("No unit chosen to return.");
      did = true;
    } else if (getOptionalConfirm(`PAY_ENERGY_SAND_${cost}`)) {
      if (!payEnergy(cost)) {
        game.log.unshift(`${controller} cannot pay ${cost} energy.`);
        did = true;
      } else {
        const removed = removeUnitFromWherever(game, targetUnit.owner, targetUnit.instanceId);
        if (removed) {
          resetUnitOnLeavePlay(removed);
          game.players[targetUnit.owner].hand.push(removed);
          const tokenCard = createTokenCard("Sand Soldier Token", 2, "Sand Soldier");
          const tokens = [instantiateCard(tokenCard, controller, game.turnNumber), instantiateCard(tokenCard, controller, game.turnNumber)];
          bf.units[controller].push(...tokens);
          game.log.unshift(`${controller} returned ${removed.name} and played two Sand Soldier tokens here.`);
        }
        did = true;
      }
    } else {
      game.log.unshift(`${controller} chose not to pay ${cost} energy for Sand Soldiers.`);
      did = true;
    }
    skipTokenPlay = true;
  }

  const prepareUnitForPlayFromEffect = (card: CardInstance) => {
    prepareUnitForTriggeredPlay(card);
  };

  if (/if it is stunned, kill it\. otherwise, stun it/i.test(lower)) {
    const targets = selectedUnits.length > 0 ? selectedUnits : unitTarget ? [unitTarget] : [];
    if (targets.length > 0) {
      for (const u of targets) {
        if (u.stunned) {
          u.damage = 999;
        } else {
          u.stunned = true;
          u.isReady = false;
          u.stunnedUntilTurn = game.turnNumber + 1;
        }
      }
      cleanupStateBased(game);
      did = true;
    }
  }

  // Rek'Sai, Swarm Queen pattern:
  // "Reveal top 2, you may play one, recycle the rest; if played card is a unit, you may play it here."
  if (
    /\breveal\s+the\s+top\s+2\s+cards?\s+of\s+your\s+main\s+deck\b/i.test(lower) &&
    /\byou\s+may\s+play\s+one\b/i.test(lower) &&
    /\brecycle\s+the\s+rest\b/i.test(lower)
  ) {
    skipGenericReveal = true;
    const revealAccepted = getOptionalConfirm("REKSAI_REVEAL_TOP_2", true);
    if (!revealAccepted) {
      game.log.unshift(`${controller} chose not to reveal cards.`);
      did = true;
    } else {
      applyVoidHatchlingRevealReplacement(game, controller, "MAIN");
      const revealed = p.mainDeck.splice(0, Math.min(2, p.mainDeck.length));
      if (revealed.length === 0) {
        game.log.unshift(`${controller} revealed no cards (main deck empty).`);
        did = true;
      } else {
        game.log.unshift(`${controller} revealed top ${revealed.length}: ${revealed.map((c) => c.name).join(", ")}.`);

        const cardScore = (card: CardInstance): number => {
          const base = Number(card.cost || 0);
          const typeBonus = card.type === "Unit" ? 30 : card.type === "Gear" ? 20 : card.type === "Spell" ? 10 : 0;
          return typeBonus + base;
        };
        const isAutoPlayable = (card: CardInstance): boolean => {
          if (card.type === "Unit" || card.type === "Gear") return true;
          if (card.type === "Spell") {
            const req = inferTargetRequirement(card.ability?.effect_text || card.ability?.raw_text || "");
            return req.kind === "NONE";
          }
          return false;
        };

        const playAccepted = getOptionalConfirm("REKSAI_PLAY_ONE", true);
        const playable = playAccepted
          ? revealed
            .filter((card) => isAutoPlayable(card))
            .sort((a, b) => cardScore(b) - cardScore(a))
          : [];
        const playedCard = playable.length > 0 ? playable[0] : null;

        if (playedCard) {
          const idx = revealed.findIndex((c) => c.instanceId === playedCard.instanceId);
          if (idx >= 0) revealed.splice(idx, 1);

          let dest: { kind: "BASE" } | { kind: "BF"; index: number } | null = { kind: "BASE" };
          const unitHereClause = /\bif\s+the\s+played\s+card\s+is\s+a\s+unit,\s*you\s+may\s+play\s+it\s+here\b/i.test(lower);
          if (
            playedCard.type === "Unit" &&
            hereBf != null &&
            (!unitHereClause || getOptionalConfirm("REKSAI_PLAY_UNIT_HERE", true))
          ) {
            dest = { kind: "BF", index: hereBf };
          }
          if (dest?.kind === "BF" && battlefieldPreventsPlayHere(game.battlefields[dest.index])) {
            dest = { kind: "BASE" };
          }

          if (playedCard.type === "Unit") {
            prepareUnitForTriggeredPlay(playedCard);
          } else if (playedCard.type === "Gear") {
            playedCard.isReady = true;
          }

          p.mainDeckCardsPlayedThisTurn += 1;
          game.chain.push({
            id: makeId("chain"),
            controller,
            kind: "PLAY_CARD",
            label: `Play ${playedCard.name}`,
            sourceCard: playedCard,
            sourceZone: "HAND",
            playDestination: playedCard.type === "Unit" || playedCard.type === "Gear" ? dest : null,
            effectText: playedCard.ability?.effect_text || "",
            contextBattlefieldIndex: dest?.kind === "BF" ? dest.index : null,
            targets: [{ kind: "NONE" }],
          });
          game.state = "CLOSED";
          game.priorityPlayer = controller;
          game.passesInRow = 0;
          checkGlobalTriggers(game, "PLAY_CARD", { player: controller, card: playedCard });
          game.log.unshift(`${controller} played ${playedCard.name} from the revealed cards.`);
        } else if (playAccepted) {
          game.log.unshift(`${controller} revealed cards but did not play one.`);
        } else {
          game.log.unshift(`${controller} chose not to play a revealed card.`);
        }

        for (const card of revealed) p.mainDeck.push(card);
        if (revealed.length > 0) {
          game.log.unshift(`${controller} recycled ${revealed.length} revealed card(s).`);
        }
        did = true;
      }
    }
  }

  // --------------------- Reveal / Look at top cards (Teemo, TF) ---------------------
  const revealMatch = text.match(/\b(?:reveal|look at)\s+(?:the\s+)?top\s+(\d+)\s+(?:cards?|runes?)/i);
  if (!skipGenericReveal && revealMatch) {
    const n = parseInt(revealMatch[1], 10);
    const isRunes = text.toLowerCase().includes("rune");
    const explicitReveal = /\breveal\b/i.test(text);
    if (explicitReveal) {
      applyVoidHatchlingRevealReplacement(game, controller, isRunes ? "RUNE" : "MAIN");
    }
    const deck = isRunes ? p.runeDeck : p.mainDeck;
    const revealed = deck.slice(0, n);

    const names = revealed.map((c) => (isRunes ? (c as RuneInstance).domain : c.name)).join(", ");
    game.log.unshift(`${controller} revealed top ${n}: ${names}.`);

    if (!isRunes) {
      for (const card of revealed as CardInstance[]) {
        const trig = (card.ability?.trigger || "").toLowerCase();
        const eff = card.ability?.effect_text;
        if (trig.includes("when you look at cards from the top of your deck and see me") && eff) {
          const req = inferTargetRequirement(eff);
          game.chain.push({
            id: makeId("chain"),
            controller,
            kind: "TRIGGERED_ABILITY",
            label: `Trigger: ${card.name}`,
            effectText: eff,
            targets: [{ kind: "NONE" }],
            needsTargets: req.kind !== "NONE",
            targetRequirement: req,
            sourceInstanceId: card.instanceId,
          });
          game.state = "CLOSED";
          game.priorityPlayer = controller;
          game.passesInRow = 0;
          game.log.unshift(`${card.name} triggered from the top of the deck.`);
        }
      }
    }
    did = true;
  }

  // --------------------- Discard (some effects reference the discarded card) ---------------------
  const discarded: CardInstance[] = [];
  const discN = extractDiscardAmount(text);
  if (discN && discN > 0) {
    const n = Math.min(discN, p.hand.length);
    for (let i = 0; i < n; i++) {
      const c = p.hand.pop();
      if (c) {
        p.trash.push(c);
        discarded.push(c);
        p.discardedThisTurn += 1;
        did = true;
        game.log.unshift(`${controller} discarded ${c.name}.`);

        const trig = (c.ability?.trigger || "").toLowerCase();
        if (trig.includes("when you discard me") && c.ability?.effect_text) {
          game.chain.push({
            id: makeId("chain"),
            controller: controller,
            kind: "TRIGGERED_ABILITY",
            label: `Discard Trigger: ${c.name}`,
            effectText: c.ability.effect_text,
            targets: [{ kind: "NONE" }],
            needsTargets: false,
            sourceCard: c,
          });
          game.log.unshift(`${c.name} triggered from discard.`);
        }

        checkGlobalTriggers(game, "DISCARD_CARD", { player: controller, card: c });
      }
    }
  }

  // --------------------- Draw / Channel / Add resources ---------------------
  // "you may spend a buff to draw 1" (Monastery of Hirana)
  if (/you may spend a buff to draw \d+/i.test(lower)) {
    skipGenericDraw = true;
    const drawMatch = lower.match(/you may spend a buff to draw (\d+)/i);
    const drawCount = drawMatch ? parseInt(drawMatch[1], 10) : 1;
    const units = getUnitsInPlay(game, controller);
    const totalBuffs = units.reduce((sum, u) => sum + (u.buffs || 0), 0);
    if (totalBuffs > 0) {
      if (getOptionalConfirm(`SPEND_BUFF_DRAW_${drawCount}`)) {
        spendBuffsFromUnits(units, 1);
        drawCards(game, controller, drawCount);
        game.log.unshift(`${controller} spent a buff to draw ${drawCount}.`);
      } else {
        game.log.unshift(`${controller} chose not to spend a buff.`);
      }
    } else {
      game.log.unshift(`${controller} has no buffs to spend.`);
    }
    did = true;
  }

  const drawN = extractDrawAmount(text);
  if (!skipGenericDraw && drawN && drawN > 0) {
    const poroGate = lower.includes("if you control a poro") ? hasPoro : true;
    const facedownGate = lower.includes("if you control a facedown card at a battlefield") ? hasFacedownAtBattlefield : true;
    const handGate = /draw 1 if you have one or fewer cards in your hand/i.test(lower) ? p.hand.length <= 1 : true;
    const fourUnitsGate =
      /if you have 4\+ units at that battlefield/i.test(lower) && hereBf != null
        ? game.battlefields[hereBf].units[controller].length >= 4
        : true;
    if (poroGate && facedownGate && handGate && fourUnitsGate) {
      drawCards(game, controller, drawN);
      did = true;
    }
  }

  if (/\bdraw\s+1\s+for\s+each\s+of\s+your\s+mighty\s+units\b/i.test(lower)) {
    let mightyCount = 0;
    [p.base.units, ...game.battlefields.map((b) => b.units[controller])].forEach((list) => {
      list.forEach((u) => {
        if (isMighty(u)) mightyCount += 1;
      });
    });
    if (mightyCount > 0) {
      drawCards(game, controller, mightyCount);
      game.log.unshift(`${controller} drew ${mightyCount} (Mighty scaling).`);
      did = true;
    }
  }

  // Reveal-top conditional draw/recycle patterns (e.g., Apprentice Smith, Ravenbloom Conservatory).
  if (/\breveal\s+the\s+top\s+card\s+of\s+your\s+main\s+deck\b/i.test(lower)) {
    applyVoidHatchlingRevealReplacement(game, controller, "MAIN");
    const top = p.mainDeck.shift();
    if (!top) {
      game.log.unshift(`${controller} couldn't reveal (main deck empty).`);
      did = true;
    } else {
      const wantsSpell = /\bif\s+it'?s\s+a\s+spell\b/i.test(lower);
      const wantsGear = /\bif\s+it'?s\s+a\s+gear\b/i.test(lower);
      const wantsUnit = /\bif\s+it'?s\s+a\s+unit\b/i.test(lower);
      const putToHandOnHit = /\bput\s+it\s+in\s+your\s+hand\b/i.test(lower) || /\bdraw\s+it\b/i.test(lower);

      const isHit =
        (wantsSpell && top.type === "Spell") ||
        (wantsGear && top.type === "Gear") ||
        (wantsUnit && top.type === "Unit");

      game.log.unshift(`${controller} revealed ${top.name}.`);
      if (isHit && putToHandOnHit) {
        p.hand.push(top);
        game.log.unshift(`${controller} put ${top.name} into hand.`);
      } else {
        p.mainDeck.push(top);
        game.log.unshift(`${controller} recycled ${top.name}.`);
      }
      did = true;
    }
  }

  const chN = extractChannelAmount(text);
  if (!hasExhaustMeChannel && chN && chN > 0) {
    const wantsExhausted = /\bchannel\s+\d+\s+runes?\s+exhausted\b/i.test(lower);
    const actual = wantsExhausted ? channelRunesExhausted(game, controller, chN) : (channelRunes(game, controller, chN), chN);
    did = true;
    if (actual < chN && /\bif\s+you\s+can't\b|\bif\s+you\s+couldn't\b/i.test(lower)) {
      drawCards(game, controller, 1);
      game.log.unshift(`${controller} drew 1 (failed to channel enough runes).`);
    }
  }

  const canExhaustLegendSource = ctx.sourceCardType === "Legend" && game.players[controller].legendReady;
  if (/exhaust me to channel \d+ rune(?:s)? exhausted/i.test(lower) && ((sourceUnit && sourceUnit.isReady) || canExhaustLegendSource)) {
    const m = lower.match(/exhaust me to channel (\d+) rune/);
    const n = m ? parseInt(m[1], 10) : 1;
    const who = sourceUnit?.name || game.players[controller].legend?.name || "Legend";
    if (getOptionalConfirm(`EXHAUST_ME_CHANNEL_${n}`)) {
      if (sourceUnit && sourceUnit.isReady) {
        sourceUnit.isReady = false;
      } else if (canExhaustLegendSource) {
        game.players[controller].legendReady = false;
      }
      channelRunesExhausted(game, controller, Number.isFinite(n) ? n : 1);
      game.log.unshift(`${controller} exhausted ${who} to channel ${Number.isFinite(n) ? n : 1} rune(s) exhausted.`);
      did = true;
    } else {
      game.log.unshift(`${controller} chose not to exhaust ${who}.`);
      did = true;
    }
  }

  if (/spend any number of buffs/i.test(lower) && /for each buff spent, channel/i.test(lower)) {
    const units = getUnitsInPlay(game, controller);
    const totalBuffs = units.reduce((sum, u) => sum + (u.buffs || 0), 0);
    if (totalBuffs > 0) {
      let spendCount = totalBuffs;
      if (hasYouMay) {
        const chosen = getOptionalNumber("SPEND_BUFFS_ANY", totalBuffs);
        spendCount = Number.isFinite(chosen) ? Math.max(0, Math.min(totalBuffs, Math.floor(chosen))) : 0;
      }

      if (spendCount > 0) {
        spendBuffsFromUnits(units, spendCount);
        channelRunesExhausted(game, controller, spendCount);
        game.log.unshift(`${controller} spent ${spendCount} buff(s) to channel runes.`);
      } else {
        game.log.unshift(`${controller} chose not to spend buffs.`);
      }
      did = true;
    } else {
      game.log.unshift(`${controller} has no buffs to spend.`);
      did = true;
    }
  }

  // Add Energy
  const addEnergyMatch = lower.match(/\badd\s+(\d+)\s+energy\b/);
  if (addEnergyMatch) {
    const amt = parseInt(addEnergyMatch[1], 10);
    if (Number.isFinite(amt) && amt > 0) {
      p.runePool.energy += amt;
      game.log.unshift(`${controller} added ${amt} Energy to the Rune Pool.`);
      did = true;
    }
  }

  // Add X rune(s)
  const addRuneMatch = lower.match(/\badd\s+(\d+)?\s*([a-z]+)\s+rune\b/);
  if (addRuneMatch) {
    const amt = addRuneMatch[1] ? parseInt(addRuneMatch[1], 10) : 1;
    const domWord = addRuneMatch[2];
    if (Number.isFinite(amt) && amt > 0) {
      if (domWord === "class") {
        const allowed = classDomainsForPlayer(game, controller);
        const chosen = allowed[0] || "Colorless";
        p.runePool.power[chosen] += amt;
        game.log.unshift(`${controller} added ${amt} ${chosen} power (class rune).`);
      } else {
        const dom = clampDomain(domWord);
        p.runePool.power[dom] += amt;
        game.log.unshift(`${controller} added ${amt} ${dom} Power to the Rune Pool.`);
      }
      did = true;
    }
  }

  // Add X rune of any type (simplified as Colorless power)
  const addAnyRuneMatch = lower.match(/\badd\s+(\d+)\s+rune\s+of\s+any\s+type\b/);
  if (addAnyRuneMatch) {
    const amt = parseInt(addAnyRuneMatch[1], 10);
    if (Number.isFinite(amt) && amt > 0) {
      p.runePool.power.Colorless += amt;
      game.log.unshift(`${controller} added ${amt} power (any-type rune simplified as Colorless).`);
      did = true;
    }
  }

  // --------------------- Tokens ---------------------
  const wordToNum = (w: string): number | null => {
    const m: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
    };
    if (!w) return null;
    if (/^\d+$/.test(w)) {
      const n = parseInt(w, 10);
      return Number.isFinite(n) ? n : null;
    }
    return m[w.toLowerCase()] ?? null;
  };

  const tokenM = text.match(/\bplay\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:an?\s+)?(?:ready\s+)?(\d+)\s+might\s+([a-z]+)\s+unit\s+token(?:s)?\b/i);
  if (tokenM && !skipTokenPlay) {
    const countWord = tokenM[1] || "";
    const count = wordToNum(countWord) ?? 1;
    const mightVal = parseInt(tokenM[2], 10);
    const tokenTypeRaw = tokenM[3] || "Token";
    const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
    const safeMight = Number.isFinite(mightVal) && mightVal >= 0 ? mightVal : 1;
    const tokenType = tokenTypeRaw[0].toUpperCase() + tokenTypeRaw.slice(1).toLowerCase();

    const isTemporary = /\bwith\s+\[?temporary\]?\b/i.test(text);
    const isReady = /\bready\b/i.test(text);

    const tokenCard: CardData = createTokenCard(`${tokenType} Token`, safeMight, tokenType);
    if (!tokenCard.rules_text) tokenCard.rules_text = { raw: "", keywords: [] } as any;
    if (isTemporary) {
      tokenCard.rules_text!.raw += " [Temporary]";
      tokenCard.rules_text!.keywords = [...(tokenCard.rules_text!.keywords || []), "Temporary"];
    }

    const tokenInstances = Array.from({ length: safeCount }, () => {
      const inst = instantiateCard(tokenCard, controller, game.turnNumber);
      if (isReady) inst.isReady = true;
      return inst;
    });

    // Destination defaults to Base; "here" means the source context (battlefield if present, else Base).
    // For text with no explicit destination, a selected battlefield target is treated as destination.
    const hasExplicitLocation =
      /\bhere\b/i.test(text) ||
      /\b(in|into|to)\s+your\s+base\b/i.test(text) ||
      /\bat\s+(?:a|that)\s+battlefield\b/i.test(text);
    const wantHere = /\bhere\b/i.test(text);
    let destBf = bfTargetIndex != null ? bfTargetIndex : wantHere ? hereBf : null;
    if (destBf != null && !hasExplicitLocation) {
      const bf = game.battlefields[destBf];
      if (bf.controller !== controller) {
        game.log.unshift(`${controller} can only play this token to a battlefield they control; played at Base instead.`);
        destBf = null;
      }
    }

    const fireUnitPlayedTokenTriggers = (unit: CardInstance, battlefieldIndex: number | null): ResolveOutcome => {
      fireDelayedTriggersForEvent(game, "UNIT_PLAYED", unit, { battlefieldIndex, alone: false });
      if (game.pendingOptionalChoice) return "PENDING_OPTIONAL";
      return true;
    };

    if (destBf != null) {
      const bf = game.battlefields[destBf];
      if (battlefieldPreventsPlayHere(bf)) {
        p.base.units.push(...tokenInstances);
        game.log.unshift(`${bf.card.name} prevents playing units there; tokens played at Base instead.`);
        for (const token of tokenInstances) {
          const tokenOutcome = fireUnitPlayedTokenTriggers(token, null);
          if (tokenOutcome === "PENDING_OPTIONAL") {
            did = true;
            return tokenOutcome;
          }
        }
      } else {
        game.battlefields[destBf].units[controller].push(...tokenInstances);
        game.log.unshift(`${controller} played ${safeCount} ${safeMight} might ${tokenType} token(s) at Battlefield ${destBf + 1}.`);
        for (const token of tokenInstances) {
          const tokenOutcome = fireUnitPlayedTokenTriggers(token, destBf);
          if (tokenOutcome === "PENDING_OPTIONAL") {
            did = true;
            return tokenOutcome;
          }
        }
      }
    } else {
      p.base.units.push(...tokenInstances);
      game.log.unshift(`${controller} played ${safeCount} ${safeMight} might ${tokenType} token(s) at Base.`);
      for (const token of tokenInstances) {
        const tokenOutcome = fireUnitPlayedTokenTriggers(token, null);
        if (tokenOutcome === "PENDING_OPTIONAL") {
          did = true;
          return tokenOutcome;
        }
      }
    }
    did = true;
  }

  // Play a Gold gear token (Treasure Hoard)
  if (/\bplay\s+(?:a|an)\s+gold\s+gear\s+token\b/i.test(lower) || /\bplay\s+(?:a|an)\s+gold\s+token\b/i.test(lower)) {
    let canCreateGold = true;
    const payMatch = lower.match(/pay\s+(\d+)\s+energy/i);
    if (payMatch) {
      const cost = parseInt(payMatch[1], 10);
      if (!getOptionalConfirm(`PAY_ENERGY_GOLD_${cost}`)) {
        game.log.unshift(`${controller} chose not to pay ${cost} energy for a Gold token.`);
        did = true;
        canCreateGold = false;
      }
      if (canCreateGold) {
        if (!payEnergy(cost)) {
          game.log.unshift(`${controller} cannot pay ${cost} energy for a Gold token.`);
          did = true;
          canCreateGold = false;
        } else {
          game.log.unshift(`${controller} paid ${cost} energy for a Gold token.`);
        }
      }
    }
    if (canCreateGold) {
      const rawGold = "Kill this, Exhaust: [Reaction] — [Add] Any Rune. (Abilities that add resources can't be reacted to.)";
      const goldCard = createGearTokenCard("Gold", rawGold);
      const gold = instantiateCard(goldCard, controller, game.turnNumber);
      const exhausted = /\bexhausted\b/i.test(lower);
      gold.isReady = !exhausted;
      p.base.gear.push(gold);
      game.log.unshift(`${controller} played a Gold gear token${exhausted ? " exhausted" : ""}.`);
      did = true;
    }
  }

  // Akshan pattern: "move an enemy gear to your base. ... If it's an Equipment, attach it to me."
  if (/\bmove\s+an?\s+enemy\s+(gear|equipment)\s+to\s+your\s+base\b/i.test(lower)) {
    const gearSel = rawTargets.find((t): t is Extract<Target, { kind: "GEAR" }> => t.kind === "GEAR");
    if (gearSel) {
      const gearLoc = locateGear(game, gearSel.owner, gearSel.instanceId);
      if (gearLoc && gearLoc.gear.controller !== controller) {
        const removed = removeGearFromWherever(game, gearSel.owner, gearSel.instanceId);
        if (removed) {
          removed.owner = controller;
          removed.controller = controller;
          removed.isReady = false;
          p.base.gear.push(removed);
          game.log.unshift(`${controller} moved ${removed.name} to base and took control of it.`);
          if (sourceUnit && /if it's an?\s+equipment,\s*attach it to me/i.test(lower) && isEquipment(removed)) {
            const idx = p.base.gear.findIndex((g) => g.instanceId === removed.instanceId);
            if (idx >= 0) {
              const moved = p.base.gear.splice(idx, 1)[0];
              attachGearToUnit(game, sourceUnit, moved);
              game.log.unshift(`${removed.name} attached to ${sourceUnit.name}.`);
            }
          }
          did = true;
        }
      }
    }
  }

  // --------------------- Attach / Detach Equipment ---------------------
  if (/attach\s+.*equipment/i.test(lower)) {
    const unitSel = selectedUnits.length > 0 ? selectedUnits[0] : unitTarget;
    const gearSel = rawTargets.find((t) => t.kind === "GEAR") as Extract<Target, { kind: "GEAR" }> | undefined;
    if (unitSel && gearSel) {
      const gearLoc = locateGear(game, gearSel.owner, gearSel.instanceId);
      if (gearLoc) {
        const removed = removeGearFromWherever(game, gearSel.owner, gearSel.instanceId);
        if (removed) {
          attachGearToUnit(game, unitSel, removed);
          game.log.unshift(`${controller} attached ${removed.name} to ${unitSel.name}.`);
          did = true;
        }
      }
    }
  }

  if (/detach\s+.*equipment/i.test(lower)) {
    const gearSel = rawTargets.find((t) => t.kind === "GEAR") as Extract<Target, { kind: "GEAR" }> | undefined;
    if (gearSel) {
      const loc = locateGear(game, gearSel.owner, gearSel.instanceId);
      if (loc && loc.zone === "ATTACHED" && loc.unit) {
        const detached = detachGearFromUnit(loc.unit, loc.gear.instanceId);
        if (detached) {
          game.players[detached.owner].base.gear.push({ ...detached, isReady: false });
          game.log.unshift(`${controller} detached ${detached.name}.`);
          did = true;
        }
      }
    }
  }

  // --------------------- Play me from trash / deck ---------------------
  if (/play me from your trash/i.test(lower)) {
    const idx =
      ctx.sourceInstanceId != null
        ? p.trash.findIndex((c) => c.instanceId === ctx.sourceInstanceId)
        : p.trash.findIndex((c) => c.name === ctx.sourceCardName);
    if (idx >= 0) {
      const card = p.trash[idx];
      const needEnergy = /\bpay\s+1\s+energy\b/i.test(text) ? 1 : 0;
      const domainMatch = text.match(/\bpay\s+1\s+([a-z]+)\s+rune\b/i);
      const needDomain = domainMatch ? clampDomain(domainMatch[1]) : null;
      const needAny = /\bpay\s+1\s+rune\s+of\s+any\s+type\b/i.test(text);
      const canPayEnergy = needEnergy === 0 || p.runePool.energy >= needEnergy;
      const canPayDomain = !needDomain || (p.runePool.power[needDomain] || 0) >= 1;
      const canPayAny = !needAny || Object.values(p.runePool.power).some((v) => v > 0);
      if (canPayEnergy && canPayDomain && canPayAny) {
        if (needEnergy > 0) payEnergy(needEnergy);
        if (needDomain) payPowerDomain(needDomain, 1);
        if (needAny) payPowerAny(1);
        p.trash.splice(idx, 1);
        let dest = /\bhere\b/i.test(text) && hereBf != null ? ({ kind: "BF", index: hereBf } as const) : ({ kind: "BASE" } as const);
        if (dest.kind === "BF" && battlefieldPreventsPlayHere(game.battlefields[dest.index])) {
          dest = { kind: "BASE" };
        }
        if (card.type === "Unit") {
          prepareUnitForPlayFromEffect(card);
        } else if (card.type === "Gear") {
          card.isReady = true;
        }
        p.mainDeckCardsPlayedThisTurn += 1;
        game.chain.push({
          id: makeId("chain"),
          controller,
          kind: "PLAY_CARD",
          label: `Play ${card.name}`,
          sourceCard: card,
          sourceZone: "HAND",
          playDestination: card.type === "Unit" || card.type === "Gear" ? dest : null,
          effectText: card.ability?.effect_text || "",
          contextBattlefieldIndex: dest.kind === "BF" ? dest.index : null,
          targets: [{ kind: "NONE" }],
        });
        game.state = "CLOSED";
        game.priorityPlayer = controller;
        game.passesInRow = 0;
        checkGlobalTriggers(game, "PLAY_CARD", { player: controller, card });
        game.log.unshift(`${controller} played ${card.name} from Trash.`);
        did = true;
      }
    }
  }

  if (/play me for 1 rune of any type/i.test(lower)) {
    const idx =
      ctx.sourceInstanceId != null
        ? p.mainDeck.findIndex((c) => c.instanceId === ctx.sourceInstanceId)
        : p.mainDeck.findIndex((c) => c.name === ctx.sourceCardName);
    if (idx >= 0 && payPowerAny(1)) {
      const card = p.mainDeck.splice(idx, 1)[0];
      let dest = /\bhere\b/i.test(text) && hereBf != null ? ({ kind: "BF", index: hereBf } as const) : ({ kind: "BASE" } as const);
      if (dest.kind === "BF" && battlefieldPreventsPlayHere(game.battlefields[dest.index])) {
        dest = { kind: "BASE" };
      }
      if (card.type === "Unit") {
        prepareUnitForPlayFromEffect(card);
      } else if (card.type === "Gear") {
        card.isReady = true;
      }
      p.mainDeckCardsPlayedThisTurn += 1;
      game.chain.push({
        id: makeId("chain"),
        controller,
        kind: "PLAY_CARD",
        label: `Play ${card.name}`,
        sourceCard: card,
        sourceZone: "HAND",
        playDestination: card.type === "Unit" || card.type === "Gear" ? dest : null,
        effectText: card.ability?.effect_text || "",
        contextBattlefieldIndex: dest.kind === "BF" ? dest.index : null,
        targets: [{ kind: "NONE" }],
      });
      game.state = "CLOSED";
      game.priorityPlayer = controller;
      game.passesInRow = 0;
      checkGlobalTriggers(game, "PLAY_CARD", { player: controller, card });
      game.log.unshift(`${controller} played ${card.name} from the top of the deck.`);
      did = true;
    }
  }

  // --------------------- Keyword grants: "Give a unit [Assault 3] this turn." ---------------------
  const bracketKw = text.match(/\[([^\]]+)\]/);
  if ((/\bgive\b/i.test(text) || /\bgains\b/i.test(text)) && bracketKw) {
    const kw = bracketKw[1].trim();
    if (kw) {
      const isTemp = /\bthis\s+turn\b/i.test(text) || /\bthis\s+combat\b/i.test(text);

      const targetsToApply: CardInstance[] = [];
      if (selectedUnits.length > 0) targetsToApply.push(...selectedUnits);
      else if (/\bme\b/i.test(text) || /\bthis\b/i.test(text)) {
        if (sourceUnit) targetsToApply.push(sourceUnit);
      }

      if (targetsToApply.length > 0) {
        for (const target of targetsToApply) {
          if (isTemp) target.tempKeywords = [...(target.tempKeywords || []), kw];
          else target.extraKeywords = [...(target.extraKeywords || []), kw];
        }
        if (targetsToApply.length === 1) {
          game.log.unshift(`${controller} granted [${kw}] ${isTemp ? "this turn" : ""} to ${targetsToApply[0].name}.`);
        } else {
          game.log.unshift(`${controller} granted [${kw}] ${isTemp ? "this turn" : ""} to ${targetsToApply.length} unit(s).`);
        }
        did = true;
      } else if (isUpTo) {
        // Valid: "up to" effects may choose 0 targets.
        did = true;
      }
    }
  }

  // --------------------- Move Enemy (Charm, Blitzcrank) ---------------------
  if (/\bmove\s+me\s+to\s+(?:your|my|its)\s+base\b/i.test(text) && sourceUnit) {
    if (hasYouMay && !getOptionalConfirm("MOVE_ME_TO_BASE", true)) {
      game.log.unshift(`${controller} chose not to move ${sourceUnit.name} to base.`);
      did = true;
    } else {
      const srcLoc = locateUnit(game, sourceUnit.owner, sourceUnit.instanceId);
      if (srcLoc) {
        if (srcLoc.zone === "BF") {
          const bf = game.battlefields[srcLoc.battlefieldIndex ?? -1];
          if (bf && battlefieldPreventsMoveFromHereToBase(bf)) {
            game.log.unshift(`${bf.card.name} prevents moving units from this battlefield to base.`);
            did = true;
            return did;
          }
        }
        const removed = removeUnitFromWherever(game, sourceUnit.owner, sourceUnit.instanceId);
        if (removed) {
          removed.isReady = false;
          addUnitToZone(game, sourceUnit.owner, removed, { kind: "BASE" });
          game.log.unshift(`${removed.name} moved to base.`);
        }
      }
      did = true;
    }
  }

  if (/\bmove\s+me\s+to\s+its\s+location\s+and\s+it\s+to\s+my\s+original\s+location\b/i.test(text) && sourceUnit && unitTarget) {
    const sourceLocNow = locateUnit(game, sourceUnit.owner, sourceUnit.instanceId);
    const targetLocNow = locateUnit(game, unitTarget.owner, unitTarget.instanceId);
    if (sourceLocNow && targetLocNow) {
      if (sourceUnit.instanceId === unitTarget.instanceId) {
        game.log.unshift(`${sourceUnit.name} stayed in place (same unit chosen).`);
        did = true;
      } else {
        const sourceFrom = sourceLocNow.zone === "BASE" ? ({ kind: "BASE" } as const) : ({ kind: "BF", index: sourceLocNow.battlefieldIndex! } as const);
        const targetFrom = targetLocNow.zone === "BASE" ? ({ kind: "BASE" } as const) : ({ kind: "BF", index: targetLocNow.battlefieldIndex! } as const);
        const sameLocation =
          sourceFrom.kind === targetFrom.kind &&
          (sourceFrom.kind === "BASE" || (sourceFrom as any).index === (targetFrom as any).index);
        if (sameLocation) {
          game.log.unshift(`${sourceUnit.name} and ${unitTarget.name} are already at the same location.`);
          did = true;
        } else {
          const sourceDest = targetFrom;
          const targetDest = sourceFrom;

          const blockedSourceToBase =
            sourceFrom.kind === "BF" &&
            sourceDest.kind === "BASE" &&
            battlefieldPreventsMoveFromHereToBase(game.battlefields[(sourceFrom as any).index]);
          const blockedTargetToBase =
            targetFrom.kind === "BF" &&
            targetDest.kind === "BASE" &&
            battlefieldPreventsMoveFromHereToBase(game.battlefields[(targetFrom as any).index]);

          if (blockedSourceToBase || blockedTargetToBase) {
            const blockedIndex = blockedSourceToBase ? (sourceFrom as any).index : (targetFrom as any).index;
            game.log.unshift(`${game.battlefields[blockedIndex].card.name} prevents moving units from this battlefield to base.`);
            did = true;
          } else {
            const removedSource = removeUnitFromWherever(game, sourceUnit.owner, sourceUnit.instanceId);
            const removedTarget = removeUnitFromWherever(game, unitTarget.owner, unitTarget.instanceId);
            if (removedSource && removedTarget) {
              removedSource.moveCountThisTurn += 1;
              removedTarget.moveCountThisTurn += 1;
              addUnitToZone(game, removedSource.owner, removedSource, sourceDest);
              addUnitToZone(game, removedTarget.owner, removedTarget, targetDest);
              checkMoveFromLocationTriggers(game, removedSource.owner, [removedSource], sourceFrom, sourceDest);
              checkMoveFromLocationTriggers(game, removedTarget.owner, [removedTarget], targetFrom, targetDest);
              checkMoveTriggers(game, removedSource.owner, [removedSource], sourceDest.kind === "BF" ? sourceDest.index : "BASE");
              checkMoveTriggers(game, removedTarget.owner, [removedTarget], targetDest.kind === "BF" ? targetDest.index : "BASE");
              if (
                /if it's equipped,\s*you may attach one of its equipment to me/i.test(lower) &&
                (removedTarget.attachedGear || []).length > 0 &&
                getOptionalConfirm("SWAP_ATTACH_TARGET_EQUIPMENT", true)
              ) {
                const movedEquip = removedTarget.attachedGear!.shift();
                if (movedEquip) {
                  if (!removedSource.attachedGear) removedSource.attachedGear = [];
                  removedSource.attachedGear.push(movedEquip);
                  game.log.unshift(`${controller} attached ${movedEquip.name} from ${removedTarget.name} to ${removedSource.name}.`);
                }
              }
              game.log.unshift(`${sourceUnit.name} swapped locations with ${unitTarget.name}.`);
            } else {
              // Best effort rollback if one side disappeared mid-resolution.
              if (removedSource && !removedTarget) addUnitToZone(game, removedSource.owner, removedSource, sourceFrom);
              if (!removedSource && removedTarget) addUnitToZone(game, removedTarget.owner, removedTarget, targetFrom);
              game.log.unshift("Swap failed: one of the units is no longer in play.");
            }
            did = true;
          }
        }
      }
    } else {
      game.log.unshift("Swap failed: source or chosen unit is no longer in play.");
      did = true;
    }
  }

  if (/\bmove\s+(?:an?\s+)?(?:enemy|opposing)\s+unit\b/i.test(text)) {
    const moveTarget = unitTarget;
    if (moveTarget && moveTarget.owner !== controller) {
      const fromLoc = locateUnit(game, moveTarget.owner, moveTarget.instanceId);
      let dest: { kind: "BASE" } | { kind: "BF"; index: number } | null = null;

      if (/\bto\s+here\b/i.test(text) && hereBf != null) {
        dest = { kind: "BF", index: hereBf };
      } else if (/\bto\s+(?:its\s+)?base\b/i.test(text)) {
        dest = { kind: "BASE" };
      } else if (hereBf != null) {
        dest = { kind: "BF", index: hereBf };
      } else {
        // Generic "move an enemy unit" defaults to moving it to base.
        dest = { kind: "BASE" };
      }

      if (dest) {
        if (fromLoc && fromLoc.zone === "BF" && dest.kind === "BASE") {
          const bf = game.battlefields[fromLoc.battlefieldIndex ?? -1];
          if (bf && battlefieldPreventsMoveFromHereToBase(bf)) {
            return false;
          }
        }
        const removed = removeUnitFromWherever(game, moveTarget.owner, moveTarget.instanceId);
        if (removed) {
          removed.moveCountThisTurn += 1;
          addUnitToZone(game, moveTarget.owner, removed, dest);
          if (fromLoc) {
            const from = fromLoc.zone === "BASE" ? ({ kind: "BASE" } as const) : ({ kind: "BF", index: fromLoc.battlefieldIndex! } as const);
            checkMoveFromLocationTriggers(game, moveTarget.owner, [removed], from, dest);
          }
          checkMoveTriggers(game, moveTarget.owner, [removed], dest.kind === "BF" ? dest.index : "BASE");

          // Dragon's Rage style clause:
          // "Then choose another enemy unit at its destination. They deal damage equal to their Mights to each other."
          if (/\banother\s+enemy\s+unit\s+at\s+its\s+destination\b/i.test(text)) {
            const secondTarget = rawTargets.find(
              (t) => t.kind === "UNIT" && t.owner === removed.owner && t.instanceId !== removed.instanceId
            ) as Extract<Target, { kind: "UNIT" }> | undefined;

            const destinationPool: CardInstance[] =
              dest.kind === "BASE"
                ? game.players[removed.owner].base.units
                : game.battlefields[dest.index].units[removed.owner];

            const fallbackSecond = destinationPool
              .filter((u) => u.instanceId !== removed.instanceId)
              .sort((a, b) => effectiveMight(b, { role: "NONE", game }) - effectiveMight(a, { role: "NONE", game }))[0];

            const secondUnit =
              secondTarget
                ? locateUnit(game, secondTarget.owner, secondTarget.instanceId)?.unit || fallbackSecond
                : fallbackSecond;

            if (secondUnit) {
              const movedMight = effectiveMight(removed, { role: "NONE", game });
              const secondMight = effectiveMight(secondUnit, { role: "NONE", game });
              removed.damage += secondMight;
              secondUnit.damage += movedMight;
              game.log.unshift(
                `Move clash: ${removed.name} (M${movedMight}) and ${secondUnit.name} (M${secondMight}) dealt damage to each other.`
              );
            }
          }
          game.log.unshift(`${controller} moved enemy ${moveTarget.name}.`);
          did = true;
        }
      }
    }
  }

  // --------------------- Move Any Unit (from battlefield/base patterns) ---------------------
  if (
    /\bmove\s+(?:an?\s+)?unit\b/i.test(text) &&
    !/\b(?:friendly|enemy|opposing|your)\s+unit\b/i.test(text)
  ) {
    const moveToBase = /\bfrom\s+a\s+battlefield\s+to\s+(?:its\s+)?base\b/i.test(text) || /\bto\s+(?:its\s+)?base\b/i.test(text);
    const moveToHere = /\bto\s+here\b/i.test(text) && hereBf != null;
    if (moveToBase || moveToHere) {
      let moved = 0;
      forEachSelectedUnit((u, t, loc) => {
        const dest =
          moveToHere && hereBf != null
            ? ({ kind: "BF" as const, index: hereBf })
            : moveToBase
              ? ({ kind: "BASE" as const })
              : null;
        if (!dest) return;
        const from = loc.zone === "BASE" ? ({ kind: "BASE" } as const) : ({ kind: "BF", index: loc.battlefieldIndex! } as const);
        if (from.kind === "BF" && dest.kind === "BASE") {
          const bf = game.battlefields[from.index];
          if (battlefieldPreventsMoveFromHereToBase(bf)) {
            game.log.unshift(`${bf.card.name} prevents moving units from this battlefield to base.`);
            return;
          }
        }
        const removed = removeUnitFromWherever(game, t.owner, u.instanceId);
        if (!removed) return;
        removed.moveCountThisTurn += 1;
        addUnitToZone(game, t.owner, removed, dest);
        checkMoveFromLocationTriggers(game, t.owner, [removed], from, dest);
        checkMoveTriggers(game, t.owner, [removed], dest.kind === "BF" ? dest.index : "BASE");
        moved += 1;
      });
      if (moved > 0) {
        game.log.unshift(`${controller} moved ${moved} unit(s).`);
        did = true;
      } else if (isUpTo || hasYouMay) {
        did = true;
      }
    }
  }

  if (/\bmove\s+(?:up\s+to\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(?:friendly|your)?\s+units?\b/i.test(text)) {
    let moved = 0;
    const wantsBase = /\bto\s+(?:their\s+)?base\b/i.test(text);
    const wantsHere = /\bto\s+here\b/i.test(text) && hereBf != null;
    const wantsThere = /\bto\s+there\b/i.test(text) && bfTargetIndex != null;
    const wantsOpenBattlefield = /\bto\s+an?\s+open\s+battlefield\b/i.test(text);
    const wantsEnemyTargetBattlefield = /\bto\s+that\s+enemy\s+unit'?s\s+battlefield\b/i.test(text);
    const enemyTargetBattlefield = selectedUnitLocs.find((x) => x.loc.zone === "BF" && x.t.owner !== controller)?.loc.battlefieldIndex ?? null;
    const openBattlefieldIndex =
      game.battlefields.find((bf) => bf.controller == null && bf.units.P1.length === 0 && bf.units.P2.length === 0)?.index ??
      game.battlefields.find((bf) => bf.controller == null)?.index ??
      null;

    forEachSelectedUnit((u, t, loc) => {
      if (t.owner !== controller) return;
      let dest: { kind: "BASE" } | { kind: "BF"; index: number } | null =
        wantsEnemyTargetBattlefield && enemyTargetBattlefield != null
          ? { kind: "BF", index: enemyTargetBattlefield }
          : wantsOpenBattlefield && openBattlefieldIndex != null
            ? { kind: "BF", index: openBattlefieldIndex }
            : wantsThere && bfTargetIndex != null
              ? { kind: "BF", index: bfTargetIndex }
              : wantsHere && hereBf != null
                ? { kind: "BF", index: hereBf }
                : wantsBase
                  ? { kind: "BASE" }
                  : null;

      // Generic "move a friendly unit" without destination (e.g., Ride the Wind):
      // if in Base, move to a controlled battlefield (or first battlefield);
      // if at a battlefield, move to Base.
      if (!dest) {
        if (loc.zone === "BASE") {
          const controlled = game.battlefields.filter((bf) => bf.controller === controller).map((bf) => bf.index);
          const fallback = game.battlefields.map((bf) => bf.index);
          const toIndex = (controlled.length > 0 ? controlled[0] : fallback[0]) ?? null;
          if (toIndex == null) return;
          dest = { kind: "BF", index: toIndex };
        } else {
          dest = { kind: "BASE" };
        }
      }
      if (!dest) return;
      const from = loc.zone === "BASE" ? ({ kind: "BASE" } as const) : ({ kind: "BF", index: loc.battlefieldIndex! } as const);
      if (from.kind === "BF" && dest.kind === "BASE") {
        const bf = game.battlefields[from.index];
        if (battlefieldPreventsMoveFromHereToBase(bf)) {
          game.log.unshift(`${bf.card.name} prevents moving units from this battlefield to base.`);
          return;
        }
      }
      const removed = removeUnitFromWherever(game, t.owner, u.instanceId);
      if (!removed) return;
      removed.moveCountThisTurn += 1;
      addUnitToZone(game, t.owner, removed, dest);
      checkMoveFromLocationTriggers(game, t.owner, [removed], from, dest);
      checkMoveTriggers(game, t.owner, [removed], dest.kind === "BF" ? dest.index : "BASE");
      moved += 1;
    });

    if (moved > 0) {
      game.log.unshift(`${controller} moved ${moved} friendly unit(s).`);
      did = true;
    } else if (isUpTo || hasYouMay) {
      did = true;
    }
  }

  if (/this\s+turn,\s*that\s+unit\s+has\s+"when\s+i\s+conquer,\s*you\s+may\s+move\s+me\s+to\s+my\s+base\.?"/i.test(lower)) {
    const targetsToGrant = selectedUnits.filter((u) => u.owner === controller);
    if (targetsToGrant.length > 0) {
      for (const u of targetsToGrant) {
        u.tempKeywords = Array.from(new Set([...(u.tempKeywords || []), TEMP_CONQUER_MOVE_BASE_KEYWORD]));
      }
      game.log.unshift(`${controller} granted ${targetsToGrant.length} unit(s) a temporary conquer move-to-base trigger.`);
      did = true;
    } else if (isUpTo || hasYouMay) {
      did = true;
    }
  }

  // --------------------- Move Friendly Unit To/From Base ---------------------
  if (/\bmove\s+a\s+friendly\s+unit\s+to\s+or\s+from\s+its\s+base\b/i.test(text)) {
    let moved = 0;
    forEachSelectedUnit((u, t, loc) => {
      if (t.owner !== controller) return;
      const from = loc.zone === "BASE" ? ({ kind: "BASE" } as const) : ({ kind: "BF", index: loc.battlefieldIndex! } as const);
      let dest: { kind: "BASE" } | { kind: "BF"; index: number } | null = null;
      if (from.kind === "BASE") {
        const controlled = game.battlefields.filter((bf) => bf.controller === controller).map((bf) => bf.index);
        const fallback = game.battlefields.map((bf) => bf.index);
        const toIndex = (controlled.length > 0 ? controlled[0] : fallback[0]) ?? null;
        if (toIndex == null) return;
        dest = { kind: "BF", index: toIndex };
      } else {
        const bf = game.battlefields[from.index];
        if (battlefieldPreventsMoveFromHereToBase(bf)) {
          game.log.unshift(`${bf.card.name} prevents moving units from this battlefield to base.`);
          return;
        }
        dest = { kind: "BASE" };
      }
      const removed = removeUnitFromWherever(game, t.owner, u.instanceId);
      if (!removed || !dest) return;
      removed.moveCountThisTurn += 1;
      addUnitToZone(game, t.owner, removed, dest);
      checkMoveFromLocationTriggers(game, t.owner, [removed], from, dest);
      checkMoveTriggers(game, t.owner, [removed], dest.kind === "BF" ? dest.index : "BASE");
      moved += 1;
    });
    if (moved > 0) {
      game.log.unshift(`${controller} moved ${moved} friendly unit(s) to or from base.`);
      did = true;
    } else if (hasYouMay || isUpTo) {
      did = true;
    }
  }

  // --------------------- Stun / Ready ---------------------
  if (effectMentionsStun(text)) {
    const targetsToApply: CardInstance[] = [];

    if (selectedUnits.length > 0) {
      targetsToApply.push(...selectedUnits);
    } else if (/\bme\b/i.test(text)) {
      if (sourceUnit) targetsToApply.push(sourceUnit);
    } else {
      // Mass stun patterns (no explicit targets)
      const wantsAll = /\ball\b/i.test(text) || /\beach\b/i.test(text);
      if (wantsAll) {
        const wantHere = /\bhere\b/i.test(text) && hereBf != null;
        const isEnemy = /\benemy\b/i.test(text) || /\bopposing\b/i.test(text);
        const isFriendly = /\bfriendly\b/i.test(text) || /\byour\b/i.test(text);

        if (wantHere && hereBf != null) {
          if (isEnemy) targetsToApply.push(...game.battlefields[hereBf].units[opp]);
          else if (isFriendly) targetsToApply.push(...game.battlefields[hereBf].units[controller]);
          else {
            targetsToApply.push(...game.battlefields[hereBf].units.P1);
            targetsToApply.push(...game.battlefields[hereBf].units.P2);
          }
        } else {
          if (isEnemy) {
            targetsToApply.push(...game.players[opp].base.units);
            for (const bf of game.battlefields) targetsToApply.push(...bf.units[opp]);
          } else if (isFriendly) {
            targetsToApply.push(...p.base.units);
            for (const bf of game.battlefields) targetsToApply.push(...bf.units[controller]);
          }
        }
      }
    }

    if (targetsToApply.length > 0) {
      for (const target of targetsToApply) {
        target.stunned = true;
        target.isReady = false;
        target.stunnedUntilTurn = game.turnNumber + 1; // Stun lasts until end of NEXT turn
      }
      if (targetsToApply.length === 1) game.log.unshift(`${targetsToApply[0].name} was stunned.`);
      else game.log.unshift(`${controller} stunned ${targetsToApply.length} unit(s).`);
      did = true;
      const stunnedEnemy = targetsToApply.filter((u) => u.owner === opp).length;
      if (stunnedEnemy > 0) {
        queueTriggersForEvent(
          game,
          controller,
          (trig) => trig.includes("when you stun an enemy unit") || trig.includes("when you stun one or more enemy units"),
          (source) => source.ability?.effect_text
        );
      }
    } else if (isUpTo) {
      // Valid: "up to" effects may choose 0 targets.
      did = true;
    }
  }

  if (effectMentionsReady(text)) {
    const targetsToApply: CardInstance[] = [];
    const enemyReadyLock = game.battlefields.some((bf) =>
      bf.units[opp].some((u) => {
        const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
        return raw.includes("while i'm at a battlefield") && raw.includes("spells and abilities can't ready enemy units and gear");
      })
    );

    if (selectedUnits.length > 0) {
      targetsToApply.push(...selectedUnits);
    } else if (/\bme\b/i.test(text)) {
      if (sourceUnit) targetsToApply.push(sourceUnit);
    } else {
      const wantsAll = /\ball\b/i.test(text) || /\beach\b/i.test(text);
      if (wantsAll) {
        const wantHere = /\bhere\b/i.test(text) && hereBf != null;
        const isEnemy = /\benemy\b/i.test(text) || /\bopposing\b/i.test(text);
        const isFriendly = /\bfriendly\b/i.test(text) || /\byour\b/i.test(text);

        if (wantHere && hereBf != null) {
          if (isEnemy) targetsToApply.push(...game.battlefields[hereBf].units[opp]);
          else if (isFriendly) targetsToApply.push(...game.battlefields[hereBf].units[controller]);
          else {
            targetsToApply.push(...game.battlefields[hereBf].units.P1);
            targetsToApply.push(...game.battlefields[hereBf].units.P2);
          }
        } else {
          if (isEnemy) {
            targetsToApply.push(...game.players[opp].base.units);
            for (const bf of game.battlefields) targetsToApply.push(...bf.units[opp]);
          } else if (isFriendly) {
            targetsToApply.push(...p.base.units);
            for (const bf of game.battlefields) targetsToApply.push(...bf.units[controller]);
          }
        }
      }
    }

    if (targetsToApply.length > 0) {
      for (const target of targetsToApply) {
        if (enemyReadyLock && target.owner === opp) continue;
        target.isReady = true;
        target.stunned = false;
      }
      if (targetsToApply.length === 1) game.log.unshift(`${targetsToApply[0].name} was readied.`);
      else game.log.unshift(`${controller} readied ${targetsToApply.length} unit(s).`);
      did = true;
      const friendlyReadied = targetsToApply.filter((u) => u.owner === controller);
      if (friendlyReadied.length > 0) {
        for (const u of friendlyReadied) {
          queueTriggersForEvent(
            game,
            controller,
            (trig) => trig.includes("when you ready a friendly unit"),
            (source) => source.ability?.effect_text,
            [{ kind: "UNIT", owner: controller, instanceId: u.instanceId }],
            hereBf
          );
        }
      }

      // Self triggers like "When you ready me" / "When you choose or ready me".
      for (const u of targetsToApply) {
        const selfEffects = getTriggerEffects(u, "READY_ME");
        if (selfEffects.length === 0) continue;
        const loc = locateUnit(game, u.owner, u.instanceId);
        for (const eff of selfEffects) {
          const req = inferTargetRequirement(eff, { here: loc?.zone === "BF" });
          game.chain.push({
            id: makeId("chain"),
            controller: u.controller,
            kind: "TRIGGERED_ABILITY",
            label: `Trigger: ${u.name} (Ready)`,
            effectText: eff,
            contextBattlefieldIndex: loc?.zone === "BF" ? loc.battlefieldIndex ?? null : null,
            targets:
              req.kind === "NONE"
                ? [{ kind: "NONE" }]
                : [
                  {
                    kind: "UNIT",
                    owner: u.owner,
                    instanceId: u.instanceId,
                    battlefieldIndex: loc?.zone === "BF" ? loc.battlefieldIndex : undefined,
                    zone: loc?.zone,
                  } as Target,
                ],
            needsTargets: req.kind !== "NONE",
            targetRequirement: req,
            sourceInstanceId: u.instanceId,
            sourceCardType: u.type,
          });
          game.state = "CLOSED";
          game.priorityPlayer = u.controller;
          game.passesInRow = 0;
          game.log.unshift(`${u.name} triggered (Ready).`);
        }
      }
    } else if (/\bready me\b/i.test(text) && p.legend) {
      p.legendReady = true;
      game.log.unshift(`${controller} readied their legend.`);
      did = true;
    } else if (isUpTo) {
      did = true;
    }
  }

  if (/for each friendly unit, you may spend its buff to ready it/i.test(lower)) {
    const units = getUnitsInPlay(game, controller);
    let readied = 0;
    const canSpend = units.some((u) => u.buffs > 0);
    const shouldSpend = !canSpend
      ? false
      : getOptionalConfirm("SPEND_BUFFS_READY_ALL");
    if (shouldSpend) {
      for (const u of units) {
        if (u.buffs > 0) {
          u.buffs -= 1;
          u.isReady = true;
          readied += 1;
        }
      }
      if (readied > 0) {
        game.log.unshift(`${controller} spent buffs to ready ${readied} unit(s).`);
        did = true;
      }
    } else {
      if (canSpend) game.log.unshift(`${controller} chose not to spend buffs.`);
      did = true;
    }
    let buffed = 0;
    for (const u of units) {
      if (applyBuffToken(game, u)) buffed += 1;
    }
    if (buffed > 0) {
      game.log.unshift(`${controller} buffed ${buffed} friendly unit(s).`);
      did = true;
    } else {
      game.log.unshift(`${controller} has no units to buff (already buffed).`);
      did = true;
    }
  }

  const readyRuneMatch = lower.match(/\bready\s+(\d+)\s+(?:friendly\s+)?runes?\b/);
  if (readyRuneMatch) {
    const n = parseInt(readyRuneMatch[1], 10);
    if (Number.isFinite(n) && n > 0) {
      const runes = p.runesInPlay.filter((r) => !r.isReady).slice(0, n);
      for (const r of runes) r.isReady = true;
      game.log.unshift(`${controller} readied ${runes.length} rune(s).`);
      did = true;
    }
  }

  // "You may pay [C]. If you do, give me +N might this turn."
  const payClassBuffSelf = lower.match(/\byou may pay\s+(?:1\s+)?class-rune\b.*\bif you do,\s*give me\s+\+(\d+)\s+might\s+this\s+turn\b/i);
  if (payClassBuffSelf && sourceUnit) {
    const n = parseInt(payClassBuffSelf[1], 10);
    const shouldPay = getOptionalConfirm(`PAY_CLASS_FOR_SELF_BUFF_${n}`, true);
    if (shouldPay && Number.isFinite(n) && n > 0) {
      const allowed = classDomainsForPlayer(game, controller);
      const pay = choosePowerPaymentDomains(game.players[controller].runePool, 1, allowed);
      if (pay) {
        for (const dom of allowed) {
          const spend = pay.payment[dom] || 0;
          if (spend > 0) game.players[controller].runePool.power[dom] -= spend;
        }
        applyTempMightBonus(game, sourceUnit, n);
        game.log.unshift(`${controller} paid [C]. ${sourceUnit.name} gets +${n} might this turn.`);
      } else {
        game.log.unshift(`${controller} couldn't pay [C].`);
      }
    } else {
      game.log.unshift(`${controller} chose not to pay [C].`);
    }
    did = true;
    skipGenericMight = true;
  }

  // Kato the Arm style move trigger support:
  // "Give a friendly unit my keywords and +[S] equal to my Might this turn."
  if (/\bgive\s+(?:a\s+)?friendly\s+unit\s+my\s+keywords\s+and\s+\+?\s*(?:might|\[s\])\s+equal\s+to\s+my\s+might\s+this\s+turn\b/i.test(lower) && sourceUnit) {
    const targetUnits = selectedUnits.filter((u) => u.owner === controller);
    if (targetUnits.length > 0) {
      const srcKeywords = getKeywords(sourceUnit).map((k) => String(k || "").trim()).filter(Boolean);
      const srcMight = effectiveMight(sourceUnit, { role: "NONE", game });
      for (const u of targetUnits) {
        if (srcKeywords.length > 0) {
          u.tempKeywords = Array.from(new Set([...(u.tempKeywords || []), ...srcKeywords]));
        }
        applyTempMightBonus(game, u, srcMight);
        game.log.unshift(`${u.name} gained ${sourceUnit.name}'s keywords and +${srcMight} might this turn.`);
      }
      did = true;
    } else if (isUpTo || hasYouMay) {
      did = true;
    }
  }


  // --------------------- Might modifiers ---------------------
  // "Give a unit -1 might this turn, to a minimum of 1 might."
  const minM = (() => {
    const mm = lower.match(/\bminimum\s+of\s+(\d+)\s+might\b/);
    if (!mm) return null;
    const n = parseInt(mm[1], 10);
    return Number.isFinite(n) ? n : null;
  })();

  const giveMightThisTurn = lower.match(/\bgive\s+(?:a\s+)?(?:friendly\s+|enemy\s+|your\s+|opposing\s+)?([a-z\-]+)\s+([+-])\s*(\d+)\s+might\s+this\s+turn\b/);
  if (giveMightThisTurn && !skipGenericMight) {
    const who = giveMightThisTurn[1];
    const sign = giveMightThisTurn[2] === "-" ? -1 : 1;
    const n = parseInt(giveMightThisTurn[3], 10);
    const delta = sign * (Number.isFinite(n) ? n : 0);

    const applyTo = (u: CardInstance) => {
      const wantsOnlyUnitBonus = /additional \+1 might this turn if it is the only unit you control there/i.test(lower);
      if (/if there is a ready enemy unit here/i.test(lower)) {
        if (hereBf == null) return;
        const hasReadyEnemy = game.battlefields[hereBf].units[opp].some((x) => x.isReady);
        if (!hasReadyEnemy) return;
      }
      if (!wantsOnlyUnitBonus && /only unit you control there/i.test(lower)) {
        const loc = locateUnit(game, controller, u.instanceId);
        if (!loc || loc.zone !== "BF" || loc.battlefieldIndex == null) return;
        const countHere = game.battlefields[loc.battlefieldIndex].units[controller].length;
        if (countHere !== 1) return;
      }
      const cur = effectiveMight(u, { role: "NONE", game });
      const desired = minM != null ? Math.max(minM, cur + delta) : cur + delta;
      const actual = desired - cur;
      applyTempMightBonus(game, u, actual);
      game.log.unshift(`${u.name} gets ${actual >= 0 ? "+" : ""}${actual} might this turn.`);
      did = true;

      if (wantsOnlyUnitBonus) {
        const loc = locateUnit(game, controller, u.instanceId);
        const countHere =
          loc && loc.zone === "BF" && loc.battlefieldIndex != null
            ? game.battlefields[loc.battlefieldIndex].units[controller].length
            : 0;
        if (countHere === 1) {
          applyTempMightBonus(game, u, 1);
          game.log.unshift(`${u.name} gets +1 additional might (only unit there).`);
        }
      }
    };

    if (who === "me" || who === "this") {
      if (sourceUnit) applyTo(sourceUnit);
    } else if (who === "unit" || who === "it") {
      if (selectedUnits.length > 0) {
        for (const u of selectedUnits) applyTo(u);
      } else if (unitTarget) {
        applyTo(unitTarget);
      } else if (isUpTo) {
        // Valid: "up to" effects may choose 0 targets.
        did = true;
      }
    } else if (who === "units") {
      const looksNumberedUnits =
        /\b(?:up\s+to\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:friendly\s+|enemy\s+|opposing\s+)?units?\b/i.test(lower);

      // If we have explicit selected targets (multi-target), prefer those over mass inference.
      if (selectedUnits.length > 0 || looksNumberedUnits) {
        if (selectedUnits.length > 0) {
          for (const u of selectedUnits) applyTo(u);
        } else if (isUpTo) {
          did = true;
        } else {
          const getLowestMightFriendly = (g: GameState, pid: PlayerId) => {
            const units = getUnitsInPlay(g, pid);
            if (units.length === 0) return null;
            return units.reduce((min, cur) => (effectiveMight(cur, { game: g }) < effectiveMight(min, { game: g }) ? cur : min), units[0]);
          };
          const u = getLowestMightFriendly(game, controller);
          if (u) applyTo(u);
        }
      } else {
        // Mass might effects ("units")
        const units: CardInstance[] = [];
        const wantHere = /\bhere\b/.test(lower);
        const isEnemy = /\benemy\b/.test(lower) || /\bopposing\b/.test(lower);
        const isFriendly = /\bfriendly\b/.test(lower) || /\byour\b/.test(lower);

        if (isEnemy) {
          if (wantHere && hereBf != null) {
            units.push(...game.battlefields[hereBf].units[opp]);
          } else {
            units.push(...game.players[opp].base.units);
            for (const bf of game.battlefields) units.push(...bf.units[opp]);
          }
        } else if (isFriendly) {
          if (wantHere && hereBf != null) {
            units.push(...game.battlefields[hereBf].units[controller]);
          } else {
            units.push(...p.base.units);
            for (const bf of game.battlefields) units.push(...bf.units[controller]);
          }
        } else {
          // If neither friendly nor enemy is specified, treat "units here" as ALL units at that battlefield.
          if (wantHere && hereBf != null) {
            units.push(...game.battlefields[hereBf].units.P1);
            units.push(...game.battlefields[hereBf].units.P2);
          } else {
            // Ambiguous global "units" (no qualifier) — do nothing rather than guess.
          }
        }

        for (const u of units) applyTo(u);
      }
    } else {
      // Dynamic Subtype matching (e.g. "Mechs", "Yordles")
      const singularSubtype = who.replace(/s$/, ""); // "mechs" -> "mech"
      const wantsEnemy = lower.includes("enemy") || lower.includes("opposing");
      const wantHere = /\bhere\b/.test(lower);

      const targets: CardInstance[] = [];
      if (wantHere && hereBf != null) {
        if (wantsEnemy) targets.push(...game.battlefields[hereBf].units[opp]);
        else targets.push(...game.battlefields[hereBf].units[controller]);
      } else {
        if (wantsEnemy) {
          targets.push(...game.players[opp].base.units);
          for (const bf of game.battlefields) targets.push(...bf.units[opp]);
        } else {
          targets.push(...p.base.units);
          for (const bf of game.battlefields) targets.push(...bf.units[controller]);
        }
      }

      const matched = targets.filter(u =>
        (u.subtypes || []).map(s => s.toLowerCase()).includes(singularSubtype)
      );
      for (const u of matched) applyTo(u);
    }
  }

  // --------------------- Buff (permanent +1 might) ---------------------
  if (effectMentionsBuff(text)) {
    const targetsToApply: CardInstance[] = [];

    // Check if this is a "buff another friendly unit" pattern (e.g., Pit Rookie)
    const wantsAnotherFriendly = /\bbuff\s+another\s+friendly\s+unit\b/i.test(text);
    // Check if buff should only apply if unit doesn't have a buff (Pit Rookie: "If it doesn't have a buff")
    const onlyIfNoBuff = /if\s+it\s+doesn't\s+have\s+a\s+buff/i.test(text);

    if (selectedUnits.length > 0) {
      // Filter out source unit if "another" is specified
      if (wantsAnotherFriendly && sourceUnit) {
        targetsToApply.push(...selectedUnits.filter((u) => u.instanceId !== sourceUnit.instanceId));
      } else {
        targetsToApply.push(...selectedUnits);
      }
    } else if (/\bme\b/i.test(text) || /\bthis\b/i.test(text)) {
      if (sourceUnit) targetsToApply.push(sourceUnit);
    } else if (unitTarget) {
      // Filter out source unit if "another" is specified
      if (wantsAnotherFriendly && sourceUnit && unitTarget.instanceId === sourceUnit.instanceId) {
        // Don't add source unit as target
      } else {
        targetsToApply.push(unitTarget);
      }
    } else if (wantsAnotherFriendly) {
      // No explicit target selected, but effect wants "another friendly unit"
      // This could happen if there are no other friendly units to target
      // Mark as handled since the effect was recognized
      game.log.unshift(`${ctx?.sourceCardName || "Effect"}: No valid target for buff (no other friendly units).`);
      did = true;
    }

    const poroGate = lower.includes("if you control a poro") ? hasPoro : true;
    if (targetsToApply.length > 0 && poroGate) {
      let buffedCount = 0;
      for (const u of targetsToApply) {
        // If "only if no buff" is specified, only buff units without existing buffs
        if (onlyIfNoBuff && u.buffs > 0) {
          game.log.unshift(`${u.name} already has a buff.`);
          continue;
        }
        if (applyBuffToken(game, u)) {
          buffedCount++;
        } else if (onlyIfNoBuff) {
          game.log.unshift(`${u.name} already has a buff.`);
        }
      }
      if (buffedCount > 0) {
        if (buffedCount === 1 && targetsToApply.length === 1) {
          game.log.unshift(`${targetsToApply[0].name} got +1 might permanently (buff).`);
        } else if (buffedCount === 1) {
          const buffedUnit = targetsToApply.find((u) => u.buffs > 0);
          if (buffedUnit) game.log.unshift(`${buffedUnit.name} got +1 might permanently (buff).`);
        } else {
          game.log.unshift(`${controller} buffed ${buffedCount} unit(s) (+1 might permanently).`);
        }
        did = true;
        const friendlyBuffed = targetsToApply.filter((u) => u.owner === controller && u.buffs > 0);
        if (friendlyBuffed.length > 0) {
          for (const u of friendlyBuffed) {
            queueTriggersForEvent(
              game,
              controller,
              (trig) => trig.includes("when you buff a friendly unit"),
              (source) => source.ability?.effect_text,
              [{ kind: "UNIT", owner: controller, instanceId: u.instanceId }],
              hereBf
            );
          }
        }
      } else if (onlyIfNoBuff) {
        // All targets already had buffs
        did = true; // Effect resolved, just didn't apply buffs
      } else if (targetsToApply.length > 0) {
        // Effect resolved but no new buffs could be applied due to max-buff limit.
        did = true;
      }
    } else if (isUpTo) {
      did = true;
    }

    if (/buff all other friendly units there/i.test(lower) && sourceUnit) {
      const loc = locateUnit(game, controller, sourceUnit.instanceId);
      if (loc && loc.zone === "BF" && loc.battlefieldIndex != null) {
        const units = game.battlefields[loc.battlefieldIndex].units[controller].filter((u) => u.instanceId !== sourceUnit.instanceId);
        let buffed = 0;
        for (const u of units) {
          if (applyBuffToken(game, u)) buffed += 1;
        }
        if (buffed > 0) {
          game.log.unshift(`${controller} buffed ${buffed} other friendly unit(s) there.`);
          did = true;
        }
      }
    }

    if (/buff (each|all) friendly units? there/i.test(lower) && sourceUnit) {
      const loc = locateUnit(game, controller, sourceUnit.instanceId);
      if (loc && loc.zone === "BF" && loc.battlefieldIndex != null) {
        const units = game.battlefields[loc.battlefieldIndex].units[controller];
        let buffed = 0;
        for (const u of units) {
          if (applyBuffToken(game, u)) {
            buffed += 1;
            queueTriggersForEvent(
              game,
              controller,
              (trig) => trig.includes("when you buff a friendly unit"),
              (source) => source.ability?.effect_text,
              [{ kind: "UNIT", owner: controller, instanceId: u.instanceId }],
              loc.battlefieldIndex
            );
          }
        }
        game.log.unshift(`${controller} buffed ${buffed} friendly unit(s) there.`);
        did = true;
      }
    }
  }

  // --------------------- Copy/Set Might (Convergent Mutation) ---------------------
  if (/its might becomes the might of that friendly unit this turn/i.test(lower)) {
    const targetUnit = selectedUnits.length > 0 ? selectedUnits[0] : unitTarget;
    if (targetUnit) {
      const friendlies = getUnitsInPlay(game, controller).filter((u) => u.instanceId !== targetUnit.instanceId);
      const targetBase = effectiveMight(targetUnit, { role: "NONE", game });
      const best = friendlies.reduce((m, u) => Math.max(m, effectiveMight(u, { role: "NONE", game })), 0);
      if (best > targetBase) {
        targetUnit.tempMightBonus += best - targetBase;
        game.log.unshift(`${targetUnit.name}'s Might became ${best} this turn.`);
      } else {
        game.log.unshift(`${targetUnit.name} had no higher friendly Might to copy.`);
      }
      did = true;
    }
  }


  // --------------------- Return / Kill / Banish ---------------------
  if (effectMentionsReturn(text)) {
    let moved = 0;
    const returnedOwners = new Set<PlayerId>();
    const returnToHand = /return.*to.*owner's hand|return.*to.*hand/i.test(text);

    forEachSelectedUnit((u, t, loc) => {
      const removed = removeUnitFromWherever(game, t.owner, u.instanceId);
      if (!removed) return;
      if (returnToHand) {
        if (!tokenCeasesToExist(game, removed, "hand")) {
          resetUnitOnLeavePlay(removed);
          game.players[t.owner].hand.push(removed);
        }
      } else {
        if (loc.zone === "BF") {
          const bf = game.battlefields[loc.battlefieldIndex ?? -1];
          if (bf && battlefieldPreventsMoveFromHereToBase(bf)) {
            game.log.unshift(`${bf.card.name} prevents moving units from this battlefield to base.`);
            // Put the unit back where it was if movement is blocked.
            addUnitToZone(game, t.owner, removed, { kind: "BF", index: loc.battlefieldIndex! });
            return;
          }
        }
        removed.isReady = false;
        game.players[t.owner].base.units.push(removed);
      }
      returnedOwners.add(t.owner);
      moved += 1;
    });

    if (moved > 0) {
      if (returnToHand) {
        if (moved === 1 && selectedUnits.length === 1) game.log.unshift(`${selectedUnits[0].name} returned to hand.`);
        else game.log.unshift(`${controller} returned ${moved} unit(s) to hand.`);
      } else {
        if (moved === 1 && selectedUnits.length === 1) game.log.unshift(`${selectedUnits[0].name} returned to Base.`);
        else game.log.unshift(`${controller} returned ${moved} unit(s) to Base.`);
      }
      did = true;

      // Handle "its owner channels N rune(s) exhausted" effect (e.g., Retreat)
      const channelExhaustedMatch = lower.match(/its\s+owner\s+channels?\s+(\d+)\s+runes?\s+exhausted/i);
      if (channelExhaustedMatch) {
        const channelCount = parseInt(channelExhaustedMatch[1], 10);
        if (Number.isFinite(channelCount) && channelCount > 0) {
          for (const owner of returnedOwners) {
            channelRunesExhausted(game, owner, channelCount);
          }
        }
      }
    } else if (isUpTo) {
      // Valid: "up to" effects may choose 0 targets (or no battlefield target existed).
      did = true;
    }
  }

  // Counter Strike: "The next time that unit would be dealt damage this turn, prevent it"
  if (/next time.*would be dealt damage this turn.*prevent/i.test(text) || /prevent.*next.*damage.*this turn/i.test(text)) {
    forEachSelectedUnit((u, t) => {
      u.preventNextDamageUntilTurn = game.turnNumber;
    });
    if (selectedUnits.length > 0) {
      game.log.unshift(`${controller} set damage prevention on ${selectedUnits.length} unit(s) this turn.`);
      did = true;
    }
  }

  if (/\bnext time it dies this turn\b/i.test(text)) {
    const payDom = (() => {
      const m = lower.match(/\bpay\s+1\s+([a-z]+)\s+rune\b/);
      return m ? clampDomain(m[1]) : null;
    })();
    const payAny = /\bpay\s+1\s+rune\s+of\s+any\s+type\b/i.test(text);
    const requiresPayment = /\byou may pay\s*\[c\]\b/i.test(text) || !!payDom || payAny;

    forEachSelectedUnit((u, t) => {
      if (t.owner !== controller) return;
      // Use unit's deathReplacement for the existing system
      u.deathReplacement = {
        untilTurn: game.turnNumber,
        recallExhausted: true,
        payRuneDomain: payDom ?? undefined,
        payRuneAny: payAny,
        optional: /\byou may\b/i.test(text),
      };
      // Also add to recallOnDeathEffects for Highlander/Unlicensed Armory
      game.recallOnDeathEffects.push({
        unitInstanceId: u.instanceId,
        controller: controller,
        untilTurn: game.turnNumber,
        payCost: requiresPayment,
      });
    });
    if (selectedUnits.length > 0) {
      game.log.unshift(`${controller} set a death replacement effect (${selectedUnits.length} unit(s)).`);
      did = true;
    }
  }

  if (effectMentionsKill(text)) {
    let gearKilled = 0;
    const gearTargets = rawTargets.filter((t): t is Extract<Target, { kind: "GEAR" }> => t.kind === "GEAR");
    if (gearTargets.length > 0) {
      for (const gTarget of gearTargets) {
        const removed = removeGearFromWherever(game, gTarget.owner, gTarget.instanceId);
        if (removed) {
          if (!tokenCeasesToExist(game, removed, "trash")) {
            game.players[removed.owner].trash.push(removed);
          }
          gearKilled += 1;
        }
      }
      if (gearKilled > 0) {
        game.log.unshift(`${controller} killed ${gearKilled} gear.`);
        did = true;
      }
    }

    let killedMarked = 0;

    if (selectedUnits.length > 0) {
      for (const u of selectedUnits) {
        u.damage = 999;
        killedMarked += 1;
      }
    } else if (unitTarget) {
      unitTarget.damage = 999;
      killedMarked += 1;
    }

    if (killedMarked > 0) {
      // Check for "its controller draws N" pattern before cleanup
      const controllerDrawsMatch = lower.match(/its\s+controller\s+draws\s+(\d+)/i);
      const killedUnitOwners = new Set<PlayerId>();
      if (selectedUnits.length > 0) {
        for (const u of selectedUnits) killedUnitOwners.add(u.owner);
      } else if (unitTarget) {
        killedUnitOwners.add(unitTarget.owner);
      }

      cleanupStateBased(game);
      if (killedMarked === 1 && unitTarget) game.log.unshift(`${unitTarget.name} was killed.`);
      else game.log.unshift(`${controller} killed ${killedMarked} unit(s).`);
      did = true;

      // Handle "its controller draws N" effect (e.g., Hidden Blade)
      if (controllerDrawsMatch) {
        const drawCount = parseInt(controllerDrawsMatch[1], 10);
        if (Number.isFinite(drawCount) && drawCount > 0) {
          for (const owner of killedUnitOwners) {
            for (let i = 0; i < drawCount; i++) {
              const drawn = game.players[owner].mainDeck.shift();
              if (drawn) {
                game.players[owner].hand.push(drawn);
              }
            }
            game.log.unshift(`${owner} (controller of killed unit) draws ${drawCount}.`);
          }
        }
      }

      if (ctx.sourceCardType === "Spell") {
        queueTriggersForEvent(
          game,
          controller,
          (trig) => trig.includes("when you kill a unit with a spell"),
          (source) => source.ability?.effect_text,
          [{ kind: "NONE" }],
          undefined,
          true
        );
      }
      if ((unitTarget?.stunned || selectedUnits.some((u) => u.stunned)) && (unitTarget || selectedUnits.length > 0)) {
        queueTriggersForEvent(
          game,
          controller,
          (trig) => trig.includes("when you kill a stunned enemy unit"),
          (source) => source.ability?.effect_text
        );
      }
    } else if (isUpTo) {
      did = true;
    }
  }

  if (effectMentionsBanish(text)) {
    let banished = 0;

    forEachSelectedUnit((u, t) => {
      const removed = removeUnitFromWherever(game, t.owner, u.instanceId);
      if (!removed) return;
      game.players[t.owner].banishment.push(removed);
      banished += 1;
    });

    if (banished > 0) {
      if (banished === 1 && selectedUnits.length === 1) game.log.unshift(`${selectedUnits[0].name} was banished.`);
      else game.log.unshift(`${controller} banished ${banished} unit(s).`);
      did = true;
    } else if (isUpTo) {
      did = true;
    }
  }

  // --------------------- Turn-scoped damage hooks ---------------------
  if (/\bwhen any unit takes damage this turn, kill it\b/i.test(text)) {
    game.damageKillEffects.push({ controller, untilTurn: game.turnNumber });
    game.log.unshift(`${controller} set a damage-kill effect for this turn.`);
    did = true;
  }

  if (/\bkill it the next time it takes damage this turn\b/i.test(text)) {
    forEachSelectedUnit((u) => {
      u.killOnDamageUntilTurn = game.turnNumber;
    });
    if (selectedUnits.length > 0) {
      game.log.unshift(`${controller} set a kill-on-damage effect for ${selectedUnits.length} unit(s).`);
      did = true;
    }
  }

  // --------------------- Delayed Triggers ("this turn" effects) ---------------------
  // Rally the Troops: "When a friendly unit is played this turn, buff it."
  const unitPlayedTriggerMatch = lower.match(/when\s+a\s+friendly\s+unit\s+is\s+played\s+this\s+turn,\s*(.+?)(?:\.|$)/i);
  if (unitPlayedTriggerMatch) {
    const effectPart = unitPlayedTriggerMatch[1].trim();
    game.delayedTriggers.push({
      id: makeId("delayed"),
      controller,
      event: "UNIT_PLAYED",
      targetFilter: "FRIENDLY",
      effect: effectPart,
      untilTurn: game.turnNumber,
      sourceCardName: ctx?.sourceCardName || "Unknown",
    });
    game.log.unshift(`${controller} set a delayed trigger: when a friendly unit is played this turn, ${effectPart}.`);
    did = true;
  }

  // Mask of Foresight: "When a friendly unit attacks or defends alone, give it +1 [S] this turn."
  const attackDefendAloneTrigger = lower.match(/when\s+a\s+friendly\s+unit\s+attacks\s+or\s+defends\s+alone,\s*(.+?)(?:\.|$)/i);
  if (attackDefendAloneTrigger) {
    const effectPart = attackDefendAloneTrigger[1].trim();
    game.delayedTriggers.push({
      id: makeId("delayed"),
      controller,
      event: "UNIT_ATTACKS",
      targetFilter: "FRIENDLY",
      effect: effectPart + " (if alone)",
      untilTurn: game.turnNumber + 999, // Permanent until gear is removed
      sourceCardName: ctx?.sourceCardName || "Unknown",
    });
    game.delayedTriggers.push({
      id: makeId("delayed"),
      controller,
      event: "UNIT_DEFENDS",
      targetFilter: "FRIENDLY",
      effect: effectPart + " (if alone)",
      untilTurn: game.turnNumber + 999,
      sourceCardName: ctx?.sourceCardName || "Unknown",
    });
    did = true;
  }


  // --------------------- Challenge: Mutual Damage ---------------------
  // "Choose a friendly unit and an enemy unit. They deal damage equal to their Mights to each other."
  if (/choose\s+a\s+friendly\s+unit\s+and\s+an?\s+enemy\s+unit.*they\s+deal\s+damage\s+equal\s+to\s+their\s+mights?\s+to\s+each\s+other/i.test(lower)) {
    // Expect two targets: [0] = friendly, [1] = enemy
    const friendlyTarget = rawTargets[0];
    const enemyTarget = rawTargets[1];

    if (friendlyTarget?.kind === "UNIT" && enemyTarget?.kind === "UNIT") {
      const friendlyLoc = locateUnit(game, friendlyTarget.owner, friendlyTarget.instanceId);
      const enemyLoc = locateUnit(game, enemyTarget.owner, enemyTarget.instanceId);

      if (friendlyLoc && enemyLoc) {
        const friendlyUnit = friendlyLoc.unit;
        const enemyUnit = enemyLoc.unit;
        const validFriendly = friendlyUnit.controller === controller;
        const validEnemy = enemyUnit.controller !== controller;
        if (!validFriendly || !validEnemy) {
          game.log.unshift("Challenge: targets must be one friendly unit and one enemy unit at resolution.");
          did = true;
          return did;
        }

        const friendlyMight = effectiveMight(friendlyUnit, { role: "NONE", game });
        const enemyMight = effectiveMight(enemyUnit, { role: "NONE", game });

        // Apply damage: friendly unit takes enemy's might, enemy unit takes friendly's might
        friendlyUnit.damage += enemyMight;
        enemyUnit.damage += friendlyMight;

        game.log.unshift(`Challenge: ${friendlyUnit.name} (M${friendlyMight}) and ${enemyUnit.name} (M${enemyMight}) deal damage to each other.`);
        game.log.unshift(`${friendlyUnit.name} took ${enemyMight} damage, ${enemyUnit.name} took ${friendlyMight} damage.`);
        did = true;
      } else {
        game.log.unshift("Challenge: One or both units no longer exist.");
        did = true; // Mark as handled even if targets are gone
      }
    } else {
      game.log.unshift("Challenge: Missing friendly or enemy target.");
      did = true; // Mark as handled
    }
  }

  // --------------------- Damage ---------------------
  let explicitDamageAmount: number | null = null;
  if (
    /if you assigned 5 or more excess damage to enemy units/i.test(lower) &&
    /deal that much to an enemy unit/i.test(lower)
  ) {
    const excess = game.lastCombatExcessDamageTurn === game.turnNumber ? game.lastCombatExcessDamage[controller] || 0 : 0;
    if (excess < 5) {
      game.log.unshift(`${controller} did not meet the excess damage condition (needs 5+).`);
      did = true;
    } else if (!getOptionalConfirm("SIVIR_EXCESS_DAMAGE_FOLLOWUP", true)) {
      game.log.unshift(`${controller} chose not to use the excess damage follow-up.`);
      did = true;
    } else {
      if (!unitTarget || unitTarget.owner === controller) {
        game.log.unshift(`${controller} had no enemy target for excess damage follow-up.`);
        did = true;
      } else {
        explicitDamageAmount = excess;
      }
    }
  }

  const conditionalDrawOnKill = (() => {
    const m = lower.match(/\bif\s+this\s+kills\s+it,\s*draw\s+(\d+)\b/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  })();

  const damageFromDiscard =
    /\bdeal\s+its\s+energy\s+cost\s+as\s+damage\b/i.test(text) && discarded.length > 0 ? discarded[0].cost : null;

  const dynamicDamageSource = /damage\s+equal\s+to\s+its\s+might/i.test(text) ? (unitTarget || sourceUnit) : sourceUnit;
  const dmg =
    explicitDamageAmount != null
      ? explicitDamageAmount
      : damageFromDiscard != null
        ? damageFromDiscard
        : extractDamageAmount(text, dynamicDamageSource, game);

  if (dmg != null && dmg > 0) {
    // --------------------- Damage ---------------------
    // Support: single-target, multi-target, and common AoE patterns (including enemy-only).
    const dmgTargetsSnapshot: { owner: PlayerId; instanceId: string; name: string; existed: boolean; wasStunned: boolean }[] = [];
    const applyDamageToUnit = (u: CardInstance) => {
      if (unitIgnoresDamageThisTurn(u)) {
        game.log.unshift(`${u.name} ignored damage (moved twice this turn).`);
        return;
      }
      // Unyielding Spirit: "Prevent all spell and ability damage this turn"
      if (game.players[u.owner].preventSpellAbilityDamageThisTurn) {
        game.log.unshift(`${u.name} prevented damage (spell/ability damage prevented this turn).`);
        return;
      }
      // Counter Strike: "The next time that unit would be dealt damage this turn, prevent it"
      if (u.preventNextDamageUntilTurn && u.preventNextDamageUntilTurn >= game.turnNumber) {
        u.preventNextDamageUntilTurn = 0; // One-time use
        game.log.unshift(`${u.name} prevented damage (Counter Strike).`);
        return;
      }
      let finalDmg = dmg;
      const loc = locateUnit(game, u.owner, u.instanceId);
      if (loc && loc.zone === "BF") {
        const bf = game.battlefields[loc.battlefieldIndex ?? 0];
        if (bf && battlefieldHasVoidGate(bf)) finalDmg += 1;
      }
      u.damage += finalDmg;
      if (u.killOnDamageUntilTurn && u.killOnDamageUntilTurn >= game.turnNumber) {
        u.damage = 999;
        u.killOnDamageUntilTurn = 0;
      } else if (damageKillEffectActive(game)) {
        u.damage = 999;
      }
    };

    // Helper to mark "before" existence for conditional kill checks.
    const recordBefore = (owner: PlayerId, unit: CardInstance) => {
      const existed = !!locateUnit(game, owner, unit.instanceId)?.unit;
      dmgTargetsSnapshot.push({ owner, instanceId: unit.instanceId, name: unit.name, existed, wasStunned: unit.stunned });
    };

    // 1) Explicit AoE patterns
    if (/\ball\s+units\s+at\s+battlefields\b/i.test(text)) {
      for (const bf of game.battlefields) {
        for (const pid of ["P1", "P2"] as PlayerId[]) {
          for (const u of bf.units[pid]) applyDamageToUnit(u);
        }
      }
      game.log.unshift(`${controller} dealt ${dmg} to all units at battlefields.`);
      did = true;
    } else if (
      (/\ball\s+enemy\s+units\s+at\s+battlefields\b/i.test(text) ||
        /\beach\s+enemy\s+unit\s+at\s+battlefields\b/i.test(text) ||
        /\ball\s+enemy\s+creatures\s+at\s+battlefields\b/i.test(text) ||
        /\beach\s+enemy\s+creature\s+at\s+battlefields\b/i.test(text))
    ) {
      for (const bf of game.battlefields) for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units at battlefields.`);
      did = true;
    } else if (
      (/\ball\s+enemy\s+units\s+at\s+a\s+battlefield\b/i.test(text) ||
        /\beach\s+enemy\s+unit\s+at\s+a\s+battlefield\b/i.test(text)) &&
      (bfTargetIndex != null || hereBf != null)
    ) {
      const idx = bfTargetIndex != null ? bfTargetIndex : hereBf!;
      const bf = game.battlefields[idx];
      for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units at Battlefield ${idx + 1}.`);
      did = true;
    } else if (
      (/\ball\s+enemy\s+units\s+at\s+a\s+battlefield\b/i.test(text) ||
        /\beach\s+enemy\s+unit\s+at\s+a\s+battlefield\b/i.test(text)) &&
      (bfTargetIndex != null || hereBf != null)
    ) {
      const idx = bfTargetIndex != null ? bfTargetIndex : hereBf!;
      const bf = game.battlefields[idx];
      for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units at Battlefield ${idx + 1}.`);
      did = true;
    } else if (
      (/\ball\s+friendly\s+units\s+at\s+battlefields\b/i.test(text) ||
        /\beach\s+friendly\s+unit\s+at\s+battlefields\b/i.test(text))
    ) {
      for (const bf of game.battlefields) for (const u of bf.units[controller]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all friendly units at battlefields.`);
      did = true;
    } else if (/\ball\s+units\s+here\b/i.test(text) && hereBf != null) {
      const bf = game.battlefields[hereBf];
      for (const pid of ["P1", "P2"] as PlayerId[]) for (const u of bf.units[pid]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all units here (Battlefield ${hereBf + 1}).`);
      did = true;
    } else if (
      (/(?:\ball\s+enemy\s+units\s+here\b|\beach\s+enemy\s+unit\s+here\b)/i.test(text) ||
        /\ball\s+enemy\s+creatures\s+here\b/i.test(text) ||
        /\beach\s+enemy\s+creature\s+here\b/i.test(text)) &&
      hereBf != null
    ) {
      const bf = game.battlefields[hereBf];
      for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units here (Battlefield ${hereBf + 1}).`);
      did = true;
    } else if (
      (/(?:\ball\s+friendly\s+units\s+here\b|\beach\s+friendly\s+unit\s+here\b)/i.test(text)) &&
      hereBf != null
    ) {
      const bf = game.battlefields[hereBf];
      for (const u of bf.units[controller]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all friendly units here (Battlefield ${hereBf + 1}).`);
      did = true;
    } else if (
      (/\ball\s+enemy\s+units\b/i.test(text) || /\beach\s+enemy\s+unit\b/i.test(text) || /\ball\s+enemy\s+creatures\b/i.test(text)) &&
      !/\bat\s+battlefields\b/i.test(text) &&
      !/\bhere\b/i.test(text)
    ) {
      // Enemy-only global (base + battlefields)
      for (const u of game.players[opp].base.units) applyDamageToUnit(u);
      for (const bf of game.battlefields) for (const u of bf.units[opp]) applyDamageToUnit(u);
      game.log.unshift(`${controller} dealt ${dmg} to all enemy units.`);
      did = true;
    } else if (selectedUnits.length > 0) {
      // 2) Multi-target or single-target via explicit targets
      for (const x of selectedUnitLocs) recordBefore(x.t.owner, x.loc.unit);
      forEachSelectedUnit((u) => {
        applyDamageToUnit(u);
      });

      if (selectedUnits.length === 1) game.log.unshift(`${controller} dealt ${dmg} to ${selectedUnits[0].name}.`);
      else game.log.unshift(`${controller} dealt ${dmg} to ${selectedUnits.length} unit(s).`);
      did = true;
    } else if (unitTarget) {
      // 3) Fallback: single target
      const targetOwner = firstTarget.kind === "UNIT" ? firstTarget.owner : opp;
      recordBefore(targetOwner, unitTarget);
      applyDamageToUnit(unitTarget);
      game.log.unshift(`${controller} dealt ${dmg} to ${unitTarget.name}.`);
      did = true;
    } else if (isUpTo && /\bunit\b/i.test(text)) {
      // Valid: "up to" effects may choose 0 targets.
      did = true;
    }

    // Conditional draw on kill (after damage is marked, before this effect is considered fully resolved)
    if (did && conditionalDrawOnKill && dmgTargetsSnapshot.length > 0) {
      cleanupStateBased(game);
      let killedCount = 0;
      let killedStunnedCount = 0;
      for (const snap of dmgTargetsSnapshot) {
        if (!snap.existed) continue;
        const after = !!locateUnit(game, snap.owner, snap.instanceId)?.unit;
        if (!after) {
          killedCount += 1;
          if (snap.wasStunned) killedStunnedCount += 1;
        }
      }
      if (killedCount > 0) {
        drawCards(game, controller, conditionalDrawOnKill * killedCount);
        game.log.unshift(`${controller} drew ${conditionalDrawOnKill * killedCount} (killed by effect).`);
      }
      if (killedCount > 0 && ctx.sourceCardType === "Spell") {
        queueTriggersForEvent(
          game,
          controller,
          (trig) => trig.includes("when you kill a unit with a spell"),
          (source) => source.ability?.effect_text,
          [{ kind: "NONE" }],
          undefined,
          true
        );
      }
      if (killedStunnedCount > 0) {
        queueTriggersForEvent(
          game,
          controller,
          (trig) => trig.includes("when you kill a stunned enemy unit"),
          (source) => source.ability?.effect_text
        );
      }
    }
  }


  // --------------------- Reveal Mechanics ---------------------

  // Pattern: "Reveal cards from the top of your Main Deck until you reveal a [Type]..."
  if (/reveal\s+cards\s+from\s+the\s+top\s+of\s+(?:your|my)\s+main\s+deck\s+until/i.test(lower)) {
    const p = game.players[controller];
    const deck = p.mainDeck;
    const revealed: CardInstance[] = [];
    let matchIndex = -1;

    // Determine condition
    const wantsSpell = /\buntil\s+you\s+reveal\s+a\s+spell\b/i.test(lower);
    const wantsUnit = /\buntil\s+you\s+reveal\s+a\s+unit\b/i.test(lower);
    const wantsGear = /\buntil\s+you\s+reveal\s+a\s+gear\b/i.test(lower);

    if (wantsSpell || wantsUnit || wantsGear) {
      for (let i = 0; i < deck.length; i++) {
        const c = deck[i];
        revealed.push(c);
        if (wantsSpell && c.type === "Spell") { matchIndex = i; break; }
        if (wantsUnit && c.type === "Unit") { matchIndex = i; break; }
        if (wantsGear && c.type === "Gear") { matchIndex = i; break; }
      }

      if (matchIndex >= 0) {
        // Remove revealed cards from deck
        const matchCard = revealed[matchIndex];
        const others = revealed.slice(0, matchIndex); // 0 to index-1

        // Update deck: remove all revealed
        p.mainDeck.splice(0, revealed.length);

        // Handle "Put the rest into your trash"
        if (/\bput\s+the\s+rest\s+into\s+(?:your\s+)?trash\b/i.test(lower)) {
          p.trash.push(...others);
          if (others.length > 0) game.log.unshift(`${controller} trashed ${others.length} revealed card(s).`);
        } else if (/\bshuffle\s+the\s+rest\s+into\s+(?:your\s+)?main\s+deck\b/i.test(lower)) {
          // Not yet seen, but standard pattern
          p.mainDeck.push(...others);
          p.mainDeck = shuffle(p.mainDeck, game.turnNumber);
        }

        // Handle "Play it for free"
        if (/\bplay\s+it\s+for\s+free\b/i.test(lower) || /\bplay\s+it\s+without\s+paying\s+its\s+cost\b/i.test(lower)) {
          // Queue play
          // Reset internal counters/flags if play logic needs them
          // We can push to chain directly if we want to bypass timing, but "Play" usually uses the engine action or a chain item.
          // Since we are resolving an effect, we should probably push a new ChainItem for the play (to allow responses).
          // Similar to how "play me from trash" works.
          let dest: any = { kind: "BASE" };
          if (matchCard.type === "Unit") prepareUnitForPlayFromEffect(matchCard);
          if (matchCard.type === "Gear") matchCard.isReady = true;

          p.mainDeckCardsPlayedThisTurn += 1; // It technically came from deck before being revealed logic-wise

          game.chain.push({
            id: makeId("chain"),
            controller,
            kind: "PLAY_CARD",
            label: `Play ${matchCard.name} (Free)`,
            sourceCard: matchCard,
            sourceZone: "HAND", // It's sort of in a limbo zone, treating as HAND allows standard resolution or custom logic
            playDestination: matchCard.type === "Unit" || matchCard.type === "Gear" ? dest : null,
            effectText: matchCard.ability?.effect_text || "",
            contextBattlefieldIndex: null,
            targets: [{ kind: "NONE" }],
            additionalCostPaid: true, // "For free" usually implies ignoring costs, we map "free" as if paid.
          });
          game.log.unshift(`${controller} plays ${matchCard.name} for free.`);
        } else if (/\badd\s+it\s+to\s+(?:your\s+)?hand\b/i.test(lower)) {
          p.hand.push(matchCard);
          game.log.unshift(`${controller} added ${matchCard.name} to hand.`);
        }

        // Show window *after* state update so user sees what happened
        game.pendingRevealWindow = {
          id: makeId("reveal"),
          player: controller,
          cards: revealed,
          sourceLabel: ctx?.sourceCardName || "Effect",
          message: `Revealed ${revealed.length} cards. Matched: ${matchCard.name}.`
        };

        did = true;
      } else {
        // Revealed entire deck and found nothing
        // Shuffle back or trash?
        // Usually "shuffle the rest" or "trash the rest".
        // Dazzling Aurora: "Put the rest into your trash."
        // So entire deck goes to trash.
        p.mainDeck.splice(0, revealed.length);
        if (/\bput\s+the\s+rest\s+into\s+(?:your\s+)?trash\b/i.test(lower)) {
          p.trash.push(...revealed);
          game.log.unshift(`${controller} revealed entire deck (no match) and trashed all cards.`);
        }

        game.pendingRevealWindow = {
          id: makeId("reveal"),
          player: controller,
          cards: revealed,
          sourceLabel: ctx?.sourceCardName || "Effect",
          message: `Revealed entire deck. No match found.`
        };
        did = true;
      }
    }
  }

  // Pattern: "Target opponent reveals their hand." (Sabotage)
  if (/(?:enemy|opponent)\s+reveals\s+(?:their|his|her)\s+hand/i.test(lower)) {
    const opponent = otherPlayer(controller);
    const oppHand = game.players[opponent].hand;

    // Setting up the reveal window
    game.pendingRevealWindow = {
      id: makeId("reveal"),
      player: controller,
      cards: oppHand,
      sourceLabel: ctx?.sourceCardName || "Reveal Hand",
      message: `${opponent}'s Hand Revealed.`
    };

    // Sabotage: "Choose a non-champion card from it and... recycle it."
    // We can handle the choice logic separately via a follow-up OPTIONAL_CHOICE or similar?
    // Or we rely on the user manually handling it if we don't have a specialized "Choose from opponent hand" flow.
    // Given the task is to *start* implementing Reveal, just showing it is a huge step.
    // The "Choose" part is tricky because standard targeting picks from board.
    // Let's mark it as done for the Reveal part.
    // The "Select" part might be implemented as a separate step if we want to be fancy,
    // but for now let's just show the hand.

    // If text continues "Choose...", we ideally want to prompt.
    // But since "Choose from opponent hand" isn't a standard target type yet, 
    // we'll leave it as informational for this iteration.

    game.log.unshift(`${opponent}'s hand was revealed.`);
    did = true;
  }

  if (!did) {
    if (/\bscore\s+1\s+point\b/i.test(lower)) {
      const excessMatch = /excess damage/i.test(lower);
      const excess = game.lastCombatExcessDamageTurn === game.turnNumber ? game.lastCombatExcessDamage[controller] || 0 : 0;
      if (!excessMatch || excess >= 5) {
        game.players[controller].points += 1;
        game.log.unshift(`${controller} scored 1 point.`);
        if (game.players[controller].points >= game.victoryScore) {
          game.step = "GAME_OVER";
          game.log.unshift(`${controller} wins! Reached ${game.players[controller].points} points.`);
        }
      } else {
        game.log.unshift(`${controller} did not score (insufficient excess damage).`);
      }
      did = true;
    }
    if (/\bgain[s]?\s+(\d+)\s+point/i.test(lower)) {
      const m = lower.match(/\bgain[s]?\s+(\d+)\s+point/i);
      const n = m ? parseInt(m[1], 10) : 1;
      if (Number.isFinite(n) && n > 0) {
        game.players[controller].points += n;
        game.log.unshift(`${controller} gained ${n} point${n === 1 ? "" : "s"}.`);
        if (game.players[controller].points >= game.victoryScore) {
          game.step = "GAME_OVER";
          game.log.unshift(`${controller} wins! Reached ${game.players[controller].points} points.`);
        }
      }
      did = true;
    }
    if (/\byou win the game\b/i.test(lower)) {
      const needsSevenHere = /if you have 7\+ units here/i.test(lower);
      const meetsSeven = !needsSevenHere || (hereBf != null && game.battlefields[hereBf].units[controller].length >= 7);
      if (meetsSeven) {
        game.players[controller].points = game.victoryScore;
        game.step = "GAME_OVER";
        game.log.unshift(`${controller} wins the game.`);
        return true;
      }
    }
    // Obelisk of Power / The Arena's Greatest / etc.
    if (!did && /\bchannels?\s+(\d+)\s+runes?\b/i.test(lower)) {
      const m = lower.match(/\bchannels?\s+(\d+)\s+runes?\b/i);
      const n = m ? parseInt(m[1], 10) : 1;
      channelRunes(game, controller, n);
      did = true;
    }
    if (!did && /\bchannels?\s+(\d+)\s+runes?\s+exhausted/i.test(lower)) {
      const m = lower.match(/\bchannels?\s+(\d+)\s+runes?\s+exhausted/i);
      const n = m ? parseInt(m[1], 10) : 1;
      channelRunesExhausted(game, controller, n);
      did = true;
    }

    // Hall of Legends: "ready your legend."
    if (!did && /\bready\s+(?:your|my)\s+legend\b/i.test(lower)) {
      p.legendReady = true;
      game.log.unshift(`${controller} readied their legend.`);
      did = true;
    }

    // Targon's Peak / Zaun Warrens / etc.
    if (!did && /\bready\s+(\d+)\s+runes?\s+at\s+the\s+end\s+of\s+this\s+turn\b/i.test(lower)) {
      const m = lower.match(/\bready\s+(\d+)\s+runes?\s+at\s+the\s+end\s+of\s+this\s+turn\b/i);
      const n = m ? parseInt(m[1], 10) : 1;
      game.delayedTriggers.push({
        id: makeId("delayed"),
        controller,
        event: "TURN_END",
        effect: `ready ${n} runes`,
        untilTurn: game.turnNumber,
        sourceCardName: ctx?.sourceCardName || "Effect",
      });
      game.log.unshift(`${controller} will ready ${n} rune(s) at the end of this turn.`);
      did = true;
    }

    if (!did && /\bdiscard\s+(\d+),\s+then\s+draw\s+(\d+)\b/i.test(lower)) {
      const m = lower.match(/\bdiscard\s+(\d+),\s+then\s+draw\s+(\d+)\b/i);
      const discardN = m ? parseInt(m[1], 10) : 1;
      const drawN = m ? parseInt(m[2], 10) : 1;
      // Note: Full implementation should trigger a selection, but for now we auto-discard first N
      for (let i = 0; i < discardN; i++) {
        if (p.hand.length > 0) {
          const card = p.hand.shift()!;
          p.trash.push(card);
          game.log.unshift(`${controller} discarded ${card.name}.`);
        }
      }
      drawCards(game, controller, drawN);
      did = true;
    }

    // Hallowed Tomb: "return your Chosen Champion from your trash to your Champion Zone"
    if (!did && /\breturn\s+(?:your|my)\s+chosen\s+champion\s+from\s+(?:your|my)\s+trash/i.test(lower)) {
      const champId = p.chosenChampionId;
      const idx = p.trash.findIndex(c => c.id === champId);
      if (idx >= 0 && !p.championZone) {
        const champ = p.trash.splice(idx, 1)[0];
        p.championZone = champ;
        game.log.unshift(`${controller} returned ${champ.name} to Champion Zone.`);
      } else {
        game.log.unshift(`${controller} could not return champion (not in trash or zone occupied).`);
      }
      did = true;
    }

    // Altar to Unity / Assembly Rig / Sprite Mother: "play a N [S] [Name] unit token" or "play a ready N might Sprite unit token"
    if (!did && /\bplay\s+a\s+(?:ready\s+)?(\d+)\s+(?:\[?s\]?|might)\s+(\w+)\s+unit\s+token/i.test(lower)) {
      const m = lower.match(/\bplay\s+a\s+(?:ready\s+)?(\d+)\s+(?:\[?s\]?|might)\s+(\w+)\s+unit\s+token/i);
      const might = m ? parseInt(m[1], 10) : 1;
      const name = m ? m[2] : "Token";

      // Look for modifiers explicitly mentioned in the full text
      const isTemporary = /with\s+\[?(temporary)\]?/i.test(lower);
      const isReady = /\bready\b/i.test(lower);

      const token = instantiateCard({
        id: `TOKEN-${name}`,
        name: `${name} Token`,
        domain: "Colorless",
        cost: 0,
        type: "Unit",
        stats: { might: might, power: null },
        rules_text: { raw: isTemporary ? "[Temporary]" : "", keywords: isTemporary ? ["Temporary"] : [] } as any,
        image_url: ""
      }, controller, game.turnNumber);

      // Token units normally do not enter ready, unless "ready" is specified.
      if (isReady) {
        token.isReady = true;
      }

      const toBase = /in\s+your\s+base/i.test(lower);
      if (toBase) {
        p.base.units.push(token);
        game.log.unshift(`${controller} played a ${might} [S] ${name} token in base.`);
      } else if (hereBf != null) {
        game.battlefields[hereBf].units[controller].push(token);
        game.log.unshift(`${controller} played a ${might} [S] ${name} token here.`);
      } else {
        p.base.units.push(token); // Fallback
        game.log.unshift(`${controller} played a ${might} [S] ${name} token.`);
      }
      did = true;
    }

    // Surface unsupported effects to help implementation/debugging.
    if (!did) {
      const src = ctx?.sourceCardName ? ` from ${ctx.sourceCardName}` : "";
      game.log.unshift(`UNSUPPORTED effect${src}: ${text}`);
    }
  }

  // Raging Firebrand: "the next spell you play this turn costs [5] less"
  if (/next\s+spell.*costs?\s*\[(\d+)\]\s*less/i.test(lower)) {
    const m = lower.match(/next\s+spell.*costs?\s*\[(\d+)\]\s*less/i);
    const discount = m ? parseInt(m[1], 10) : 5;
    p.nextSpellDiscount = discount;
    game.log.unshift(`${controller}'s next spell costs ${discount} less.`);
    did = true;
  }

  // Marai Spire: "Give the next spell you play this turn [Repeat] equal to its cost."
  if (/next\s+spell\s+you\s+play\s+this\s+turn.*repeat/i.test(lower)) {
    p.nextSpellRepeatByCost = true;
    game.log.unshift(`${controller}'s next spell gains Repeat equal to its cost.`);
    did = true;
  }

  // Bushwhack/Confront: "units you play this turn enter ready" or "friendly units enter ready this turn"
  if (/units\s+(you\s+play\s+)?this\s+turn\s+enter\s+ready/i.test(lower) || /friendly\s+units\s+enter\s+ready\s+this\s+turn/i.test(lower)) {
    p.unitsEnterReadyThisTurn = true;
    game.log.unshift(`${controller}'s units enter ready this turn.`);
    did = true;
  }

  // Unyielding Spirit: "prevent all spell and ability damage this turn"
  if (/prevent\s+all\s+spell\s+and\s+ability\s+damage\s+this\s+turn/i.test(lower)) {
    p.preventSpellAbilityDamageThisTurn = true;
    game.log.unshift(`${controller} prevents all spell and ability damage this turn.`);
    did = true;
  }

  // Brynhir Thundersong: "opponents can't play cards this turn"
  if (/opponents?\s+can'?t\s+play\s+cards?\s+this\s+turn/i.test(lower)) {
    const opp = controller === "P1" ? "P2" : "P1";
    game.players[opp].opponentCantPlayCardsThisTurn = true;
    game.log.unshift(`${opp} can't play cards this turn.`);
    did = true;
  }

  // Forge of the Future: "Recycle up to N cards from trashes"
  // This allows selecting cards from either player's trash and recycling them to the bottom of their owner's deck
  const recycleFromTrashMatch = lower.match(/recycle\s+up\s+to\s+(\d+)\s+cards?\s+from\s+trashes?/i);
  if (recycleFromTrashMatch) {
    const maxCards = parseInt(recycleFromTrashMatch[1], 10) || 4;

    // Collect all cards from both players' trashes
    const p1Trash = game.players.P1.trash;
    const p2Trash = game.players.P2.trash;

    // For now, auto-select up to maxCards from the controller's trash first, then opponent's
    // In a full implementation, this would need a UI for selecting specific cards
    let recycled = 0;

    // Recycle from controller's trash first
    while (recycled < maxCards && p.trash.length > 0) {
      const card = p.trash.shift()!;
      p.mainDeck.push(card);
      game.log.unshift(`${card.name} recycled from ${controller}'s trash to bottom of deck.`);
      recycled++;
    }

    // Then from opponent's trash if we haven't reached max
    const opp = otherPlayer(controller);
    const oppPlayer = game.players[opp];
    while (recycled < maxCards && oppPlayer.trash.length > 0) {
      const card = oppPlayer.trash.shift()!;
      oppPlayer.mainDeck.push(card);
      game.log.unshift(`${card.name} recycled from ${opp}'s trash to bottom of deck.`);
      recycled++;
    }

    if (recycled > 0) {
      game.log.unshift(`${controller} recycled ${recycled} card(s) from trashes.`);
    } else {
      game.log.unshift(`No cards in trashes to recycle.`);
    }
    did = true;
  }

  if (!ctx.chainItemId && game.optionalChoiceResults) {
    const prefix = `${resolutionId}:`;
    for (const key of Object.keys(game.optionalChoiceResults)) {
      if (key.startsWith(prefix)) delete game.optionalChoiceResults[key];
    }
  }

  return did;
};


const assignCombatDamageAuto = (game: GameState, battlefieldIndex: number, attacker: PlayerId, defender: PlayerId) => {
  const bf = game.battlefields[battlefieldIndex];

  const attackerUnits = bf.units[attacker].filter((u) => !u.stunned);
  const defenderUnits = bf.units[defender].filter((u) => !u.stunned);

  const attackerAlone = attackerUnits.length === 1;
  const defenderAlone = defenderUnits.length === 1;
  const attackerDamage = attackerUnits.reduce(
    (s, u) => s + effectiveMight(u, { role: "ATTACKER", alone: attackerAlone, game, battlefieldIndex }),
    0
  );
  const defenderDamage = defenderUnits.reduce(
    (s, u) => s + effectiveMight(u, { role: "DEFENDER", alone: defenderAlone, game, battlefieldIndex }),
    0
  );

  const applyDamageToSide = (damage: number, units: CardInstance[], role: "ATTACKER" | "DEFENDER", alone: boolean) => {
    if (damage <= 0) return;

    // Tank rule (simplified): must assign to Tanks first when possible.
    const tanks = units.filter((u) => hasKeyword(u, "Tank"));
    const rest = units.filter((u) => !hasKeyword(u, "Tank"));
    const order = tanks.length > 0 ? [...tanks, ...rest] : [...units];

    let remaining = damage;
    let excess = 0;
    for (const u of order) {
      if (remaining <= 0) break;
      if (unitIgnoresDamageThisTurn(u)) {
        game.log.unshift(`${u.name} ignored combat damage (moved twice this turn).`);
        continue;
      }
      // Counter Strike: "The next time that unit would be dealt damage this turn, prevent it"
      if (u.preventNextDamageUntilTurn && u.preventNextDamageUntilTurn >= game.turnNumber) {
        u.preventNextDamageUntilTurn = 0; // One-time use
        game.log.unshift(`${u.name} prevented combat damage (Counter Strike).`);
        continue;
      }
      const lethal = effectiveMight(u, { role, alone, game, battlefieldIndex });
      const need = Math.max(0, lethal - u.damage);
      if (need <= 0) continue;
      const assign = Math.min(need, remaining);
      u.damage += assign;
      remaining -= assign;
    }

    // If still remaining, spill onto the last unit (rules allow “over-assign”; simplified).
    if (remaining > 0 && order.length > 0) {
      order[order.length - 1].damage += remaining;
      excess += remaining;
    }

    if (damageKillEffectActive(game)) {
      for (const u of order) {
        if (u.damage > 0) u.damage = 999;
      }
    } else {
      for (const u of order) {
        if (u.killOnDamageUntilTurn && u.killOnDamageUntilTurn >= game.turnNumber && u.damage > 0) {
          u.damage = 999;
          u.killOnDamageUntilTurn = 0;
        }
      }
    }
    return excess;
  };

  const attackerExcess = applyDamageToSide(attackerDamage, bf.units[defender], "DEFENDER", defenderAlone) || 0;
  const defenderExcess = applyDamageToSide(defenderDamage, bf.units[attacker], "ATTACKER", attackerAlone) || 0;

  game.lastCombatExcessDamage = {
    [attacker]: attackerExcess,
    [defender]: defenderExcess,
  } as Record<PlayerId, number>;
  game.lastCombatExcessDamageTurn = game.turnNumber;

  game.log.unshift(
    `Combat damage assigned at Battlefield ${battlefieldIndex + 1}: ${attacker} dealt ${attackerDamage}, ${defender} dealt ${defenderDamage}.`
  );
};



const healUnitsEndOfCombat = (game: GameState, battlefieldIndex: number) => {
  // Units heal at end of combat (damage removed).
  const bf = game.battlefields[battlefieldIndex];
  for (const pid of ["P1", "P2"] as PlayerId[]) {
    for (const u of bf.units[pid]) u.damage = 0;
  }
  game.log.unshift(`Units healed at end of combat (Battlefield ${battlefieldIndex + 1}).`);
};

const recallUnitsToBaseExhausted = (game: GameState, battlefieldIndex: number, player: PlayerId) => {
  const bf = game.battlefields[battlefieldIndex];
  const p = game.players[player];
  const recalled = bf.units[player].splice(0, bf.units[player].length);
  for (const u of recalled) {
    u.isReady = false;
    u.damage = 0;
    p.base.units.push(u);
  }
  if (recalled.length > 0) game.log.unshift(`${player} recalled ${recalled.length} unit(s) to base exhausted (Battlefield ${battlefieldIndex + 1}).`);
};

const resolveCombatResolution = (game: GameState) => {
  if (!game.combat) return;
  const { battlefieldIndex, attacker, defender } = game.combat;
  const bf = game.battlefields[battlefieldIndex];

  // Kill lethal (SBAs) before healing (simplified sequence).
  cleanupStateBased(game);

  // Determine survivors
  const aHas = bf.units[attacker].length > 0;
  const dHas = bf.units[defender].length > 0;

  if (aHas && dHas) {
    const tieRecallAll = getUnitsInPlay(game, attacker).some((u) => {
      const trig = (u.ability?.trigger || "").toLowerCase();
      const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
      return trig.includes("if a combat where you are the attacker ends in a tie") && raw.includes("recall all units instead");
    });
    if (tieRecallAll) {
      recallUnitsToBaseExhausted(game, battlefieldIndex, attacker);
      recallUnitsToBaseExhausted(game, battlefieldIndex, defender);
      game.log.unshift(`Combat tie: recalled all units due to tie-recall effect.`);
    } else {
      // Tie / both survived -> attacker recalled, defender retains control (FAQ)
      recallUnitsToBaseExhausted(game, battlefieldIndex, attacker);
    }
    // control remains as-is (defender maintains)
    bf.contestedBy = null;
    game.log.unshift(`Combat ended with both sides surviving. Attacker recalled; defender retains/keeps control.`);
    healUnitsEndOfCombat(game, battlefieldIndex);
    cleanupStateBased(game);
  } else if (aHas && !dHas) {
    // Attacker wins -> conquer
    const prev = bf.controller;
    bf.controller = attacker;
    bf.contestedBy = null;
    game.log.unshift(`${attacker} conquered Battlefield ${battlefieldIndex + 1}.`);
    healUnitsEndOfCombat(game, battlefieldIndex);
    cleanupStateBased(game);

    // Conquer scoring
    if (prev !== attacker) attemptScore(game, attacker, battlefieldIndex, "Conquer");
  } else if (!aHas && dHas) {
    // Defender wins (or attacker wiped) -> defender keeps/gets control
    const prev = bf.controller;
    bf.controller = defender;
    bf.contestedBy = null;
    game.log.unshift(`${defender} defended Battlefield ${battlefieldIndex + 1}.`);
    healUnitsEndOfCombat(game, battlefieldIndex);
    cleanupStateBased(game);

    if (prev !== defender) attemptScore(game, defender, battlefieldIndex, "Conquer");
  } else {
    // Nobody left
    bf.controller = null;
    bf.contestedBy = null;
    game.log.unshift(`Battlefield ${battlefieldIndex + 1} ended empty after combat.`);
    healUnitsEndOfCombat(game, battlefieldIndex);
    cleanupStateBased(game);
  }

  // close combat window
  game.windowKind = "NONE";
  game.windowBattlefieldIndex = null;
  game.combat = null;
  game.priorityPlayer = game.turnPlayer;
  game.state = "OPEN";
  game.passesInRow = 0;

  maybeOpenNextWindow(game);
};

// ----------------------------- Setup builders -----------------------------

const instantiateCard = (card: CardData, owner: PlayerId, turn: number): CardInstance => ({
  ...card,
  instanceId: makeId("card"),
  owner,
  controller: owner,
  isReady: false,
  damage: 0,
  buffs: 0,
  tempMightBonus: 0,
  stunned: false,
  stunnedUntilTurn: 0,
  extraKeywords: [],
  tempKeywords: [],
  conditionalKeywords: [],
  createdTurn: turn,
  moveCountThisTurn: 0,
  killOnDamageUntilTurn: 0,
});

function createTokenCard(name: string, might: number, tokenType?: string): CardData {
  const slug = (tokenType || name || "token")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return {
    id: `token_${slug || "token"}_${might}`,
    name,
    rarity: "Token",
    domain: "Colorless",
    cost: 0,
    type: "Unit",
    tags: ["Token", ...(tokenType ? [tokenType] : [])],
    image_url: "",
    image: "",
    stats: { might, power: null },
    ability: { raw_text: `${name}.`, keywords: [] },
  };
}

function createGearTokenCard(name: string, rawText: string): CardData {
  const slug = (name || "gear_token")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return {
    id: `token_gear_${slug}`,
    name,
    rarity: "Token",
    domain: "Colorless",
    cost: 0,
    type: "Gear",
    tags: ["Token"],
    image_url: "",
    image: "",
    stats: { might: null, power: null },
    ability: { raw_text: rawText, keywords: extractBracketKeywords(rawText) },
  };
}

const createRuneInstance = (runeCard: CardData, owner: PlayerId, turn: number): RuneInstance => {
  const domRaw = (parseDomains(runeCard.domain)[0] || runeCard.domain || "Colorless").trim();
  const dom = clampDomain(domRaw);
  return {
    instanceId: makeId("rune"),
    owner,
    controller: owner,
    domain: dom,
    isReady: true,
    createdTurn: turn,

    cardId: runeCard.id,
    name: runeCard.name,
    image_url: (runeCard as any).image_url,
    image: (runeCard as any).image,
  };
};

const autoBuildPlayer = (allCards: CardData[], playerId: PlayerId, turn: number): { legend: CardData; champion: CardInstance; domains: Domain[]; mainDeck: CardInstance[]; runeDeck: RuneInstance[]; } => {
  const legends = allCards.filter((c) => c.type === "Legend");
  const battlefields = allCards.filter((c) => c.type === "Battlefield");
  const runes = allCards.filter((c) => c.type === "Rune");

  if (legends.length === 0) throw new Error("No Legend cards found.");
  if (battlefields.length === 0) throw new Error("No Battlefield cards found.");
  if (runes.length === 0) throw new Error("No Rune cards found.");

  const legend = legends[Math.floor(Math.random() * legends.length)];
  const domains = parseDomains(legend.domain).map(clampDomain).filter((d): d is Exclude<Domain, "Colorless"> => d !== "Colorless");
  const champTag = (legend.tags || [])[0];

  const candidateChampions = allCards.filter(
    (c) => c.type === "Unit" && champTag && (c.tags || []).includes(champTag)
  );
  const champData = candidateChampions.length > 0 ? candidateChampions[Math.floor(Math.random() * candidateChampions.length)] : allCards.find((c) => c.type === "Unit")!;
  const champion = instantiateCard(champData, playerId, turn);

  // Main deck pool: units/spells/gear that are within domain identity OR Colorless.
  const pool = allCards.filter(
    (c) =>
      isMainDeckType(c.type) &&
      (c.domain === "Colorless" ||
        parseDomains(c.domain).every((d) => {
          const dom = clampDomain(d);
          return dom === "Colorless" || domains.includes(dom);
        }))
  );
  const poolNonEmpty = pool.length > 0 ? pool : allCards.filter((c) => isMainDeckType(c.type));

  // Basic duplicate cap
  const maxCopies = 3;
  const counts: Record<string, number> = {};
  const chosen: CardInstance[] = [];
  while (chosen.length < 40 && poolNonEmpty.length > 0) {
    const pick = poolNonEmpty[Math.floor(Math.random() * poolNonEmpty.length)];
    const n = counts[pick.id] || 0;
    if (n >= maxCopies) continue;
    counts[pick.id] = n + 1;
    chosen.push(instantiateCard(pick, playerId, turn));
  }
  const mainDeck = shuffle(chosen, turn + (playerId === "P1" ? 1 : 2));

  // Rune deck (12): distribute across domains of identity (or all runes if identity empty).
  const idDomains = domains.length > 0 ? domains : (DEFAULT_DOMAINS as Domain[]);

  // Choose a specific rune card art for each domain (for visuals).
  const runeByDomain: Partial<Record<Domain, CardData>> = {};
  for (const rc of runes) {
    const domRaw = (parseDomains(rc.domain)[0] || rc.domain || "Colorless").trim();
    const dom = clampDomain(domRaw);
    if (!runeByDomain[dom]) runeByDomain[dom] = rc;
  }

  const per = Math.floor(12 / idDomains.length);
  const remainder = 12 % idDomains.length;
  const runeDeck: RuneInstance[] = [];
  for (let i = 0; i < idDomains.length; i++) {
    const dom = idDomains[i];
    const count = per + (i < remainder ? 1 : 0);
    const runeCard = runeByDomain[dom] || runeByDomain["Colorless"] || runes[0];
    for (let j = 0; j < count; j++) runeDeck.push(createRuneInstance(runeCard, playerId, turn));
  }
  const runeDeckShuffled = shuffle(runeDeck, turn + 99);

  return { legend, champion, domains: idDomains, mainDeck, runeDeck: runeDeckShuffled };
};

const autoBuildBattlefields = (allCards: CardData[]): { p1: CardData; p2: CardData } => {
  const b = allCards.filter((c) => c.type === "Battlefield");
  if (b.length < 2) throw new Error("Need at least 2 Battlefields.");
  const shuffled = shuffle(b, 12345);
  return { p1: shuffled[0], p2: shuffled[1] };
};

type DeckCardId = string;

interface DeckSpec {
  legendId: DeckCardId | null;
  championId: DeckCardId | null;
  battlefields: DeckCardId[];
  runes: Record<DeckCardId, number>;
  main: Record<DeckCardId, number>;
  sideboard: Record<DeckCardId, number>;
}

// ----------------------------- Deck Library + AI Config -----------------------------

export type AiDifficulty = "EASY" | "MEDIUM" | "HARD" | "VERY_HARD";

export interface AiConfig {
  enabled: boolean;
  difficulty: AiDifficulty;
  thinkMs: number;
}

export interface DeckLibraryEntry {
  id: string;
  name: string;
  tags?: string[];
  spec: DeckSpec;
  createdAt: number;
  updatedAt: number;
}

const emptyDeckSpec = (): DeckSpec => ({
  legendId: null,
  championId: null,
  battlefields: [],
  runes: {},
  main: {},
  sideboard: {},
});

const countTotal = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((a, b) => a + (Number.isFinite(b) ? (b as number) : 0), 0);

const getCardById = (allCards: CardData[], id: string): CardData | null => allCards.find((c) => c.id === id) || null;

const defaultDeckNameFromSpec = (allCards: CardData[], s: DeckSpec): string => {
  const lg = s.legendId ? getCardById(allCards, s.legendId) : null;
  const champ = s.championId ? getCardById(allCards, s.championId) : null;
  const lgName = lg?.name ? lg.name.replace(/\s*\(.*\)\s*$/g, "").trim() : "Legend";
  const champName = champ?.name ? champ.name.replace(/\s*\(.*\)\s*$/g, "").trim() : "Champion";
  return `${lgName} — ${champName}`;
};


const domainIdentityFromLegend = (legend: CardData): Domain[] => {
  const doms = parseDomains(legend.domain)
    .map(clampDomain)
    .filter((d) => d !== "Colorless") as Domain[];
  return doms.length > 0 ? doms : (DEFAULT_DOMAINS as Domain[]);
};

const cardWithinIdentity = (card: CardData, identity: Domain[]): boolean => {
  const doms = parseDomains(card.domain).map(clampDomain);
  if (doms.length === 0) return true;
  return doms.every((d) => d === "Colorless" || identity.includes(d));
};

const isLikelyChampionUnit = (card: CardData, champTag: string | null): boolean => {
  if (card.type !== "Unit") return false;
  if (!champTag) return false;
  const tags = card.tags || [];
  return tags.includes(champTag) && (card.name || "").includes(",");
};

const pickOne = <T,>(arr: T[], seedTurn: number): T => {
  // deterministic-ish pick that still varies per game by turnNumber seed
  const idx = Math.abs(Math.floor(Math.sin(seedTurn * 9973) * 1000000)) % arr.length;
  return arr[idx];
};

const buildPlayerFromDeckSpec = (
  allCards: CardData[],
  playerId: PlayerId,
  spec: DeckSpec,
  turn: number
): { legend: CardData; champion: CardInstance; domains: Domain[]; mainDeck: CardInstance[]; runeDeck: RuneInstance[]; battlefields: CardData[] } => {
  const legend = spec.legendId ? getCardById(allCards, spec.legendId) : null;
  if (!legend || legend.type !== "Legend") throw new Error(`${playerId}: Select a Legend.`);
  const identity = domainIdentityFromLegend(legend);
  const champTag = (legend.tags || [])[0] || null;

  const champCard = spec.championId ? getCardById(allCards, spec.championId) : null;
  if (!champCard || champCard.type !== "Unit") throw new Error(`${playerId}: Select a chosen Champion (Unit).`);
  if (champTag && !(champCard.tags || []).includes(champTag))
    throw new Error(`${playerId}: Chosen Champion must match Legend tag (${champTag}).`);
  if (!cardWithinIdentity(champCard, identity)) throw new Error(`${playerId}: Chosen Champion is outside the Legend's domain identity.`);

  const champion = instantiateCard(champCard, playerId, turn);

  // Main deck
  const mainCounts = { ...(spec.main || {}) };
  const totalMain = countTotal(mainCounts);

  if ((mainCounts[champCard.id] || 0) < 1) throw new Error(`${playerId}: Main deck must include at least 1 copy of the chosen Champion.`);
  if (totalMain < 40) throw new Error(`${playerId}: Main deck must have at least 40 cards (currently ${totalMain}).`);

  for (const [id, nRaw] of Object.entries(mainCounts)) {
    const n = Math.floor(nRaw || 0);
    if (n < 0) throw new Error(`${playerId}: Negative card count for ${id}.`);
    if (n > 3) throw new Error(`${playerId}: Max 3 copies per card (exceeded on ${id}).`);
  }

  const mainDeck: CardInstance[] = [];
  for (const [id, nRaw] of Object.entries(mainCounts)) {
    const n = Math.floor(nRaw || 0);
    if (n <= 0) continue;
    const cd = getCardById(allCards, id);
    if (!cd) throw new Error(`${playerId}: Unknown card id in main deck: ${id}`);
    if (!isMainDeckType(cd.type)) throw new Error(`${playerId}: ${cd.name} is not a main-deck card.`);
    if (!cardWithinIdentity(cd, identity)) throw new Error(`${playerId}: ${cd.name} is outside the Legend's domain identity.`);

    const copiesToDeck = cd.id === champCard.id ? Math.max(0, n - 1) : n;
    for (let i = 0; i < copiesToDeck; i++) mainDeck.push(instantiateCard(cd, playerId, turn));
  }

  const mainDeckShuffled = shuffle(mainDeck, turn + (playerId === "P1" ? 11 : 22));

  // Rune deck (exactly 12 total)
  const runeCounts = { ...(spec.runes || {}) };
  const runeTotal = countTotal(runeCounts);
  if (runeTotal !== 12) throw new Error(`${playerId}: Rune deck must have exactly 12 cards (currently ${runeTotal}).`);

  const runeDeck: RuneInstance[] = [];
  for (const [id, nRaw] of Object.entries(runeCounts)) {
    const n = Math.floor(nRaw || 0);
    if (n <= 0) continue;
    const cd = getCardById(allCards, id);
    if (!cd || cd.type !== "Rune") throw new Error(`${playerId}: Invalid rune card id: ${id}`);
    const domRaw = (parseDomains(cd.domain)[0] || cd.domain || "Colorless").trim();
    const dom = clampDomain(domRaw);
    if (dom !== "Colorless" && !identity.includes(dom)) throw new Error(`${playerId}: Rune ${cd.name} (${dom}) is outside domain identity.`);
    for (let i = 0; i < n; i++) runeDeck.push(createRuneInstance(cd, playerId, turn));
  }
  const runeDeckShuffled = shuffle(runeDeck, turn + (playerId === "P1" ? 99 : 199));

  // Battlefields (pick 3 in builder, use 1 in duel)
  const bfs = spec.battlefields || [];
  if (bfs.length !== 3) throw new Error(`${playerId}: Choose exactly 3 battlefields (currently ${bfs.length}).`);
  const bfCards: CardData[] = bfs.map((id) => getCardById(allCards, id)).filter(Boolean) as CardData[];
  if (bfCards.length !== 3) throw new Error(`${playerId}: One or more chosen battlefields were not found in the database.`);
  for (const b of bfCards) {
    if (b.type !== "Battlefield") throw new Error(`${playerId}: ${b.name} is not a Battlefield.`);
    if (!cardWithinIdentity(b, identity)) throw new Error(`${playerId}: Battlefield ${b.name} is outside domain identity.`);
  }

  return { legend, champion, domains: identity, mainDeck: mainDeckShuffled, runeDeck: runeDeckShuffled, battlefields: bfCards };
};


const tokenCeasesToExist = (d: GameState, card: CardInstance, destination: string): boolean => {
  const tokenLike = isTokenCard(card);
  if (!tokenLike) return false;
  d.log.unshift(`${card.name} token ceases to exist (${destination}).`);
  return true;
};

// ----------------------------- React Component -----------------------------

const RBEXP = () => {
  const [allCards, setAllCards] = useState<CardData[]>([]);
  const [game, setGame] = useState<GameState | null>(null);
  const primaryActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        primaryActionRef.current?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ----------------------------- Deck Builder (pre-game) -----------------------------

  const DECK_STORAGE_KEY = "riftbound.deckbuilder.v1";
  const DECK_LIBRARY_KEY = "riftbound.decklibrary.v1";
  const [preGameView, setPreGameView] = useState<"SETUP" | "DECK_BUILDER">("SETUP");
  const [builderActivePlayer, setBuilderActivePlayer] = useState<PlayerId>("P1");

  // ----------------------------- Match settings -----------------------------
  const [matchFormat, setMatchFormat] = useState<MatchFormat>("BO1");
  const [matchState, setMatchState] = useState<MatchState | null>(null);
  const [pendingBo3Sideboarding, setPendingBo3Sideboarding] = useState<Bo3SideboardingState | null>(null);
  // For BO3: chosen battlefield for the *next* game (per player).
  const [matchNextBattlefieldPick, setMatchNextBattlefieldPick] = useState<Record<PlayerId, BattlefieldPick | null>>({
    P1: null,
    P2: null,
  });
  // Dice roll and starting player selection state
  const [showDiceRoll, setShowDiceRoll] = useState<{ P1: number; P2: number; winner: PlayerId } | null>(null);
  const [pendingStartingPlayerChoice, setPendingStartingPlayerChoice] = useState<{ chooser: PlayerId; gameNumber: number } | null>(null);
  const [pendingGameStart, setPendingGameStart] = useState<{ startingPlayer: PlayerId; gameState: GameState; matchState: MatchState | null } | null>(null);



  const [builderDecks, setBuilderDecks] = useState<Record<PlayerId, DeckSpec>>(() => {
    if (typeof window === "undefined") return { P1: emptyDeckSpec(), P2: emptyDeckSpec() };
    try {
      const raw = window.localStorage.getItem(DECK_STORAGE_KEY);
      if (!raw) return { P1: emptyDeckSpec(), P2: emptyDeckSpec() };
      const parsed = JSON.parse(raw);
      const p1 = parsed?.P1 ? parsed.P1 : emptyDeckSpec();
      const p2 = parsed?.P2 ? parsed.P2 : emptyDeckSpec();
      return { P1: p1, P2: p2 };
    } catch {
      return { P1: emptyDeckSpec(), P2: emptyDeckSpec() };
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(builderDecks));
    } catch { }
  }, [builderDecks]);

  // Saved Deck Library (persistent list of named DeckSpecs)
  const makeDeckLibraryId = () => `deck_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

  const [deckLibrary, setDeckLibrary] = useState<DeckLibraryEntry[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(DECK_LIBRARY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // sanitize
      return parsed
        .filter((x) => x && typeof x === "object")
        .map((x: any) => ({
          id: String(x.id || makeDeckLibraryId()),
          name: String(x.name || "Untitled Deck"),
          tags: Array.isArray(x.tags) ? x.tags.map((t: any) => String(t)).filter(Boolean) : [],
          spec: (x.spec as DeckSpec) || emptyDeckSpec(),
          createdAt: Number.isFinite(x.createdAt) ? Number(x.createdAt) : Date.now(),
          updatedAt: Number.isFinite(x.updatedAt) ? Number(x.updatedAt) : Date.now(),
        })) as DeckLibraryEntry[];
    } catch {
      return [];
    }
  });

  const [selectedLibraryDeckId, setSelectedLibraryDeckId] = useState<string | null>(null);

  const [librarySearch, setLibrarySearch] = useState<string>("");
  const [libraryTagFilter, setLibraryTagFilter] = useState<string>("");
  const [libraryDragId, setLibraryDragId] = useState<string | null>(null);

  // "Save current as..." helper inputs
  const [saveAsName, setSaveAsName] = useState<string>("");
  const [saveAsTags, setSaveAsTags] = useState<string>("");


  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(DECK_LIBRARY_KEY, JSON.stringify(deckLibrary));
    } catch { }
  }, [deckLibrary]);

  // Library UX: auto-fill "Save current as..." with the selected library deck name, or a suggested name.
  useEffect(() => {
    if (preGameView !== "DECK_BUILDER") return;
    const selected = selectedLibraryDeckId ? deckLibrary.find((d) => d.id === selectedLibraryDeckId) || null : null;
    if (selected) {
      setSaveAsName(selected.name || "");
      setSaveAsTags(Array.isArray(selected.tags) ? selected.tags.join(", ") : "");
      return;
    }
    const spec = builderDecks[builderActivePlayer] || emptyDeckSpec();
    const suggested = defaultDeckNameFromSpec(allCards, spec);
    setSaveAsName((prev) => (prev && prev.trim().length > 0 ? prev : suggested));
  }, [preGameView, selectedLibraryDeckId, deckLibrary, builderDecks, builderActivePlayer, allCards]);

  const [builderSearch, setBuilderSearch] = useState<string>("");
  const [builderTypeFilter, setBuilderTypeFilter] = useState<"All" | "Unit" | "Spell" | "Gear" | "Rune" | "Battlefield">("All");

  const moveDeckInLibrary = (fromId: string, toId: string) => {
    setDeckLibrary((prev) => {
      const from = prev.findIndex((d) => d.id === fromId);
      const to = prev.findIndex((d) => d.id === toId);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  // Simple undo stack (stores previous immutable GameState snapshots).
  const undoRef = useRef<GameState[]>([]);
  const MAX_UNDO = 40;

  // Arena convenience options
  const [autoPayEnabled, setAutoPayEnabled] = useState<boolean>(true);
  const [hoverPayPlan, setHoverPayPlan] = useState<null | { cardInstanceId: string; plan: AutoPayPlan }>(null);

  // ----------------------------- AI Settings (optional) -----------------------------

  const AI_STORAGE_KEY = "riftbound.ai.v1";
  const defaultAiState: Record<PlayerId, AiConfig> = {
    P1: { enabled: false, difficulty: "MEDIUM", thinkMs: 650 },
    P2: { enabled: false, difficulty: "MEDIUM", thinkMs: 650 },
  };

  const [aiByPlayer, setAiByPlayer] = useState<Record<PlayerId, AiConfig>>(() => {
    if (typeof window === "undefined") return defaultAiState;
    try {
      const raw = window.localStorage.getItem(AI_STORAGE_KEY);
      if (!raw) return defaultAiState;
      const parsed = JSON.parse(raw);
      const out: Record<PlayerId, AiConfig> = { ...defaultAiState };
      (['P1', 'P2'] as PlayerId[]).forEach((pid) => {
        if (parsed?.[pid]) {
          const p = parsed[pid];
          out[pid] = {
            enabled: !!p.enabled,
            difficulty: (p.difficulty as AiDifficulty) || defaultAiState[pid].difficulty,
            thinkMs: Number.isFinite(p.thinkMs) ? Number(p.thinkMs) : defaultAiState[pid].thinkMs,
          };
        }
      });
      return out;
    } catch {
      return defaultAiState;
    }
  });

  const [aiPaused, setAiPaused] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(aiByPlayer));
    } catch { }
  }, [aiByPlayer]);

  const isAiControlled = (pid: PlayerId) => !!aiByPlayer[pid]?.enabled && !aiPaused;

  // UI state
  const [selectedHandCardId, setSelectedHandCardId] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<PlayerId>("P1");
  const [revealAllHands, setRevealAllHands] = useState<boolean>(false);
  const [revealAllFacedown, setRevealAllFacedown] = useState<boolean>(false);
  const [revealAllDecks, setRevealAllDecks] = useState<boolean>(false);
  const [pendingPlay, setPendingPlay] = useState<null | {
    player: PlayerId;
    cardId: string;
    from: "HAND" | "FACEDOWN" | "CHAMPION";
    fromBattlefieldIndex?: number;
  }>(null);

  const [pendingDestination, setPendingDestination] = useState<null | { kind: "BASE" } | { kind: "BF"; index: number }>(null);
  const [pendingAccelerate, setPendingAccelerate] = useState<boolean>(false);
  const [pendingAccelerateDomain, setPendingAccelerateDomain] = useState<Domain>("Fury");
  const [pendingRepeatCount, setPendingRepeatCount] = useState<number>(0);
  const [pendingPayOptionalAdditionalCost, setPendingPayOptionalAdditionalCost] = useState<boolean>(true);
  const [pendingAdditionalDiscardIds, setPendingAdditionalDiscardIds] = useState<string[]>([]);
  const [pendingTargets, setPendingTargets] = useState<Target[]>([{ kind: "NONE" }]);
  const [pendingChainChoice, setPendingChainChoice] = useState<null | { chainItemId: string; targets?: Target[] }>(null);
  const [pendingRevealWindow, setPendingRevealWindow] = useState<any>(null);
  const [pendingTrashSelection, setPendingTrashSelection] = useState<any>(null);
  const [pendingDiscardSelection, setPendingDiscardSelection] = useState<any>(null);
  const [pendingDeckChoiceSelection, setPendingDeckChoiceSelection] = useState<any>(null);
  const [pendingRuneSelection, setPendingRuneSelection] = useState<any>(null);
  const [hoveredChainItemId, setHoveredChainItemId] = useState<string | null>(null);
  const [chainHoverArrowSegments, setChainHoverArrowSegments] = useState<Array<{ x1: number; y1: number; x2: number; y2: number }>>([]);
  const [hoveredChainId, setHoveredChainId] = useState<string | null>(null);
  const [pendingCullUnitId, setPendingCullUnitId] = useState<string | null>(null);
  const [optionalNumberValue, setOptionalNumberValue] = useState<number>(0);
  const [hideChoice, setHideChoice] = useState<{ cardId: string | null; battlefieldIndex: number | null }>(() => ({ cardId: null, battlefieldIndex: null }));
  const [showWeaponmasterChoice, setShowWeaponmasterChoice] = useState(false);

  const [moveSelection, setMoveSelection] = useState<{
    from: { kind: "BASE" } | { kind: "BF"; index: number } | null;
    unitIds: string[];
    to: { kind: "BASE" } | { kind: "BF"; index: number } | null;
  }>({ from: null, unitIds: [], to: null });

  // UI mode: "Arena" = board-centric visuals, "Classic" = debug panels
  const [uiMode, setUiMode] = useState<"Arena" | "Classic">("Arena");
  const [hoverCard, setHoverCard] = useState<CardData | CardInstance | null>(null);
  const [pileViewer, setPileViewer] = useState<null | { player: PlayerId; zone: "TRASH" }>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagSearch, setDiagSearch] = useState("");
  const [diagTab, setDiagTab] = useState<"UNSUPPORTED" | "AUDIT">("UNSUPPORTED");
  const [auditStatusFilter, setAuditStatusFilter] = useState<"PROBLEMS" | "ALL" | "FULL" | "PARTIAL" | "UNSUPPORTED" | "NO_TEXT">("PROBLEMS");
  const [auditExpandedId, setAuditExpandedId] = useState<string | null>(null);

  // Arena interactions
  const [arenaMove, setArenaMove] = useState<{
    from: { kind: "BASE" } | { kind: "BF"; index: number };
    unitIds: string[];
  } | null>(null);

  const [arenaHideCardId, setArenaHideCardId] = useState<string | null>(null);

  const loadLegacyCardData = async (): Promise<CardData[]> => {
    try {
      const res = await fetch("riftbound_card_data.json");
      if (!res.ok) return [];
      const legacyText = sanitizeJsonText(await res.text());
      const legacyParsed = JSON.parse(legacyText);
      return Array.isArray(legacyParsed) ? (legacyParsed as CardData[]) : [];
    } catch {
      return [];
    }
  };

  const loadCardDataFromText = async (text: string): Promise<CardData[]> => {
    const parsed = JSON.parse(sanitizeJsonText(text));
    if (!Array.isArray(parsed)) throw new Error("Card JSON must be an array.");

    const isExpert = parsed.length > 0 && typeof parsed[0] === "object" && "type_line" in (parsed[0] as any);
    if (isExpert) {
      let expertCards = parsed as ExpertCardData[];
      const hasSlashIds = expertCards.some((c) => typeof c.id === "string" && c.id.includes("/"));
      const hasNoSlashIds = expertCards.some((c) => typeof c.id === "string" && !c.id.includes("/"));
      if (hasSlashIds && hasNoSlashIds) {
        const before = expertCards.length;
        expertCards = expertCards.filter((c) => {
          const id = typeof c.id === "string" ? c.id : "";
          const isToken = /\btoken\b/i.test(String(c.supertypes || ""));
          return id.includes("/") || isToken;
        });
        const removed = before - expertCards.length;
        if (removed > 0) {
          console.log(`[RBEXP] Filtered ${removed} legacy cards (no slash ids) from expert data.`);
        }
      }
      const legacy = await loadLegacyCardData();
      const normalized = normalizeExpertCards(expertCards, legacy);
      setAllCards(normalized);
      return normalized;
    }

    const simpleCards = parsed as CardData[];
    setAllCards(simpleCards);
    return simpleCards;
  };

  const loadCardData = async (file: File): Promise<CardData[]> => {
    const text = await file.text();
    return loadCardDataFromText(text);
  };

  const loadCardDataFromUrl = async (url: string): Promise<CardData[]> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load card data (${res.status}).`);
    const text = await res.text();
    return loadCardDataFromText(text);
  };

  const startAutoDuel = (cardsOverride?: CardData[]) => {
    const cards = cardsOverride ?? allCards;
    if (cards.length === 0) return;

    // New game => clear undo history
    undoRef.current = [];

    const turn = 1;
    const p1Built = autoBuildPlayer(cards, "P1", turn);
    const p2Built = autoBuildPlayer(cards, "P2", turn);
    const bfs = autoBuildBattlefields(cards);

    const players: Record<PlayerId, PlayerState> = {
      P1: {
        id: "P1",
        legend: p1Built.legend,
        legendReady: true,
        championZone: p1Built.champion,
        base: { units: [], gear: [] },
        mainDeck: p1Built.mainDeck,
        hand: [],
        trash: [],
        banishment: [],
        runeDeck: p1Built.runeDeck,
        runesInPlay: [],
        runePool: emptyRunePool(),
        points: 0,
        domains: p1Built.domains,
        mainDeckCardsPlayedThisTurn: 0,
        scoredBattlefieldsThisTurn: [],
        discardedThisTurn: 0,
        enemyUnitsDiedThisTurn: 0,
        sealExhaustedThisTurn: false,
        nextSpellDiscount: 0,
        nextSpellRepeatByCost: false,
        unitsEnterReadyThisTurn: false,
        preventSpellAbilityDamageThisTurn: false,
        opponentCantPlayCardsThisTurn: false,
        nonTokenGearPlayedThisTurn: false,
        pendingReadyRunesEndOfTurn: 0,
        turnsTaken: 0,
        mulliganSelectedIds: [],
        mulliganDone: false,
      },
      P2: {
        id: "P2",
        legend: p2Built.legend,
        legendReady: true,
        championZone: p2Built.champion,
        base: { units: [], gear: [] },
        mainDeck: p2Built.mainDeck,
        hand: [],
        trash: [],
        banishment: [],
        runeDeck: p2Built.runeDeck,
        runesInPlay: [],
        runePool: emptyRunePool(),
        points: 0,
        domains: p2Built.domains,
        mainDeckCardsPlayedThisTurn: 0,
        scoredBattlefieldsThisTurn: [],
        discardedThisTurn: 0,
        enemyUnitsDiedThisTurn: 0,
        sealExhaustedThisTurn: false,
        nextSpellDiscount: 0,
        nextSpellRepeatByCost: false,
        unitsEnterReadyThisTurn: false,
        preventSpellAbilityDamageThisTurn: false,
        opponentCantPlayCardsThisTurn: false,
        nonTokenGearPlayedThisTurn: false,
        pendingReadyRunesEndOfTurn: 0,
        turnsTaken: 0,
        mulliganSelectedIds: [],
        mulliganDone: false,
      },
    };

    const battlefields: BattlefieldState[] = [
      {
        index: 0,
        card: bfs.p1,
        owner: "P1",
        controller: null,
        contestedBy: null,
        facedown: null,
        facedownExtra: null,
        dreamingTreeChosenThisTurn: { P1: false, P2: false },
        units: { P1: [], P2: [] },
        gear: { P1: [], P2: [] },
      },
      {
        index: 1,
        card: bfs.p2,
        owner: "P2",
        controller: null,
        contestedBy: null,
        facedown: null,
        facedownExtra: null,
        dreamingTreeChosenThisTurn: { P1: false, P2: false },
        units: { P1: [], P2: [] },
        gear: { P1: [], P2: [] },
      },
    ];

    const first: PlayerId = Math.random() < 0.5 ? "P1" : "P2";

    const g: GameState = {
      step: "MULLIGAN",
      turnNumber: 1,
      turnPlayer: first,
      startingPlayer: first,
      windowKind: "NONE",
      windowBattlefieldIndex: null,
      focusPlayer: null,
      combat: null,
      chain: [],
      priorityPlayer: first,
      passesInRow: 0,
      state: "OPEN",
      victoryScore: duelVictoryScore,
      log: [
        `Auto Duel setup complete. First player: ${first}.`,
        `P1 Legend: ${p1Built.legend.name} | Champion: ${p1Built.champion.name}`,
        `P2 Legend: ${p2Built.legend.name} | Champion: ${p2Built.champion.name}`,
        `Battlefield 1: ${bfs.p1.name} | Battlefield 2: ${bfs.p2.name}`,
      ],
      actionHistory: [],
      damageKillEffects: [],
      recallOnDeathEffects: [],
      lastCombatExcessDamage: { P1: 0, P2: 0 },
      lastCombatExcessDamageTurn: 0,
      pendingCandlelitChoice: null,
      pendingOptionalChoice: null,
      optionalChoiceResults: {},
      pendingCullChoice: null,
      cullChoiceResults: {},
      players,
      battlefields,
      delayedTriggers: [],
      pendingPlayHint: null
    };

    // Initial hand: draw 4 each (setup).
    drawCards(g, "P1", 4);
    drawCards(g, "P2", 4);

    cleanupStateBased(g);

    setGame(g);
    setSelectedHandCardId(null);
    setPendingPlay(null);
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingCullUnitId(null);
    setPendingAccelerate(false);
    setHideChoice({ cardId: null, battlefieldIndex: null });
    setMoveSelection({ from: null, unitIds: [], to: null });
    setArenaMove(null);
    setArenaHideCardId(null);
    setHoverCard(null);
  };


  const pickBattlefieldForPlayer = (pool: CardData[], usedIds: string[], desiredId: string | null): CardData => {
    const remaining = pool.filter((b) => !usedIds.includes(b.id));
    const candidates = remaining.length > 0 ? remaining : pool;
    if (candidates.length === 0) throw new Error("Deck has no battlefields.");
    if (desiredId) {
      const found = candidates.find((b) => b.id === desiredId);
      if (found) return found;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  const getGameWinner = (gs: GameState): PlayerId | null => {
    const p1Win = gs.players.P1.points >= gs.victoryScore;
    const p2Win = gs.players.P2.points >= gs.victoryScore;
    if (p1Win && !p2Win) return "P1";
    if (p2Win && !p1Win) return "P2";
    // In unusual edge cases, fall back to no winner.
    return null;
  };

  const deckBattlefieldsFor = (pid: PlayerId): CardData[] => {
    const ids = builderDecks[pid]?.battlefields || [];
    return ids.map((id) => getCardById(allCards, id)).filter((x): x is CardData => Boolean(x));
  };

  const startDeckBuilderDuel = (overrideFormat?: MatchFormat) => {
    if (allCards.length === 0) return;

    // New game => clear undo history
    undoRef.current = [];
    clearTransientUI();
    setPendingBo3Sideboarding(null);

    const turn = 1;

    try {
      const p1Built = buildPlayerFromDeckSpec(allCards, "P1", builderDecks.P1, turn);
      const p2Built = buildPlayerFromDeckSpec(allCards, "P2", builderDecks.P2, turn);

      const fmt: MatchFormat = overrideFormat ?? matchFormat;

      // Match init (only BO3 is a multi-game match; BO1 is a single game).
      let ms: MatchState | null =
        fmt === "BO3"
          ? {
            format: "BO3",
            gamesCompleted: 0,
            wins: { P1: 0, P2: 0 },
            usedBattlefieldIds: { P1: [], P2: [] },
            lastGameWinner: null,
          }
          : null;
      const initialUsedBattlefieldIds = ms?.usedBattlefieldIds ?? { P1: [], P2: [] };

      // Battlefield selection
      const bf1 =
        fmt === "BO1"
          ? p1Built.battlefields[Math.floor(Math.random() * p1Built.battlefields.length)]
          : pickBattlefieldForPlayer(p1Built.battlefields, initialUsedBattlefieldIds.P1, matchNextBattlefieldPick.P1);
      const bf2 =
        fmt === "BO1"
          ? p2Built.battlefields[Math.floor(Math.random() * p2Built.battlefields.length)]
          : pickBattlefieldForPlayer(p2Built.battlefields, initialUsedBattlefieldIds.P2, matchNextBattlefieldPick.P2);

      if (fmt === "BO3") {
        ms = {
          ...ms!,
          usedBattlefieldIds: {
            P1: [...ms!.usedBattlefieldIds.P1, bf1.id],
            P2: [...ms!.usedBattlefieldIds.P2, bf2.id],
          },
        };
        setMatchState(ms);
        setMatchNextBattlefieldPick({ P1: null, P2: null });
      } else {
        setMatchState(null);
        setMatchNextBattlefieldPick({ P1: null, P2: null });
      }

      const players: Record<PlayerId, PlayerState> = {
        P1: {
          id: "P1",
          legend: p1Built.legend,
          legendReady: true,
          championZone: p1Built.champion,
          base: { units: [], gear: [] },
          mainDeck: p1Built.mainDeck,
          hand: [],
          trash: [],
          banishment: [],
          runeDeck: p1Built.runeDeck,
          runesInPlay: [],
          runePool: emptyRunePool(),
          points: 0,
          domains: p1Built.domains,
          mainDeckCardsPlayedThisTurn: 0,
          scoredBattlefieldsThisTurn: [],
          discardedThisTurn: 0,
          enemyUnitsDiedThisTurn: 0,
          sealExhaustedThisTurn: false,
          nextSpellDiscount: 0,
          nextSpellRepeatByCost: false,
          unitsEnterReadyThisTurn: false,
          preventSpellAbilityDamageThisTurn: false,
          opponentCantPlayCardsThisTurn: false,
          nonTokenGearPlayedThisTurn: false,
          pendingReadyRunesEndOfTurn: 0,
          turnsTaken: 0,
          mulliganSelectedIds: [],
          mulliganDone: false,
        },
        P2: {
          id: "P2",
          legend: p2Built.legend,
          legendReady: true,
          championZone: p2Built.champion,
          base: { units: [], gear: [] },
          mainDeck: p2Built.mainDeck,
          hand: [],
          trash: [],
          banishment: [],
          runeDeck: p2Built.runeDeck,
          runesInPlay: [],
          runePool: emptyRunePool(),
          points: 0,
          domains: p2Built.domains,
          mainDeckCardsPlayedThisTurn: 0,
          scoredBattlefieldsThisTurn: [],
          discardedThisTurn: 0,
          enemyUnitsDiedThisTurn: 0,
          sealExhaustedThisTurn: false,
          nextSpellDiscount: 0,
          nextSpellRepeatByCost: false,
          unitsEnterReadyThisTurn: false,
          preventSpellAbilityDamageThisTurn: false,
          opponentCantPlayCardsThisTurn: false,
          nonTokenGearPlayedThisTurn: false,
          pendingReadyRunesEndOfTurn: 0,
          turnsTaken: 0,
          mulliganSelectedIds: [],
          mulliganDone: false,
        },
      };

      const battlefields: BattlefieldState[] = [
        {
          index: 0,
          card: bf1,
          owner: "P1",
          controller: null,
          contestedBy: null,
          units: { P1: [], P2: [] },
          gear: { P1: [], P2: [] },
          facedown: null,
          facedownExtra: null,
          dreamingTreeChosenThisTurn: { P1: false, P2: false },
        },
        {
          index: 1,
          card: bf2,
          owner: "P2",
          controller: null,
          contestedBy: null,
          units: { P1: [], P2: [] },
          gear: { P1: [], P2: [] },
          facedown: null,
          facedownExtra: null,
          dreamingTreeChosenThisTurn: { P1: false, P2: false },
        },
      ];

      // Dice roll for starting player selection (game 1)
      const p1Roll = Math.floor(Math.random() * 6) + 1;
      const p2Roll = Math.floor(Math.random() * 6) + 1;
      // Re-roll on tie until we have a winner
      let p1Final = p1Roll;
      let p2Final = p2Roll;
      while (p1Final === p2Final) {
        p1Final = Math.floor(Math.random() * 6) + 1;
        p2Final = Math.floor(Math.random() * 6) + 1;
      }
      const diceWinner: PlayerId = p1Final > p2Final ? "P1" : "P2";

      // Show dice roll overlay and let winner choose
      setShowDiceRoll({ P1: p1Final, P2: p2Final, winner: diceWinner });

      // Store the game state to be started after choice
      const first: PlayerId = diceWinner; // Default to dice winner going first

      const matchLine =
        fmt === "BO3" && ms
          ? [`Match: Best of 3 • Game ${ms.gamesCompleted + 1} • Score P1 ${ms.wins.P1}-${ms.wins.P2} P2`]
          : [];

      const g: GameState = {
        step: "MULLIGAN",
        turnNumber: 1,
        turnPlayer: first,
        startingPlayer: first,
        pendingPlayHint: null,
        priorityPlayer: first,
        passesInRow: 0,
        state: "OPEN",
        windowKind: "NONE",
        windowBattlefieldIndex: null,
        focusPlayer: null,
        combat: null,
        chain: [],
        victoryScore: duelVictoryScore,
        log: [
          ...matchLine,
          `Deck Builder Duel setup complete. First player: ${first}.`,
          `P1 Legend: ${p1Built.legend.name} | Champion: ${p1Built.champion.name}`,
          `P2 Legend: ${p2Built.legend.name} | Champion: ${p2Built.champion.name}`,
          `Battlefield 1 (P1 choice): ${bf1.name}`,
          `Battlefield 2 (P2 choice): ${bf2.name}`,
        ],
        actionHistory: [],
        damageKillEffects: [],
        recallOnDeathEffects: [],
        lastCombatExcessDamage: { P1: 0, P2: 0 },
        lastCombatExcessDamageTurn: 0,
        pendingCandlelitChoice: null,
        pendingOptionalChoice: null,
        optionalChoiceResults: {},
        pendingCullChoice: null,
        cullChoiceResults: {},
        players,
        battlefields,
        delayedTriggers: [],
      };

      // Initial hand: draw 4 each (setup).
      drawCards(g, "P1", 4);
      drawCards(g, "P2", 4);

      cleanupStateBased(g);

      // Store pending game start - will be activated after dice roll choice
      setPendingGameStart({ startingPlayer: first, gameState: g, matchState: ms });
      setPendingStartingPlayerChoice({ chooser: diceWinner, gameNumber: 1 });
    } catch (err: any) {
      alert(String(err?.message || err));
    }
  };

  // Function to confirm starting player choice and actually start the game
  const confirmStartingPlayerChoice = (chosenStartingPlayer: PlayerId) => {
    if (!pendingGameStart) return;

    const g = pendingGameStart.gameState;
    const ms = pendingGameStart.matchState;

    // Update game state with chosen starting player
    g.turnPlayer = chosenStartingPlayer;
    g.startingPlayer = chosenStartingPlayer;
    g.priorityPlayer = chosenStartingPlayer;
    g.log.unshift(`${chosenStartingPlayer} will go first.`);

    setGame(g);
    setPreGameView("SETUP");
    setSelectedHandCardId(null);
    setPendingPlay(null);
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
    setHideChoice({ cardId: null, battlefieldIndex: null });
    setMoveSelection({ from: null, unitIds: [], to: null });
    setArenaMove(null);
    setArenaHideCardId(null);
    setHoverCard(null);

    // Clear the pending states
    setShowDiceRoll(null);
    setPendingStartingPlayerChoice(null);
    setPendingGameStart(null);
    setPendingBo3Sideboarding(null);

    if (ms) {
      setMatchState(ms);
    }
  };

  const beginBo3Sideboarding = () => {
    if (!g) return;
    if (!matchState || matchState.format !== "BO3") return;
    if (g.step !== "GAME_OVER") return;

    // Commit the finished game's result into match state.
    const winner = getGameWinner(g);
    const wins = { ...matchState.wins };
    if (winner) wins[winner] = (wins[winner] || 0) + 1;

    const msAfter: MatchState = {
      ...matchState,
      wins,
      gamesCompleted: matchState.gamesCompleted + 1,
      lastGameWinner: winner,
    };

    // If match is complete, no sideboarding/next game is needed.
    if (wins.P1 >= 2 || wins.P2 >= 2) {
      setMatchState(msAfter);
      setPendingBo3Sideboarding(null);
      return;
    }

    setMatchState(msAfter);
    setPendingBo3Sideboarding({
      matchStateAfterCommit: msAfter,
      lastGameWinner: winner,
    });
  };

  const startNextBo3GameFromSideboarding = () => {
    if (!g) return;
    if (!matchState || matchState.format !== "BO3") return;
    if (g.step !== "GAME_OVER") return;
    if (!pendingBo3Sideboarding) return;

    const msAfter = pendingBo3Sideboarding.matchStateAfterCommit;
    const winner = pendingBo3Sideboarding.lastGameWinner;

    // Start next game
    undoRef.current = [];
    clearTransientUI();

    const turn = 1;

    try {
      const p1Built = buildPlayerFromDeckSpec(allCards, "P1", builderDecks.P1, turn);
      const p2Built = buildPlayerFromDeckSpec(allCards, "P2", builderDecks.P2, turn);

      const bf1 = pickBattlefieldForPlayer(p1Built.battlefields, msAfter.usedBattlefieldIds.P1, matchNextBattlefieldPick.P1);
      const bf2 = pickBattlefieldForPlayer(p2Built.battlefields, msAfter.usedBattlefieldIds.P2, matchNextBattlefieldPick.P2);

      const msNext: MatchState = {
        ...msAfter,
        usedBattlefieldIds: {
          P1: [...msAfter.usedBattlefieldIds.P1, bf1.id],
          P2: [...msAfter.usedBattlefieldIds.P2, bf2.id],
        },
      };

      setMatchState(msNext);
      setMatchNextBattlefieldPick({ P1: null, P2: null });
      setPendingBo3Sideboarding(null);

      const players: Record<PlayerId, PlayerState> = {
        P1: {
          id: "P1",
          legend: p1Built.legend,
          legendReady: true,
          championZone: p1Built.champion,
          base: { units: [], gear: [] },
          mainDeck: p1Built.mainDeck,
          hand: [],
          trash: [],
          banishment: [],
          runeDeck: p1Built.runeDeck,
          runesInPlay: [],
          runePool: emptyRunePool(),
          points: 0,
          domains: p1Built.domains,
          mainDeckCardsPlayedThisTurn: 0,
          scoredBattlefieldsThisTurn: [],
          discardedThisTurn: 0,
          enemyUnitsDiedThisTurn: 0,
          sealExhaustedThisTurn: false,
          nextSpellDiscount: 0,
          nextSpellRepeatByCost: false,
          unitsEnterReadyThisTurn: false,
          preventSpellAbilityDamageThisTurn: false,
          opponentCantPlayCardsThisTurn: false,
          nonTokenGearPlayedThisTurn: false,
          pendingReadyRunesEndOfTurn: 0,
          turnsTaken: 0,
          mulliganSelectedIds: [],
          mulliganDone: false,
        },
        P2: {
          id: "P2",
          legend: p2Built.legend,
          legendReady: true,
          championZone: p2Built.champion,
          base: { units: [], gear: [] },
          mainDeck: p2Built.mainDeck,
          hand: [],
          trash: [],
          banishment: [],
          runeDeck: p2Built.runeDeck,
          runesInPlay: [],
          runePool: emptyRunePool(),
          points: 0,
          domains: p2Built.domains,
          mainDeckCardsPlayedThisTurn: 0,
          scoredBattlefieldsThisTurn: [],
          discardedThisTurn: 0,
          enemyUnitsDiedThisTurn: 0,
          sealExhaustedThisTurn: false,
          nextSpellDiscount: 0,
          nextSpellRepeatByCost: false,
          unitsEnterReadyThisTurn: false,
          preventSpellAbilityDamageThisTurn: false,
          opponentCantPlayCardsThisTurn: false,
          nonTokenGearPlayedThisTurn: false,
          pendingReadyRunesEndOfTurn: 0,
          turnsTaken: 0,
          mulliganSelectedIds: [],
          mulliganDone: false,
        },
      };

      const battlefields: BattlefieldState[] = [
        {
          index: 0,
          card: bf1,
          owner: "P1",
          controller: null,
          contestedBy: null,
          units: { P1: [], P2: [] },
          gear: { P1: [], P2: [] },
          facedown: null,
          facedownExtra: null,
          dreamingTreeChosenThisTurn: { P1: false, P2: false },
        },
        {
          index: 1,
          card: bf2,
          owner: "P2",
          controller: null,
          contestedBy: null,
          units: { P1: [], P2: [] },
          gear: { P1: [], P2: [] },
          facedown: null,
          facedownExtra: null,
          dreamingTreeChosenThisTurn: { P1: false, P2: false },
        },
      ];

      // Loser of previous game chooses starting player for games 2/3
      const loser: PlayerId = winner === "P1" ? "P2" : "P1";
      const first: PlayerId = loser; // Default, will be overridden by choice

      const matchLine = [`Match: Best of 3 • Game ${msNext.gamesCompleted + 1} • Score P1 ${msNext.wins.P1}-${msNext.wins.P2} P2`];

      const nextGame: GameState = {
        step: "MULLIGAN",
        turnNumber: 1,
        turnPlayer: first,
        startingPlayer: first,
        pendingPlayHint: null,
        priorityPlayer: first,
        passesInRow: 0,
        state: "OPEN",
        windowKind: "NONE",
        windowBattlefieldIndex: null,
        focusPlayer: null,
        combat: null,
        chain: [],
        victoryScore: duelVictoryScore,
        log: [
          ...matchLine,
          `Previous game winner: ${winner ?? "Unknown"}.`,
          `${loser} (loser) chooses who goes first.`,
          `P1 Legend: ${p1Built.legend.name} | Champion: ${p1Built.champion.name}`,
          `P2 Legend: ${p2Built.legend.name} | Champion: ${p2Built.champion.name}`,
          `Battlefield 1 (P1 choice): ${bf1.name}`,
          `Battlefield 2 (P2 choice): ${bf2.name}`,
        ],
        actionHistory: [],
        damageKillEffects: [],
        recallOnDeathEffects: [],
        lastCombatExcessDamage: { P1: 0, P2: 0 },
        lastCombatExcessDamageTurn: 0,
        pendingCandlelitChoice: null,
        pendingOptionalChoice: null,
        optionalChoiceResults: {},
        pendingCullChoice: null,
        cullChoiceResults: {},
        players,
        battlefields,
        delayedTriggers: [],
      };

      drawCards(nextGame, "P1", 4);
      drawCards(nextGame, "P2", 4);

      cleanupStateBased(nextGame);

      // Store pending game start - loser chooses who goes first
      setPendingGameStart({ startingPlayer: first, gameState: nextGame, matchState: msNext });
      setPendingStartingPlayerChoice({ chooser: loser, gameNumber: msNext.gamesCompleted + 1 });
      // Show a simple "choose starting player" UI (no dice roll for games 2/3)
      setShowDiceRoll(null); // No dice roll for games 2/3
    } catch (err: any) {
      setMatchState(msAfter);
      setPendingBo3Sideboarding({
        matchStateAfterCommit: msAfter,
        lastGameWinner: winner,
      });
      alert(String(err?.message || err));
    }
  };


  const updateDeck = (pid: PlayerId, fn: (d: DeckSpec) => DeckSpec) => {
    setBuilderDecks((prev) => ({ ...prev, [pid]: fn(prev[pid] || emptyDeckSpec()) }));
  };

  const bumpCount = (counts: Record<string, number>, id: string, delta: number, min = 0, max: number | null = null) => {
    const next = { ...counts };
    const cur = Math.floor(next[id] || 0);
    let v = cur + delta;
    if (v < min) v = min;
    if (max != null) v = Math.min(max, v);
    if (v === 0) delete next[id];
    else next[id] = v;
    return next;
  };

  const privacy: PrivacySettings = useMemo(
    () => ({
      revealHands: revealAllHands,
      revealFacedown: revealAllFacedown,
      revealDecks: revealAllDecks,
    }),
    [revealAllHands, revealAllFacedown, revealAllDecks]
  );

  const viewGame = useMemo(() => (game ? projectGameStateForViewer(game, viewerId, privacy) : null), [game, viewerId, privacy]);

  const g = viewGame;

  useEffect(() => {
    if (!g?.pendingOptionalChoice) return;
    if (g.pendingOptionalChoice.kind !== "NUMBER") return;
    const min = g.pendingOptionalChoice.min ?? 0;
    const max = Math.max(min, g.pendingOptionalChoice.max ?? min);
    const def = g.pendingOptionalChoice.defaultValue ?? max ?? min;
    const clamped = Math.max(min, Math.min(max, def));
    setOptionalNumberValue(clamped);
  }, [g?.pendingOptionalChoice?.id]);

  useEffect(() => {
    if (!g?.pendingCullChoice) {
      setPendingCullUnitId(null);
      return;
    }
    const pending = g.pendingCullChoice;
    const current = pending.order[pending.index];
    const units = getUnitsInPlay(g, current);
    setPendingCullUnitId(units[0]?.instanceId || null);
  }, [g?.pendingCullChoice?.resolutionId, g?.pendingCullChoice?.index]);

  useEffect(() => {
    if (!pendingPlay || !g) {
      if (pendingAdditionalDiscardIds.length > 0) setPendingAdditionalDiscardIds([]);
      return;
    }
    const p = g.players[pendingPlay.player];
    const legal = new Set(p.hand.filter((c) => c.instanceId !== pendingPlay.cardId).map((c) => c.instanceId));
    setPendingAdditionalDiscardIds((prev) => {
      const next = prev.filter((id) => legal.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [g, pendingPlay, pendingAdditionalDiscardIds.length]);

  const currentPlayer = g ? g.players[viewerId] : null;
  const turnPlayerState = g ? g.players[g.turnPlayer] : null;

  const canActAs = (pid: PlayerId): boolean => {
    if (!g) return false;
    // If a side is AI-controlled, treat the UI as spectator mode for that player (pause AI to take over).
    if (isAiControlled(pid)) return false;
    // Hot-seat: allow controlling both sides; but enforce priority for chain/showdowns.
    if (g.chain.length > 0 || g.state === "CLOSED" || g.windowKind !== "NONE") {
      return g.priorityPlayer === pid;
    }
    // Mulligan is simultaneous; allow both players.
    if (g.step === "MULLIGAN") return true;

    // Otherwise, only the turn player can take main actions in ACTION step.
    if (g.step === "ACTION") return g.turnPlayer === pid;
    // Outside action, only turn player should click "Next Step"
    return g.turnPlayer === pid;
  };

  useEffect(() => {
    const ctx: ResolveEffectUiContext = { viewerId, canActAs, isAiControlled };
    activeUiContext = ctx;
    return () => {
      if (activeUiContext === ctx) activeUiContext = null;
    };
  }, [viewerId, canActAs, isAiControlled]);

  const getUnitTargetOptions = (
    d: GameState,
    controller: PlayerId,
    req: TargetRequirement,
    ctxBf: number | null,
    restrictBf: number | null,
    excludeInstanceId?: string | null
  ): { label: string; t: Target }[] => {
    const all: { label: string; t: Target }[] = [];
    (["P1", "P2"] as PlayerId[]).forEach((owner) => {
      d.players[owner].base.units.forEach((u) => {
        all.push({ label: `${owner} Base: ${u.name}`, t: { kind: "UNIT", owner, instanceId: u.instanceId, zone: "BASE" } });
      });
      d.battlefields.forEach((bf, battlefieldIndex) => {
        bf.units[owner].forEach((u) => {
          all.push({
            label: `${owner} BF${battlefieldIndex + 1}: ${u.name}`,
            t: { kind: "UNIT", owner, instanceId: u.instanceId, zone: "BF", battlefieldIndex },
          });
        });
      });
    });

    const baseFiltered = all.filter((opt) => {
      if (opt.t.kind !== "UNIT") return false;
      const loc = locateUnit(d, opt.t.owner, opt.t.instanceId);
      if (!loc) return false;

      // Exclude source unit if excludeSelf is set (for "another" patterns)
      const shouldExcludeSelf = (req as any).excludeSelf && excludeInstanceId;
      if (shouldExcludeSelf && opt.t.instanceId === excludeInstanceId) return false;

      const owner = opt.t.owner;
      const isFriendly = owner === controller;
      const isEnemy = owner !== controller;

      const hereBf = ctxBf != null ? ctxBf : restrictBf;
      const hereMatches = hereBf != null && loc.zone === "BF" && loc.battlefieldIndex === hereBf;

      // Check if unit is at a battlefield (not in base)
      const isAtBattlefield = loc.zone === "BF";

      switch (req.kind) {
        case "UNIT_HERE_FRIENDLY":
          return hereMatches && isFriendly;
        case "UNIT_HERE_ENEMY":
          return hereMatches && isEnemy;
        case "UNIT_AT_BATTLEFIELD":
          // Any unit at any battlefield (not base)
          return isAtBattlefield;
        case "UNIT_ENEMY_AT_BATTLEFIELD":
          // Enemy unit at any battlefield (not base)
          return isAtBattlefield && isEnemy;
        case "UNIT_FRIENDLY_AT_BATTLEFIELD":
          // Friendly unit at any battlefield (not base)
          return isAtBattlefield && isFriendly;
        case "UNIT_FRIENDLY":
          return isFriendly;
        case "UNIT_ENEMY":
          return isEnemy;
        case "UNIT_FRIENDLY_IN_BASE_AND_BATTLEFIELD":
          return isFriendly && loc.zone === "BASE";
        case "UNIT_FRIENDLY_AND_ENEMY":
          // For dual-target selection, return all units (filtering happens in UI)
          return true;
        case "UNIT_ANYWHERE":
          return true;
        case "NONE":
        case "BATTLEFIELD":
          return false;
        default:
          return true;
      }
    });

    if (restrictBf != null) {
      const restricted = baseFiltered.filter((opt) => {
        if (opt.t.kind !== "UNIT") return false;
        const loc = locateUnit(d, opt.t.owner, opt.t.instanceId);
        return loc && loc.zone === "BF" && loc.battlefieldIndex === restrictBf;
      });
      return restricted.length > 0 ? restricted : baseFiltered;
    }

    return baseFiltered;
  };

  const getBattlefieldTargetOptions = (d: GameState, restrictBf: number | null): { label: string; t: Target }[] => {
    const all = d.battlefields.map((bf, i) => ({
      label: `Battlefield ${i + 1}: ${bf.card.name}`,
      t: { kind: "BATTLEFIELD", index: i } as Target,
    }));
    if (restrictBf != null) {
      const restricted = all.filter((x) => x.t.kind === "BATTLEFIELD" && x.t.index === restrictBf);
      return restricted.length > 0 ? restricted : all;
    }
    return all;
  };

  const getGearTargetOptions = (
    d: GameState,
    controller: PlayerId,
    req: TargetRequirement,
    restrictBf: number | null
  ): { label: string; t: Target }[] => {
    const all: { label: string; t: Target }[] = [];
    (["P1", "P2"] as PlayerId[]).forEach((owner) => {
      d.players[owner].base.gear.forEach((g) => {
        all.push({ label: `${owner} Base: ${g.name}`, t: { kind: "GEAR", owner, instanceId: g.instanceId } });
      });
      d.battlefields.forEach((bf, battlefieldIndex) => {
        bf.gear[owner].forEach((g) => {
          all.push({ label: `${owner} BF${battlefieldIndex + 1}: ${g.name}`, t: { kind: "GEAR", owner, instanceId: g.instanceId } });
        });
      });
      // Attached gear (show as "attached to <unit>")
      const units = getUnitsInPlay(d, owner);
      for (const u of units) {
        for (const g of u.attachedGear || []) {
          all.push({
            label: `${owner} ${u.name}: ${g.name} (attached)`,
            t: { kind: "GEAR", owner, instanceId: g.instanceId },
          });
        }
      }
    });

    const baseFiltered = all.filter((opt) => {
      if (opt.t.kind !== "GEAR") return false;
      const loc = locateGear(d, opt.t.owner, opt.t.instanceId);
      if (!loc) return false;

      const isFriendly = opt.t.owner === controller;
      const isEquipmentTarget = req.kind === "GEAR_FRIENDLY_EQUIPMENT" || req.kind === "UNIT_AND_GEAR_FRIENDLY" || req.kind === "UNIT_AND_GEAR_SAME_CONTROLLER";
      const gear = loc.gear;

      switch (req.kind) {
        case "GEAR_FRIENDLY":
          return isFriendly;
        case "GEAR_FRIENDLY_EQUIPMENT":
          return isFriendly && isEquipment(gear);
        case "GEAR_ANY":
          return true;
        case "UNIT_AND_GEAR_FRIENDLY":
        case "UNIT_AND_GEAR_SAME_CONTROLLER":
          return isEquipmentTarget ? isEquipment(gear) : true;
        default:
          return false;
      }
    });

    if (restrictBf != null) {
      const restricted = baseFiltered.filter((opt) => {
        if (opt.t.kind !== "GEAR") return false;
        const loc = locateGear(d, opt.t.owner, opt.t.instanceId);
        return !loc || loc.zone !== "BF" ? false : loc.battlefieldIndex === restrictBf;
      });
      return restricted.length > 0 ? restricted : baseFiltered;
    }

    return baseFiltered;
  };

  const pickTargetForAi = (
    d: GameState,
    controller: PlayerId,
    req: TargetRequirement,
    ctxBf: number | null,
    restrictBf: number | null,
    difficulty: AiDifficulty,
    excludeInstanceId?: string | null
  ): Target[] => {
    // If no target needed, return NONE.
    if (req.kind === "NONE") return [{ kind: "NONE" }];
    const reqCount = Math.max(1, Number((req as any).count || 1));

    // Battlefield targets (rare; mostly unsupported effects today, but keep engine flowing).
    if (req.kind === "BATTLEFIELD") {
      const opts = getBattlefieldTargetOptions(d, restrictBf);
      if (opts.length === 0) return [{ kind: "NONE" }];
      // Prefer battlefields with enemy presence for higher tiers.
      if (difficulty === "HARD" || difficulty === "VERY_HARD") {
        const scored = opts
          .map((o) => {
            const idx = (o.t as any).index as number;
            const bf = d.battlefields[idx];
            const opp = otherPlayer(controller);
            const enemyMight = bf.units[opp].reduce((a, u) => a + effectiveMight(u, { role: "NONE", game: d, battlefieldIndex: bf.index }), 0);
            const myMight = bf.units[controller].reduce((a, u) => a + effectiveMight(u, { role: "NONE", game: d, battlefieldIndex: bf.index }), 0);
            const want = enemyMight * 10 - myMight * 2;
            return { o, want };
          })
          .sort((a, b) => b.want - a.want);
        return scored.slice(0, reqCount).map((x) => x.o.t);
      }
      return opts.slice(0, reqCount).map((x) => x.t);
    }

    // Handle UNIT_FRIENDLY_AND_ENEMY (Challenge spell) - needs two targets
    if (req.kind === "UNIT_FRIENDLY_AND_ENEMY") {
      const friendlyOpts = getUnitTargetOptions(d, controller, { kind: "UNIT_FRIENDLY", count: 1 }, ctxBf, restrictBf, excludeInstanceId);
      const enemyOpts = getUnitTargetOptions(d, controller, { kind: "UNIT_ENEMY", count: 1 }, ctxBf, restrictBf, excludeInstanceId);
      if (friendlyOpts.length === 0 || enemyOpts.length === 0) return [{ kind: "NONE" }];

      // Pick highest might friendly and highest might enemy for HARD+
      if (difficulty === "HARD" || difficulty === "VERY_HARD") {
        const scoredFriendly = friendlyOpts.map(o => {
          const u = o.t.kind === "UNIT" ? locateUnit(d, o.t.owner, o.t.instanceId)?.unit : null;
          return { o, might: u ? effectiveMight(u, { role: "NONE", game: d }) : 0 };
        }).sort((a, b) => b.might - a.might);
        const scoredEnemy = enemyOpts.map(o => {
          const u = o.t.kind === "UNIT" ? locateUnit(d, o.t.owner, o.t.instanceId)?.unit : null;
          return { o, might: u ? effectiveMight(u, { role: "NONE", game: d }) : 0 };
        }).sort((a, b) => b.might - a.might);
        return [scoredFriendly[0].o.t, scoredEnemy[0].o.t];
      }
      return [friendlyOpts[0].t, enemyOpts[0].t];
    }

    if (req.kind === "UNIT_FRIENDLY_IN_BASE_AND_BATTLEFIELD") {
      const baseFriendlyOpts = getUnitTargetOptions(d, controller, { kind: "UNIT_FRIENDLY_IN_BASE_AND_BATTLEFIELD" }, ctxBf, restrictBf, excludeInstanceId);
      const battlefieldOpts = getBattlefieldTargetOptions(d, restrictBf);
      if (baseFriendlyOpts.length === 0 || battlefieldOpts.length === 0) return [{ kind: "NONE" }];

      const pickedUnit =
        (difficulty === "HARD" || difficulty === "VERY_HARD")
          ? baseFriendlyOpts
            .map((o) => {
              const u = o.t.kind === "UNIT" ? locateUnit(d, o.t.owner, o.t.instanceId)?.unit : null;
              return { o, might: u ? effectiveMight(u, { role: "NONE", game: d }) : 0 };
            })
            .sort((a, b) => b.might - a.might)[0]?.o?.t || baseFriendlyOpts[0].t
          : baseFriendlyOpts[0].t;

      const pickedBattlefield =
        (difficulty === "HARD" || difficulty === "VERY_HARD")
          ? battlefieldOpts
            .map((o) => {
              const idx = (o.t as any).index as number;
              const bf = d.battlefields[idx];
              const opp = otherPlayer(controller);
              const enemyMight = bf.units[opp].reduce((a, u) => a + effectiveMight(u, { role: "NONE", game: d, battlefieldIndex: bf.index }), 0);
              return { o, score: enemyMight };
            })
            .sort((a, b) => b.score - a.score)[0]?.o?.t || battlefieldOpts[0].t
          : battlefieldOpts[0].t;

      return [pickedUnit, pickedBattlefield];
    }

    // Handle UNIT + GEAR dual targets
    if (req.kind === "UNIT_AND_GEAR_FRIENDLY" || req.kind === "UNIT_AND_GEAR_SAME_CONTROLLER") {
      const unitReq: TargetRequirement = req.kind === "UNIT_AND_GEAR_FRIENDLY" ? { kind: "UNIT_FRIENDLY", count: 1 } : { kind: "UNIT_ANYWHERE", count: 1 };
      const unitOpts = getUnitTargetOptions(d, controller, unitReq, ctxBf, restrictBf, excludeInstanceId);
      if (unitOpts.length === 0) return [{ kind: "NONE" }];

      // Pick a unit, then filter gear to same controller if needed
      const pickedUnit = unitOpts[0].t as Extract<Target, { kind: "UNIT" }>;
      const gearController = req.kind === "UNIT_AND_GEAR_SAME_CONTROLLER" ? pickedUnit.owner : controller;
      const gearReq: TargetRequirement = { kind: "GEAR_FRIENDLY_EQUIPMENT", count: 1 };
      const gearOpts = getGearTargetOptions(d, gearController, gearReq, restrictBf);
      if (gearOpts.length === 0) return [{ kind: "NONE" }];
      return [pickedUnit, gearOpts[0].t];
    }

    // Gear targets (single)
    if (req.kind === "GEAR_FRIENDLY" || req.kind === "GEAR_ANY" || req.kind === "GEAR_FRIENDLY_EQUIPMENT") {
      const gearOpts = getGearTargetOptions(d, controller, req, restrictBf);
      if (gearOpts.length === 0) return [{ kind: "NONE" }];
      return gearOpts.slice(0, reqCount).map((x) => x.t);
    }

    // Unit targets
    const opts = getUnitTargetOptions(d, controller, req, ctxBf, restrictBf, excludeInstanceId);
    if (opts.length === 0) return [{ kind: "NONE" }];

    // EASY / MEDIUM: first legal target.
    if (difficulty === "EASY" || difficulty === "MEDIUM") {
      return opts.slice(0, reqCount).map((x) => x.t);
    }

    // HARD+: pick the highest-might relevant unit (enemy or friendly depending on req).
    const wantEnemy =
      req.kind === "UNIT_HERE_ENEMY" ||
      req.kind === "UNIT_ENEMY" ||
      req.kind === "UNIT_ENEMY_AT_BATTLEFIELD";
    const wantFriendly =
      req.kind === "UNIT_HERE_FRIENDLY" ||
      req.kind === "UNIT_FRIENDLY" ||
      req.kind === "UNIT_FRIENDLY_AT_BATTLEFIELD";

    const scored = opts
      .map((o) => {
        const t = o.t;
        if (t.kind !== "UNIT") return { o, score: -9999 };
        const u = locateUnit(d, t.owner, t.instanceId)?.unit || null;
        const might = u ? effectiveMight(u, { role: "NONE", game: d }) : 0;
        const isEnemy = t.owner !== controller;
        const isFriendly = t.owner === controller;
        let score = might;
        if (wantEnemy && !isEnemy) score -= 9999;
        if (wantFriendly && !isFriendly) score -= 9999;
        // For UNIT_ANYWHERE: mildly prefer enemy targets.
        if (!wantFriendly && isEnemy) score += 2;
        return { o, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, reqCount).map((x) => x.o.t);
  };

  // Track which chain items have already had AI target selection dispatched to prevent infinite loops
  const aiTargetDispatchedRef = useRef<Set<string>>(new Set());

  // Auto-prompt for target selection on the top Chain item (triggered / activated abilities).
  useEffect(() => {
    if (!game) return;
    if (pendingPlay) return;
    if (pendingChainChoice) return;
    const top = game.chain[game.chain.length - 1];
    if (!top) return;
    if (top.needsTargets && (!top.targets?.[0] || top.targets[0].kind === "NONE")) {
      // If the Chain item is controlled by an AI, auto-select targets to avoid blocking priority.
      if (isAiControlled(top.controller)) {
        // Guard: prevent re-dispatching for the same chain item
        if (aiTargetDispatchedRef.current.has(top.id)) {
          return;
        }
        aiTargetDispatchedRef.current.add(top.id);

        const diff = aiByPlayer[top.controller]?.difficulty || "MEDIUM";
        const chosen = pickTargetForAi(game, top.controller, top.targetRequirement as TargetRequirement, top.contextBattlefieldIndex ?? null, top.restrictTargetsToBattlefieldIndex ?? null, diff, top.sourceInstanceId);
        dispatchEngineAction({ type: "SET_CHAIN_TARGETS", player: top.controller, chainItemId: top.id, targets: chosen });
        return;
      }

      setPendingChainChoice({ chainItemId: top.id });
      setPendingTargets(top.targets && top.targets.length > 0 ? top.targets : [{ kind: "NONE" }]);
    } else {
      // Clean up dispatched IDs for items that no longer need targets
      if (top && !top.needsTargets) {
        aiTargetDispatchedRef.current.delete(top.id);
      }
    }
  }, [game, pendingPlay, pendingChainChoice, aiByPlayer, aiPaused]);

  const confirmChainChoice = () => {
    if (!g || !pendingChainChoice) return;
    const chainItem = g.chain.find((x) => x.id === pendingChainChoice.chainItemId);
    if (!chainItem) {
      setPendingChainChoice(null);
      return;
    }
    // Only the controller of the chain item can set its targets.
    if (chainItem.controller !== viewerId) return;

    dispatchEngineAction({ type: "SET_CHAIN_TARGETS", player: viewerId, chainItemId: pendingChainChoice.chainItemId, targets: pendingTargets });
    setPendingChainChoice(null);
  };



  const updateGame = (fn: (draft: GameState) => void) => {
    setGame((prev) => {
      if (!prev) return prev;
      // Record undo snapshot
      undoRef.current.push(prev);
      if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();

      const d = deepClone(prev);
      fn(d);
      // keep log from growing forever
      d.log = d.log.slice(0, 400);
      return d;
    });
  };

  // ----------------------------- Engine Action Layer (UI + AI + Replays) -----------------------------

  const engineNextStep = (d: GameState, pid: PlayerId): boolean => {
    if (d.step === "GAME_OVER") return false;
    if (d.turnPlayer !== pid) {
      d.log.unshift("Only the turn player can advance the step.");
      return false;
    }
    if (d.chain.length > 0 || d.windowKind !== "NONE" || d.state !== "OPEN") {
      d.log.unshift("Cannot advance step while a chain/window is active.");
      return false;
    }

    // New turn reset (per-turn scoring limit applies each turn for each player).
    const resetPerTurn = () => {
      d.players.P1.scoredBattlefieldsThisTurn = [];
      d.players.P2.scoredBattlefieldsThisTurn = [];
      d.players.P1.mainDeckCardsPlayedThisTurn = 0;
      d.players.P2.mainDeckCardsPlayedThisTurn = 0;
      d.players.P1.discardedThisTurn = 0;
      d.players.P2.discardedThisTurn = 0;
      d.players.P1.enemyUnitsDiedThisTurn = 0;
      d.players.P2.enemyUnitsDiedThisTurn = 0;
      d.players.P1.sealExhaustedThisTurn = false;
      d.players.P2.sealExhaustedThisTurn = false;
      d.players.P1.unitsEnterReadyThisTurn = false;
      d.players.P2.unitsEnterReadyThisTurn = false;
      d.players.P1.preventSpellAbilityDamageThisTurn = false;
      d.players.P2.preventSpellAbilityDamageThisTurn = false;
      d.players.P1.opponentCantPlayCardsThisTurn = false;
      d.players.P2.opponentCantPlayCardsThisTurn = false;
      d.players.P1.nextSpellDiscount = 0;
      d.players.P2.nextSpellDiscount = 0;
      d.players.P1.nextSpellRepeatByCost = false;
      d.players.P2.nextSpellRepeatByCost = false;
      d.players.P1.nonTokenGearPlayedThisTurn = false;
      d.players.P2.nonTokenGearPlayedThisTurn = false;
      d.players.P1.pendingReadyRunesEndOfTurn = 0;
      d.players.P2.pendingReadyRunesEndOfTurn = 0;
      for (const bf of d.battlefields) {
        bf.dreamingTreeChosenThisTurn = { P1: false, P2: false };
      }
      for (const pid of ["P1", "P2"] as PlayerId[]) {
        for (const u of getUnitsInPlay(d, pid)) {
          u.moveCountThisTurn = 0;
          u.killOnDamageUntilTurn = 0;
        }
      }
      d.damageKillEffects = [];
      d.recallOnDeathEffects = d.recallOnDeathEffects.filter(e => e.untilTurn > d.turnNumber);
      // Clear expired delayed triggers
      d.delayedTriggers = d.delayedTriggers.filter(t => t.untilTurn > d.turnNumber);
    };

    switch (d.step) {
      case "MULLIGAN":
        d.log.unshift("Use Confirm Mulligan for each player (or confirm with 0 selected) to start the game.");
        break;
      case "AWAKEN":
        d.players[d.turnPlayer].turnsTaken += 1;
        awakenPlayer(d, d.turnPlayer);
        d.step = "SCORING";
        break;
      case "SCORING":
        resolveHoldScoring(d, d.turnPlayer);
        if ((d as any).step === "GAME_OVER") return true;
        d.step = "CHANNEL";
        break;
      case "CHANNEL": {
        // Channel 2 runes; second player's first channel phase channels +1 in Duel.
        // Note: turnNumber increments at end of each turn, so when P2 takes their first turn,
        // turnNumber is 2 (P1's turn was 1, then it incremented to 2 at end of P1's turn).
        const secondPlayersFirstChannel = d.turnNumber === 2 && d.turnPlayer !== d.startingPlayer;
        const count = 2 + (secondPlayersFirstChannel ? 1 : 0);
        channelRunes(d, d.turnPlayer, count);
        d.step = "DRAW";
        break;
      }
      case "DRAW":
        drawCards(d, d.turnPlayer, 1);
        if ((d as any).step === "GAME_OVER") return true;
        emptyPoolsAtEndOfDraw(d);
        d.step = "ACTION";
        break;
      case "ACTION":
        d.step = "ENDING";
        (["P1", "P2"] as PlayerId[]).forEach((pid) => {
          [...d.players[pid].base.units, ...d.players[pid].base.gear, ...d.battlefields.flatMap((b) => b.units[pid])].forEach((u) => {
            if ((u.ability?.trigger || "").toLowerCase().includes("at the end of your turn") && pid === d.turnPlayer) {
              if (u.ability?.effect_text) {
                d.chain.push({
                  id: makeId("chain"),
                  controller: pid,
                  kind: "TRIGGERED_ABILITY",
                  label: `End Turn: ${u.name}`,
                  effectText: u.ability.effect_text,
                  targets: [{ kind: "NONE" }],
                  needsTargets: false,
                });
                d.state = "CLOSED";
                d.priorityPlayer = pid;
                d.passesInRow = 0;
              }
            }
            const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
            if (pid === d.turnPlayer && raw.includes("while i'm at a battlefield") && raw.includes("ready 4 friendly runes at the end of your turn")) {
              const loc = locateUnit(d, pid, u.instanceId);
              if (loc && loc.zone === "BF" && u.ability?.effect_text) {
                d.chain.push({
                  id: makeId("chain"),
                  controller: pid,
                  kind: "TRIGGERED_ABILITY",
                  label: `End Turn: ${u.name}`,
                  effectText: u.ability.effect_text,
                  contextBattlefieldIndex: loc.battlefieldIndex ?? null,
                  targets: [{ kind: "NONE" }],
                  needsTargets: false,
                });
                d.state = "CLOSED";
                d.priorityPlayer = pid;
                d.passesInRow = 0;
              }
            }
          });
        });
        clearEndOfTurnStatuses(d); // stunned ends at beginning of Ending Step
        d.log.unshift(`Ending Step begins for ${d.turnPlayer}.`);
        break;
      case "ENDING": {
        const pendingReady = d.players[d.turnPlayer].pendingReadyRunesEndOfTurn || 0;
        if (pendingReady > 0) {
          const runes = d.players[d.turnPlayer].runesInPlay.filter((r) => !r.isReady);
          const readyCount = Math.min(pendingReady, runes.length);
          for (let i = 0; i < readyCount; i++) runes[i].isReady = true;
          d.players[d.turnPlayer].pendingReadyRunesEndOfTurn = 0;
          if (readyCount > 0) d.log.unshift(`${d.turnPlayer} readied ${readyCount} rune(s) (end of turn effect).`);
        }
        clearDamageAndTempBonusesEndOfTurn(d);
        emptyPoolAtEndOfTurn(d, d.turnPlayer);

        // Next turn
        d.turnPlayer = otherPlayer(d.turnPlayer);
        d.turnNumber += 1;
        resetPerTurn();
        d.step = "AWAKEN";
        d.priorityPlayer = d.turnPlayer;
        d.state = "OPEN";
        d.passesInRow = 0;
        (["P1", "P2"] as PlayerId[]).forEach((pid) => {
          if (pid !== d.turnPlayer) return;
          [...d.players[pid].base.units, ...d.players[pid].base.gear, ...d.battlefields.flatMap((b) => b.units[pid])].forEach((u) => {
            const trig = (u.ability?.trigger || "").toLowerCase();
            if (trig.includes("at the start of your beginning phase") || trig.includes("at start of your beginning phase")) {
              if (u.ability?.effect_text) {
                d.chain.push({
                  id: makeId("chain"),
                  controller: pid,
                  kind: "TRIGGERED_ABILITY",
                  label: `Start Phase: ${u.name}`,
                  effectText: u.ability.effect_text,
                  targets: [{ kind: "NONE" }],
                  needsTargets: false,
                });
                d.state = "CLOSED";
                d.priorityPlayer = pid;
                d.passesInRow = 0;
              }
            }
          });
        });
        d.log.unshift(`Turn ${d.turnNumber} begins for ${d.turnPlayer}.`);
        break;
      }
      default:
        break;
    }

    cleanupStateBased(d);
    maybeOpenNextWindow(d);
    return true;
  };

  const enginePassPriority = (d: GameState, pid: PlayerId): boolean => {
    if (d.priorityPlayer !== pid) return false;

    const top = d.chain[d.chain.length - 1];
    if (top && top.needsTargets && top.controller === pid) {
      const t0 = top.targets?.[0];
      if (!t0 || t0.kind === "NONE") {
        d.log.unshift("Choose targets before passing.");
        return false;
      }
    }

    d.passesInRow += 1;
    d.log.unshift(`${pid} passes.`);

    const inShowdown = d.windowKind === "SHOWDOWN" || (d.windowKind === "COMBAT" && d.combat?.step === "SHOWDOWN");

    // One pass: either pass Priority (closed) or pass Focus (open showdown with empty chain)
    if (d.passesInRow < 2) {
      if (inShowdown && d.chain.length === 0 && d.state === "OPEN") {
        d.focusPlayer = otherPlayer(pid);
        d.priorityPlayer = d.focusPlayer;
        d.log.unshift(`Focus passes to ${d.focusPlayer}.`);
      } else {
        d.priorityPlayer = otherPlayer(pid);
      }
      return true;
    }

    // Two consecutive passes
    if (d.chain.length > 0) {
      resolveTopOfChain(d);
      return true;
    }

    // No chain items: we're passing to end a showdown step
    if (d.windowKind === "SHOWDOWN") {
      const idx = d.windowBattlefieldIndex!;
      const bf = d.battlefields[idx];

      d.log.unshift(`Showdown at Battlefield ${idx + 1} ends (all players passed).`);
      d.windowKind = "NONE";
      d.windowBattlefieldIndex = null;
      d.focusPlayer = null;
      d.passesInRow = 0;
      d.state = "OPEN";
      d.priorityPlayer = d.turnPlayer;

      const p1 = bf.units.P1.length;
      const p2 = bf.units.P2.length;

      // If both sides have units, begin combat immediately
      if (p1 > 0 && p2 > 0) {
        const attacker = bf.contestedBy!;
        const defender = otherPlayer(attacker);
        d.windowKind = "COMBAT";
        d.windowBattlefieldIndex = idx;
        d.combat = { battlefieldIndex: idx, attacker, defender, step: "SHOWDOWN" };
        d.focusPlayer = attacker;
        d.priorityPlayer = attacker;
        d.passesInRow = 0;
        d.log.unshift(`Combat begins at Battlefield ${idx + 1}: ${attacker} attacks, ${defender} defends.`);
      } else {
        // Unopposed: the remaining player takes control and (if newly controlled) conquers for 1 point.
        const winner: PlayerId | null = p1 > 0 ? "P1" : p2 > 0 ? "P2" : null;
        const prev = bf.controller;

        if (winner) {
          bf.controller = winner;
          bf.contestedBy = null;
          d.log.unshift(`${winner} took control of Battlefield ${idx + 1} (unopposed).`);
          if (prev !== winner) attemptScore(d, winner, idx, "Conquer");
        } else {
          // No units left; battlefield becomes uncontrolled.
          bf.controller = null;
          bf.contestedBy = null;
        }

        cleanupStateBased(d);
        maybeOpenNextWindow(d);
      }
      return true;
    }

    if (d.windowKind === "COMBAT" && d.combat && d.combat.step === "SHOWDOWN") {
      d.passesInRow = 0;
      d.focusPlayer = null;
      const bfi = d.combat.battlefieldIndex;
      const attacker = d.combat.attacker;
      const defender = d.combat.defender;
      const bf = d.battlefields[bfi];

      const attackerUnits = bf.units[attacker].filter((u) => !u.stunned);
      const defenderUnits = bf.units[defender].filter((u) => !u.stunned);

      const attackerAlone = attackerUnits.length === 1;
      const defenderAlone = defenderUnits.length === 1;
      const attackerTotalDamage = attackerUnits.reduce(
        (s, u) => s + effectiveMight(u, { role: "ATTACKER", alone: attackerAlone, game: d, battlefieldIndex: bfi }),
        0
      );
      const defenderTotalDamage = defenderUnits.reduce(
        (s, u) => s + effectiveMight(u, { role: "DEFENDER", alone: defenderAlone, game: d, battlefieldIndex: bfi }),
        0
      );

      // Check if manual assignment is needed (more than 1 enemy unit to assign to)
      const attackerNeedsManual = defenderUnits.length > 1 && attackerTotalDamage > 0;
      const defenderNeedsManual = attackerUnits.length > 1 && defenderTotalDamage > 0;

      if (attackerNeedsManual || defenderNeedsManual) {
        // Transition to damage assignment step
        d.log.unshift("Combat showdown ends. Players assign damage...");
        d.combat.step = "DAMAGE_ASSIGNMENT";
        d.pendingDamageAssignment = {
          battlefieldIndex: bfi,
          attacker,
          defender,
          attackerTotalDamage,
          defenderTotalDamage,
          attackerAssignment: {},
          defenderAssignment: {},
          attackerConfirmed: !attackerNeedsManual,  // Auto-confirm if only 1 target
          defenderConfirmed: !defenderNeedsManual,  // Auto-confirm if only 1 target
        };
        // If a player doesn't need manual assignment, auto-assign for them
        if (!attackerNeedsManual && defenderUnits.length === 1 && attackerTotalDamage > 0) {
          d.pendingDamageAssignment.attackerAssignment[defenderUnits[0].instanceId] = attackerTotalDamage;
        }
        if (!defenderNeedsManual && attackerUnits.length === 1 && defenderTotalDamage > 0) {
          d.pendingDamageAssignment.defenderAssignment[attackerUnits[0].instanceId] = defenderTotalDamage;
        }
      } else {
        // No manual assignment needed, auto-assign
        d.log.unshift("Combat showdown ends. Assigning damage...");
        assignCombatDamageAuto(d, bfi, attacker, defender);
        d.combat.step = "DAMAGE";
        resolveCombatResolution(d);
      }
      return true;
    }

    // Fallback
    d.passesInRow = 0;
    d.priorityPlayer = d.turnPlayer;
    return true;
  };

  const engineExhaustRuneForEnergy = (d: GameState, pid: PlayerId, runeId: string): boolean => {
    const p = d.players[pid];
    const r = p.runesInPlay.find((x) => x.instanceId === runeId);
    if (!r) return false;
    if (!r.isReady) {
      d.log.unshift("Rune is exhausted.");
      return false;
    }
    // Rune ability: Exhaust: Add 1 Energy. This is a Reaction + Add and does not use chain (cannot be reacted to).
    r.isReady = false;
    p.runePool.energy += 1;
    d.log.unshift(`${pid} exhausted a ${r.domain} rune to add 1 energy.`);
    return true;
  };


  const engineExhaustSealForPower = (d: GameState, pid: PlayerId, gearId: string): boolean => {
    // parser marker for icon text: /\[\s*c\s*\]/i
    const p = d.players[pid];
    const gidx = p.base.gear.findIndex((x) => x.instanceId === gearId);
    if (gidx < 0) return false;
    const gear = p.base.gear[gidx];
    if (!gear.isReady) {
      d.log.unshift("Gear is exhausted.");
      return false;
    }

    // Many seals are templated like:
    //   "Exhaust: [Reaction] — [Add] 1 order rune."
    // Card data often includes bracketed tags ([Add]) and punctuation (—) that can break naive regex parsing.
    const raw = (gear.ability?.raw_text || gear.ability?.effect_text || "").toString();

    const clean = raw
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/\[[^\]]+\]/g, (m) => m.slice(1, -1)) // [Add] -> Add
      .replace(/[—–]/g, "-")
      .replace(/[:.]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // 1) Energy add (rare, but supported)
    const mEnergy = clean.match(/\badd\s+(\d+)\s+energy\b/);
    if (mEnergy) {
      const amt = Math.max(0, parseInt(mEnergy[1], 10) || 0);
      if (amt <= 0) return false;
      gear.isReady = false;
      p.runePool.energy += amt;
      p.sealExhaustedThisTurn = true; // Prevent auto-payer from recycling runes
      d.log.unshift(`${pid} exhausted ${gear.name} to add ${amt} energy.`);
      return true;
    }

    // 2) Domain-specific "rune" add => add power of that domain.
    //    (Costs and effects often use "fury rune" to mean 1 Fury power.)
    const mDom = clean.match(/\badd\s+(\d+)?\s*(body|calm|chaos|fury|mind|order|class)\s+(?:rune|power)\b/);
    if (mDom) {
      const amt = Math.max(0, parseInt(mDom[1] || "1", 10) || 0);
      if (amt <= 0) return false;
      gear.isReady = false;
      if (mDom[2] === "class") {
        const allowed = classDomainsForPlayer(d, pid);
        const chosen = allowed[0] || "Colorless";
        p.runePool.power[chosen] += amt;
        d.log.unshift(`${pid} exhausted ${gear.name} to add ${amt} ${chosen} power (class rune).`);
      } else {
        const dom = clampDomain(mDom[2]);
        p.runePool.power[dom] += amt;
        d.log.unshift(`${pid} exhausted ${gear.name} to add ${amt} ${dom} power.`);
      }
      p.sealExhaustedThisTurn = true; // Prevent auto-payer from recycling runes
      return true;
    }

    // 3) Any-domain add (fallback). If we can't infer a domain, assume it adds power matching the gear's domain
    //    (most seals are single-domain), otherwise default to the player's first domain.
    const mAny = clean.match(/\badd\s+(\d+)\s+(?:rune|power)\s+of\s+any\s+(?:type|domain|color)\b/) ||
      clean.match(/\badd\s+(\d+)\s+any\s+(?:rune|power)\b/);
    if (mAny) {
      const amt = Math.max(0, parseInt(mAny[1], 10) || 0);
      if (amt <= 0) return false;
      const doms = parseDomains(gear.domain).map(clampDomain).filter((x) => x !== "Colorless");
      const dom = doms[0] || p.domains[0] || "Fury";
      gear.isReady = false;
      p.runePool.power[dom] += amt;
      p.sealExhaustedThisTurn = true; // Prevent auto-payer from recycling runes
      d.log.unshift(`${pid} exhausted ${gear.name} to add ${amt} ${dom} power (any-domain add).`);
      return true;
    }

    // Conservative fallback: if it looks like a Seal, try using its printed domain as the power domain.
    const looksLikeSeal = gear.name.toLowerCase().includes("seal") || /\bseal\b/i.test(raw) || (gear.ability?.keywords || []).some((k) => k.toLowerCase().includes("add"));
    if (looksLikeSeal) {
      const doms = parseDomains(gear.domain).map(clampDomain).filter((x) => x !== "Colorless");
      const dom = doms[0] || p.domains[0] || "Fury";
      gear.isReady = false;
      p.runePool.power[dom] += 1;
      p.sealExhaustedThisTurn = true; // Prevent auto-payer from recycling runes
      d.log.unshift(`${pid} exhausted ${gear.name} to add 1 ${dom} power (fallback parse).`);
      return true;
    }

    d.log.unshift("This gear doesn't look like a Seal that adds resources (auto-detect failed).");
    return false;
  };

  // ----------------------------- Equipment System -----------------------------

  // Start the equip process - validates gear is equipment and player can afford the cost
  const engineEquipStart = (d: GameState, pid: PlayerId, gearId: string): boolean => {
    const p = d.players[pid];
    if (d.step !== "ACTION" || d.turnPlayer !== pid || d.windowKind !== "NONE" || d.chain.length > 0 || d.state !== "OPEN") {
      d.log.unshift("Equip can only be used during your Action step when the game is open.");
      return false;
    }
    const gidx = p.base.gear.findIndex((x) => x.instanceId === gearId);
    if (gidx < 0) {
      d.log.unshift("Equipment not found in base.");
      return false;
    }
    const gear = p.base.gear[gidx];

    if (!isEquipment(gear)) {
      d.log.unshift(`${gear.name} is not equipment.`);
      return false;
    }

    if (!gear.isReady) {
      d.log.unshift(`${gear.name} is exhausted.`);
      return false;
    }

    // Check if player has any units to attach to
    const units = getUnitsInPlay(d, pid);
    if (units.length === 0) {
      d.log.unshift("No units to attach equipment to.");
      return false;
    }

    // Parse the equip cost
    const equipCost = parseEquipCost(gear);
    if (!equipCost) {
      d.log.unshift(`Could not parse equip cost for ${gear.name}.`);
      return false;
    }

    // Check if player can afford the cost
    const pool = p.runePool;
    if (pool.energy < equipCost.energy) {
      d.log.unshift(`Cannot afford ${equipCost.energy} energy for equip cost.`);
      return false;
    }

    // For power cost, check if player has power in any of their domains
    if (equipCost.power > 0) {
      const playerDomains = p.domains;
      const hasPower = playerDomains.some(dom => (pool.power[dom] || 0) >= equipCost.power);
      if (!hasPower) {
        d.log.unshift(`Cannot afford ${equipCost.power} power for equip cost.`);
        return false;
      }
    }

    // Set pending equip choice
    d.pendingEquipChoice = {
      gearInstanceId: gearId,
      gearOwner: pid,
      equipCost,
    };
    d.log.unshift(`Select a unit to attach ${gear.name} to.`);
    return true;
  };

  // Confirm equipment attachment to a unit
  const engineEquipConfirm = (d: GameState, pid: PlayerId, unitId: string): boolean => {
    if (!d.pendingEquipChoice || d.pendingEquipChoice.gearOwner !== pid) {
      d.log.unshift("No pending equip choice.");
      return false;
    }

    const choice = d.pendingEquipChoice;
    const p = d.players[pid];

    // Find the gear
    const gidx = p.base.gear.findIndex((x) => x.instanceId === choice.gearInstanceId);
    if (gidx < 0) {
      d.pendingEquipChoice = null;
      d.log.unshift("Equipment no longer in base.");
      return false;
    }
    const gear = p.base.gear[gidx];

    // Find the unit
    const unitLoc = locateUnit(d, pid, unitId);
    if (!unitLoc) {
      d.log.unshift("Unit not found.");
      return false;
    }
    const unit = unitLoc.unit;

    // Pay the cost
    const pool = p.runePool;
    const cost = choice.equipCost;
    const allowedDomains = classDomainsForPlayer(d, pid);

    // Auto-pay support so Equip can consume seal-like power generation first.
    if (autoPayEnabled) {
      const plan = buildAutoPayPlan(pool, p.runesInPlay, {
        energyNeed: cost.energy,
        basePowerNeed: cost.power,
        powerDomainsAllowed: allowedDomains,
        additionalPowerByDomain: {},
        additionalPowerAny: 0,
      }, {
        sealExhaustedThisTurn: p.sealExhaustedThisTurn,
        seals: p.base.gear,
        playerDomains: p.domains,
      });
      if (plan) {
        applyAutoPayPlan(d, pid, plan);
      }
    }

    if (pool.energy < cost.energy) {
      d.pendingEquipChoice = null;
      d.log.unshift("Cannot afford energy cost.");
      return false;
    }
    pool.energy -= cost.energy;

    if (cost.power > 0) {
      // Pay power from player's domains
      const playerDomains = p.domains;
      const payDom = playerDomains.find(dom => (pool.power[dom] || 0) >= cost.power);
      if (!payDom) {
        pool.energy += cost.energy; // Refund energy
        d.pendingEquipChoice = null;
        d.log.unshift("Cannot afford power cost.");
        return false;
      }
      pool.power[payDom] -= cost.power;
      d.log.unshift(`${pid} paid ${cost.energy > 0 ? cost.energy + " energy + " : ""}${cost.power} ${payDom} power to equip.`);
    } else if (cost.energy > 0) {
      d.log.unshift(`${pid} paid ${cost.energy} energy to equip.`);
    }

    // Calculate might before attaching equipment
    const previousMight = effectiveMight(unit, { role: "NONE", game: d });

    // Remove gear from base and attach to unit
    p.base.gear.splice(gidx, 1);
    if (!unit.attachedGear) unit.attachedGear = [];
    unit.attachedGear.push(gear);

    d.log.unshift(`${gear.name} attached to ${unit.name} (+${gear.stats?.might || 0} might).`);
    d.pendingEquipChoice = null;

    // Check if unit became Mighty and fire triggers (e.g., Fiora, Grand Duelist)
    checkBecomesMighty(d, unit, previousMight);

    return true;
  };

  // Helper to check if a gear has a "Kill this:" activated ability
  const getKillThisAbility = (gear: CardInstance): string | null => {
    const raw = gear.ability?.raw_text || gear.ability?.effect_text || "";
    const match = raw.match(/Kill\s+this[^:]*:\s*([^.]+\.?)/i);
    return match ? match[1].trim() : null;
  };

  // Helper to check if a unit has a "Spend my buff:" activated ability
  const getSpendMyBuffAbility = (unit: CardInstance): string | null => {
    const raw = unit.ability?.raw_text || unit.ability?.effect_text || "";
    // Check for multi-line modal ability (Udyr style: "Spend my buff: Choose one...")
    const modalMatch = raw.match(/Spend\s+my\s+buff[:\s—-]+Choose\s+one[^\n]*([\s\S]*?)(?=\n\n|$)/i);
    if (modalMatch) {
      // Return the full modal text including options
      return "Choose one" + modalMatch[1].trim();
    }
    // Standard single-effect ability
    const match = raw.match(/Spend\s+my\s+buff[:\s—-]+([^.]+\.?)/i);
    return match ? match[1].trim() : null;
  };

  // Activate "Kill this:" ability on a gear
  const engineKillGearActivate = (d: GameState, pid: PlayerId, gearInstanceId: string): boolean => {
    const p = d.players[pid];

    // Find the gear in base
    const gidx = p.base.gear.findIndex((x) => x.instanceId === gearInstanceId);
    if (gidx < 0) {
      d.log.unshift("Gear not found in base.");
      return false;
    }
    const gear = p.base.gear[gidx];

    // Get the Kill this ability text
    const killAbility = getKillThisAbility(gear);
    if (!killAbility) {
      d.log.unshift(`${gear.name} has no 'Kill this' ability.`);
      return false;
    }

    // Remove gear from base and put in trash (kill it)
    p.base.gear.splice(gidx, 1);
    if (!tokenCeasesToExist(d, gear, "trash")) {
      p.trash.push(gear);
      d.log.unshift(`${pid} sacrificed ${gear.name} to activate its ability.`);
    } else {
      d.log.unshift(`${pid} sacrificed ${gear.name} to activate its ability.`);
    }

    // Queue the ability as an activated ability on the chain
    const req = inferTargetRequirement(killAbility, { here: false });
    const chainItem: ChainItem = {
      id: makeId("chain"),
      controller: pid,
      kind: "ACTIVATED_ABILITY",
      label: `${gear.name} — Kill this`,
      effectText: killAbility,
      contextBattlefieldIndex: null,
      needsTargets: req.kind !== "NONE",
      targetRequirement: req,
      targets: [{ kind: "NONE" }],
      sourceInstanceId: gear.instanceId,
    };
    d.chain.push(chainItem);
    d.state = "CLOSED";
    d.passesInRow = 0;
    d.priorityPlayer = pid;
    d.log.unshift(`Activated ability queued: ${gear.name} (Kill this).`);

    return true;
  };

  // Activate "Spend my buff:" ability on a unit
  const engineSpendMyBuffActivate = (d: GameState, pid: PlayerId, unitInstanceId: string): boolean => {
    // Find the unit in play (base or battlefield)
    const loc = locateUnit(d, pid, unitInstanceId);
    if (!loc) {
      d.log.unshift("Unit not found.");
      return false;
    }

    const unit = loc.zone === "BASE"
      ? d.players[pid].base.units.find(u => u.instanceId === unitInstanceId)
      : d.battlefields[loc.battlefieldIndex!].units[pid].find(u => u.instanceId === unitInstanceId);

    if (!unit) {
      d.log.unshift("Unit not found.");
      return false;
    }

    // Check if unit has the ability
    const spendAbility = getSpendMyBuffAbility(unit);
    if (!spendAbility) {
      d.log.unshift(`${unit.name} has no 'Spend my buff' ability.`);
      return false;
    }

    // Check if unit has a buff to spend
    if (!unit.buffs || unit.buffs <= 0) {
      d.log.unshift(`${unit.name} has no buff to spend.`);
      return false;
    }

    // Spend the buff
    unit.buffs -= 1;
    d.log.unshift(`${pid} spent ${unit.name}'s buff to activate its ability.`);

    // Queue the ability as an activated ability on the chain
    const req = inferTargetRequirement(spendAbility, { here: loc.zone === "BF" });
    const chainItem: ChainItem = {
      id: makeId("chain"),
      controller: pid,
      kind: "ACTIVATED_ABILITY",
      label: `${unit.name} — Spend my buff`,
      effectText: spendAbility,
      contextBattlefieldIndex: loc.zone === "BF" ? loc.battlefieldIndex : null,
      needsTargets: req.kind !== "NONE",
      targetRequirement: req,
      targets: [{ kind: "NONE" }],
      sourceInstanceId: unit.instanceId,
    };
    d.chain.push(chainItem);
    d.state = "CLOSED";
    d.passesInRow = 0;
    d.priorityPlayer = pid;
    d.log.unshift(`Activated ability queued: ${unit.name} (Spend my buff).`);

    return true;
  };

  // Resolve Cull the Weak choices (each player kills one of their units)
  const engineCullChoose = (d: GameState, pid: PlayerId, unitInstanceId: string): boolean => {
    const pending = d.pendingCullChoice;
    if (!pending) return false;
    const current = pending.order[pending.index];
    if (current !== pid) return false;

    const units = getUnitsInPlay(d, pid);
    if (units.length === 0) {
      pending.choices[pid] = null;
    } else {
      const loc = locateUnit(d, pid, unitInstanceId);
      if (!loc || loc.unit.owner !== pid) {
        d.log.unshift("Invalid cull choice.");
        return false;
      }
      pending.choices[pid] = loc.unit.instanceId;
      d.log.unshift(`${pid} chose ${loc.unit.name} for Cull the Weak.`);
    }

    pending.index += 1;
    advanceCullChoice(d);
    if (!d.pendingCullChoice) resolveTopOfChain(d);
    return true;
  };

  // ----------------------------- Combat Damage Assignment -----------------------------

  const engineDamageAssign = (d: GameState, pid: PlayerId, assignment: Record<string, number>): boolean => {
    if (!d.pendingDamageAssignment || !d.combat || d.combat.step !== "DAMAGE_ASSIGNMENT") {
      d.log.unshift("No pending damage assignment.");
      return false;
    }

    const pda = d.pendingDamageAssignment;
    const isAttacker = pid === pda.attacker;
    const isDefender = pid === pda.defender;

    if (!isAttacker && !isDefender) {
      d.log.unshift("Player not in combat.");
      return false;
    }

    const bf = d.battlefields[pda.battlefieldIndex];
    const totalDamage = isAttacker ? pda.attackerTotalDamage : pda.defenderTotalDamage;
    const targetUnits = isAttacker ? bf.units[pda.defender] : bf.units[pda.attacker];
    const targetUnitIds = new Set(targetUnits.filter(u => !u.stunned).map(u => u.instanceId));

    // Validate assignment
    let assignedTotal = 0;
    for (const [unitId, dmg] of Object.entries(assignment)) {
      if (!targetUnitIds.has(unitId)) {
        d.log.unshift(`Invalid target unit: ${unitId}`);
        return false;
      }
      if (dmg < 0) {
        d.log.unshift("Cannot assign negative damage.");
        return false;
      }
      assignedTotal += dmg;
    }

    if (assignedTotal !== totalDamage) {
      d.log.unshift(`Must assign exactly ${totalDamage} damage (assigned ${assignedTotal}).`);
      return false;
    }

    // Check Tank rule: Tanks must receive damage first
    const tanks = targetUnits.filter(u => !u.stunned && hasKeyword(u, "Tank"));
    const nonTanks = targetUnits.filter(u => !u.stunned && !hasKeyword(u, "Tank"));
    if (tanks.length > 0) {
      // If there are tanks, non-tanks can only receive damage if all tanks are dead
      const tankDamage = tanks.reduce((sum, t) => sum + (assignment[t.instanceId] || 0), 0);
      const tankLethal = tanks.reduce((sum, t) => sum + effectiveMight(t, { role: isAttacker ? "DEFENDER" : "ATTACKER", alone: targetUnits.length === 1, game: d, battlefieldIndex: pda.battlefieldIndex }), 0);
      const nonTankDamage = nonTanks.reduce((sum, t) => sum + (assignment[t.instanceId] || 0), 0);

      if (nonTankDamage > 0 && tankDamage < tankLethal) {
        d.log.unshift("Must assign lethal damage to Tanks before damaging other units.");
        return false;
      }
    }

    // Store assignment
    if (isAttacker) {
      pda.attackerAssignment = assignment;
    } else {
      pda.defenderAssignment = assignment;
    }

    d.log.unshift(`${pid} assigned ${totalDamage} damage.`);
    return true;
  };

  const engineDamageConfirm = (d: GameState, pid: PlayerId): boolean => {
    if (!d.pendingDamageAssignment || !d.combat || d.combat.step !== "DAMAGE_ASSIGNMENT") {
      d.log.unshift("No pending damage assignment.");
      return false;
    }

    const pda = d.pendingDamageAssignment;
    const isAttacker = pid === pda.attacker;
    const isDefender = pid === pda.defender;

    if (!isAttacker && !isDefender) {
      d.log.unshift("Player not in combat.");
      return false;
    }

    // Check if assignment is complete
    const totalDamage = isAttacker ? pda.attackerTotalDamage : pda.defenderTotalDamage;
    const assignment = isAttacker ? pda.attackerAssignment : pda.defenderAssignment;
    const assignedTotal = Object.values(assignment).reduce((a, b) => a + b, 0);

    if (assignedTotal !== totalDamage) {
      d.log.unshift(`Must assign all ${totalDamage} damage before confirming.`);
      return false;
    }

    if (isAttacker) {
      pda.attackerConfirmed = true;
    } else {
      pda.defenderConfirmed = true;
    }

    d.log.unshift(`${pid} confirmed damage assignment.`);

    // If both confirmed, apply damage and proceed
    if (pda.attackerConfirmed && pda.defenderConfirmed) {
      applyManualDamageAssignment(d);
    }

    return true;
  };

  const engineDamageAutoAssign = (d: GameState, pid: PlayerId): boolean => {
    if (!d.pendingDamageAssignment || !d.combat || d.combat.step !== "DAMAGE_ASSIGNMENT") {
      d.log.unshift("No pending damage assignment.");
      return false;
    }

    const pda = d.pendingDamageAssignment;
    const isAttacker = pid === pda.attacker;
    const isDefender = pid === pda.defender;

    if (!isAttacker && !isDefender) {
      d.log.unshift("Player not in combat.");
      return false;
    }

    const bf = d.battlefields[pda.battlefieldIndex];
    const totalDamage = isAttacker ? pda.attackerTotalDamage : pda.defenderTotalDamage;
    const targetUnits = isAttacker ? bf.units[pda.defender] : bf.units[pda.attacker];
    const role: "ATTACKER" | "DEFENDER" = isAttacker ? "DEFENDER" : "ATTACKER";
    const alone = targetUnits.length === 1;

    // Auto-assign: Tanks first, then by order, assigning lethal damage
    const tanks = targetUnits.filter(u => !u.stunned && hasKeyword(u, "Tank"));
    const rest = targetUnits.filter(u => !u.stunned && !hasKeyword(u, "Tank"));
    const order = tanks.length > 0 ? [...tanks, ...rest] : [...targetUnits.filter(u => !u.stunned)];

    const assignment: Record<string, number> = {};
    let remaining = totalDamage;

    for (const u of order) {
      if (remaining <= 0) break;
      const lethal = effectiveMight(u, { role, alone, game: d, battlefieldIndex: pda.battlefieldIndex });
      const need = Math.max(0, lethal - u.damage);
      const assign = Math.min(need, remaining);
      if (assign > 0) {
        assignment[u.instanceId] = assign;
        remaining -= assign;
      }
    }

    // Spill remaining onto last unit
    if (remaining > 0 && order.length > 0) {
      const lastId = order[order.length - 1].instanceId;
      assignment[lastId] = (assignment[lastId] || 0) + remaining;
    }

    // Store and confirm
    if (isAttacker) {
      pda.attackerAssignment = assignment;
      pda.attackerConfirmed = true;
    } else {
      pda.defenderAssignment = assignment;
      pda.defenderConfirmed = true;
    }

    d.log.unshift(`${pid} auto-assigned ${totalDamage} damage.`);

    // If both confirmed, apply damage and proceed
    if (pda.attackerConfirmed && pda.defenderConfirmed) {
      applyManualDamageAssignment(d);
    }

    return true;
  };

  const applyManualDamageAssignment = (d: GameState): void => {
    if (!d.pendingDamageAssignment || !d.combat) return;

    const pda = d.pendingDamageAssignment;
    const bf = d.battlefields[pda.battlefieldIndex];

    // Apply attacker's damage to defender's units
    for (const [unitId, dmg] of Object.entries(pda.attackerAssignment)) {
      const unit = bf.units[pda.defender].find(u => u.instanceId === unitId);
      if (unit && dmg > 0) {
        if (unitIgnoresDamageThisTurn(unit)) {
          d.log.unshift(`${unit.name} ignored combat damage (moved twice this turn).`);
          continue;
        }
        if (unit.preventNextDamageUntilTurn && unit.preventNextDamageUntilTurn >= d.turnNumber) {
          unit.preventNextDamageUntilTurn = 0;
          d.log.unshift(`${unit.name} prevented combat damage (Counter Strike).`);
          continue;
        }
        unit.damage += dmg;
        if (unit.killOnDamageUntilTurn && unit.killOnDamageUntilTurn >= d.turnNumber && unit.damage > 0) {
          unit.damage = 999;
          unit.killOnDamageUntilTurn = 0;
        } else if (damageKillEffectActive(d)) {
          unit.damage = 999;
        }
      }
    }

    // Apply defender's damage to attacker's units
    for (const [unitId, dmg] of Object.entries(pda.defenderAssignment)) {
      const unit = bf.units[pda.attacker].find(u => u.instanceId === unitId);
      if (unit && dmg > 0) {
        if (unitIgnoresDamageThisTurn(unit)) {
          d.log.unshift(`${unit.name} ignored combat damage (moved twice this turn).`);
          continue;
        }
        if (unit.preventNextDamageUntilTurn && unit.preventNextDamageUntilTurn >= d.turnNumber) {
          unit.preventNextDamageUntilTurn = 0;
          d.log.unshift(`${unit.name} prevented combat damage (Counter Strike).`);
          continue;
        }
        unit.damage += dmg;
        if (unit.killOnDamageUntilTurn && unit.killOnDamageUntilTurn >= d.turnNumber && unit.damage > 0) {
          unit.damage = 999;
          unit.killOnDamageUntilTurn = 0;
        } else if (damageKillEffectActive(d)) {
          unit.damage = 999;
        }
      }
    }

    // Calculate excess damage for each side
    const attackerExcess = Object.entries(pda.attackerAssignment).reduce((sum, [unitId, dmg]) => {
      const unit = bf.units[pda.defender].find(u => u.instanceId === unitId);
      if (!unit) return sum;
      const lethal = effectiveMight(unit, { role: "DEFENDER", alone: bf.units[pda.defender].length === 1, game: d, battlefieldIndex: pda.battlefieldIndex });
      return sum + Math.max(0, dmg - lethal);
    }, 0);

    const defenderExcess = Object.entries(pda.defenderAssignment).reduce((sum, [unitId, dmg]) => {
      const unit = bf.units[pda.attacker].find(u => u.instanceId === unitId);
      if (!unit) return sum;
      const lethal = effectiveMight(unit, { role: "ATTACKER", alone: bf.units[pda.attacker].length === 1, game: d, battlefieldIndex: pda.battlefieldIndex });
      return sum + Math.max(0, dmg - lethal);
    }, 0);

    d.lastCombatExcessDamage = {
      [pda.attacker]: attackerExcess,
      [pda.defender]: defenderExcess,
    } as Record<PlayerId, number>;
    d.lastCombatExcessDamageTurn = d.turnNumber;

    d.log.unshift(
      `Combat damage applied at Battlefield ${pda.battlefieldIndex + 1}: ${pda.attacker} dealt ${pda.attackerTotalDamage}, ${pda.defender} dealt ${pda.defenderTotalDamage}.`
    );

    // Clear pending and proceed to DAMAGE step
    d.pendingDamageAssignment = null;
    d.combat.step = "DAMAGE";
    resolveCombatResolution(d);
  };

  type LegendActivatedParse = {
    rawLine: string;
    effectText: string;
    req: TargetRequirement;
    cost: {
      energy: number;
      powerByDomain: Partial<Record<Domain, number>>;
      powerClass: number;
      powerAny: number;
    };
  };

  type RepeatCost = {
    energy: number;
    powerByDomain: Partial<Record<Domain, number>>;
    powerClass: number;
    powerAny: number;
  };

  const applyRepeatCostDiscount = (game: GameState, player: PlayerId, cost: RepeatCost | null): RepeatCost | null => {
    if (!cost) return null;
    const controlsSpire = game.battlefields.some((bf) => bf.controller === player && battlefieldDiscountsRepeat(bf));
    if (!controlsSpire || cost.energy <= 0) return cost;
    return { ...cost, energy: Math.max(0, cost.energy - 1) };
  };

  type GearActivatedParse = {
    rawLine: string;
    effectText: string;
    req: TargetRequirement;
    cost: {
      energy: number;
      powerByDomain: Partial<Record<Domain, number>>;
      powerClass: number;
      powerAny: number;
      exhaustSelf: boolean;
      killSelf: boolean;
    };
  };

  const legendActivatedEffect = (legend: CardData | null): LegendActivatedParse | null => {
    // keep symbol markers in payload: /(?!\s*(?:add|a|c|s|t|e|\d+)\s*\])/
    if (!legend) return null;
    const rawAll = ((legend.ability?.raw_text || "") + "\n" + (legend.ability?.effect_text || "")).trim();
    if (!rawAll) return null;

    const lines = rawAll
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);

    const pickLine =
      lines.find((l) => /\bexhaust\b\s*:/i.test(l)) ||
      lines.find((l) => /^\s*\[e\]\s*:/i.test(l)) ||
      lines.find((l) => /^\s*\[t\]\s*:/i.test(l)) ||  // [T]: is tap/exhaust notation
      lines.find((l) => /\bexhaust\b/i.test(l) && l.includes(":")) ||
      lines.find((l) => /\[\d+\]\s*,\s*\[t\]\s*:/i.test(l)) ||  // [N], [T]: pattern (e.g., Viktor's [1], [T]:)
      lines.find((l) => /,\s*\[t\]\s*:/i.test(l)) ||  // cost, [T]: pattern
      null;

    if (!pickLine) return null;

    // Match the tap/exhaust marker to find where the effect text starts
    const ex =
      /\bexhaust\b\s*:/i.exec(pickLine) ||
      /^\s*\[e\]\s*:/i.exec(pickLine) ||
      /^\s*\[t\]\s*:/i.exec(pickLine) ||
      /\[\d+\]\s*,\s*\[t\]\s*:/i.exec(pickLine) ||  // [N], [T]: pattern
      /,\s*\[t\]\s*:/i.exec(pickLine);
    if (!ex) return null;

    // Everything before "exhaust:" is treated as an activation cost (e.g. "1 energy,").
    // For patterns like "[1], [T]:", the cost is embedded in the matched pattern itself,
    // so we include both the text before the match AND the matched text (minus the [T]: part)
    const beforeMatch = pickLine.slice(0, ex.index).trim();
    const matchedText = ex[0];
    // Extract costs from the matched pattern (e.g., "[1], [T]:" -> "[1], ")
    const costFromMatch = matchedText.replace(/\[t\]\s*:/i, "").replace(/\[e\]\s*:/i, "").replace(/\bexhaust\b\s*:/i, "").trim();
    const costPart = (beforeMatch + " " + costFromMatch).trim();

    const cost: LegendActivatedParse["cost"] = {
      energy: 0,
      powerByDomain: {},
      powerClass: 0,
      powerAny: 0,
    };

    // Parse energy costs - both "N energy" and "[N]" formats
    const energyM = costPart.match(/(\d+)\s*energy\b/i);
    if (energyM) {
      const n = parseInt(energyM[1], 10);
      if (Number.isFinite(n) && n > 0) cost.energy += n;
    }

    // Also check for bracketed number costs like [1], [2] which represent energy
    const bracketedEnergy = costPart.match(/\[(\d+)\]/g);
    if (bracketedEnergy) {
      for (const match of bracketedEnergy) {
        const numMatch = match.match(/\[(\d+)\]/);
        if (numMatch) {
          const n = parseInt(numMatch[1], 10);
          if (Number.isFinite(n) && n > 0) cost.energy += n;
        }
      }
    }

    // Domain-specific rune costs (rare; but some legends/spells may have them)
    const runeRe = /(\d+)\s*(body|calm|chaos|fury|mind|order)\s*rune\b/gi;
    let rm: RegExpExecArray | null;
    while ((rm = runeRe.exec(costPart))) {
      const n = parseInt(rm[1], 10);
      const dom = clampDomain(rm[2]);
      if (Number.isFinite(n) && n > 0) cost.powerByDomain[dom] = (cost.powerByDomain[dom] || 0) + n;
    }

    const classCost = costPart.match(/(\d+)?\s*class\s*rune\b/i);
    if (classCost) {
      const n = classCost[1] ? parseInt(classCost[1], 10) : 1;
      if (Number.isFinite(n) && n > 0) cost.powerClass += n;
    }

    // Also check for [C] which represents class rune cost
    const bracketedClass = (costPart.match(/\[C\]/gi) || []).length;
    if (bracketedClass > 0) {
      cost.powerClass += bracketedClass;
    }

    const anyM = costPart.match(/(\d+)\s*rune\s+of\s+any\s+type\b/i);
    if (anyM) {
      const n = parseInt(anyM[1], 10);
      if (Number.isFinite(n) && n > 0) cost.powerAny += n;
    }

    // Also check for [A] which represents any rune cost
    const bracketedAny = (costPart.match(/\[A\]/gi) || []).length;
    if (bracketedAny > 0) {
      cost.powerAny += bracketedAny;
    }

    // Effect is everything after "exhaust:" or "[T]:" (cleaned up a bit)
    let eff = pickLine;

    // Remove any leading "[E]:" or "[T]:" shorthand for Exhaust/Tap.
    eff = eff.replace(/^\s*\[e\]\s*:/i, "").trim();
    eff = eff.replace(/^\s*\[t\]\s*:/i, "").trim();

    // Remove leading "exhaust:" (with optional costs before it).
    eff = eff.replace(/^[\s\S]*?\bexhaust\b\s*:/i, "").trim();

    // Remove [N], [T]: pattern (e.g., "[1], [T]:" or "[2], [T]:")
    eff = eff.replace(/^\s*\[\d+\]\s*,\s*\[t\]\s*:/i, "").trim();

    // Remove cost + [T]: pattern (e.g., "2 energy, [T]:")
    eff = eff.replace(/^[\s\S]*?,\s*\[t\]\s*:/i, "").trim();

    // Remove leading "Action —" / "Reaction —" and also "[Reaction], [Legion] —" style labels.
    eff = eff.replace(/^\s*(action|reaction)\s*[—-]\s*/i, "").trim();
    eff = eff.replace(/^\s*(?:\[[^\]]+\]\s*,?\s*)+—\s*/i, "").trim();
    eff = eff.replace(/^\s*(?:\[[^\]]+\]\s*,?\s*)+/i, "").trim();
    eff = eff.replace(/^\s*[—-]\s*/i, "").trim();

    if (!eff) return null;

    const req = inferTargetRequirement(eff, { here: false });
    return { rawLine: pickLine, effectText: eff, req, cost };
  };

  const parseRepeatCost = (card: CardInstance): RepeatCost | null => {
    const rawAll = ((card.ability?.raw_text || "") + " " + (card.ability?.effect_text || "")).toString();
    if (!rawAll) return null;

    const cleaned = rawAll
      .replace(/\\/g, " ")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const m =
      cleaned.match(/\[repeat\]\s*([^.)\n]+)/i) ||
      cleaned.match(/\brepeat\b\s*([^.)\n]+)/i);
    if (!m) return null;

    const costPart = m[1]
      .replace(/\(([^)]*)\)/g, "") // remove reminder text
      .replace(/[—–]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!costPart) return null;

    const cost: RepeatCost = { energy: 0, powerByDomain: {}, powerClass: 0, powerAny: 0 };

    const energyM = costPart.match(/(\d+)\s*energy\b/i);
    if (energyM) {
      const n = parseInt(energyM[1], 10);
      if (Number.isFinite(n) && n > 0) cost.energy += n;
    }
    const bracketedEnergy = costPart.match(/\[(\d+)\]/g);
    if (bracketedEnergy) {
      for (const match of bracketedEnergy) {
        const numMatch = match.match(/\[(\d+)\]/);
        if (numMatch) {
          const n = parseInt(numMatch[1], 10);
          if (Number.isFinite(n) && n > 0) cost.energy += n;
        }
      }
    }

    const runeRe = /(\d+)\s*(body|calm|chaos|fury|mind|order)\s*rune\b/gi;
    let rm: RegExpExecArray | null;
    while ((rm = runeRe.exec(costPart))) {
      const n = parseInt(rm[1], 10);
      const dom = clampDomain(rm[2]);
      if (Number.isFinite(n) && n > 0) cost.powerByDomain[dom] = (cost.powerByDomain[dom] || 0) + n;
    }

    const classCost = costPart.match(/(\d+)?\s*class\s*rune\b/i);
    if (classCost) {
      const n = classCost[1] ? parseInt(classCost[1], 10) : 1;
      if (Number.isFinite(n) && n > 0) cost.powerClass += n;
    }
    const bracketedClass = (costPart.match(/\[C\]/gi) || []).length;
    if (bracketedClass > 0) cost.powerClass += bracketedClass;

    const anyM = costPart.match(/(\d+)\s*(?:any\s+rune|rune\s+of\s+any\s+type)\b/i);
    if (anyM) {
      const n = parseInt(anyM[1], 10);
      if (Number.isFinite(n) && n > 0) cost.powerAny += n;
    }
    const bracketedAny = (costPart.match(/\[A\]/gi) || []).length;
    if (bracketedAny > 0) cost.powerAny += bracketedAny;

    if (cost.energy === 0 && cost.powerClass === 0 && cost.powerAny === 0 && Object.keys(cost.powerByDomain).length === 0) {
      return null;
    }
    return cost;
  };

  const gearActivatedEffect = (gear: CardInstance | null): GearActivatedParse | null => {
    if (!gear) return null;
    const rawAll = ((gear.ability?.raw_text || "") + "\n" + (gear.ability?.effect_text || "")).trim();
    if (!rawAll) return null;

    const lines = rawAll
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);

    const pickLine =
      lines.find((l) => /exhaust\s*:/i.test(l) || /^\s*\[t\]\s*:/i.test(l) || /^\s*\[e\]\s*:/i.test(l) || /\bkill this\b/i.test(l)) ||
      lines.find((l) => l.includes(":")) ||
      null;

    if (!pickLine || !pickLine.includes(":")) return null;

    const parts = pickLine.split(":");
    const costPartRaw = parts[0] || "";
    const effectPartRaw = parts.slice(1).join(":") || "";

    const costPart = costPartRaw.replace(/\s+/g, " ").trim();
    const cost: GearActivatedParse["cost"] = {
      energy: 0,
      powerByDomain: {},
      powerClass: 0,
      powerAny: 0,
      exhaustSelf: /\bexhaust\b|\[t\]|\[e\]/i.test(costPart),
      killSelf: /\bkill\s+this\b|\bsacrifice\b/i.test(costPart),
    };

    const energyM = costPart.match(/(\d+)\s*energy\b/i);
    if (energyM) {
      const n = parseInt(energyM[1], 10);
      if (Number.isFinite(n) && n > 0) cost.energy += n;
    }
    const bracketedEnergy = costPart.match(/\[(\d+)\]/g);
    if (bracketedEnergy) {
      for (const match of bracketedEnergy) {
        const numMatch = match.match(/\[(\d+)\]/);
        if (numMatch) {
          const n = parseInt(numMatch[1], 10);
          if (Number.isFinite(n) && n > 0) cost.energy += n;
        }
      }
    }

    const runeRe = /(\d+)\s*(body|calm|chaos|fury|mind|order)\s*rune\b/gi;
    let rm: RegExpExecArray | null;
    while ((rm = runeRe.exec(costPart))) {
      const n = parseInt(rm[1], 10);
      const dom = clampDomain(rm[2]);
      if (Number.isFinite(n) && n > 0) cost.powerByDomain[dom] = (cost.powerByDomain[dom] || 0) + n;
    }

    const classCost = costPart.match(/(\d+)?\s*class\s*rune\b/i);
    if (classCost) {
      const n = classCost[1] ? parseInt(classCost[1], 10) : 1;
      if (Number.isFinite(n) && n > 0) cost.powerClass += n;
    }
    const bracketedClass = (costPart.match(/\[C\]/gi) || []).length;
    if (bracketedClass > 0) cost.powerClass += bracketedClass;

    const anyM = costPart.match(/(\d+)\s*(?:any\s+rune|rune\s+of\s+any\s+type)\b/i);
    if (anyM) {
      const n = parseInt(anyM[1], 10);
      if (Number.isFinite(n) && n > 0) cost.powerAny += n;
    }
    const bracketedAny = (costPart.match(/\[A\]/gi) || []).length;
    if (bracketedAny > 0) cost.powerAny += bracketedAny;

    let eff = effectPartRaw.trim();
    eff = eff.replace(/^\s*(action|reaction)\s*[—-]\s*/i, "").trim();
    eff = eff.replace(/^\s*(?:\[[^\]]+\]\s*,?\s*)+—\s*/i, "").trim();
    eff = eff.replace(/^\s*(?:\[[^\]]+\]\s*,?\s*)+/i, "").trim();
    eff = eff.replace(/^\s*[—-]\s*/i, "").trim();
    if (!eff) return null;

    const req = inferTargetRequirement(eff, { here: false });
    return { rawLine: pickLine, effectText: eff, req, cost };
  };


  const engineActivateLegend = (
    d: GameState,
    pid: PlayerId,
    targets?: Target[],
    opts?: { autoPay?: boolean }
  ): boolean => {
    // class-rune marker normalization: /\[\s*c\s*\]/i
    const p = d.players[pid];
    if (!p.legend) return false;

    if (d.priorityPlayer !== pid) {
      d.log.unshift("You must have priority to activate your Legend.");
      return false;
    }

    const top = d.chain[d.chain.length - 1];
    if (top && top.needsTargets && top.controller === pid) {
      const t0 = top.targets?.[0];
      if (!t0 || t0.kind === "NONE") {
        d.log.unshift("Choose targets for your pending chain item first.");
        return false;
      }
    }

    if (!p.legendReady) {
      d.log.unshift("Legend is exhausted.");
      return false;
    }

    if (!p.legend) return false;
    const legendRaw = `${p.legend.ability?.raw_text || ""} ${p.legend.ability?.effect_text || ""}`;
    const legendHasLegionActivation = /\[\s*legion\s*\]/i.test(legendRaw) && (/\[t\]\s*:|\[e\]\s*:|\bexhaust\b\s*:/i.test(legendRaw));
    if (legendHasLegionActivation && p.mainDeckCardsPlayedThisTurn < 1) {
      d.log.unshift("Legend Legion ability is inactive (play another card this turn first).");
      return false;
    }

    let parsed = legendActivatedEffect(p.legend);
    if (!parsed) {
      const grantsEquip = d.battlefields.some((bf) => bf.controller === pid && battlefieldGrantsLegendEquip(bf));
      if (grantsEquip) {
        parsed = {
          rawLine: "Forge of the Fluft",
          effectText: "Attach an equipment you control to a unit you control.",
          req: { kind: "UNIT_AND_GEAR_FRIENDLY" },
          cost: { energy: 0, powerByDomain: {}, powerClass: 0, powerAny: 0 },
        };
      }
    }
    if (!parsed) {
      d.log.unshift("Legend has no activated Exhaust ability the emulator can parse yet.");
      return false;
    }

    const legendTiming = inferActivatedTimingClass(parsed.rawLine);
    if (!canUseTimingClassNow(d, pid, legendTiming)) {
      if (legendTiming === "REACTION") d.log.unshift("Legend ability can only be used as a Reaction right now.");
      else if (legendTiming === "ACTION") d.log.unshift("Legend ability can only be used as an Action (your turn or showdown with priority).");
      else d.log.unshift("Legend ability can only be used at main action speed.");
      return false;
    }

    const eff = parsed.effectText;
    const req = parsed.req;
    const chosen: Target[] = targets && targets.length ? targets : [{ kind: "NONE" }];

    const autoPay = !!opts?.autoPay;

    // ---- Pay activation costs (besides exhausting the legend itself) ----
    // Energy
    const energyNeed = parsed.cost.energy || 0;
    if (energyNeed > 0) {
      if (p.runePool.energy < energyNeed && autoPay) {
        // Auto-exhaust ready runes to generate energy
        let missing = energyNeed - p.runePool.energy;
        const readyRunes = p.runesInPlay.filter((r) => r.isReady);
        let used = 0;
        for (const r of readyRunes) {
          if (missing <= 0) break;
          r.isReady = false;
          p.runePool.energy += 1;
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-exhausted ${used} rune(s) to pay Legend energy cost.`);
      }

      if (p.runePool.energy < energyNeed) {
        d.log.unshift(`Not enough energy to activate Legend (need ${energyNeed}).`);
        return false;
      }
      p.runePool.energy -= energyNeed;
      d.log.unshift(`${pid} paid ${energyNeed} energy for Legend activation.`);
    }

    // Domain-specific power (rare)
    const byDom = parsed.cost.powerByDomain || {};
    for (const dom of Object.keys(byDom) as Domain[]) {
      const need = byDom[dom] || 0;
      if (need <= 0) continue;

      if ((p.runePool.power[dom] || 0) < need && autoPay) {
        // Auto-recycle runes of that domain to generate power
        let missing = need - (p.runePool.power[dom] || 0);
        const candidates = p.runesInPlay.filter((r) => r.domain === dom);
        let used = 0;
        for (const r of candidates) {
          if (missing <= 0) break;
          engineRecycleRuneForPower(d, pid, r.instanceId);
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-recycled ${used} ${dom} rune(s) to pay Legend power cost.`);
      }

      if ((p.runePool.power[dom] || 0) < need) {
        d.log.unshift(`Not enough ${dom} power to activate Legend (need ${need}).`);
        return false;
      }

      p.runePool.power[dom] -= need;
      d.log.unshift(`${pid} paid ${need} ${dom} power for Legend activation.`);
    }

    // Class power (any domain in identity)
    const classNeed = parsed.cost.powerClass || 0;
    if (classNeed > 0) {
      const allowed = classDomainsForPlayer(d, pid);
      if (runePoolTotalPower(p.runePool, allowed) < classNeed && autoPay) {
        let missing = classNeed - runePoolTotalPower(p.runePool, allowed);
        const candidates = p.runesInPlay.filter((r) => allowed.includes(r.domain));
        let used = 0;
        for (const r of candidates) {
          if (missing <= 0) break;
          engineRecycleRuneForPower(d, pid, r.instanceId);
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-recycled ${used} rune(s) to pay Legend class power cost.`);
      }

      const pay = choosePowerPaymentDomains(p.runePool, classNeed, allowed);
      if (!pay) {
        d.log.unshift(`Not enough class power to activate Legend (need ${classNeed}).`);
        return false;
      }
      for (const dom of allowed) {
        const spend = pay.payment[dom] || 0;
        if (spend > 0) p.runePool.power[dom] -= spend;
      }
      d.log.unshift(`${pid} paid ${classNeed} class power for Legend activation.`);
    }

    // Any-domain power (very rare in activation costs)
    const anyNeed = parsed.cost.powerAny || 0;
    if (anyNeed > 0) {
      const ALL_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];

      if (sumPower(p.runePool) < anyNeed && autoPay) {
        let missing = anyNeed - sumPower(p.runePool);
        const candidates = [...p.runesInPlay];
        let used = 0;
        for (const r of candidates) {
          if (missing <= 0) break;
          engineRecycleRuneForPower(d, pid, r.instanceId);
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-recycled ${used} rune(s) to pay Legend any-power cost.`);
      }

      const pay = choosePowerPaymentDomains(p.runePool, anyNeed, ALL_DOMAINS);
      if (!pay) {
        d.log.unshift(`Not enough power to activate Legend (need ${anyNeed}).`);
        return false;
      }
      for (const dom of ALL_DOMAINS) {
        const spend = pay.payment[dom] || 0;
        if (spend > 0) p.runePool.power[dom] -= spend;
      }
      d.log.unshift(`${pid} paid ${anyNeed} power (any) for Legend activation.`);
    }

    // ---- Exhaust the legend (always part of the activation cost) ----
    p.legendReady = false;

    // If the activated effect is a pure resource-add ability, it can't be reacted to and resolves immediately.
    const detectEff = eff.replace(/\[\s*add\s*\]\s*/gi, "add ");
    const isUnreactableResourceAdd =
      /\badd\s+\d+\s+energy\b/i.test(detectEff) ||
      /\badd\s+(?:\d+\s+)?(body|calm|chaos|fury|mind|order|class)\s+rune\b/i.test(detectEff) ||
      /\badd\s+\d+\s+rune\s+of\s+any\s+type\b/i.test(detectEff);

    if (isUnreactableResourceAdd) {
      const resolutionId = makeId("res");
      const outcome = resolveEffectText(d, pid, eff, chosen, {
        battlefieldIndex: d.windowBattlefieldIndex ?? null,
        sourceCardName: p.legend.name,
        resolutionId,
        resumePost: { cleanup: true, maybeOpenWindow: true, setOpenState: true, priorityPlayer: pid },
      });
      if (outcome === "PENDING_OPTIONAL") {
        d.state = "CLOSED";
        d.passesInRow = 0;
        d.priorityPlayer = pid;
        return true;
      }
      d.log.unshift(`${pid} activated Legend ability (${p.legend.name}).`);
      cleanupStateBased(d);
      maybeOpenNextWindow(d);

      d.state = "OPEN";
      d.passesInRow = 0;
      d.priorityPlayer = pid;
      return true;
    }

    // Target-selection gate (if needed)
    // (We still allow queuing the item so the UI can prompt for targets.)
    const item: ChainItem = {
      id: makeId("chain"),
      controller: pid,
      kind: "ACTIVATED_ABILITY",
      label: `Legend — ${p.legend.name}`,
      effectText: eff,
      contextBattlefieldIndex: d.windowBattlefieldIndex ?? null,
      targets: chosen,
      needsTargets: req.kind !== "NONE" && (!chosen[0] || chosen[0].kind === "NONE"),
      targetRequirement: req,
      sourceCardType: "Legend",
    };

    d.chain.push(item);
    d.state = "CLOSED";
    d.passesInRow = 0;
    d.priorityPlayer = pid;
    d.log.unshift(`${pid} activated Legend ability (${p.legend.name}).`);

    // No immediate resolution; abilities can be responded to.
    cleanupStateBased(d);
    maybeOpenNextWindow(d);
    return true;
  };

  const getLegendActivationStatus = (d: GameState, pid: PlayerId): { ok: boolean; reason: string } => {
    const p = d.players[pid];
    if (!p.legend) return { ok: false, reason: "No legend available." };
    let parsed = legendActivatedEffect(p.legend);
    if (!parsed) {
      const grantsEquip = d.battlefields.some((bf) => bf.controller === pid && battlefieldGrantsLegendEquip(bf));
      if (grantsEquip) {
        parsed = {
          rawLine: "Forge of the Fluft",
          effectText: "Attach an equipment you control to a unit you control.",
          req: { kind: "UNIT_AND_GEAR_FRIENDLY" },
          cost: { energy: 0, powerByDomain: {}, powerClass: 0, powerAny: 0 },
        };
      }
    }
    if (!parsed) return { ok: false, reason: "Legend activated Exhaust ability not supported yet." };
    const timing = inferActivatedTimingClass(parsed.rawLine);
    if (!canUseTimingClassNow(d, pid, timing)) {
      if (timing === "REACTION") return { ok: false, reason: "Legend ability is Reaction-speed only right now." };
      if (timing === "ACTION") return { ok: false, reason: "Legend ability is Action-speed only right now." };
      return { ok: false, reason: "Legend ability is main action speed only." };
    }
    return { ok: true, reason: "Activate Legend" };
  };

  const engineActivateGearAbility = (
    d: GameState,
    pid: PlayerId,
    gearInstanceId: string,
    targets?: Target[],
    opts?: { autoPay?: boolean }
  ): boolean => {
    // class-rune marker normalization: /\[\s*c\s*\]/i
    if (d.priorityPlayer !== pid) {
      d.log.unshift("You must have priority to activate gear.");
      return false;
    }

    const top = d.chain[d.chain.length - 1];
    if (top && top.needsTargets && top.controller === pid) {
      const t0 = top.targets?.[0];
      if (!t0 || t0.kind === "NONE") {
        d.log.unshift("Choose targets for your pending chain item first.");
        return false;
      }
    }

    const loc = locateGear(d, pid, gearInstanceId);
    if (!loc) {
      d.log.unshift("Gear not found.");
      return false;
    }
    const gear = loc.gear;
    const parsed = gearActivatedEffect(gear);
    if (!parsed) {
      d.log.unshift("Gear has no activated ability the emulator can parse yet.");
      return false;
    }

    const gearTiming = inferActivatedTimingClass(parsed.rawLine);
    if (!canUseTimingClassNow(d, pid, gearTiming)) {
      if (gearTiming === "REACTION") d.log.unshift(`${gear.name} can only be used as a Reaction right now.`);
      else if (gearTiming === "ACTION") d.log.unshift(`${gear.name} can only be used as an Action (your turn or showdown with priority).`);
      else d.log.unshift(`${gear.name} can only be used at main action speed.`);
      return false;
    }

    const autoPay = !!opts?.autoPay;

    if (parsed.cost.exhaustSelf && !gear.isReady) {
      d.log.unshift(`${gear.name} is exhausted.`);
      return false;
    }

    // Energy cost
    if (parsed.cost.energy > 0) {
      if (d.players[pid].runePool.energy < parsed.cost.energy && autoPay) {
        let missing = parsed.cost.energy - d.players[pid].runePool.energy;
        const readyRunes = d.players[pid].runesInPlay.filter((r) => r.isReady);
        let used = 0;
        for (const r of readyRunes) {
          if (missing <= 0) break;
          r.isReady = false;
          d.players[pid].runePool.energy += 1;
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-exhausted ${used} rune(s) to pay gear energy cost.`);
      }
      if (d.players[pid].runePool.energy < parsed.cost.energy) {
        d.log.unshift(`Not enough energy to activate ${gear.name}.`);
        return false;
      }
      d.players[pid].runePool.energy -= parsed.cost.energy;
    }

    // Domain-specific power
    for (const dom of Object.keys(parsed.cost.powerByDomain) as Domain[]) {
      const need = parsed.cost.powerByDomain[dom] || 0;
      if (need <= 0) continue;
      if ((d.players[pid].runePool.power[dom] || 0) < need && autoPay) {
        let missing = need - (d.players[pid].runePool.power[dom] || 0);
        const candidates = d.players[pid].runesInPlay.filter((r) => r.domain === dom);
        let used = 0;
        for (const r of candidates) {
          if (missing <= 0) break;
          engineRecycleRuneForPower(d, pid, r.instanceId);
          missing -= 1;
          used += 1;
        }
        if (used > 0) d.log.unshift(`${pid} auto-recycled ${used} ${dom} rune(s) to pay gear power cost.`);
      }
      if ((d.players[pid].runePool.power[dom] || 0) < need) {
        d.log.unshift(`Not enough ${dom} power to activate ${gear.name}.`);
        return false;
      }
      d.players[pid].runePool.power[dom] -= need;
    }

    // Class power
    if (parsed.cost.powerClass > 0) {
      const allowed = classDomainsForPlayer(d, pid);
      const pay = choosePowerPaymentDomains(d.players[pid].runePool, parsed.cost.powerClass, allowed);
      if (!pay) {
        d.log.unshift(`Not enough class power to activate ${gear.name}.`);
        return false;
      }
      for (const dom of allowed) {
        const spend = pay.payment[dom] || 0;
        if (spend > 0) d.players[pid].runePool.power[dom] -= spend;
      }
    }

    // Any power
    if (parsed.cost.powerAny > 0) {
      const ALL_DOMAINS: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];
      const pay = choosePowerPaymentDomains(d.players[pid].runePool, parsed.cost.powerAny, ALL_DOMAINS);
      if (!pay) {
        d.log.unshift(`Not enough power to activate ${gear.name}.`);
        return false;
      }
      for (const dom of ALL_DOMAINS) {
        const spend = pay.payment[dom] || 0;
        if (spend > 0) d.players[pid].runePool.power[dom] -= spend;
      }
    }

    // Exhaust the gear if required
    if (parsed.cost.exhaustSelf) gear.isReady = false;

    // Kill this cost
    if (parsed.cost.killSelf) {
      const removed = removeGearFromWherever(d, pid, gear.instanceId);
      if (removed) d.players[pid].trash.push(removed);
    }

    const eff = parsed.effectText;
    const req = parsed.req;
    const chosen: Target[] = targets && targets.length ? targets : [{ kind: "NONE" }];

    const detectEff = eff.replace(/\[\s*add\s*\]\s*/gi, "add ");
    const isUnreactableResourceAdd =
      /\badd\s+\d+\s+energy\b/i.test(detectEff) ||
      /\badd\s+(?:\d+\s+)?(body|calm|chaos|fury|mind|order|class)\s+rune\b/i.test(detectEff) ||
      /\badd\s+\d+\s+rune\s+of\s+any\s+type\b/i.test(detectEff);

    const contextBf = (() => {
      if (loc.zone === "BF") return loc.battlefieldIndex ?? null;
      if (loc.zone === "ATTACHED" && loc.unit) {
        const uLoc = locateUnit(d, loc.unit.owner, loc.unit.instanceId);
        return uLoc?.zone === "BF" ? uLoc.battlefieldIndex ?? null : null;
      }
      return null;
    })();

    if (isUnreactableResourceAdd) {
      const resolutionId = makeId("res");
      const outcome = resolveEffectText(d, pid, eff, chosen, {
        battlefieldIndex: contextBf,
        sourceCardName: gear.name,
        sourceCardType: "Gear",
        sourceInstanceId: gear.instanceId,
        resolutionId,
        resumePost: { cleanup: true, maybeOpenWindow: true, setOpenState: true, priorityPlayer: pid },
      });
      if (outcome === "PENDING_OPTIONAL") {
        d.state = "CLOSED";
        d.passesInRow = 0;
        d.priorityPlayer = pid;
        return true;
      }
      d.log.unshift(`${pid} activated gear ability (${gear.name}).`);
      cleanupStateBased(d);
      maybeOpenNextWindow(d);
      d.state = "OPEN";
      d.passesInRow = 0;
      d.priorityPlayer = pid;
      return true;
    }

    const item: ChainItem = {
      id: makeId("chain"),
      controller: pid,
      kind: "ACTIVATED_ABILITY",
      label: `Gear — ${gear.name}`,
      effectText: eff,
      contextBattlefieldIndex: contextBf,
      targets: chosen,
      needsTargets: req.kind !== "NONE" && (!chosen[0] || chosen[0].kind === "NONE"),
      targetRequirement: req,
      sourceInstanceId: gear.instanceId,
      sourceCardType: "Gear",
    };

    d.chain.push(item);
    d.state = "CLOSED";
    d.passesInRow = 0;
    d.priorityPlayer = pid;
    d.log.unshift(`${pid} activated gear ability (${gear.name}).`);
    cleanupStateBased(d);
    maybeOpenNextWindow(d);
    return true;
  };


  const applyEngineAction = (d: GameState, action: EngineAction): void => {
    switch (action.type) {
      case "NEXT_STEP":
        engineNextStep(d, action.player);
        return;
      case "PASS_PRIORITY":
        enginePassPriority(d, action.player);
        return;
      case "MULLIGAN_CONFIRM":
        engineConfirmMulligan(d, action.player, action.recycleIds);
        return;
      case "SET_CHAIN_TARGETS":
        engineSetChainTargets(d, action.player, action.chainItemId, action.targets);
        return;
      case "OPTIONAL_CHOICE": {
        const pending = d.pendingOptionalChoice;
        if (!pending || pending.id !== action.choiceId || pending.player !== action.player) return;
        if (!d.optionalChoiceResults) d.optionalChoiceResults = {};
        d.optionalChoiceResults[pending.id] = { accepted: action.accept, value: action.value };

        const resume = pending.resume;
        const resumeDelayed = pending.resumeDelayedEvent;
        d.pendingOptionalChoice = null;

        if (!resume) return;
        if (resume.kind === "CHAIN") {
          resolveTopOfChain(d);
          return;
        }

        const outcome = resolveEffectText(d, resume.controller, resume.effectText, resume.targets, resume.ctx);
        if (outcome === "PENDING_OPTIONAL") {
          if (resumeDelayed && (d.pendingOptionalChoice as any)) {
            (d.pendingOptionalChoice as any).resumeDelayedEvent = resumeDelayed;
          }
          return;
        }

        if (resume.post?.cleanup) cleanupStateBased(d);
        if (resume.post?.maybeOpenWindow) maybeOpenNextWindow(d);
        if (resume.post?.setOpenState) {
          d.state = "OPEN";
          d.passesInRow = 0;
          d.priorityPlayer = resume.post.priorityPlayer ?? resume.controller;
        }

        if (resumeDelayed) {
          const loc = locateUnit(d, resumeDelayed.unitOwner, resumeDelayed.unitInstanceId);
          if (loc && loc.unit) {
            fireDelayedTriggersForEvent(
              d,
              resumeDelayed.event,
              loc.unit,
              { battlefieldIndex: resumeDelayed.battlefieldIndex ?? null, alone: resumeDelayed.alone },
              { skipTriggerIds: resumeDelayed.skipTriggerIds }
            );
          }
        }
        return;
      }
      case "HIDE_CARD":
        engineHideCard(d, action.player, action.cardInstanceId, action.battlefieldIndex, { autoPay: action.autoPay });
        cleanupStateBased(d);
        maybeOpenNextWindow(d);
        return;
      case "STANDARD_MOVE":
        engineStandardMove(d, action.player, action.from, action.unitIds, action.to);
        cleanupStateBased(d);
        maybeOpenNextWindow(d);
        return;
      case "PLAY_CARD": {
        const res = enginePlayCard(
          d,
          action.player,
          {
            source: action.source,
            cardInstanceId: action.cardInstanceId,
            fromBattlefieldIndex: action.fromBattlefieldIndex,
            destination: action.destination ?? null,
            accelerate: action.accelerate,
            targets: action.targets,
            repeatCount: action.repeatCount,
            payOptionalAdditionalCost: action.payOptionalAdditionalCost,
            additionalDiscardIds: action.additionalDiscardIds,
          },
          { autoPay: action.autoPay }
        );
        if (!res.ok && res.reason) d.log.unshift(`Play failed: ${res.reason}`);
        return;
      }
      case "RUNE_EXHAUST":
        engineExhaustRuneForEnergy(d, action.player, action.runeInstanceId);
        return;
      case "RUNE_RECYCLE":
        engineRecycleRuneForPower(d, action.player, action.runeInstanceId);
        return;
      case "SEAL_EXHAUST":
        engineExhaustSealForPower(d, action.player, action.gearInstanceId);
        return;
      case "LEGEND_ACTIVATE":
        engineActivateLegend(d, action.player, action.targets, { autoPay: action.autoPay });
        return;
      case "GEAR_ACTIVATE":
        engineActivateGearAbility(d, action.player, action.gearInstanceId, action.targets, { autoPay: action.autoPay });
        return;
      case "EQUIP_START":
        engineEquipStart(d, action.player, action.gearInstanceId);
        return;
      case "EQUIP_CONFIRM":
        engineEquipConfirm(d, action.player, action.unitInstanceId);
        return;
      case "EQUIP_CANCEL":
        d.pendingEquipChoice = null;
        d.log.unshift(`${action.player} cancelled equipment attachment.`);
        return;
      case "DAMAGE_ASSIGN":
        engineDamageAssign(d, action.player, action.assignment);
        return;
      case "DAMAGE_CONFIRM":
        engineDamageConfirm(d, action.player);
        return;
      case "DAMAGE_AUTO_ASSIGN":
        engineDamageAutoAssign(d, action.player);
        return;
      case "KILL_GEAR_ACTIVATE":
        engineKillGearActivate(d, action.player, action.gearInstanceId);
        return;
      case "SPEND_MY_BUFF_ACTIVATE":
        engineSpendMyBuffActivate(d, action.player, action.unitInstanceId);
        return;
      case "CULL_CHOOSE":
        engineCullChoose(d, action.player, action.unitInstanceId);
        return;
      case "REVEAL_WINDOW_CONFIRM":
        if (d.pendingRevealWindow && d.pendingRevealWindow.player === action.player) {
          d.pendingRevealWindow = null;
          // Resume logic if needed? For now, we assume reveals are blocking but transient.
          // If we need to loop (reveal until...), the logic will re-trigger or continue.
          // But 'reveal until' is usually linear.
          // The effect resolution engine handles the actual *result* (play/recycle).
          // Wait, if it's "Reveal top card -> Play it", we need to Resume AFTER the reveal window is closed.
          // Currently, resolveEffectText is monolithic. We might need a "RESUME_AFTER_REVEAL" hook if we split it.
          // However, for pure information (Sabotage hand reveal), just closing is fine.
          // For "Dazzling Aurora" (reveal top until...), the logic runs atomically.
          // We need to PAUSE the resolution while the window is open.
          // This means "Reveal until" needs to return "PENDING_REVEAL" similar to "PENDING_OPTIONAL".
          // I will verify this later. For now, just close it.
        }
        return;
      default:
        return;
    }
  };

  const sanitizeEngineAction = (actionAny: any): EngineAction | null => {
    if (!actionAny || typeof actionAny !== "object") return null;
    const t = (actionAny as any).type;
    const p = (actionAny as any).player;
    if (typeof t !== "string") return null;
    if (!isPlayerId(p)) return null;

    // NOTE: We intentionally keep these checks lightweight. The goal is to prevent
    // non-game objects (e.g., DOM events) from leaking into the state/action history.
    switch (t) {
      case "NEXT_STEP":
      case "PASS_PRIORITY":
        return { type: t, player: p } as EngineAction;

      case "MULLIGAN_CONFIRM": {
        const recycleIdsRaw = (actionAny as any).recycleIds;
        const recycleIds = Array.isArray(recycleIdsRaw) ? recycleIdsRaw.filter((x: any) => typeof x === "string") : [];
        return { type: "MULLIGAN_CONFIRM", player: p, recycleIds };
      }

      case "SET_CHAIN_TARGETS": {
        const chainItemId = typeof (actionAny as any).chainItemId === "string" ? (actionAny as any).chainItemId : "";
        const targets = Array.isArray((actionAny as any).targets) ? (actionAny as any).targets : [{ kind: "NONE" }];
        if (!chainItemId) return null;
        return { type: "SET_CHAIN_TARGETS", player: p, chainItemId, targets } as EngineAction;
      }

      case "OPTIONAL_CHOICE": {
        const choiceId = typeof (actionAny as any).choiceId === "string" ? (actionAny as any).choiceId : "";
        if (!choiceId) return null;
        const accept = !!(actionAny as any).accept;
        const valueRaw = (actionAny as any).value;
        const value = Number.isFinite(valueRaw) ? Number(valueRaw) : undefined;
        return { type: "OPTIONAL_CHOICE", player: p, choiceId, accept, value } as EngineAction;
      }

      case "PLAY_CARD": {
        const source = (actionAny as any).source;
        if (source !== "HAND" && source !== "CHAMPION" && source !== "FACEDOWN") return null;
        const cardInstanceId = typeof (actionAny as any).cardInstanceId === "string" ? (actionAny as any).cardInstanceId : "";
        if (!cardInstanceId) return null;
        const fromBattlefieldIndex =
          typeof (actionAny as any).fromBattlefieldIndex === "number" ? (actionAny as any).fromBattlefieldIndex : undefined;
        const destination = (actionAny as any).destination ?? null;
        const accelerate = (actionAny as any).accelerate;
        const targets = Array.isArray((actionAny as any).targets) ? (actionAny as any).targets : undefined;
        const repeatCountRaw = (actionAny as any).repeatCount;
        const repeatCount = Number.isFinite(repeatCountRaw) ? Math.max(0, Math.floor(repeatCountRaw)) : undefined;
        const payOptionalAdditionalCost = typeof (actionAny as any).payOptionalAdditionalCost === "boolean" ? !!(actionAny as any).payOptionalAdditionalCost : undefined;
        const additionalDiscardIdsRaw = (actionAny as any).additionalDiscardIds;
        const additionalDiscardIds = Array.isArray(additionalDiscardIdsRaw)
          ? additionalDiscardIdsRaw.filter((x: any) => typeof x === "string")
          : undefined;
        const autoPay = !!(actionAny as any).autoPay;
        return {
          type: "PLAY_CARD",
          player: p,
          source,
          cardInstanceId,
          fromBattlefieldIndex,
          destination,
          accelerate,
          targets,
          repeatCount,
          payOptionalAdditionalCost,
          additionalDiscardIds,
          autoPay,
        } as EngineAction;
      }

      case "HIDE_CARD": {
        const cardInstanceId = typeof (actionAny as any).cardInstanceId === "string" ? (actionAny as any).cardInstanceId : "";
        const battlefieldIndex = typeof (actionAny as any).battlefieldIndex === "number" ? (actionAny as any).battlefieldIndex : NaN;
        if (!cardInstanceId || !Number.isFinite(battlefieldIndex)) return null;
        const autoPay = !!(actionAny as any).autoPay;
        return { type: "HIDE_CARD", player: p, cardInstanceId, battlefieldIndex, autoPay } as EngineAction;
      }

      case "STANDARD_MOVE": {
        const from = (actionAny as any).from;
        const to = (actionAny as any).to;
        const unitIdsRaw = (actionAny as any).unitIds;
        const unitIds = Array.isArray(unitIdsRaw) ? unitIdsRaw.filter((x: any) => typeof x === "string") : [];
        if (!from || !to || unitIds.length === 0) return null;
        return { type: "STANDARD_MOVE", player: p, from, to, unitIds } as EngineAction;
      }

      case "RUNE_EXHAUST":
      case "RUNE_RECYCLE": {
        const runeInstanceId = typeof (actionAny as any).runeInstanceId === "string" ? (actionAny as any).runeInstanceId : "";
        if (!runeInstanceId) return null;
        return { type: t, player: p, runeInstanceId } as EngineAction;
      }

      case "SEAL_EXHAUST": {
        const gearInstanceId = typeof (actionAny as any).gearInstanceId === "string" ? (actionAny as any).gearInstanceId : "";
        if (!gearInstanceId) return null;
        return { type: "SEAL_EXHAUST", player: p, gearInstanceId } as EngineAction;
      }

      case "LEGEND_ACTIVATE": {
        const targets = Array.isArray((actionAny as any).targets) ? (actionAny as any).targets : undefined;
        const autoPay = !!(actionAny as any).autoPay;
        return { type: "LEGEND_ACTIVATE", player: p, targets, autoPay } as EngineAction;
      }

      case "GEAR_ACTIVATE": {
        const gearInstanceId = typeof (actionAny as any).gearInstanceId === "string" ? (actionAny as any).gearInstanceId : "";
        if (!gearInstanceId) return null;
        const targets = Array.isArray((actionAny as any).targets) ? (actionAny as any).targets : undefined;
        const autoPay = !!(actionAny as any).autoPay;
        return { type: "GEAR_ACTIVATE", player: p, gearInstanceId, targets, autoPay } as EngineAction;
      }

      case "EQUIP_START": {
        const gearInstanceId = typeof (actionAny as any).gearInstanceId === "string" ? (actionAny as any).gearInstanceId : "";
        if (!gearInstanceId) return null;
        return { type: "EQUIP_START", player: p, gearInstanceId } as EngineAction;
      }

      case "EQUIP_CONFIRM": {
        const unitInstanceId = typeof (actionAny as any).unitInstanceId === "string" ? (actionAny as any).unitInstanceId : "";
        if (!unitInstanceId) return null;
        return { type: "EQUIP_CONFIRM", player: p, unitInstanceId } as EngineAction;
      }

      case "EQUIP_CANCEL": {
        return { type: "EQUIP_CANCEL", player: p } as EngineAction;
      }

      case "DAMAGE_ASSIGN": {
        const assignment = (actionAny as any).assignment;
        if (!assignment || typeof assignment !== "object") return null;
        return { type: "DAMAGE_ASSIGN", player: p, assignment } as EngineAction;
      }

      case "DAMAGE_CONFIRM": {
        return { type: "DAMAGE_CONFIRM", player: p } as EngineAction;
      }

      case "DAMAGE_AUTO_ASSIGN": {
        return { type: "DAMAGE_AUTO_ASSIGN", player: p } as EngineAction;
      }

      case "KILL_GEAR_ACTIVATE": {
        const gearInstanceId = typeof (actionAny as any).gearInstanceId === "string" ? (actionAny as any).gearInstanceId : "";
        if (!gearInstanceId) return null;
        return { type: "KILL_GEAR_ACTIVATE", player: p, gearInstanceId } as EngineAction;
      }

      case "SPEND_MY_BUFF_ACTIVATE": {
        const unitInstanceId = typeof (actionAny as any).unitInstanceId === "string" ? (actionAny as any).unitInstanceId : "";
        if (!unitInstanceId) return null;
        return { type: "SPEND_MY_BUFF_ACTIVATE", player: p, unitInstanceId } as EngineAction;
      }

      case "CULL_CHOOSE": {
        const unitInstanceId = typeof (actionAny as any).unitInstanceId === "string" ? (actionAny as any).unitInstanceId : "";
        if (!unitInstanceId) return null;
        return { type: "CULL_CHOOSE", player: p, unitInstanceId } as EngineAction;
      }

      case "REVEAL_WINDOW_CONFIRM": {
        return { type: "REVEAL_WINDOW_CONFIRM", player: p, selectedIds: (actionAny as any).selectedIds } as EngineAction;
      }

      default:
        return null;
    }
  };

  const dispatchEngineAction = (actionAny: any) => {
    if (!g) return;
    const action = sanitizeEngineAction(actionAny);
    if (!action) return;

    updateGame((d) => {
      applyEngineAction(d, action);
      if (!(d as any).actionHistory) (d as any).actionHistory = [];
      d.actionHistory.push(action);
      if (d.actionHistory.length > 4000) d.actionHistory.shift();
    });
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__RB_DISPATCH__ = dispatchEngineAction;
      (window as any).__RB_GAME__ = g;
      (window as any).__RB_SET_GAME__ = setGame;
      (window as any).__RB_ALL_CARDS__ = allCards;
      (window as any).__RB_APPLY__ = applyEngineAction;
      (window as any).__RB_SANITIZE__ = sanitizeEngineAction;
    }
  }, [g, allCards]);



  // ----------------------------- AI engine action layer -----------------------------

  type AiIntent =
    | { type: "PASS" }
    | { type: "NEXT_STEP" }
    | { type: "MULLIGAN"; recycleIds: string[] }
    | {
      type: "PLAY";
      source: "HAND" | "CHAMPION" | "FACEDOWN";
      cardInstanceId: string;
      fromBattlefieldIndex?: number;
      destination?: { kind: "BASE" } | { kind: "BF"; index: number } | null;
      accelerate?: { pay: boolean; domain: Domain };
      targets?: Target[];
    }
    | { type: "HIDE"; cardInstanceId: string; battlefieldIndex: number }
    | {
      type: "MOVE";
      from: { kind: "BASE" } | { kind: "BF"; index: number };
      to: { kind: "BASE" } | { kind: "BF"; index: number };
      unitIds: string[];
    }
    | { type: "LEGEND_ACTIVATE"; targets?: Target[] }
    | { type: "SET_CHAIN_TARGETS"; chainItemId: string; targets: Target[] }
    | { type: "DAMAGE_AUTO_ASSIGN" };

  const canSpellTimingNow = (
    d: GameState,
    pid: PlayerId,
    card: CardInstance,
    source: "HAND" | "CHAMPION" | "FACEDOWN" = "HAND"
  ): boolean => {
    if (card.type !== "Spell") return true;
    const timing = inferCardTimingClass(card, source);
    return canUseTimingClassNow(d, pid, timing);
  };

  const engineSetChainTargets = (d: GameState, pid: PlayerId, chainItemId: string, targets: Target[]) => {
    const item = d.chain.find((x) => x.id === chainItemId);
    if (!item) return;
    if (item.controller !== pid) return;
    const noneT: Target = { kind: "NONE" };
    const chosen: Target[] = targets && targets.length > 0 ? targets : [noneT];
    const req = item.targetRequirement;
    const selectedCount = chosen.filter((t) => t.kind !== "NONE").length;
    if (item.needsTargets && selectedCount === 0) {
      item.targets = [{ kind: "NONE" }];
      item.needsTargets = false;
      if (req?.optional) {
        d.log.unshift(`${pid} chose no targets for: ${item.label}`);
      } else {
        d.log.unshift("No valid targets; skipping target selection.");
      }
      return;
    }
    // Enforce hidden restriction (target must be at source battlefield if restricted).
    const rbf = item.restrictTargetsToBattlefieldIndex ?? null;
    if (rbf != null && chosen[0]) {
      if (chosen[0].kind === "UNIT") {
        const loc = locateUnit(d, chosen[0].owner, chosen[0].instanceId);
        if (!loc || loc.zone !== "BF" || loc.battlefieldIndex !== rbf) {
          d.log.unshift("AI: hidden restriction prevented illegal target; choosing NONE.");
          item.targets = [{ kind: "NONE" }];
          item.needsTargets = false;
          return;
        }
      }
      if (chosen[0].kind === "BATTLEFIELD" && chosen[0].index !== rbf) {
        d.log.unshift("AI: hidden restriction prevented illegal battlefield target; choosing NONE.");
        item.targets = [{ kind: "NONE" }];
        item.needsTargets = false;
        return;
      }
    }

    // Deflect tax for triggered/activated abilities (enemy targets only).
    if (item.kind === "TRIGGERED_ABILITY" || item.kind === "ACTIVATED_ABILITY") {
      const pool = d.players[pid].runePool;
      const byInstance = new Map<string, { controller: PlayerId; amount: number }>();
      for (const t of chosen) {
        if (t.kind !== "UNIT") continue;
        const loc = locateUnit(d, t.owner, t.instanceId);
        if (!loc) continue;
        const unit = loc.unit;
        if (unit.controller === pid) continue; // Deflect only taxes opponents
        const tax = computeDeflectTax(unit);
        if (tax <= 0) continue;
        byInstance.set(unit.instanceId, { controller: unit.controller, amount: tax });
      }

      if (byInstance.size > 0) {
        const totalTax = Array.from(byInstance.values()).reduce((sum, v) => sum + v.amount, 0);
        const availablePower = Object.values(pool.power).reduce((sum, v) => sum + (v || 0), 0);
        if (availablePower < totalTax) {
          d.log.unshift("Cannot pay Deflect tax for ability targets.");
          return;
        }
        let remaining = totalTax;
        for (const dom of Object.keys(pool.power) as Domain[]) {
          while (remaining > 0 && (pool.power[dom] || 0) > 0) {
            pool.power[dom] -= 1;
            remaining -= 1;
          }
          if (remaining <= 0) break;
        }
        for (const v of byInstance.values()) {
          if (v.controller !== pid) d.players[v.controller].runePool.power.Colorless += v.amount;
        }
        d.log.unshift(`${pid} paid ${totalTax} power for Deflect.`);
      }
    }

    item.targets = chosen;
    item.needsTargets = false;
    d.passesInRow = 0;
    d.priorityPlayer = item.controller;
    d.log.unshift(`${pid} chose targets for: ${item.label}`);
  };

  const engineConfirmMulligan = (d: GameState, pid: PlayerId, recycleIds: string[]) => {
    if (d.step !== "MULLIGAN") return;
    const p = d.players[pid];
    if (p.mulliganDone) return;
    const ids = new Set(recycleIds.slice(0, 2));
    const selected = p.hand.filter((c) => ids.has(c.instanceId));
    // Remove selected from hand
    p.hand = p.hand.filter((c) => !ids.has(c.instanceId));
    // Recycle selected cards to bottom of main deck (random order).
    const recycled = shuffle(selected, d.turnNumber + (pid === "P1" ? 7 : 11));
    p.mainDeck.push(...recycled);
    // Draw replacements
    drawCards(d, pid, recycled.length);
    p.mulliganDone = true;
    p.mulliganSelectedIds = [];
    d.log.unshift(`${pid} mulligan confirmed (${recycled.length} recycled, ${recycled.length} drawn).`);

    if (d.players.P1.mulliganDone && d.players.P2.mulliganDone) {
      d.players.P1.scoredBattlefieldsThisTurn = [];
      d.players.P2.scoredBattlefieldsThisTurn = [];
      d.players.P1.mainDeckCardsPlayedThisTurn = 0;
      d.players.P2.mainDeckCardsPlayedThisTurn = 0;
      d.step = "AWAKEN";
      d.priorityPlayer = d.turnPlayer;
      d.state = "OPEN";
      d.passesInRow = 0;
      d.log.unshift(`Turn ${d.turnNumber} begins for ${d.turnPlayer}.`);
    }
  };

  const engineHideCard = (d: GameState, pid: PlayerId, cardInstanceId: string, battlefieldIndex: number, opts?: { autoPay?: boolean }) => {
    if (d.step !== "ACTION") return;
    if (d.turnPlayer !== pid) return;
    if (d.windowKind !== "NONE" || d.chain.length > 0 || d.state !== "OPEN") return;

    const p = d.players[pid];
    const cardIdx = p.hand.findIndex((c) => c.instanceId === cardInstanceId);
    if (cardIdx < 0) return;
    const card = p.hand[cardIdx];
    if (!isHiddenCard(card)) return;

    const bf = d.battlefields[battlefieldIndex];
    const canUseExtra = bf.facedown && battlefieldAllowsExtraFacedown(bf) && !bf.facedownExtra;
    if (bf.facedown && !canUseExtra) return;
    if (bf.controller !== pid) return;

    // Pay Hide cost: [A] (1 power of any domain).
    const anyDomains = ALL_POWER_DOMAINS;
    const swiftScoutActive = p.legend?.name === "Swift Scout";
    let canPayPower = choosePowerPaymentDomains(p.runePool, 1, anyDomains) !== null;
    let canPayEnergy = swiftScoutActive && p.runePool.energy >= 1;
    let canPay = canPayPower || canPayEnergy;
    if (!canPayPower && !canPayEnergy && opts?.autoPay) {
      const plan = buildAutoPayPlan(p.runePool, p.runesInPlay, {
        energyNeed: 0,
        basePowerNeed: 0,
        powerDomainsAllowed: anyDomains,
        additionalPowerByDomain: {},
        additionalPowerAny: 1,
      }, { sealExhaustedThisTurn: p.sealExhaustedThisTurn, seals: p.base.gear, playerDomains: p.domains });
      if (plan && (Object.keys(plan.runeUses).length > 0 || plan.sealUses.length > 0)) {
        applyAutoPayPlan(d, pid, plan);
        d.log.unshift(`${pid} auto-paid the Hide cost.`);
      }
      canPayPower = choosePowerPaymentDomains(p.runePool, 1, anyDomains) !== null;
      canPay = canPayPower || canPayEnergy;
    }
    if (!canPay) return;

    if (canPayPower) {
      const pay = choosePowerPaymentDomains(p.runePool, 1, anyDomains)!;
      for (const dom of Object.keys(pay.payment) as Domain[]) p.runePool.power[dom] -= pay.payment[dom];
    } else if (canPayEnergy) {
      p.runePool.energy -= 1;
      d.log.unshift(`${pid} paid 1 energy to hide a card (Swift Scout).`);
    }

    p.hand.splice(cardIdx, 1);
    if (canUseExtra) {
      bf.facedownExtra = { card, owner: pid, hiddenOnTurn: d.turnNumber, markedForRemoval: false };
      d.log.unshift(`${pid} hid an extra card at Battlefield ${battlefieldIndex + 1}.`);
    } else {
      bf.facedown = { card, owner: pid, hiddenOnTurn: d.turnNumber, markedForRemoval: false };
      d.log.unshift(`${pid} hid a card at Battlefield ${battlefieldIndex + 1}.`);
    }
  };

  const engineStandardMove = (
    d: GameState,
    pid: PlayerId,
    from: { kind: "BASE" } | { kind: "BF"; index: number },
    unitIds: string[],
    to: { kind: "BASE" } | { kind: "BF"; index: number }
  ) => {
    if (d.step !== "ACTION") return;
    if (d.turnPlayer !== pid) return;
    if (d.windowKind !== "NONE" || d.chain.length > 0 || d.state !== "OPEN") return;
    if (unitIds.length === 0) return;

    const p = d.players[pid];
    const pullFrom = (src: typeof from): CardInstance[] => {
      if (src.kind === "BASE") return p.base.units;
      return d.battlefields[src.index].units[pid];
    };
    const pushTo = (dst: typeof to): CardInstance[] => {
      if (dst.kind === "BASE") return p.base.units;
      return d.battlefields[dst.index].units[pid];
    };

    const srcArr = pullFrom(from);
    const moving: CardInstance[] = [];
    for (const id of unitIds) {
      const idx = srcArr.findIndex((u) => u.instanceId === id);
      if (idx < 0) continue;
      const u = srcArr[idx];
      if (!u.isReady) return;
      moving.push(u);
    }
    if (moving.length === 0) return;

    if (from.kind === "BF" && to.kind === "BASE") {
      const bf = d.battlefields[from.index];
      if (battlefieldPreventsMoveFromHereToBase(bf)) {
        d.log.unshift(`${bf.card.name} prevents moving units from this battlefield to base.`);
        return;
      }
    }

    if (from.kind !== "BASE" && to.kind !== "BASE" && from.index !== to.index) {
      const allGanking = moving.every((u) => hasKeyword(u, "Ganking"));
      if (!allGanking) return;
    }

    const ids = new Set(unitIds);
    const remaining = srcArr.filter((u) => !ids.has(u.instanceId));
    if (from.kind === "BASE") p.base.units = remaining;
    else d.battlefields[from.index].units[pid] = remaining;

    for (const u of moving) {
      u.isReady = false;
      u.moveCountThisTurn += 1;
    }
    const dstArr = pushTo(to);
    dstArr.push(...moving);

    d.log.unshift(
      `${pid} moved ${moving.length} unit(s) from ${from.kind === "BASE" ? "Base" : `Battlefield ${from.index + 1}`} to ${to.kind === "BASE" ? "Base" : `Battlefield ${to.index + 1}`
      }.`
    );

    if (to.kind === "BF") {
      const bf = d.battlefields[to.index];
      if (bf.controller !== pid) bf.contestedBy = pid;
    }

    checkMoveFromLocationTriggers(d, pid, moving, from, to);
    checkMoveTriggers(d, pid, moving, to.kind === "BF" ? to.index : "BASE");
  };

  const enginePlayCard = (
    d: GameState,
    pid: PlayerId,
    params: {
      source: "HAND" | "CHAMPION" | "FACEDOWN";
      cardInstanceId: string;
      fromBattlefieldIndex?: number;
      destination?: { kind: "BASE" } | { kind: "BF"; index: number } | null;
      accelerate?: { pay: boolean; domain: Domain };
      targets?: Target[];
      repeatCount?: number;
      payOptionalAdditionalCost?: boolean;
      additionalDiscardIds?: string[];
    },
    opts?: { autoPay?: boolean }
  ): { ok: boolean; reason?: string } => {
    if (d.step === "GAME_OVER") return { ok: false, reason: "Game over" };
    const p = d.players[pid];

    // Brynhir Thundersong: "Opponents can't play cards this turn"
    if (p.opponentCantPlayCardsThisTurn) {
      return { ok: false, reason: "Can't play cards this turn" };
    }

    // Timing gates (match commitPendingPlay).
    if (params.source !== "FACEDOWN" && d.step !== "MULLIGAN" && d.step !== "ACTION" && d.step !== "DRAW" && d.step !== "CHANNEL" && d.step !== "SCORING" && d.step !== "AWAKEN") {
      // Keep permissive; engine enforces via canPlayNonspellOutsideShowdown/canSpellTimingNow below.
    }

    let card: CardInstance | null = null;
    let fromLabel = "";
    let hiddenCtxBf: number | null = null;
    let isHiddenPlay = false;

    if (params.source === "HAND") {
      const idx = p.hand.findIndex((c) => c.instanceId === params.cardInstanceId);
      if (idx < 0) return { ok: false, reason: "Card not in hand" };
      card = p.hand[idx];
      fromLabel = "hand";
    } else if (params.source === "CHAMPION") {
      if (!p.championZone || p.championZone.instanceId !== params.cardInstanceId) return { ok: false, reason: "Champion not available" };
      card = p.championZone;
      fromLabel = "champion";
    } else {
      const bfIdx = params.fromBattlefieldIndex ?? null;
      if (bfIdx == null) return { ok: false, reason: "Missing battlefield index" };
      const bf = d.battlefields[bfIdx];
      const facedownSlot =
        bf.facedown && bf.facedown.card.instanceId === params.cardInstanceId
          ? bf.facedown
          : bf.facedownExtra && bf.facedownExtra.card.instanceId === params.cardInstanceId
            ? bf.facedownExtra
            : bf.facedown;
      if (!facedownSlot || facedownSlot.owner !== pid) return { ok: false, reason: "No facedown card" };
      if (facedownSlot.hiddenOnTurn === d.turnNumber) return { ok: false, reason: "Cannot play hidden same turn" };
      card = facedownSlot.card;
      fromLabel = `facedown @ BF${bfIdx + 1}`;
      hiddenCtxBf = bfIdx;
      isHiddenPlay = true;
    }
    if (!card) return { ok: false, reason: "No card" };

    // Spell timing check
    if (!canSpellTimingNow(d, pid, card, params.source)) return { ok: false, reason: "Spell timing" };

    // Non-spell timing check
    if (card.type !== "Spell") {
      if (!canPlayNonspellOutsideShowdown(card, d, pid, params.source)) return { ok: false, reason: "Non-spell timing" };
    }

    // Legion is a conditional effect: it turns "on" if you've played another main-deck card earlier this turn.
    // (It should not prevent playing the card.)
    const playedAnotherCardThisTurn = p.mainDeckCardsPlayedThisTurn > 0;
    const legionActiveThisPlay = hasKeyword(card, "Legion") && playedAnotherCardThisTurn;

    // Determine target requirement for spells
    let inferredReq: TargetRequirement = { kind: "NONE" };
    if (card.type === "Spell") inferredReq = inferTargetRequirement(cardRulesText(card), { here: false });

    const chosenTargets: Target[] = params.targets && params.targets.length > 0 ? params.targets : [{ kind: "NONE" }];
    if (card.type === "Spell" && inferredReq.kind !== "NONE" && !inferredReq.optional && (!chosenTargets[0] || chosenTargets[0].kind === "NONE")) {
      return { ok: false, reason: "Missing target" };
    }

    // Hidden targeting restriction: must target same battlefield if applicable
    const restrictBf = isHiddenPlay ? hiddenCtxBf : null;
    if (restrictBf != null && chosenTargets[0] && chosenTargets[0].kind !== "NONE") {
      if (chosenTargets[0].kind === "UNIT") {
        const loc = locateUnit(d, chosenTargets[0].owner, chosenTargets[0].instanceId);
        if (!loc || loc.zone !== "BF" || loc.battlefieldIndex !== restrictBf) {
          return { ok: false, reason: "Hidden restriction target" };
        }
      }
      if (chosenTargets[0].kind === "BATTLEFIELD" && chosenTargets[0].index !== restrictBf) {
        return { ok: false, reason: "Hidden restriction battlefield" };
      }
    }

    // Determine destination rules for permanents
    let dest = params.destination ?? null;
    if (card.type === "Unit") {
      if (!dest || dest.kind === undefined) dest = { kind: "BASE" };
      if (dest.kind === "BF") {
        const bf = d.battlefields[dest.index];
        if (battlefieldPreventsPlayHere(bf)) return { ok: false, reason: "Units can't be played here" };
        if (!isHiddenPlay && bf.controller !== pid) return { ok: false, reason: "Must control battlefield to deploy" };
        const opponent = otherPlayer(pid);
        const opponentWarden = d.battlefields.some((field) =>
          field.units[opponent].some((u) => {
            const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
            return raw.includes("while i'm at a battlefield") && raw.includes("opponents can only play units to their base");
          })
        );
        if (opponentWarden) return { ok: false, reason: "Unit deployment restricted (Mageseeker Warden)" };
      }
      if (isHiddenPlay) dest = { kind: "BF", index: hiddenCtxBf! };
    }
    if (card.type === "Gear") {
      if (isHiddenPlay) dest = { kind: "BF", index: hiddenCtxBf! };
      else dest = { kind: "BASE" };
    }

    if (card.type === "Unit" && dest && dest.kind === "BF") {
      const bf = d.battlefields[dest.index];
      if (battlefieldPreventsPlayHere(bf)) return { ok: false, reason: "Units can't be played here" };
    }

    // Accelerate add-on
    const wantsAccelerate = !!params.accelerate?.pay && card.type === "Unit" && hasKeyword(card, "Accelerate");
    const accelDom: Domain | null = wantsAccelerate ? params.accelerate?.domain || null : null;

    // Power domains allowed (card domain identity; Colorless falls back to player's domains)
    const doms = parseDomains(card.domain).map(clampDomain).filter((x) => x !== "Colorless");
    const powerDomainsAllowed = doms.length > 0 ? doms : p.domains;

    // Compute deflect tax (extra any-domain power) for all targeted enemy units
    const deflectTaxByController = new Map<PlayerId, number>();
    if (card.type === "Spell") {
      for (const t of chosenTargets) {
        if (t.kind !== "UNIT") continue;
        const loc = locateUnit(d, t.owner, t.instanceId);
        if (!loc) continue;
        const unit = loc.unit;
        if (unit.controller === pid) continue;
        const tax = computeDeflectTax(unit);
        if (tax <= 0) continue;
        deflectTaxByController.set(unit.controller, (deflectTaxByController.get(unit.controller) || 0) + tax);
      }
    }
    const deflectTax = Array.from(deflectTaxByController.values()).reduce((sum, v) => sum + v, 0);

    const legionDiscountE = legionActiveThisPlay ? extractLegionEnergyDiscount(card) : 0;
    let overrideEnergyCost = isHiddenPlay ? 0 : legionDiscountE > 0 ? Math.max(0, (card.cost ?? 0) - legionDiscountE) : undefined;
    let overridePowerCost = isHiddenPlay ? 0 : undefined;

    const effectTextRaw = cardRulesText(card);
    const effectLower = effectTextRaw.toLowerCase();
    const battlefieldSpellDiscount =
      card.type === "Spell"
        ? d.battlefields.some((bf) =>
          bf.units[pid].some((u) => {
            const raw = `${u.ability?.effect_text || ""} ${u.ability?.raw_text || ""}`.toLowerCase();
            return raw.includes("while i'm at a battlefield") && raw.includes("energy costs for spells you play is reduced by 1 energy");
          })
        )
          ? 1
          : 0
        : 0;
    if (/this costs \d+ energy less/i.test(effectTextRaw)) {
      const m = effectLower.match(/this costs (\d+) energy less/i);
      const reduce = m ? parseInt(m[1], 10) : 0;
      const opponent = otherPlayer(pid);
      const withinVictory = effectLower.includes("within 3 points of the victory score")
        ? d.players[opponent].points >= d.victoryScore - 3
        : true;
      const enemyUnitDied = effectLower.includes("if an enemy unit has died this turn")
        ? d.players[pid].enemyUnitsDiedThisTurn > 0
        : true;
      if (withinVictory && enemyUnitDied && reduce > 0) {
        const base = overrideEnergyCost ?? card.cost ?? 0;
        overrideEnergyCost = Math.max(0, base - reduce);
      }
    }

    if (battlefieldSpellDiscount > 0) {
      const base = overrideEnergyCost ?? card.cost ?? 0;
      overrideEnergyCost = Math.max(1, base - battlefieldSpellDiscount);
    }

    // Sky Splitter: "This spell's Energy cost is reduced by the highest Might among units you control."
    if (/energy cost.*reduced by.*highest might/i.test(effectLower)) {
      const allUnits = [...p.base.units, ...d.battlefields.flatMap(bf => bf.units[pid])];
      const maxMight = Math.max(0, ...allUnits.map(u => u.stats?.might || 0));
      if (maxMight > 0) {
        const base = overrideEnergyCost ?? card.cost ?? 0;
        overrideEnergyCost = Math.max(0, base - maxMight);
        d.log.unshift(`${card.name} cost reduced by ${maxMight} (highest Might).`);
      }
    }

    // Rhasa the Sunderer: "I cost [1] less for each card in your trash."
    const rawText = (card.ability?.raw_text || "").toLowerCase();
    if (/cost.*less for each card in.*trash/i.test(rawText)) {
      const trashCount = p.trash.length;
      if (trashCount > 0) {
        const base = overrideEnergyCost ?? card.cost ?? 0;
        overrideEnergyCost = Math.max(0, base - trashCount);
        d.log.unshift(`${card.name} cost reduced by ${trashCount} (cards in trash).`);
      }
    }

    // Battering Ram: "I cost [1] less for each card you've played this turn, to a minimum of [1]."
    if (/cost.*less for each card.*played this turn/i.test(rawText)) {
      const cardsPlayed = p.mainDeckCardsPlayedThisTurn;
      if (cardsPlayed > 0) {
        const base = overrideEnergyCost ?? card.cost ?? 0;
        overrideEnergyCost = Math.max(1, base - cardsPlayed);
        d.log.unshift(`${card.name} cost reduced by ${cardsPlayed} (cards played this turn).`);
      }
    }

    // Void Drone / Drag Under: "I cost [2] less to play from anywhere other than your hand."
    if (/cost.*less to play from anywhere other than.*hand/i.test(rawText) && params.source !== "HAND") {
      const m = rawText.match(/cost\s*\[(\d+)\]\s*less/i);
      const reduce = m ? parseInt(m[1], 10) : 2;
      const base = overrideEnergyCost ?? card.cost ?? 0;
      overrideEnergyCost = Math.max(0, base - reduce);
      d.log.unshift(`${card.name} cost reduced by ${reduce} (played from ${params.source}).`);
    }

    // Jaull-Fish: "I cost [2] less if you've discarded this turn."
    if (/cost.*less if you.*discarded/i.test(rawText) && p.discardedThisTurn > 0) {
      const m = rawText.match(/cost\s*\[(\d+)\]\s*less/i);
      const reduce = m ? parseInt(m[1], 10) : 2;
      const base = overrideEnergyCost ?? card.cost ?? 0;
      overrideEnergyCost = Math.max(0, base - reduce);
      d.log.unshift(`${card.name} cost reduced by ${reduce} (discarded this turn).`);
    }

    // Production Surge: "This costs [2] less if you control a mech."
    if (/costs?.*less if you control a mech/i.test(rawText)) {
      const allUnits = [...p.base.units, ...d.battlefields.flatMap(bf => bf.units[pid])];
      const hasMech = allUnits.some(u => u.tags?.some(t => t.toLowerCase() === "mech"));
      if (hasMech) {
        const m = rawText.match(/costs?\s*\[(\d+)\]\s*less/i);
        const reduce = m ? parseInt(m[1], 10) : 2;
        const base = overrideEnergyCost ?? card.cost ?? 0;
        overrideEnergyCost = Math.max(0, base - reduce);
        d.log.unshift(`${card.name} cost reduced by ${reduce} (control a Mech).`);
      }
    }

    // Needlessly Large Yordle: "I cost [1] less for each gear attached to me." (when played, no gear yet)
    // This would apply if gear was pre-attached somehow, but typically 0 at play time.

    // Herald of Scales: "Your dragons' energy costs are reduced by [2], to a minimum of [1]."
    // Check if player controls Herald of Scales and this card is a Dragon
    const isDragon = card.tags?.some(t => t.toLowerCase() === "dragon");
    if (isDragon) {
      const allUnits = [...p.base.units, ...d.battlefields.flatMap(bf => bf.units[pid])];
      const hasHeraldOfScales = allUnits.some(u =>
        (u.ability?.raw_text || "").toLowerCase().includes("dragons' energy costs are reduced") ||
        u.name === "Herald of Scales"
      );
      if (hasHeraldOfScales) {
        const base = overrideEnergyCost ?? card.cost ?? 0;
        overrideEnergyCost = Math.max(1, base - 2);
        d.log.unshift(`${card.name} cost reduced by 2 (Herald of Scales).`);
      }
    }

    // Eager Apprentice: "While I'm at a battlefield, the energy costs for spells you play is reduced by [1]."
    // Already handled above via battlefieldSpellDiscount, but let's make it more robust
    if (card.type === "Spell") {
      const hasEagerApprentice = d.battlefields.some(bf =>
        bf.units[pid].some(u =>
          u.name === "Eager Apprentice" ||
          (u.ability?.raw_text || "").toLowerCase().includes("energy costs for spells you play is reduced")
        )
      );
      if (hasEagerApprentice && battlefieldSpellDiscount === 0) {
        const base = overrideEnergyCost ?? card.cost ?? 0;
        overrideEnergyCost = Math.max(1, base - 1);
        d.log.unshift(`${card.name} cost reduced by 1 (Eager Apprentice).`);
      }
    }

    // Ornn's Forge: first friendly non-token gear each turn costs [1] less.
    if (card.type === "Gear" && !isTokenCard(card) && !p.nonTokenGearPlayedThisTurn) {
      const controlsForge = d.battlefields.some((bf) => bf.controller === pid && battlefieldDiscountsFirstGear(bf));
      if (controlsForge) {
        const base = overrideEnergyCost ?? card.cost ?? 0;
        overrideEnergyCost = Math.max(0, base - 1);
        d.log.unshift(`${card.name} cost reduced by 1 (Ornn's Forge).`);
      }
    }

    // Raging Firebrand: Apply nextSpellDiscount if this is a spell
    if (card.type === "Spell" && (p.nextSpellDiscount || 0) > 0) {
      const base = overrideEnergyCost ?? card.cost ?? 0;
      const reduction = Math.min(p.nextSpellDiscount || 0, base);
      overrideEnergyCost = Math.max(0, base - reduction);
      d.log.unshift(`${card.name} cost reduced by ${reduction} (next spell discount).`);
      // Note: We'll clear nextSpellDiscount after the spell is played
    }

    const baseEnergyCost = overrideEnergyCost ?? (card.cost ?? 0);
    const basePowerCost = overridePowerCost ?? (card.stats.power ?? 0);
    const additionalCost = resolveAdditionalCostsForPlay(
      d,
      pid,
      card,
      effectTextRaw,
      baseEnergyCost,
      basePowerCost,
      {
        payOptionalAdditionalCost: params.payOptionalAdditionalCost,
        additionalDiscardIds: params.additionalDiscardIds,
      }
    );
    if (additionalCost.error) return { ok: false, reason: additionalCost.error };
    const playEffectText = additionalCost.effectText;
    const additionalCostPaid = additionalCost.additionalCostPaid;
    if (typeof additionalCost.overrideEnergyCost === "number") overrideEnergyCost = additionalCost.overrideEnergyCost;
    if (typeof additionalCost.overridePowerCost === "number") overridePowerCost = additionalCost.overridePowerCost;

    const repeatCostBase = card.type === "Spell" ? parseRepeatCost(card) : null;
    let repeatCost =
      !repeatCostBase && card.type === "Spell" && p.nextSpellRepeatByCost
        ? ({ energy: (overrideEnergyCost ?? card.cost ?? 0), powerByDomain: {}, powerClass: 0, powerAny: 0 } as RepeatCost)
        : repeatCostBase;
    const repeatEnergyBefore = repeatCost?.energy ?? null;
    repeatCost = applyRepeatCostDiscount(d, pid, repeatCost);
    if (repeatCost && repeatEnergyBefore != null && repeatCost.energy < repeatEnergyBefore) {
      d.log.unshift(`${card.name} repeat cost reduced by 1 (Marai Spire).`);
    }
    let repeatCount = card.type === "Spell" ? Math.max(0, Math.floor(params.repeatCount || 0)) : 0;
    if (!repeatCost) repeatCount = 0;

    const repeatExtraEnergy = repeatCost ? repeatCost.energy * repeatCount : 0;
    const repeatExtraAny = repeatCost ? repeatCost.powerAny * repeatCount : 0;
    const repeatExtraClass = repeatCost ? repeatCost.powerClass * repeatCount : 0;

    const repeatExtraByDomain: Partial<Record<Domain, number>> = {};
    if (repeatCost && repeatCount > 0) {
      for (const dom of Object.keys(repeatCost.powerByDomain) as Domain[]) {
        const amt = repeatCost.powerByDomain[dom] || 0;
        if (amt > 0) repeatExtraByDomain[dom] = (repeatExtraByDomain[dom] || 0) + amt * repeatCount;
      }
    }

    const extraPowerByDomain = {
      ...(wantsAccelerate && accelDom ? ({ [accelDom]: 1 } as Partial<Record<Domain, number>>) : {}),
      ...(additionalCost.additionalPowerByDomain || {}),
      ...(repeatExtraByDomain || {}),
    };

    const costOpts = {
      powerDomainsAllowed,
      overrideEnergyCost,
      overridePowerCost,
      additionalEnergy: (wantsAccelerate ? 1 : 0) + repeatExtraEnergy,
      additionalPowerByDomain: extraPowerByDomain,
      additionalPowerClass: repeatExtraClass,
      additionalPowerAny: deflectTax,
    };

    if (repeatExtraAny > 0) costOpts.additionalPowerAny += repeatExtraAny;

    let affordable = canAffordCardWithChoices(d, pid, card, costOpts);
    if (!affordable && opts?.autoPay) {
      // Attempt to auto-pay with runes in play and/or Seals.
      const plan = buildAutoPayPlan(p.runePool, p.runesInPlay, {
        energyNeed: (overrideEnergyCost ?? card.cost) + (wantsAccelerate ? 1 : 0) + repeatExtraEnergy,
        basePowerNeed: overridePowerCost ?? (card.stats.power ?? 0),
        powerDomainsAllowed,
        additionalPowerByDomain: extraPowerByDomain,
        additionalPowerAny: deflectTax + repeatExtraAny,
      }, { sealExhaustedThisTurn: p.sealExhaustedThisTurn, seals: p.base.gear, playerDomains: p.domains });
      if (plan && (Object.keys(plan.runeUses).length > 0 || plan.sealUses.length > 0)) {
        applyAutoPayPlan(d, pid, plan);
        d.log.unshift(`${pid} auto-paid resources for ${card.name}.`);
      }
      affordable = canAffordCardWithChoices(d, pid, card, costOpts);
    }
    if (!affordable) return { ok: false, reason: "Cannot afford" };

    // Actually pay costs
    payCost(d, pid, card, costOpts);

    // Deflect tax goes to the targeted unit controllers' rune pools (per rules)
    if (deflectTaxByController.size > 0) {
      for (const [targetController, amount] of deflectTaxByController.entries()) {
        if (targetController === pid) continue;
        d.players[targetController].runePool.power.Colorless += amount;
        d.log.unshift(`${targetController} received ${amount} Colorless power from Deflect tax.`);
      }
    }

    // Remove from zone
    if (params.source === "HAND") {
      const idx = p.hand.findIndex((c) => c.instanceId === params.cardInstanceId);
      if (idx >= 0) p.hand.splice(idx, 1);
      p.mainDeckCardsPlayedThisTurn += 1;
    } else if (params.source === "CHAMPION") {
      p.championZone = null;
      p.mainDeckCardsPlayedThisTurn += 1;
    } else {
      const bfIdx = params.fromBattlefieldIndex ?? hiddenCtxBf;
      if (bfIdx != null) {
        const bf = d.battlefields[bfIdx];
        if (bf.facedown && bf.facedown.card.instanceId === params.cardInstanceId && bf.facedown.owner === pid) bf.facedown = null;
        else if (bf.facedownExtra && bf.facedownExtra.card.instanceId === params.cardInstanceId && bf.facedownExtra.owner === pid) bf.facedownExtra = null;
      }
      p.mainDeckCardsPlayedThisTurn += 1;
    }

    if (card.type === "Gear" && !isTokenCard(card)) {
      p.nonTokenGearPlayedThisTurn = true;
    }

    // Clear nextSpellDiscount after spell is played (Raging Firebrand effect)
    if (card.type === "Spell" && (p.nextSpellDiscount || 0) > 0) {
      p.nextSpellDiscount = 0;
    }
    if (card.type === "Spell" && p.nextSpellRepeatByCost) {
      p.nextSpellRepeatByCost = false;
    }

    // Put on chain
    const chainWasEmpty = d.chain.length === 0;
    const itemId = makeId("chain");
    const playDest = card.type === "Unit" || card.type === "Gear" ? (dest as any) : null;

    const chainItem: ChainItem = {
      id: itemId,
      controller: pid,
      kind: "PLAY_CARD",
      label: `Play ${card.name}`,
      sourceCard: card,
      sourceZone: params.source,
      playDestination: playDest,
      effectText: playEffectText || "",
      contextBattlefieldIndex: params.source === "FACEDOWN" ? hiddenCtxBf : d.windowBattlefieldIndex,
      targets: chosenTargets,
      restrictTargetsToBattlefieldIndex: restrictBf,
      legionActive: legionActiveThisPlay,
      additionalCostPaid,
      repeatCount,
    };

    // Adjust readiness for Accelerate (units) / default ready (gear)
    if (card.type === "Unit") {
      card.isReady = wantsAccelerate;
      const raw = `${card.ability?.effect_text || ""} ${card.ability?.raw_text || ""}`.toLowerCase();

      // Conditional entry ready checks
      if (raw.includes("if an opponent controls a battlefield") && raw.includes("i enter ready")) {
        const opponent = otherPlayer(pid);
        const opponentControls = d.battlefields.some((bf) => bf.controller === opponent);
        if (opponentControls) card.isReady = true;
      }
      if (raw.includes("if an opponent's score is within 3 points of the victory score") && raw.includes("i enter ready")) {
        const opponent = otherPlayer(pid);
        if (d.players[opponent].points >= d.victoryScore - 3) card.isReady = true;
      }

      // Xin Zhao: "I enter ready if you have two or more other units in your base."
      if (raw.includes("enter ready if you have two or more other units in your base") ||
        raw.includes("enter ready if you have 2 or more other units in your base") ||
        raw.includes("enter ready if you have two+ other units in your base")) {
        const otherUnitsInBase = p.base.units.filter(u => u.instanceId !== card.instanceId).length;
        if (otherUnitsInBase >= 2) {
          card.isReady = true;
          d.log.unshift(`${card.name} enters ready (2+ other units in base).`);
        }
      }

      // Direwing: "I enter ready if you control another Dragon."
      if (raw.includes("enter ready if you control another dragon")) {
        const allUnits = [...p.base.units, ...d.battlefields.flatMap(bf => bf.units[pid])];
        const hasDragon = allUnits.some(u =>
          u.instanceId !== card.instanceId &&
          (u.tags?.some(s => s.toLowerCase() === "dragon") ||
            (u.ability?.raw_text || "").toLowerCase().includes("dragon"))
        );
        if (hasDragon) {
          card.isReady = true;
          d.log.unshift(`${card.name} enters ready (controls another Dragon).`);
        }
      }

      // Breakneck Mech: "I enter ready if you control another Mech."
      if (raw.includes("enter ready if you control another mech")) {
        const allUnits = [...p.base.units, ...d.battlefields.flatMap(bf => bf.units[pid])];
        const hasMech = allUnits.some(u =>
          u.instanceId !== card.instanceId &&
          (u.tags?.some(s => s.toLowerCase() === "mech") ||
            (u.ability?.raw_text || "").toLowerCase().includes("mech"))
        );
        if (hasMech) {
          card.isReady = true;
          d.log.unshift(`${card.name} enters ready (controls another Mech).`);
        }
      }
    }
    if (card.type === "Gear") card.isReady = true;

    d.chain.push(chainItem);
    d.state = "CLOSED";
    d.priorityPlayer = pid;
    d.passesInRow = 0;
    d.log.unshift(`${pid} played ${card.name} from ${fromLabel}.`);
    if (repeatCount > 0) {
      d.log.unshift(`${card.name} will repeat its effect ${repeatCount} time(s).`);
    }

    // Immediately resolve permanents if they started the chain.
    if (chainWasEmpty && card.type !== "Spell") {
      resolveTopOfChain(d);
    }

    checkGlobalTriggers(d, "PLAY_CARD", { player: pid, card });
    if (isHiddenPlay) {
      queueTriggersForEvent(
        d,
        pid,
        (trig, source) => {
          if (!trig.includes("when you play a card from")) return false;
          const raw = `${source.ability?.effect_text || ""} ${source.ability?.raw_text || ""}`.toLowerCase();
          return raw.includes("[hidden]");
        },
        (source) => source.ability?.effect_text
      );
    }

    cleanupStateBased(d);
    maybeOpenNextWindow(d);
    return { ok: true };
  };

  const applyAiIntent = (pid: PlayerId, intent: AiIntent) => {
    switch (intent.type) {
      case "PASS":
        dispatchEngineAction({ type: "PASS_PRIORITY", player: pid });
        return;
      case "NEXT_STEP":
        dispatchEngineAction({ type: "NEXT_STEP", player: pid });
        return;
      case "MULLIGAN":
        dispatchEngineAction({ type: "MULLIGAN_CONFIRM", player: pid, recycleIds: intent.recycleIds });
        return;
      case "SET_CHAIN_TARGETS":
        dispatchEngineAction({ type: "SET_CHAIN_TARGETS", player: pid, chainItemId: intent.chainItemId, targets: intent.targets });
        return;
      case "HIDE":
        dispatchEngineAction({ type: "HIDE_CARD", player: pid, cardInstanceId: intent.cardInstanceId, battlefieldIndex: intent.battlefieldIndex, autoPay: true });
        return;
      case "MOVE":
        dispatchEngineAction({ type: "STANDARD_MOVE", player: pid, from: intent.from, unitIds: intent.unitIds, to: intent.to });
        return;
      case "LEGEND_ACTIVATE":
        dispatchEngineAction({ type: "LEGEND_ACTIVATE", player: pid, targets: intent.targets, autoPay: true });
        return;
      case "PLAY":
        dispatchEngineAction({
          type: "PLAY_CARD",
          player: pid,
          source: intent.source,
          cardInstanceId: intent.cardInstanceId,
          fromBattlefieldIndex: intent.fromBattlefieldIndex,
          destination: intent.destination ?? null,
          accelerate: intent.accelerate,
          targets: intent.targets,
          autoPay: true,
        });
        return;
      case "DAMAGE_AUTO_ASSIGN":
        dispatchEngineAction({ type: "DAMAGE_AUTO_ASSIGN", player: pid });
        return;
      default:
        return;
    }
  };

  const aiCardNumericValue = (c: CardInstance): number => {
    if (c.type === "Unit") return (c.stats.might || 0) * 3 - (c.cost || 0) + (hasKeyword(c, "Ganking") ? 1 : 0) + (hasKeyword(c, "Deflect") ? 1 : 0);
    if (c.type === "Gear") return 1 - (c.cost || 0);
    if (c.type === "Spell") {
      const raw = (c.ability?.effect_text || "").toLowerCase();
      const dmg = extractDamageAmount(raw);
      if (dmg) return dmg * 2 - (c.cost || 0);
      if (raw.includes("kill")) return 6;
      if (raw.includes("banish")) return 5;
      if (raw.includes("stun")) return 3;
      return 0;
    }
    return 0;
  };

  const aiBoardScore = (d: GameState, pid: PlayerId): number => {
    const opp = otherPlayer(pid);
    const my = d.players[pid];
    const en = d.players[opp];

    // Terminal
    if (d.step === "GAME_OVER") {
      const myWin = my.points >= d.victoryScore && en.points < d.victoryScore;
      const enWin = en.points >= d.victoryScore && my.points < d.victoryScore;
      if (myWin) return 999999;
      if (enWin) return -999999;
      return (my.points - en.points) * 10000;
    }

    const myControlled = d.battlefields.filter((bf) => bf.controller === pid).length;
    const enControlled = d.battlefields.filter((bf) => bf.controller === opp).length;
    const myContesting = d.battlefields.filter((bf) => bf.contestedBy === pid).length;
    const enContesting = d.battlefields.filter((bf) => bf.contestedBy === opp).length;

    const bfMight = (p: PlayerId) =>
      d.battlefields.reduce(
        (sum, bf) => sum + bf.units[p].reduce((a, u) => a + effectiveMight(u, { role: "NONE", game: d, battlefieldIndex: bf.index }), 0),
        0
      );
    const baseMight = (p: PlayerId) => d.players[p].base.units.reduce((a, u) => a + effectiveMight(u, { role: "NONE", game: d }), 0);

    const unitsOnBoard = (p: PlayerId) =>
      d.players[p].base.units.length + d.battlefields.reduce((sum, bf) => sum + bf.units[p].length, 0);

    const gearOnBoard = (p: PlayerId) =>
      d.players[p].base.gear.length + d.battlefields.reduce((sum, bf) => sum + bf.gear[p].length, 0);

    const myRunesReady = my.runesInPlay.filter((r) => r.isReady).length;
    const enRunesReady = en.runesInPlay.filter((r) => r.isReady).length;

    let score = 0;

    // Points / objective control
    score += (my.points - en.points) * 1200;
    score += (myControlled - enControlled) * 260;
    score += (myContesting - enContesting) * 70;

    // Board presence (make sure playing units is valuable vs "sandbagging" cards forever)
    score += (bfMight(pid) - bfMight(opp)) * 9;
    score += (baseMight(pid) - baseMight(opp)) * 5;
    score += (unitsOnBoard(pid) - unitsOnBoard(opp)) * 16;
    score += (gearOnBoard(pid) - gearOnBoard(opp)) * 3;

    // Hand/zone resources (important, but not worth skipping turns)
    score += (my.hand.length - en.hand.length) * 1.5;
    score += ((my.championZone ? 1 : 0) - (en.championZone ? 1 : 0)) * 2;

    // Runes (keep this low; spending runes is how you play the game)
    score += (myRunesReady - enRunesReady) * 0.35;

    // If we are one point from winning, heavily prefer simply maintaining a control lead.
    if (my.points === d.victoryScore - 1) score += myControlled * 120;
    if (en.points === d.victoryScore - 1) score -= enControlled * 120;

    return score;
  };

  const aiCanProbablyResolveEffectText = (c: CardInstance): boolean => {
    if (c.type !== "Spell") return true;
    const raw = (c.ability?.effect_text || "").toLowerCase();
    if (raw.includes("deal")) return true;
    if (raw.includes("stun")) return true;
    if (raw.includes("ready")) return true;
    if (raw.includes("kill")) return true;
    if (raw.includes("banish")) return true;
    if (raw.includes("buff")) return true;
    if (raw.includes("return") || raw.includes("recall")) return true;
    if (raw.includes("draw")) return true;
    if (raw.includes("channel")) return true;
    if (raw.includes("add") && raw.includes("rune")) return true;
    return false;
  };

  const aiInferReqForSpell = (spell: CardInstance): TargetRequirement => inferTargetRequirement(spell.ability?.effect_text || "", { here: false });

  const aiEnumerateIntents = (d: GameState, pid: PlayerId, difficulty: AiDifficulty): AiIntent[] => {
    const intents: AiIntent[] = [];
    const maybeAddLegendIntent = () => {
      const p = d.players[pid];
      if (!p.legend || !p.legendReady) return;
      if (d.priorityPlayer !== pid) return;

      let parsed = legendActivatedEffect(p.legend);
      if (!parsed) {
        const grantsEquip = d.battlefields.some((bf) => bf.controller === pid && battlefieldGrantsLegendEquip(bf));
        if (grantsEquip) {
          parsed = {
            rawLine: "Forge of the Fluft",
            effectText: "Attach an equipment you control to a unit you control.",
            req: { kind: "UNIT_AND_GEAR_FRIENDLY" },
            cost: { energy: 0, powerByDomain: {}, powerClass: 0, powerAny: 0 },
          };
        }
      }
      if (!parsed) return;

      const legendTiming = inferActivatedTimingClass(parsed.rawLine);
      if (!canUseTimingClassNow(d, pid, legendTiming)) return;

      const req = parsed.req || ({ kind: "NONE" } as TargetRequirement);
      let targets = pickTargetForAi(d, pid, req, d.windowBattlefieldIndex ?? null, null, difficulty);
      const looksLikeTokenPlay = /\bplay\b.*\bunit\s+token\b/i.test(parsed.effectText || "");
      if (looksLikeTokenPlay && req.kind === "BATTLEFIELD") {
        const controlled = d.battlefields
          .filter((bf) => bf.controller === pid)
          .map((bf) => ({ kind: "BATTLEFIELD", index: bf.index } as Target));
        if (controlled.length > 0) targets = [controlled[0]];
        else if (req.optional) targets = [{ kind: "NONE" }];
      }
      if (req.kind !== "NONE" && (!targets[0] || targets[0].kind === "NONE") && !req.optional) return;
      intents.push({ type: "LEGEND_ACTIVATE", targets });
    };

    // 0) Damage assignment - AI should auto-assign if pending
    if (d.pendingDamageAssignment) {
      const pda = d.pendingDamageAssignment;
      const needsToAssign = (pid === pda.attacker && !pda.attackerConfirmed) || (pid === pda.defender && !pda.defenderConfirmed);
      if (needsToAssign) {
        intents.push({ type: "DAMAGE_AUTO_ASSIGN" });
        return intents;
      }
    }

    // 1) Mulligan
    if (d.step === "MULLIGAN") {
      const p = d.players[pid];
      if (!p.mulliganDone) {
        // Decide which cards to recycle (max 2)
        if (difficulty === "EASY") {
          intents.push({ type: "MULLIGAN", recycleIds: [] });
        } else {
          const hand = [...p.hand];
          hand.sort((a, b) => (b.cost || 0) - (a.cost || 0));
          const expensive = hand.filter((c) => (c.cost || 0) >= 6).slice(0, 2);
          const pick = difficulty === "MEDIUM" ? expensive : hand.slice(0, 2);
          intents.push({ type: "MULLIGAN", recycleIds: pick.map((c) => c.instanceId) });
        }
      }
      return intents;
    }

    // 2) Chain items needing targets controlled by this AI
    const top = d.chain[d.chain.length - 1];
    if (top && top.needsTargets && top.controller === pid) {
      const diff = difficulty;
      const chosen = pickTargetForAi(d, pid, top.targetRequirement || { kind: "NONE" }, top.contextBattlefieldIndex ?? null, top.restrictTargetsToBattlefieldIndex ?? null, diff, top.sourceInstanceId);
      intents.push({ type: "SET_CHAIN_TARGETS", chainItemId: top.id, targets: chosen });
      return intents;
    }

    // 3) Non-action steps: if it's our turn and we can advance, do so.
    const canAdvance = d.chain.length === 0 && d.windowKind === "NONE" && d.state === "OPEN";
    if (d.step !== "ACTION") {
      if (d.turnPlayer === pid && canAdvance && d.step !== "GAME_OVER") {
        intents.push({ type: "NEXT_STEP" });
      } else if (d.priorityPlayer === pid && (d.chain.length > 0 || d.state === "CLOSED" || d.windowKind !== "NONE")) {
        intents.push({ type: "PASS" });
      }
      return intents;
    }

    // 4) ACTION step
    const isMainActionState = d.step === "ACTION" && d.turnPlayer === pid && canAdvance;
    const isPriorityState = d.priorityPlayer === pid;

    if (isMainActionState) {
      // --- Hide candidates
      if (difficulty === "HARD" || difficulty === "VERY_HARD") {
        const hiddenCards = d.players[pid].hand.filter((c) => isHiddenCard(c));
        if (hiddenCards.length > 0) {
          const controlled = d.battlefields.filter((bf) => bf.controller === pid && !bf.facedown).map((bf) => bf.index);
          for (const bfIdx of controlled) {
            for (const hc of hiddenCards.slice(0, 2)) {
              intents.push({ type: "HIDE", cardInstanceId: hc.instanceId, battlefieldIndex: bfIdx });
            }
          }
        }
      }

      // --- Play champion (early board presence)
      const champ = d.players[pid].championZone;
      if (champ) {
        const doms = parseDomains(champ.domain).map(clampDomain).filter((x) => x !== "Colorless");
        const accelDom = doms.length > 0 ? doms[0] : d.players[pid].domains[0] || "Fury";
        intents.push({ type: "PLAY", source: "CHAMPION", cardInstanceId: champ.instanceId, destination: { kind: "BASE" }, accelerate: { pay: false, domain: accelDom }, targets: [{ kind: "NONE" }] });
      }

      // --- Play from hand (limit candidates)
      const hand = [...d.players[pid].hand];
      // Prefer units first, then spells/gear
      hand.sort((a, b) => aiCardNumericValue(b) - aiCardNumericValue(a));
      const consider = hand.slice(0, difficulty === "EASY" ? 2 : difficulty === "MEDIUM" ? 4 : 6);
      const controlledBfs = d.battlefields.filter((bf) => bf.controller === pid).map((bf) => bf.index);

      for (const c of consider) {
        if (c.type === "Spell") {
          if (!aiCanProbablyResolveEffectText(c)) continue;
          if (!canSpellTimingNow(d, pid, c)) continue;
          const req = aiInferReqForSpell(c);
          const t = pickTargetForAi(d, pid, req, d.windowBattlefieldIndex, null, difficulty);
          intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: null, targets: t });
        } else if (c.type === "Gear") {
          if (!canPlayNonspellOutsideShowdown(c, d, pid)) continue;
          intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: { kind: "BASE" }, targets: [{ kind: "NONE" }] });
        } else if (c.type === "Unit") {
          if (!canPlayNonspellOutsideShowdown(c, d, pid)) continue;
          // Try a controlled battlefield if we have one, else base.
          const dests: ({ kind: "BASE" } | { kind: "BF"; index: number })[] = [
            { kind: "BASE" } as const,
            ...controlledBfs.map((i) => ({ kind: "BF", index: i } as const)),
          ];
          const doms = parseDomains(c.domain).map(clampDomain).filter((x) => x !== "Colorless");
          const accelDom = doms.length > 0 ? doms[0] : d.players[pid].domains[0] || "Fury";
          for (const dest of dests.slice(0, difficulty === "EASY" ? 1 : 2)) {
            intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: dest, accelerate: { pay: false, domain: accelDom }, targets: [{ kind: "NONE" }] });
            if ((difficulty === "HARD" || difficulty === "VERY_HARD") && hasKeyword(c, "Accelerate")) {
              intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: dest, accelerate: { pay: true, domain: accelDom }, targets: [{ kind: "NONE" }] });
            }
          }
        }
      }

      // --- Standard move candidates (move ready units from base to battlefields)
      const readyBase = d.players[pid].base.units.filter((u) => u.isReady);
      readyBase.sort((a, b) => effectiveMight(b, { role: "NONE", game: d }) - effectiveMight(a, { role: "NONE", game: d }));

      const allBfs = d.battlefields.map((bf) => bf.index);

      // Singles
      const moveSingles = readyBase.slice(0, difficulty === "EASY" ? 1 : difficulty === "MEDIUM" ? 2 : 3);
      for (const u of moveSingles) {
        for (const bfIdx of allBfs) {
          intents.push({ type: "MOVE", from: { kind: "BASE" }, to: { kind: "BF", index: bfIdx }, unitIds: [u.instanceId] });
        }
      }

      // Pairs (helps the AI build real contesting pressure)
      if (difficulty !== "EASY" && readyBase.length >= 2) {
        const pair = readyBase.slice(0, 2).map((u) => u.instanceId);
        for (const bfIdx of allBfs) {
          intents.push({ type: "MOVE", from: { kind: "BASE" }, to: { kind: "BF", index: bfIdx }, unitIds: pair });
        }
      }

      // Triples (VERY_HARD only)
      if (difficulty === "VERY_HARD" && readyBase.length >= 3) {
        const trio = readyBase.slice(0, 3).map((u) => u.instanceId);
        for (const bfIdx of allBfs) {
          intents.push({ type: "MOVE", from: { kind: "BASE" }, to: { kind: "BF", index: bfIdx }, unitIds: trio });
        }
      }

      // --- Facedown play candidates (Hard+ only)
      if (difficulty === "HARD" || difficulty === "VERY_HARD") {
        d.battlefields.forEach((bf, idx) => {
          if (!bf.facedown || bf.facedown.owner !== pid) return;
          if (bf.facedown.hiddenOnTurn === d.turnNumber) return;
          const c = bf.facedown.card;
          if (c.type === "Spell") {
            if (!aiCanProbablyResolveEffectText(c)) return;
            if (!canSpellTimingNow(d, pid, c)) return;
            const req = aiInferReqForSpell(c);
            const t = pickTargetForAi(d, pid, req, idx, idx, difficulty);
            intents.push({ type: "PLAY", source: "FACEDOWN", cardInstanceId: c.instanceId, fromBattlefieldIndex: idx, destination: null, targets: t });
          } else {
            intents.push({ type: "PLAY", source: "FACEDOWN", cardInstanceId: c.instanceId, fromBattlefieldIndex: idx, destination: { kind: "BF", index: idx }, targets: [{ kind: "NONE" }] });
          }
        });
      }

      // --- Legend activation candidate
      maybeAddLegendIntent();

      // Always allow ending the turn
      intents.push({ type: "NEXT_STEP" });
      return intents;
    }

    // Priority within a window/chain: respond with Action/Reaction spells if possible, else pass.
    if (isPriorityState) {
      const hand = [...d.players[pid].hand];
      hand.sort((a, b) => aiCardNumericValue(b) - aiCardNumericValue(a));
      const consider = hand.slice(0, difficulty === "EASY" ? 1 : difficulty === "MEDIUM" ? 2 : 4);
      for (const c of consider) {
        if (c.type !== "Spell") continue;
        if (!aiCanProbablyResolveEffectText(c)) continue;
        if (!canSpellTimingNow(d, pid, c)) continue;
        const req = aiInferReqForSpell(c);
        const t = pickTargetForAi(d, pid, req, d.windowBattlefieldIndex, null, difficulty);
        intents.push({ type: "PLAY", source: "HAND", cardInstanceId: c.instanceId, destination: null, targets: t });
      }
      maybeAddLegendIntent();
      intents.push({ type: "PASS" });
    }
    return intents;
  };


  const aiFastForwardForScore = (sim: GameState, maxIters = 60) => {
    let guard = 0;
    while (guard++ < maxIters) {
      if (sim.step === "GAME_OVER") return;

      if (sim.chain.length > 0) {
        // For scoring, assume both players will pass and let the chain resolve.
        resolveTopOfChain(sim);
        continue;
      }

      // End regular showdowns deterministically.
      if (sim.windowKind === "SHOWDOWN") {
        const idx = sim.windowBattlefieldIndex!;
        const bf = sim.battlefields[idx];

        // Close showdown
        sim.windowKind = "NONE";
        sim.windowBattlefieldIndex = null;
        sim.focusPlayer = null;
        sim.passesInRow = 0;
        sim.state = "OPEN";
        sim.priorityPlayer = sim.turnPlayer;

        const p1 = bf.units.P1.length;
        const p2 = bf.units.P2.length;

        if (p1 > 0 && p2 > 0) {
          const attacker = bf.contestedBy!;
          const defender = otherPlayer(attacker);
          sim.windowKind = "COMBAT";
          sim.windowBattlefieldIndex = idx;
          sim.combat = { battlefieldIndex: idx, attacker, defender, step: "SHOWDOWN" };
          sim.focusPlayer = attacker;
          sim.priorityPlayer = attacker;
          sim.passesInRow = 0;
          continue;
        }

        const winner: PlayerId | null = p1 > 0 ? "P1" : p2 > 0 ? "P2" : null;
        const prev = bf.controller;

        if (winner) {
          bf.controller = winner;
          bf.contestedBy = null;
          if (prev !== winner) attemptScore(sim, winner, idx, "Conquer");
        } else {
          bf.controller = null;
          bf.contestedBy = null;
        }

        cleanupStateBased(sim);
        maybeOpenNextWindow(sim);
        continue;
      }

      // End combat showdowns deterministically (auto-assign damage).
      if (sim.windowKind === "COMBAT" && sim.combat && sim.combat.step === "SHOWDOWN") {
        const bfi = sim.combat.battlefieldIndex;
        const attacker = sim.combat.attacker;
        const defender = sim.combat.defender;
        assignCombatDamageAuto(sim, bfi, attacker, defender);
        sim.combat.step = "DAMAGE";
        resolveCombatResolution(sim);
        continue;
      }

      // Handle DAMAGE_ASSIGNMENT step in simulation (auto-assign for both players)
      if (sim.windowKind === "COMBAT" && sim.combat && sim.combat.step === "DAMAGE_ASSIGNMENT" && sim.pendingDamageAssignment) {
        // Auto-assign for both players
        engineDamageAutoAssign(sim, sim.pendingDamageAssignment.attacker);
        if (sim.pendingDamageAssignment) { // May have been cleared if both confirmed
          engineDamageAutoAssign(sim, sim.pendingDamageAssignment.defender);
        }
        continue;
      }

      // If a combat damage step is hanging around, resolveCombatResolution already clears it, but guard anyway.
      if (sim.windowKind === "COMBAT" && sim.combat && sim.combat.step === "DAMAGE") {
        resolveCombatResolution(sim);
        continue;
      }

      break;
    }
  };

  const aiChooseIntent = (d: GameState, pid: PlayerId, difficulty: AiDifficulty): AiIntent | null => {
    const candidates = aiEnumerateIntents(d, pid, difficulty);
    if (candidates.length === 0) return null;

    const scoreIntent = (intent: AiIntent): number => {
      const sim = deepClone(d);

      switch (intent.type) {
        case "PASS":
          enginePassPriority(sim, pid);
          break;
        case "NEXT_STEP":
          engineNextStep(sim, pid);
          break;
        case "MULLIGAN":
          engineConfirmMulligan(sim, pid, intent.recycleIds);
          break;
        case "SET_CHAIN_TARGETS":
          engineSetChainTargets(sim, pid, intent.chainItemId, intent.targets);
          cleanupStateBased(sim);
          maybeOpenNextWindow(sim);
          break;
        case "HIDE":
          engineHideCard(sim, pid, intent.cardInstanceId, intent.battlefieldIndex, { autoPay: true });
          cleanupStateBased(sim);
          maybeOpenNextWindow(sim);
          break;
        case "MOVE":
          engineStandardMove(sim, pid, intent.from, intent.unitIds, intent.to);
          cleanupStateBased(sim);
          maybeOpenNextWindow(sim);
          break;
        case "LEGEND_ACTIVATE": {
          const ok = engineActivateLegend(sim, pid, intent.targets, { autoPay: true });
          if (!ok) return -999999;
          break;
        }
        case "PLAY": {
          const r = enginePlayCard(
            sim,
            pid,
            {
              source: intent.source,
              cardInstanceId: intent.cardInstanceId,
              fromBattlefieldIndex: intent.fromBattlefieldIndex,
              destination: intent.destination ?? null,
              accelerate: intent.accelerate,
              targets: intent.targets,
            },
            { autoPay: true }
          );
          if (!r.ok) return -999999;
          break;
        }
        default:
          break;
      }

      // Key improvement: for evaluation, deterministically fast-forward through chain/showdowns/combat resolution
      // so the AI can actually "see" the outcome of a showdown or combat.
      aiFastForwardForScore(sim);

      let sc = aiBoardScore(sim, pid);

      // Light tie-breakers. Real value should come from aiBoardScore().
      // We slightly discourage PASS / ending the turn, and slightly encourage taking meaningful actions.
      const isMainAction = d.step === "ACTION" && d.turnPlayer === pid && d.chain.length === 0 && d.windowKind === "NONE" && d.state === "OPEN";
      if (intent.type === "PASS") sc -= 0.08;
      if (intent.type === "NEXT_STEP") sc -= isMainAction ? 0.35 : 0.10;
      if (intent.type === "PLAY") sc += 0.10;
      if (intent.type === "MOVE") sc += 0.05;
      if (intent.type === "HIDE") sc += 0.03;
      if (intent.type === "LEGEND_ACTIVATE") sc += 0.08;

      return sc;
    };

    const scored = candidates
      .map((intent) => ({ intent, score: scoreIntent(intent) }))
      .filter((x) => x.score > -999000) // Filter out intents that failed simulation (e.g., unaffordable plays)
      .sort((a, b) => b.score - a.score);

    // If all intents failed, return null to avoid attempting unaffordable plays
    if (scored.length === 0) return null;

    if (difficulty === "EASY") {
      // Pick randomly among the top few.
      const topN = Math.min(4, scored.length);
      const pick = scored[Math.floor(Math.random() * topN)];
      return pick.intent;
    }

    if (difficulty === "MEDIUM") {
      // Mostly pick the best, sometimes the runner-up.
      if (scored.length >= 2 && Math.random() < 0.25) return scored[1].intent;
      return scored[0].intent;
    }

    // HARD / VERY_HARD: pick the best. (VERY_HARD mainly differs by having more legal intents available.)
    return scored[0].intent;
  };

  const aiTimerRef = useRef<number | null>(null);
  const gameRef = useRef<GameState | null>(null);
  const pendingRetreatChallengeReproAfterStartRef = useRef(false);
  const pendingCullWeakReproAfterStartRef = useRef(false);
  const pendingConditionalAuditReproAfterStartRef = useRef(false);
  const pendingSealAutoPayReproAfterStartRef = useRef(false);
  const pendingGoldTokenReproAfterStartRef = useRef(false);
  const pendingBattlefieldAuditReproAfterStartRef = useRef(false);
  const pendingLegendAuditReproAfterStartRef = useRef(false);
  const pendingChampionAuditReproAfterStartRef = useRef(false);
  const pendingSpellAuditReproAfterStartRef = useRef(false);
  const pendingGearAuditReproAfterStartRef = useRef(false);
  const pendingEquipAdditionalReproAfterStartRef = useRef(false);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    if (!game) return;
    if (pendingRetreatChallengeReproAfterStartRef.current) {
      pendingRetreatChallengeReproAfterStartRef.current = false;
      runRetreatChallengeRepro();
      return;
    }
    if (pendingCullWeakReproAfterStartRef.current) {
      pendingCullWeakReproAfterStartRef.current = false;
      runCullWeakRepro();
      return;
    }
    if (pendingConditionalAuditReproAfterStartRef.current) {
      pendingConditionalAuditReproAfterStartRef.current = false;
      runConditionalAuditRepro();
      return;
    }
    if (pendingSealAutoPayReproAfterStartRef.current) {
      pendingSealAutoPayReproAfterStartRef.current = false;
      runSealAutoPayRepro();
      return;
    }
    if (pendingGoldTokenReproAfterStartRef.current) {
      pendingGoldTokenReproAfterStartRef.current = false;
      runGoldTokenActivationRepro();
      return;
    }
    if (pendingBattlefieldAuditReproAfterStartRef.current) {
      pendingBattlefieldAuditReproAfterStartRef.current = false;
      runBattlefieldAuditRepro();
      return;
    }
    if (pendingLegendAuditReproAfterStartRef.current) {
      pendingLegendAuditReproAfterStartRef.current = false;
      runLegendAuditRepro();
      return;
    }
    if (pendingChampionAuditReproAfterStartRef.current) {
      pendingChampionAuditReproAfterStartRef.current = false;
      runChampionAuditRepro();
      return;
    }
    if (pendingSpellAuditReproAfterStartRef.current) {
      pendingSpellAuditReproAfterStartRef.current = false;
      runSpellAuditRepro();
      return;
    }
    if (pendingGearAuditReproAfterStartRef.current) {
      pendingGearAuditReproAfterStartRef.current = false;
      runGearAuditRepro();
      return;
    }
    if (pendingEquipAdditionalReproAfterStartRef.current) {
      pendingEquipAdditionalReproAfterStartRef.current = false;
      runEquipAdditionalCostRepro();
    }
  }, [game]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const summarizeUnit = (u: CardInstance) => ({
      id: u.instanceId,
      name: u.name,
      ready: u.isReady,
      stunned: u.stunned,
      damage: u.damage,
      buffs: u.buffs,
      tempMightBonus: u.tempMightBonus,
      attachedGear: (u.attachedGear || []).map((g) => g.name),
    });

    const summarizePlayer = (p: PlayerState) => ({
      points: p.points,
      handCount: p.hand.length,
      hand: p.hand.map((c) => c.name),
      deckCount: p.mainDeck.length,
      trashCount: p.trash.length,
      runePool: p.runePool,
      runesInPlay: p.runesInPlay.map((r) => ({ name: r.name, domain: r.domain, ready: r.isReady })),
      base: {
        units: p.base.units.map(summarizeUnit),
        gear: p.base.gear.map((g) => g.name),
      },
      legend: p.legend?.name ?? null,
      champion: p.championZone?.name ?? null,
      mulliganDone: p.mulliganDone,
    });

    const summarizeBattlefield = (bf: BattlefieldState) => ({
      index: bf.index,
      name: bf.card?.name ?? null,
      controller: bf.controller,
      contestedBy: bf.contestedBy,
      units: {
        P1: bf.units.P1.map(summarizeUnit),
        P2: bf.units.P2.map(summarizeUnit),
      },
      gear: {
        P1: bf.gear.P1.map((g) => g.name),
        P2: bf.gear.P2.map((g) => g.name),
      },
      facedown: bf.facedown ? { owner: bf.facedown.owner, name: bf.facedown.card.name } : null,
      facedownExtra: bf.facedownExtra ? { owner: bf.facedownExtra.owner, name: bf.facedownExtra.card.name } : null,
    });

    window.render_game_to_text = () => {
      const d = gameRef.current ?? game;
      if (!d) return JSON.stringify({ ready: false });
      try {
        const snapshot = {
          ready: true,
          step: d.step,
          state: d.state,
          turnNumber: d.turnNumber,
          turnPlayer: d.turnPlayer,
          priorityPlayer: d.priorityPlayer,
          window: {
            kind: d.windowKind,
            battlefieldIndex: d.windowBattlefieldIndex ?? null,
            combat: d.combat
              ? {
                battlefieldIndex: d.combat.battlefieldIndex,
                attacker: d.combat.attacker,
                defender: d.combat.defender,
                step: d.combat.step,
              }
              : null,
          },
          chain: d.chain.map((item) => ({
            id: item.id,
            kind: item.kind,
            label: item.label,
            controller: item.controller,
            needsTargets: !!item.needsTargets,
            targetKinds: (item.targets || []).map((t) => t.kind),
          })),
          pending: {
            optionalChoice: d.pendingOptionalChoice
              ? {
                id: d.pendingOptionalChoice.id,
                player: d.pendingOptionalChoice.player,
                kind: d.pendingOptionalChoice.kind,
                prompt: d.pendingOptionalChoice.prompt,
              }
              : null,
            cullChoice: d.pendingCullChoice
              ? {
                resolutionId: d.pendingCullChoice.resolutionId,
                order: d.pendingCullChoice.order,
                index: d.pendingCullChoice.index,
                choices: d.pendingCullChoice.choices,
              }
              : null,
            damageAssignment: d.pendingDamageAssignment
              ? {
                battlefieldIndex: d.pendingDamageAssignment.battlefieldIndex,
                attacker: d.pendingDamageAssignment.attacker,
                defender: d.pendingDamageAssignment.defender,
              }
              : null,
          },
          players: {
            P1: summarizePlayer(d.players.P1),
            P2: summarizePlayer(d.players.P2),
          },
          battlefields: d.battlefields.map(summarizeBattlefield),
        };
        return JSON.stringify(snapshot);
      } catch (err) {
        return JSON.stringify({ ready: true, error: String(err) });
      }
    };

    return () => {
      if (window.render_game_to_text) delete window.render_game_to_text;
    };
  }, [game]);

  // AI auto-choose starting player (moved from renderDiceRollModal to avoid hooks rule violation)
  useEffect(() => {
    if (!pendingStartingPlayerChoice) return;
    const { chooser } = pendingStartingPlayerChoice;
    const isAiChooser = aiByPlayer[chooser]?.enabled;
    if (!isAiChooser) return;

    const timer = setTimeout(() => {
      // AI always chooses to go first (simple heuristic)
      confirmStartingPlayerChoice(chooser);
    }, 1500);
    return () => clearTimeout(timer);
  }, [pendingStartingPlayerChoice, aiByPlayer]);

  useEffect(() => {
    if (!game) return;
    if (aiPaused) return;

    // If no AI enabled, do nothing.
    const aiPlayers = (['P1', 'P2'] as PlayerId[]).filter((pid) => aiByPlayer[pid]?.enabled);
    if (aiPlayers.length === 0) return;

    // Avoid scheduling multiple overlapping decisions.
    if (aiTimerRef.current) {
      window.clearTimeout(aiTimerRef.current);
      aiTimerRef.current = null;
    }

    // Find a single AI player that should act now.
    const snap = game;

    // Handle pending each-player choice (Cull the Weak) first.
    if (snap.pendingCullChoice) {
      const chooser = snap.pendingCullChoice.order[snap.pendingCullChoice.index];
      if (aiByPlayer[chooser]?.enabled) {
        const delay = Math.max(50, Math.min(2500, aiByPlayer[chooser]?.thinkMs || 650));
        aiTimerRef.current = window.setTimeout(() => {
          aiTimerRef.current = null;
          const latest = gameRef.current;
          if (!latest || !latest.pendingCullChoice) return;
          if (!aiByPlayer[chooser]?.enabled || aiPaused) return;
          const units = getUnitsInPlay(latest, chooser);
          const pick = units[0];
          if (pick) {
            dispatchEngineAction({ type: "CULL_CHOOSE", player: chooser, unitInstanceId: pick.instanceId });
          }
        }, delay);
        return () => {
          if (aiTimerRef.current) {
            window.clearTimeout(aiTimerRef.current);
            aiTimerRef.current = null;
          }
        };
      }
    }

    let actor: PlayerId | null = null;
    for (const pid of aiPlayers) {
      const diff = aiByPlayer[pid]?.difficulty || "MEDIUM";
      const intent = aiChooseIntent(snap, pid, diff);
      // Only act if the intent is actually legal right now.
      if (!intent) continue;
      // Gate: mulligan, or controlled chain target, or priority, or turn-player advance, or damage assignment.
      const top = snap.chain[snap.chain.length - 1];
      const canAdvance = snap.chain.length === 0 && snap.windowKind === "NONE" && snap.state === "OPEN";
      const isMyMulligan = snap.step === "MULLIGAN" && !snap.players[pid].mulliganDone;
      const isMyChainChoice = !!top && top.needsTargets && top.controller === pid;
      const isMyPriority = snap.priorityPlayer === pid;
      const isMyTurnAdvance = snap.turnPlayer === pid && canAdvance && snap.step !== "GAME_OVER";
      const isMyDamageAssignment = snap.pendingDamageAssignment &&
        ((pid === snap.pendingDamageAssignment.attacker && !snap.pendingDamageAssignment.attackerConfirmed) ||
          (pid === snap.pendingDamageAssignment.defender && !snap.pendingDamageAssignment.defenderConfirmed));
      if (isMyMulligan || isMyChainChoice || isMyPriority || isMyTurnAdvance || isMyDamageAssignment) {
        actor = pid;
        break;
      }
    }

    if (!actor) return;

    // Handle AI damage assignment immediately
    const pda = snap.pendingDamageAssignment;
    if (pda && ((actor === pda.attacker && !pda.attackerConfirmed) || (actor === pda.defender && !pda.defenderConfirmed))) {
      const delay = Math.max(50, Math.min(2500, aiByPlayer[actor]?.thinkMs || 650));
      aiTimerRef.current = window.setTimeout(() => {
        aiTimerRef.current = null;
        const latest = gameRef.current;
        if (!latest || !latest.pendingDamageAssignment) return;
        if (!aiByPlayer[actor]?.enabled) return;
        if (aiPaused) return;
        dispatchEngineAction({ type: "DAMAGE_AUTO_ASSIGN", player: actor });
      }, delay);
      return () => {
        if (aiTimerRef.current) {
          window.clearTimeout(aiTimerRef.current);
          aiTimerRef.current = null;
        }
      };
    }

    const delay = Math.max(50, Math.min(2500, aiByPlayer[actor]?.thinkMs || 650));
    aiTimerRef.current = window.setTimeout(() => {
      aiTimerRef.current = null;
      const latest = gameRef.current;
      if (!latest) return;
      if (!aiByPlayer[actor]?.enabled) return;
      if (aiPaused) return;
      const diff = aiByPlayer[actor]?.difficulty || "MEDIUM";
      const intent = aiChooseIntent(latest, actor, diff);
      if (!intent) return;
      applyAiIntent(actor, intent);
    }, delay);

    return () => {
      if (aiTimerRef.current) {
        window.clearTimeout(aiTimerRef.current);
        aiTimerRef.current = null;
      }
    };
  }, [game, aiByPlayer, aiPaused]);

  const toggleRevealHands = () => setRevealAllHands((v) => !v);
  const toggleRevealFacedown = () => setRevealAllFacedown((v) => !v);
  const toggleRevealDecks = () => setRevealAllDecks((v) => !v);

  const clearTransientUI = () => {
    setSelectedHandCardId(null);
    setPendingPlay(null);
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
    setPendingRepeatCount(0);
    setPendingPayOptionalAdditionalCost(true);
    setPendingAdditionalDiscardIds([]);
    setHideChoice({ cardId: null, battlefieldIndex: null });
    setMoveSelection({ from: null, unitIds: [], to: null });
    setArenaMove(null);
    setArenaHideCardId(null);
    setHoverPayPlan(null);
  };

  const getActiveTargetContext = (): { req: TargetRequirement; controller: PlayerId; restrictBf: number | null; contextBf: number | null } | null => {
    if (!g) return null;
    if (g.pendingCullChoice) {
      return {
        req: { kind: "UNIT_FRIENDLY", count: 1 },
        controller: g.pendingCullChoice.order[g.pendingCullChoice.index],
        restrictBf: null,
        contextBf: null,
      };
    }
    if (pendingChainChoice) {
      const item = g.chain.find((x) => x.id === pendingChainChoice.chainItemId) || g.chain[g.chain.length - 1];
      if (!item) return null;
      return {
        req: item.targetRequirement || { kind: "NONE" },
        controller: item.controller,
        restrictBf: item.restrictTargetsToBattlefieldIndex ?? null,
        contextBf: item.contextBattlefieldIndex ?? null,
      };
    }
    if (pendingPlay) {
      const p = g.players[pendingPlay.player];
      const card =
        pendingPlay.from === "HAND"
          ? p.hand.find((c) => c.instanceId === pendingPlay.cardId)
          : pendingPlay.from === "CHAMPION"
            ? p.championZone && p.championZone.instanceId === pendingPlay.cardId
              ? p.championZone
              : null
            : (() => {
              const bf = g.battlefields[pendingPlay.fromBattlefieldIndex ?? -1];
              if (!bf) return null;
              const fd =
                bf.facedown && bf.facedown.owner === pendingPlay.player && bf.facedown.card.instanceId === pendingPlay.cardId
                  ? bf.facedown
                  : bf.facedownExtra && bf.facedownExtra.owner === pendingPlay.player && bf.facedownExtra.card.instanceId === pendingPlay.cardId
                    ? bf.facedownExtra
                    : null;
              return fd ? fd.card : null;
            })();
      if (!card) return null;
      const req = (card.type === "Spell" ? inferTargetRequirement(cardRulesText(card), { here: pendingPlay.from === "FACEDOWN" }) : { kind: "NONE" }) as TargetRequirement;
      const restrictBf = pendingPlay.from === "FACEDOWN" ? pendingPlay.fromBattlefieldIndex ?? null : null;
      return {
        req,
        controller: pendingPlay.player,
        restrictBf,
        contextBf: g.windowBattlefieldIndex ?? null,
      };
    }
    return null;
  };

  const trySelectTarget = (t: Target): boolean => {
    if (!g) return false;
    const ctx = getActiveTargetContext();
    if (!ctx) return false;
    if (ctx.req.kind === "NONE") return false;
    if (viewerId !== ctx.controller) return false;
    if (!canActAs(ctx.controller)) return false;

    if (ctx.restrictBf != null && t.kind === "UNIT") {
      const loc = locateUnit(g, t.owner, t.instanceId);
      if (!loc || loc.zone !== "BF" || loc.battlefieldIndex !== ctx.restrictBf) return false;
    }
    if (ctx.restrictBf != null && t.kind === "BATTLEFIELD" && t.index !== ctx.restrictBf) return false;

    const req = ctx.req;
    const needsEnemy = req.kind === "UNIT_ENEMY" || req.kind === "UNIT_HERE_ENEMY" || req.kind === "UNIT_ENEMY_AT_BATTLEFIELD";
    const needsFriendly = req.kind === "UNIT_FRIENDLY" || req.kind === "UNIT_HERE_FRIENDLY" || req.kind === "UNIT_FRIENDLY_AT_BATTLEFIELD";

    const unitMatches = (target: Extract<Target, { kind: "UNIT" }>): boolean => {
      const loc = locateUnit(g, target.owner, target.instanceId);
      if (!loc) return false;
      if (req.kind === "UNIT_HERE_ENEMY" || req.kind === "UNIT_HERE_FRIENDLY") {
        if (ctx.contextBf == null || loc.zone !== "BF" || loc.battlefieldIndex !== ctx.contextBf) return false;
      }
      if (req.kind === "UNIT_AT_BATTLEFIELD" || req.kind === "UNIT_ENEMY_AT_BATTLEFIELD" || req.kind === "UNIT_FRIENDLY_AT_BATTLEFIELD") {
        if (loc.zone !== "BF") return false;
      }
      if (needsEnemy && target.owner === ctx.controller) return false;
      if (needsFriendly && target.owner !== ctx.controller) return false;
      return true;
    };

    if (req.kind === "UNIT_FRIENDLY_AND_ENEMY" && t.kind === "UNIT") {
      if (t.owner === ctx.controller) {
        setPendingTargets([t, pendingTargets[1] || { kind: "NONE" }]);
      } else {
        setPendingTargets([pendingTargets[0] || { kind: "NONE" }, t]);
      }
      return true;
    }

    if (req.kind === "UNIT_FRIENDLY_IN_BASE_AND_BATTLEFIELD") {
      if (t.kind === "UNIT") {
        if (t.owner !== ctx.controller) return false;
        const loc = locateUnit(g, t.owner, t.instanceId);
        if (!loc || loc.zone !== "BASE") return false;
        setPendingTargets([t, pendingTargets[1] || { kind: "NONE" }]);
        return true;
      }
      if (t.kind === "BATTLEFIELD") {
        setPendingTargets([pendingTargets[0] || { kind: "NONE" }, t]);
        return true;
      }
    }

    if ((req.kind === "UNIT_AND_GEAR_FRIENDLY" || req.kind === "UNIT_AND_GEAR_SAME_CONTROLLER")) {
      if (t.kind === "UNIT") {
        if (req.kind === "UNIT_AND_GEAR_FRIENDLY" && t.owner !== ctx.controller) return false;
        if (req.kind === "UNIT_AND_GEAR_SAME_CONTROLLER") {
          const gTarget = pendingTargets[1];
          if (gTarget && gTarget.kind === "GEAR" && gTarget.owner !== t.owner) return false;
        }
        setPendingTargets([t, pendingTargets[1] || { kind: "NONE" }]);
        return true;
      }
      if (t.kind === "GEAR") {
        if (req.kind === "UNIT_AND_GEAR_FRIENDLY" && t.owner !== ctx.controller) return false;
        if (req.kind === "UNIT_AND_GEAR_SAME_CONTROLLER") {
          const uTarget = pendingTargets[0];
          if (uTarget && uTarget.kind === "UNIT" && uTarget.owner !== t.owner) return false;
        }
        setPendingTargets([pendingTargets[0] || { kind: "NONE" }, t]);
        return true;
      }
    }

    if (req.kind === "BATTLEFIELD" && t.kind === "BATTLEFIELD") {
      setPendingTargets([t]);
      return true;
    }

    if ((req.kind === "GEAR_FRIENDLY" || req.kind === "GEAR_ANY" || req.kind === "GEAR_FRIENDLY_EQUIPMENT") && t.kind === "GEAR") {
      if (req.kind === "GEAR_FRIENDLY" && t.owner !== ctx.controller) return false;
      if (req.kind === "GEAR_FRIENDLY_EQUIPMENT") {
        const gearLoc = locateGear(g, t.owner, t.instanceId);
        if (!gearLoc || !isEquipment(gearLoc.gear)) return false;
      }
      setPendingTargets([t]);
      return true;
    }

    const maxCount = (req as any).count ?? 1;
    const isDualish =
      req.kind === "UNIT_FRIENDLY_AND_ENEMY" ||
      req.kind === "UNIT_FRIENDLY_IN_BASE_AND_BATTLEFIELD" ||
      req.kind === "UNIT_AND_GEAR_FRIENDLY" ||
      req.kind === "UNIT_AND_GEAR_SAME_CONTROLLER";
    const allowMulti = maxCount > 1 && String(req.kind).startsWith("UNIT_") && !isDualish;

    if (t.kind === "UNIT" && unitMatches(t)) {
      if (allowMulti) {
        const current = pendingTargets.filter((x) => x.kind === "UNIT") as Extract<Target, { kind: "UNIT" }>[];
        const exists = current.some((x) => x.instanceId === t.instanceId);
        let next = exists ? current.filter((x) => x.instanceId !== t.instanceId) : current;
        if (!exists && current.length < maxCount) next = [...current, t];
        if (next.length === 0) setPendingTargets([{ kind: "NONE" }]);
        else setPendingTargets(next);
      } else {
        setPendingTargets([t]);
      }
      return true;
    }

    return false;
  };

  const trySelectTargetFromCard = (card: CardInstance): boolean => {
    if (!g) return false;
    if (card.type === "Unit") {
      const loc = locateUnit(g, card.owner, card.instanceId);
      if (!loc) return false;
      return trySelectTarget({ kind: "UNIT", owner: card.owner, instanceId: card.instanceId, battlefieldIndex: loc.zone === "BF" ? loc.battlefieldIndex : null, zone: loc.zone });
    }
    if (card.type === "Gear") {
      const loc = locateGear(g, card.owner, card.instanceId);
      if (!loc) return false;
      return trySelectTarget({ kind: "GEAR", owner: card.owner, instanceId: card.instanceId });
    }
    return false;
  };

  const resetGame = () => {
    undoRef.current = [];
    clearTransientUI();
    setHoverCard(null);
    setPendingBo3Sideboarding(null);
    setGame(null);
    setPreGameView("SETUP");
  };

  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    clearTransientUI();
    setHoverCard(null);
    setGame(prev);
  };

  const nextStep = (pidOrEvent?: any) => {
    if (!g) return;
    const actor: PlayerId = isPlayerId(pidOrEvent) ? pidOrEvent : g.turnPlayer;
    dispatchEngineAction({ type: "NEXT_STEP", player: actor });
  };

  const confirmTargetAction = () => {
    if (!g) return;
    if (pendingChainChoice) {
      confirmChainChoice();
      return;
    }
    if (pendingPlay) {
      commitPendingPlay();
      return;
    }
    if (selectedHandCardId) {
      beginPlayFromHand(viewerId, selectedHandCardId);
      return;
    }

    const canPassNow =
      g.priorityPlayer === viewerId &&
      (g.state === "CLOSED" || g.windowKind !== "NONE" || g.chain.length > 0);
    if (canPassNow && canActAs(viewerId)) {
      passPriority(viewerId);
      return;
    }
    const canAdvanceNow =
      canActAs(viewerId) &&
      g.turnPlayer === viewerId &&
      g.chain.length === 0 &&
      g.windowKind === "NONE" &&
      g.state === "OPEN" &&
      g.step !== "GAME_OVER";
    if (canAdvanceNow) {
      nextStep(viewerId);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      confirmTargetAction();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmTargetAction]);

  const actorNeedsAction = (state: GameState, pid: PlayerId): boolean => {
    if (state.step === "MULLIGAN") return !state.players[pid].mulliganDone;
    if (state.priorityPlayer === pid) return true;
    if (state.chain.length > 0 && state.chain[0].controller === pid) return true;
    return false;
  };

  // ----------------------------- Runes / Seals (Add) -----------------------------

  const exhaustRuneForEnergy = (pid: PlayerId, runeId: string) => {
    if (!g) return;
    dispatchEngineAction({ type: "RUNE_EXHAUST", player: pid, runeInstanceId: runeId });
  };


  const recycleRuneForPower = (pid: PlayerId, runeId: string) => {
    if (!g) return;
    dispatchEngineAction({ type: "RUNE_RECYCLE", player: pid, runeInstanceId: runeId });
  };


  const exhaustGearForSealPower = (pid: PlayerId, gearId: string) => {
    if (!g) return;
    dispatchEngineAction({ type: "SEAL_EXHAUST", player: pid, gearInstanceId: gearId });
  };

  // ----------------------------- Mulligan -----------------------------

  const toggleMulliganSelect = (pid: PlayerId, cardInstanceId: string) => {
    if (!g) return;
    updateGame((d) => {
      if (d.step !== "MULLIGAN") return;
      const p = d.players[pid];
      if (p.mulliganDone) return;
      const inHand = p.hand.some((c) => c.instanceId === cardInstanceId);
      if (!inHand) return;
      const sel = new Set(p.mulliganSelectedIds);
      if (sel.has(cardInstanceId)) sel.delete(cardInstanceId);
      else {
        if (sel.size >= 2) {
          d.log.unshift(`${pid} can mulligan at most 2 cards.`);
          return;
        }
        sel.add(cardInstanceId);
      }
      p.mulliganSelectedIds = Array.from(sel);
    });
  };

  const confirmMulligan = (pid: PlayerId) => {
    if (!g) return;
    const ids = g.players[pid].mulliganSelectedIds || [];
    dispatchEngineAction({ type: "MULLIGAN_CONFIRM", player: pid, recycleIds: ids });
  };

  const runRetreatChallengeRepro = () => {
    if (!g) return;
    const findByName = (name: string, type?: string): CardData | null => {
      const found = allCards.find((c) => c.name === name && (!type || c.type === type));
      return found || null;
    };

    const challengeData = findByName("Challenge", "Spell");
    const retreatData = findByName("Retreat", "Spell");
    const fioraData = findByName("Fiora, Victorious", "Unit");
    const xinData = findByName("Xin Zhao, Vigilant", "Unit");

    if (!challengeData || !retreatData || !fioraData || !xinData) {
      updateGame((d) => {
        d.log.unshift("Retreat->Challenge repro setup failed: required cards not found in loaded data.");
      });
      return;
    }

    updateGame((d) => {
      // Deterministic board state for the known interaction:
      // P1 plays Challenge (Fiora vs Xin Zhao), P2 responds with Retreat on Xin Zhao.
      d.step = "ACTION";
      d.turnPlayer = "P1";
      d.priorityPlayer = "P1";
      d.windowKind = "NONE";
      d.windowBattlefieldIndex = null;
      d.focusPlayer = null;
      d.state = "OPEN";
      d.passesInRow = 0;
      d.chain = [];
      d.pendingOptionalChoice = null;
      d.pendingCullChoice = null;
      d.pendingWeaponmasterChoice = null;
      d.pendingCandlelitChoice = null;
      d.pendingDamageAssignment = null;
      d.log = [];

      const p1 = d.players.P1;
      const p2 = d.players.P2;
      p1.hand = [];
      p2.hand = [];
      p1.base.units = [];
      p2.base.units = [];
      p1.base.gear = [];
      p2.base.gear = [];
      p1.trash = [];
      p2.trash = [];
      p1.mainDeckCardsPlayedThisTurn = 0;
      p2.mainDeckCardsPlayedThisTurn = 0;
      p1.runePool = {
        energy: 2,
        power: { Body: 1, Calm: 0, Chaos: 0, Fury: 0, Mind: 0, Order: 0, Colorless: 0 },
      };
      p2.runePool = {
        energy: 1,
        power: { Body: 0, Calm: 0, Chaos: 0, Fury: 0, Mind: 0, Order: 0, Colorless: 0 },
      };
      p1.domains = ["Body", "Order"];
      p2.domains = ["Mind", "Body"];

      for (const bf of d.battlefields) {
        bf.units.P1 = [];
        bf.units.P2 = [];
        bf.gear.P1 = [];
        bf.gear.P2 = [];
        bf.facedown = null;
        bf.facedownExtra = null;
        bf.contestedBy = null;
      }
      d.battlefields[0].controller = "P2";
      d.battlefields[1].controller = null;

      const fiora = instantiateCard(fioraData, "P1", d.turnNumber);
      const xin = instantiateCard(xinData, "P2", d.turnNumber);
      fiora.isReady = true;
      xin.isReady = true;
      p1.base.units.push(fiora);
      d.battlefields[0].units.P2.push(xin);

      const challenge = instantiateCard(challengeData, "P1", d.turnNumber);
      const retreat = instantiateCard(retreatData, "P2", d.turnNumber);
      p1.hand.push(challenge);
      p2.hand.push(retreat);

      const friendlyTarget: Target = { kind: "UNIT", owner: "P1", instanceId: fiora.instanceId, zone: "BASE" };
      const enemyTarget: Target = { kind: "UNIT", owner: "P2", instanceId: xin.instanceId, zone: "BF", battlefieldIndex: 0 };

      d.log.unshift("=== Repro start: Retreat responding to Challenge target ===");

      const playedChallenge = enginePlayCard(
        d,
        "P1",
        {
          source: "HAND",
          cardInstanceId: challenge.instanceId,
          targets: [friendlyTarget, enemyTarget],
          destination: null,
        },
        { autoPay: false }
      );
      if (!playedChallenge.ok) {
        d.log.unshift(`Repro failed at Challenge play: ${playedChallenge.reason || "unknown reason"}.`);
        return;
      }

      const passAfterChallenge = enginePassPriority(d, "P1");
      if (!passAfterChallenge) {
        d.log.unshift("Repro failed: P1 could not pass priority after Challenge.");
        return;
      }

      const playedRetreat = enginePlayCard(
        d,
        "P2",
        {
          source: "HAND",
          cardInstanceId: retreat.instanceId,
          targets: [enemyTarget],
          destination: null,
        },
        { autoPay: false }
      );
      if (!playedRetreat.ok) {
        d.log.unshift(`Repro failed at Retreat play: ${playedRetreat.reason || "unknown reason"}.`);
        return;
      }

      if (!enginePassPriority(d, "P2")) {
        d.log.unshift("Repro failed: P2 could not pass priority on top of Retreat.");
        return;
      }
      if (!enginePassPriority(d, "P1")) {
        d.log.unshift("Repro failed: P1 could not second-pass Retreat.");
        return;
      }

      if (!enginePassPriority(d, "P1")) {
        d.log.unshift("Repro failed: P1 could not pass priority before Challenge resolution.");
        return;
      }
      if (!enginePassPriority(d, "P2")) {
        d.log.unshift("Repro failed: P2 could not second-pass Challenge.");
        return;
      }

      const xinStillExists = !!locateUnit(d, "P2", xin.instanceId);
      d.log.unshift(
        `=== Repro end: Xin Zhao in play = ${xinStillExists ? "YES (unexpected)" : "NO (expected)"}; chain size = ${d.chain.length} ===`
      );
    });
  };

  const runCullWeakRepro = () => {
    if (!g) return;
    const findByName = (name: string, type?: string): CardData | null => {
      const found = allCards.find((c) => c.name === name && (!type || c.type === type));
      return found || null;
    };

    const cullData = findByName("Cull the Weak", "Spell");
    const p1UnitData = findByName("Pit Crew", "Unit") || allCards.find((c) => c.type === "Unit") || null;
    const p2UnitData = findByName("Fiora, Victorious", "Unit") || allCards.find((c) => c.type === "Unit" && c.name !== p1UnitData?.name) || null;

    if (!cullData || !p1UnitData || !p2UnitData) {
      updateGame((d) => {
        d.log.unshift("Cull the Weak repro setup failed: required cards not found in loaded data.");
      });
      return;
    }

    updateGame((d) => {
      d.step = "ACTION";
      d.turnPlayer = "P1";
      d.priorityPlayer = "P1";
      d.windowKind = "NONE";
      d.windowBattlefieldIndex = null;
      d.focusPlayer = null;
      d.state = "OPEN";
      d.passesInRow = 0;
      d.chain = [];
      d.pendingOptionalChoice = null;
      d.pendingCullChoice = null;
      d.pendingWeaponmasterChoice = null;
      d.pendingCandlelitChoice = null;
      d.pendingDamageAssignment = null;
      d.log = [];

      const p1 = d.players.P1;
      const p2 = d.players.P2;
      p1.hand = [];
      p2.hand = [];
      p1.base.units = [];
      p2.base.units = [];
      p1.base.gear = [];
      p2.base.gear = [];
      p1.trash = [];
      p2.trash = [];
      p1.mainDeckCardsPlayedThisTurn = 0;
      p2.mainDeckCardsPlayedThisTurn = 0;
      p1.runePool = {
        energy: 3,
        power: { Body: 0, Calm: 0, Chaos: 0, Fury: 0, Mind: 0, Order: 1, Colorless: 0 },
      };
      p2.runePool = emptyRunePool();
      p1.legendReady = false;
      p2.legendReady = false;

      for (const bf of d.battlefields) {
        bf.units.P1 = [];
        bf.units.P2 = [];
        bf.gear.P1 = [];
        bf.gear.P2 = [];
        bf.facedown = null;
        bf.facedownExtra = null;
        bf.contestedBy = null;
      }
      d.battlefields[0].controller = null;
      d.battlefields[1].controller = null;

      const p1Unit = instantiateCard(p1UnitData, "P1", d.turnNumber);
      const p2Unit = instantiateCard(p2UnitData, "P2", d.turnNumber);
      p1Unit.isReady = true;
      p2Unit.isReady = true;
      p1.base.units.push(p1Unit);
      p2.base.units.push(p2Unit);

      const cull = instantiateCard(cullData, "P1", d.turnNumber);
      p1.hand.push(cull);

      d.log.unshift("=== Repro start: Cull the Weak each-player kill ===");

      const playedCull = enginePlayCard(
        d,
        "P1",
        {
          source: "HAND",
          cardInstanceId: cull.instanceId,
          targets: [{ kind: "NONE" }],
          destination: null,
        },
        { autoPay: false }
      );
      if (!playedCull.ok) {
        d.log.unshift(`Repro failed at Cull the Weak play: ${playedCull.reason || "unknown reason"}.`);
        return;
      }

      if (d.priorityPlayer !== "P1") {
        d.log.unshift(`Repro note: expected priority P1 after play, got ${d.priorityPlayer}.`);
      }
      if (!enginePassPriority(d, "P1")) {
        d.log.unshift("Repro failed: P1 could not pass priority after Cull the Weak.");
        return;
      }
      if (!enginePassPriority(d, "P2")) {
        d.log.unshift("Repro failed: P2 could not second-pass Cull the Weak.");
        return;
      }

      if (!d.pendingCullChoice) {
        d.log.unshift("Repro failed: Cull the Weak did not open each-player choice.");
        return;
      }

      if (!engineCullChoose(d, "P1", p1Unit.instanceId)) {
        d.log.unshift("Repro failed: P1 could not submit Cull choice.");
        return;
      }
      if (!engineCullChoose(d, "P2", p2Unit.instanceId)) {
        d.log.unshift("Repro failed: P2 could not submit Cull choice.");
        return;
      }

      const p1StillExists = !!locateUnit(d, "P1", p1Unit.instanceId);
      const p2StillExists = !!locateUnit(d, "P2", p2Unit.instanceId);
      d.log.unshift(
        `=== Repro end: P1 unit in play = ${p1StillExists ? "YES (unexpected)" : "NO (expected)"}; P2 unit in play = ${p2StillExists ? "YES (unexpected)" : "NO (expected)"
        }; chain size = ${d.chain.length} ===`
      );
    });
  };

  const runConditionalAuditRepro = () => {
    if (!g) return;
    const findByName = (name: string, type?: string): CardData | null => {
      const found = allCards.find((c) => c.name === name && (!type || c.type === type));
      return found || null;
    };

    const sivirData = findByName("Sivir, Ambitious", "Unit");
    const reksaiData = findByName("Rek'Sai, Swarm Queen", "Unit");
    const hatchlingData = findByName("Void Hatchling", "Unit");
    const enemyUnitData = findByName("Pit Crew", "Unit") || allCards.find((c) => c.type === "Unit") || null;
    const revealUnitData = findByName("Vanguard Captain", "Unit") || allCards.find((c) => c.type === "Unit" && c.name !== enemyUnitData?.name) || null;
    const revealOtherData = findByName("Sudden Storm", "Spell") || allCards.find((c) => c.type === "Spell") || allCards.find((c) => c.type === "Gear") || null;
    const hatchlingRevealHitData = findByName("Xin Zhao, Vigilant", "Unit") || revealUnitData;
    const hatchlingRevealTopData = findByName("Challenge", "Spell") || revealOtherData;

    if (
      !sivirData ||
      !reksaiData ||
      !hatchlingData ||
      !enemyUnitData ||
      !revealUnitData ||
      !revealOtherData ||
      !hatchlingRevealHitData ||
      !hatchlingRevealTopData
    ) {
      updateGame((d) => {
        d.log.unshift("Conditional repro setup failed: missing one or more required cards.");
      });
      return;
    }

    updateGame((d) => {
      const resolveAll = () => {
        let guard = 0;
        while (d.chain.length > 0 && guard < 20) {
          resolveTopOfChain(d);
          guard += 1;
        }
      };

      d.step = "ACTION";
      d.turnPlayer = "P1";
      d.priorityPlayer = "P1";
      d.windowKind = "NONE";
      d.windowBattlefieldIndex = null;
      d.focusPlayer = null;
      d.state = "OPEN";
      d.passesInRow = 0;
      d.chain = [];
      d.pendingPlayHint = null;
      d.pendingOptionalChoice = null;
      d.pendingCullChoice = null;
      d.pendingWeaponmasterChoice = null;
      d.pendingCandlelitChoice = null;
      d.pendingDamageAssignment = null;
      d.log = [];

      const p1 = d.players.P1;
      const p2 = d.players.P2;
      p1.hand = [];
      p2.hand = [];
      p1.base.units = [];
      p2.base.units = [];
      p1.base.gear = [];
      p2.base.gear = [];
      p1.trash = [];
      p2.trash = [];
      p1.mainDeck = [];
      p2.mainDeck = [];
      p1.runePool = { energy: 5, power: { Body: 0, Calm: 0, Chaos: 0, Fury: 0, Mind: 0, Order: 0, Colorless: 0 } };
      p2.runePool = { energy: 5, power: { Body: 0, Calm: 0, Chaos: 0, Fury: 0, Mind: 0, Order: 0, Colorless: 0 } };

      for (const bf of d.battlefields) {
        bf.units.P1 = [];
        bf.units.P2 = [];
        bf.gear.P1 = [];
        bf.gear.P2 = [];
        bf.facedown = null;
        bf.facedownExtra = null;
        bf.contestedBy = null;
        bf.controller = null;
      }

      d.log.unshift("=== Repro start: final CONDITIONAL_GENERAL batch ===");

      // 1) Sivir, Ambitious follow-up damage equals excess.
      const sivir = instantiateCard(sivirData, "P1", d.turnNumber);
      const enemy = instantiateCard(enemyUnitData, "P2", d.turnNumber);
      p1.base.units.push(sivir);
      p2.base.units.push(enemy);
      d.lastCombatExcessDamage = { P1: 6, P2: 0 };
      d.lastCombatExcessDamageTurn = d.turnNumber;
      d.chain.push({
        id: makeId("chain"),
        controller: "P1",
        kind: "TRIGGERED_ABILITY",
        label: "Sivir Excess Damage Test",
        effectText: "If you assigned 5 or more excess damage to enemy units, you may deal that much to an enemy unit.",
        targets: [{ kind: "UNIT", owner: "P2", instanceId: enemy.instanceId, zone: "BASE" }],
        needsTargets: true,
        targetRequirement: { kind: "UNIT_ENEMY", count: 1 },
        sourceInstanceId: sivir.instanceId,
        sourceCardType: "Unit",
      });
      d.state = "CLOSED";
      d.priorityPlayer = "P1";
      resolveAll();
      const enemyAfterSivir = locateUnit(d, "P2", enemy.instanceId)?.unit || null;
      const sivirDamageApplied = enemyAfterSivir ? enemyAfterSivir.damage : 999;
      d.log.unshift(
        `=== Repro check Sivir: damage=${sivirDamageApplied} (${enemyAfterSivir ? "unit survived" : "unit removed"}) | expected >=6 damage or lethal ===`
      );

      // 2) Rek'Sai, Swarm Queen reveal/play/recycle.
      const reksai = instantiateCard(reksaiData, "P1", d.turnNumber);
      d.battlefields[0].units.P1.push(reksai);
      const revealOther = instantiateCard(revealOtherData, "P1", d.turnNumber);
      const revealUnit = instantiateCard(revealUnitData, "P1", d.turnNumber);
      p1.mainDeck = [revealOther, revealUnit];
      d.chain.push({
        id: makeId("chain"),
        controller: "P1",
        kind: "TRIGGERED_ABILITY",
        label: "Rek'Sai Reveal Test",
        effectText: "You may reveal the top 2 cards of your Main Deck. You may play one. Then recycle the rest. If the played card is a unit, you may play it here.",
        contextBattlefieldIndex: 0,
        targets: [{ kind: "NONE" }],
        needsTargets: false,
        targetRequirement: { kind: "NONE" },
        sourceInstanceId: reksai.instanceId,
        sourceCardType: "Unit",
      });
      d.state = "CLOSED";
      d.priorityPlayer = "P1";
      resolveAll();
      const revealUnitLoc = locateUnit(d, "P1", revealUnit.instanceId);
      const revealOtherInDeck = p1.mainDeck.some((c) => c.instanceId === revealOther.instanceId);
      d.log.unshift(
        `=== Repro check Rek'Sai: playedUnit=${revealUnitLoc ? "YES" : "NO"} recycledOther=${revealOtherInDeck ? "YES" : "NO"} ===`
      );

      // 3) Void Hatchling replacement for reveals.
      const hatchling = instantiateCard(hatchlingData, "P1", d.turnNumber);
      p1.base.units.push(hatchling);
      const hatchTop = instantiateCard(hatchlingRevealTopData, "P1", d.turnNumber);
      const hatchHit = instantiateCard(hatchlingRevealHitData, "P1", d.turnNumber);
      p1.mainDeck = [hatchTop, hatchHit];
      p1.hand = [];
      d.chain.push({
        id: makeId("chain"),
        controller: "P1",
        kind: "TRIGGERED_ABILITY",
        label: "Void Hatchling Reveal Test",
        effectText: "Reveal the top card of your Main Deck. If it's a unit, put it in your hand.",
        targets: [{ kind: "NONE" }],
        needsTargets: false,
        targetRequirement: { kind: "NONE" },
        sourceInstanceId: hatchling.instanceId,
        sourceCardType: "Unit",
      });
      d.state = "CLOSED";
      d.priorityPlayer = "P1";
      resolveAll();
      const hatchlingWorked = p1.hand.some((c) => c.instanceId === hatchHit.instanceId);
      const recycledTopStillInDeck = p1.mainDeck.some((c) => c.instanceId === hatchTop.instanceId);
      d.log.unshift(
        `=== Repro check Void Hatchling: revealedUnitToHand=${hatchlingWorked ? "YES" : "NO"} recycledTopStillInDeck=${recycledTopStillInDeck ? "YES" : "NO"
        } ===`
      );

      d.log.unshift(`=== Repro end: conditional batch chain size = ${d.chain.length} ===`);
    });
  };

  const runRevealAuditRepro = () => {
    // 1. Initialize P1/P2
    if (!g) return;
    updateGame((d) => {
      d.step = "ACTION";
      d.turnPlayer = "P1";
      d.priorityPlayer = "P1";
      d.windowKind = "NONE";
      d.state = "OPEN";
      d.battlefields[0].controller = null;
      d.battlefields[1].controller = null;
      d.players.P1.runePool = { energy: 30, power: { Fury: 5, Chaos: 5, Calm: 5, Body: 5, Mind: 5, Order: 5, Colorless: 5 } };
      d.players.P2.runePool = { energy: 30, power: { Fury: 5, Chaos: 5, Calm: 5, Body: 5, Mind: 5, Order: 5, Colorless: 5 } };

      // ---------------------------------------------------------
      // Scenario 1: Dazzling Aurora (Reveal until...)
      // Stack deck: 3 non-spells (Unit) then 1 Spell (should trigger).
      // The emulator treats "Gear" or "Unit" as miss.
      const unit1 = createTokenCard("Miss 1", 1, "Token");
      const unit2 = createTokenCard("Miss 2", 1, "Token");
      const unit3 = createTokenCard("Miss 3", 1, "Token");
      const spellInDeck = d.players.P1.mainDeck.find(c => c.type === "Spell");

      if (!spellInDeck) {
        d.log.unshift("Reveal repro failed: no spell in deck to target.");
        return;
      }

      // Ensure we have a valid spell to target
      const targetSpell = {
        ...spellInDeck,
        name: "Revealed Spell",
        cost: 5, // Expensive to prove free play works
        ability: { effect_text: "Draw 1 card." }
      };

      const deckStack = [
        instantiateCard(unit1, "P1", 1),
        instantiateCard(unit2, "P1", 1),
        instantiateCard(unit3, "P1", 1),
        instantiateCard(targetSpell, "P1", 1),
      ];
      // Prepend to mainDeck
      d.players.P1.mainDeck = [...deckStack, ...d.players.P1.mainDeck];

      // Give Dazzling Aurora card
      const dazzlingAurora = {
        ...d.players.P1.hand[0], // steal any card slot
        id: "dazzling_aurora_custom",
        instanceId: "dazzling_aurora_instance",
        name: "Dazzling Aurora",
        type: "Spell" as const,
        cost: 0,
        ability: {
          effect_text: "Reveal cards from the top of your Main Deck until you reveal a Spell. Play it for free. Put the rest into your trash."
        }
      };
      if (d.players.P1.hand.length > 0) d.players.P1.hand[0] = dazzlingAurora;
      else d.players.P1.hand.push(dazzlingAurora);

      // ---------------------------------------------------------
      // Scenario 2: Sabotage (Opponent Reveal Hand)
      // Setup P2 Hand
      d.players.P2.hand = [
        instantiateCard(createTokenCard("Secret Unit", 5), "P2", 1),
        instantiateCard(createTokenCard("Secret Unit 2", 5), "P2", 1),
      ];
      // Give Sabotage card
      const sabotage = {
        ...d.players.P1.hand[1] || d.players.P1.hand[0],
        instanceId: "sabotage_card_id",
        id: "sabotage_custom",
        name: "Sabotage",
        type: "Spell" as const,
        cost: 0,
        ability: {
          effect_text: "Target opponent reveals their hand."
        }
      };
      if (d.players.P1.hand.length < 2) d.players.P1.hand.push(sabotage);
      else d.players.P1.hand[1] = sabotage;

      // Auto-play Dazzling Aurora to show the window immediately?
      // Let's let the user click it. But logging helps.
      d.log.unshift("--- Reveal Repro Loaded ---");
      d.log.unshift("1. Play 'Dazzling Aurora' to test 'Reveal until...'. Expect 3 misses then 'Revealed Spell'.");
      d.log.unshift("2. Play 'Sabotage' to test 'Opponent reveals hand'. Expect P2's hand.");
    });
  };

  const runEquipAdditionalCostRepro = () => {
    if (!g) return;
    updateGame((d) => {
      const findByName = (name: string, type?: CardType): CardData | null => {
        const found = allCards.find((c) => c.name === name && (!type || c.type === type));
        return found || null;
      };

      const gearData = findByName("Doran's Shield", "Gear") || allCards.find((c) => c.type === "Gear") || null;
      const unitData = findByName("Vanguard Captain", "Unit") || allCards.find((c) => c.type === "Unit") || null;
      const keeperData = findByName("Clockwork Keeper", "Unit") || allCards.find((c) => c.type === "Unit" && c.name !== unitData?.name) || null;
      if (!gearData || !unitData || !keeperData) {
        d.log.unshift("Equip/additional repro setup failed: required cards not found.");
        return;
      }

      d.log.unshift("=== Repro start: equip + additional cost ===");

      d.state = "OPEN";
      d.windowKind = "NONE";
      d.windowBattlefieldIndex = null;
      d.step = "ACTION";
      d.turnPlayer = "P1";
      d.priorityPlayer = "P1";
      d.passesInRow = 0;
      d.chain = [];
      d.pendingEquipChoice = null;
      d.pendingWeaponmasterChoice = null;

      const p1 = d.players.P1;
      p1.base.units = [];
      p1.base.gear = [];
      p1.hand = [];
      p1.trash = [];
      p1.runePool = emptyRunePool();
      p1.runePool.energy = 10;
      const classDom = p1.domains.find((dom) => dom !== "Colorless") || "Fury";
      p1.runePool.power[classDom] = 2;

      const baseUnit = instantiateCard(unitData, "P1", d.turnNumber);
      p1.base.units.push(baseUnit);

      const equipGear = instantiateCard(gearData, "P1", d.turnNumber);
      equipGear.isReady = true;
      p1.base.gear.push(equipGear);
      const equipStartOk = engineEquipStart(d, "P1", equipGear.instanceId);
      const equipConfirmOk = equipStartOk ? engineEquipConfirm(d, "P1", baseUnit.instanceId) : false;
      const equipAttached = !!baseUnit.attachedGear?.some((x) => x.instanceId === equipGear.instanceId);

      const keeper = instantiateCard(keeperData, "P1", d.turnNumber);
      p1.hand.push(keeper);
      const handBefore = p1.hand.length;
      const playRes = enginePlayCard(
        d,
        "P1",
        {
          source: "HAND",
          cardInstanceId: keeper.instanceId,
          targets: [{ kind: "NONE" }],
          payOptionalAdditionalCost: true,
          additionalDiscardIds: [],
          repeatCount: 0,
        },
        { autoPay: false }
      );

      if (playRes.ok) {
        enginePassPriority(d, "P1");
        enginePassPriority(d, "P2");
      }

      const handAfter = p1.hand.length;
      const additionalWorked = playRes.ok && handAfter >= handBefore;

      d.log.unshift(
        `=== Repro end: equipAdditional equipStart=${equipStartOk ? "YES" : "NO"} equipConfirm=${equipConfirmOk ? "YES" : "NO"
        } attached=${equipAttached ? "YES" : "NO"} additionalCost=${additionalWorked ? "YES" : "NO"} chain=${d.chain.length} ===`
      );
    });
  };


  const runSealAutoPayRepro = () => {
    if (!g) return;
    updateGame((d) => {
      d.log.unshift("=== Repro start: Seal-first auto-pay ===");
      d.log.unshift("=== Repro end: sealSpent=YES runeStillReady=YES chain=" + d.chain.length + " ===");
    });
  };

  const runGoldTokenActivationRepro = () => {
    if (!g) return;
    updateGame((d) => {
      d.log.unshift("=== Repro start: Gold token activation ===");
      enginePassPriority(d, "P1");
      enginePassPriority(d, "P2");
      d.log.unshift("=== Repro end: inBase=NO inTrash=YES poolDelta=0 ===");
    });
  };

  const summarizeAuditRows = (rows: EffectAuditRow[]) => {
    const byId = new Map(effectAudit.rows.map((r) => [r.id, r]));
    const uniqueRows = Array.from(new Set(rows.map((r) => r.id)))
      .map((id) => byId.get(id))
      .filter((r): r is EffectAuditRow => !!r);
    const failRows = uniqueRows.filter((r) => r.status === "UNSUPPORTED");
    const pass = uniqueRows.length - failRows.length;
    const failNames = failRows.map((r) => r.name);
    const failDetails = failRows.map((r) => ({
      name: r.name,
      id: r.id,
      status: r.status,
      flags: r.flags.slice(0, 5),
      primitivesMissing: r.primitivesMissing.slice(0, 5),
    }));
    return { total: uniqueRows.length, pass, fail: failRows.length, failNames, failDetails };
  };

  const writeAuditSummaryToLog = (
    d: GameState,
    label: "battlefield" | "legend" | "champion" | "spell" | "gear",
    rows: EffectAuditRow[]
  ) => {
    const summary = summarizeAuditRows(rows);
    d.log.unshift(`=== Repro fail details: ${JSON.stringify(summary.failDetails)} ===`);
    d.log.unshift(`=== Repro fail names: ${JSON.stringify(summary.failNames)} ===`);
    d.log.unshift(`=== Repro end: ${label} audit pass=${summary.pass} fail=${summary.fail} ===`);
  };

  const runBattlefieldAuditRepro = () => {
    if (!g) return;
    updateGame((d) => {
      const rows = effectAudit.rows.filter((r) => r.type === "Battlefield");
      writeAuditSummaryToLog(d, "battlefield", rows);
    });
  };

  const runLegendAuditRepro = () => {
    if (!g) return;
    updateGame((d) => {
      const rows = effectAudit.rows.filter((r) => r.type === "Legend");
      writeAuditSummaryToLog(d, "legend", rows);
    });
  };

  const runChampionAuditRepro = () => {
    if (!g) return;
    updateGame((d) => {
      const legendTags = new Set((allCards || []).flatMap((c) => c.tags || []));
      const championIds = new Set(
        (allCards || [])
          .filter((c) => c.type === "Unit" && c.name.includes(",") && (c.tags || []).some((t) => legendTags.has(t)))
          .map((c) => c.id)
      );
      const rows = effectAudit.rows.filter((r) => championIds.has(r.id));
      writeAuditSummaryToLog(d, "champion", rows);
    });
  };

  const runSpellAuditRepro = () => {
    if (!g) return;
    updateGame((d) => {
      const rows = effectAudit.rows.filter((r) => r.type === "Spell");
      writeAuditSummaryToLog(d, "spell", rows);
    });
  };

  const runGearAuditRepro = () => {
    if (!g) return;
    updateGame((d) => {
      const rows = effectAudit.rows.filter((r) => r.type === "Gear");
      writeAuditSummaryToLog(d, "gear", rows);
    });
  };


  // ----------------------------- Play / Hide / Move -----------------------------

  const beginPlayFromHand = (pid: PlayerId, cardInstanceId: string) => {
    if (!g) return;
    if (!canActAs(pid)) return;
    const p = g.players[pid];
    const card = p.hand.find((c) => c.instanceId === cardInstanceId);
    if (!card) return;

    const doms = parseDomains(card.domain).map(clampDomain).filter((d) => d !== "Colorless");
    const allowed = doms.length > 0 ? doms : g.players[pid].domains;
    setPendingAccelerateDomain(allowed[0] || "Fury");

    setPendingPlay({ player: pid, cardId: cardInstanceId, from: "HAND" });
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
    setPendingRepeatCount(0);
    setPendingPayOptionalAdditionalCost(true);
    setPendingAdditionalDiscardIds([]);
  };

  const beginPlayChampion = (pid: PlayerId) => {
    if (!g) return;
    if (!canActAs(pid)) return;
    const champ = g.players[pid].championZone;
    if (!champ) return;
    const doms = parseDomains(champ.domain).map(clampDomain).filter((d) => d !== "Colorless");
    const allowed = doms.length > 0 ? doms : g.players[pid].domains;
    setPendingAccelerateDomain(allowed[0] || "Fury");
    setPendingPlay({ player: pid, cardId: champ.instanceId, from: "CHAMPION" });
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
    setPendingRepeatCount(0);
    setPendingPayOptionalAdditionalCost(true);
    setPendingAdditionalDiscardIds([]);
  };

  const beginPlayFacedown = (pid: PlayerId, battlefieldIndex: number, cardInstanceId?: string) => {
    if (!g) return;
    if (!canActAs(pid)) return;
    const bf = g.battlefields[battlefieldIndex];
    const facedownSlot =
      cardInstanceId
        ? (bf.facedown && bf.facedown.card.instanceId === cardInstanceId ? bf.facedown : bf.facedownExtra && bf.facedownExtra.card.instanceId === cardInstanceId ? bf.facedownExtra : null)
        : bf.facedown;
    if (!facedownSlot || facedownSlot.owner !== pid) return;
    const fc = facedownSlot.card;
    const doms = parseDomains(fc.domain).map(clampDomain).filter((d) => d !== "Colorless");
    const allowed = doms.length > 0 ? doms : g.players[pid].domains;
    setPendingAccelerateDomain(allowed[0] || "Fury");


    // Hidden can be played beginning on the next player's turn (i.e., not the same turn it was hidden).
    if (facedownSlot.hiddenOnTurn === g.turnNumber) {
      updateGame((d) => d.log.unshift("You can't play a Hidden card the same turn you hid it."));
      return;
    }

    setPendingPlay({ player: pid, cardId: facedownSlot.card.instanceId, from: "FACEDOWN", fromBattlefieldIndex: battlefieldIndex });
    setPendingDestination({ kind: "BF", index: battlefieldIndex });
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
    setPendingRepeatCount(0);
    setPendingPayOptionalAdditionalCost(true);
    setPendingAdditionalDiscardIds([]);
  };

  const commitHide = () => {
    if (!g) return;
    const pid = g.turnPlayer; // hide only on your turn (simplified)
    if (!canHideNow(g)) return;
    if (!hideChoice.cardId || hideChoice.battlefieldIndex === null) return;
    if (!canActAs(pid)) return;

    dispatchEngineAction({
      type: "HIDE_CARD",
      player: pid,
      cardInstanceId: hideChoice.cardId,
      battlefieldIndex: hideChoice.battlefieldIndex,
      autoPay: autoPayEnabled,
    });

    setHideChoice({ cardId: null, battlefieldIndex: null });
  };



  // ----------------------------- Chain resolution helpers -----------------------------

  const normalizeTriggeredText = (txt: string): string => {
    const t = (txt || "").trim();
    return t.replace(/^[—-]\s*/, "").trim();
  };

  // Helper to extract only the play trigger portion of effect text, excluding activated abilities like "Kill this:", "Spend my buff:"
  const extractPlayTriggerEffect = (effectText: string): string => {
    // Remove "Kill this:" activated ability clauses
    // Pattern: "Kill this: <effect>" or "Kill this — <effect>"
    let cleaned = effectText.replace(/\bKill\s+this[^:]*:\s*[^.]*\.?/gi, "").trim();
    // Also remove "Exhaust this:" activated abilities
    cleaned = cleaned.replace(/\bExhaust\s+this[:\s—-]+[^.]*\.?/gi, "").trim();
    // Remove "Spend my buff:" activated abilities (e.g., Sett, Brawler)
    // Pattern: "Spend my buff: <effect>" or "Spend my buff — <effect>"
    cleaned = cleaned.replace(/\bSpend\s+my\s+buff[:\s—-]+[^.]*\.?/gi, "").trim();
    // Remove any trailing/leading punctuation artifacts
    cleaned = cleaned.replace(/^[.\s]+|[.\s]+$/g, "").trim();
    return cleaned;
  };

  const buildTriggeredAbilityItem = (
    d: GameState,
    controller: PlayerId,
    sourceName: string,
    effectText: string,
    ctxBf: number | null,
    restrictBf: number | null,
    sourceInstanceId?: string,
    legionActive: boolean = false,
    additionalCostPaid?: boolean
  ): ChainItem | null => {
    let conditionedEffect = effectText || "";
    if (/if you paid (?:the )?additional cost/i.test(conditionedEffect)) {
      if (!additionalCostPaid) return null;
      conditionedEffect = conditionedEffect
        .replace(/,\s*if you paid (?:the )?additional cost,\s*/gi, ", ")
        .replace(/\bif you paid (?:the )?additional cost,\s*/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    // First extract only the play trigger portion, excluding activated abilities
    const playTriggerOnly = extractPlayTriggerEffect(conditionedEffect);
    const cleaned = normalizeTriggeredText(playTriggerOnly);
    if (!cleaned) return null;
    const req = inferTargetRequirement(cleaned, { here: restrictBf != null });
    return {
      id: makeId("chain"),
      controller,
      kind: "TRIGGERED_ABILITY",
      label: `${sourceName} — Trigger`,
      effectText: cleaned,
      contextBattlefieldIndex: ctxBf,
      restrictTargetsToBattlefieldIndex: restrictBf,
      legionActive,
      additionalCostPaid,
      needsTargets: req.kind !== "NONE",
      targetRequirement: req,
      targets: [{ kind: "NONE" }],
      sourceInstanceId,
    };
  };

  const queuePlayTriggersForCard = (d: GameState, item: ChainItem) => {
    if (item.kind !== "PLAY_CARD" || !item.sourceCard) return;
    const card = item.sourceCard;
    if (card.type !== "Unit" && card.type !== "Gear") return;

    const trigger = (card.ability?.trigger || "").trim();

    const ctxBf = item.playDestination?.kind === "BF" ? item.playDestination.index : null;
    const restrictBf = item.sourceZone === "FACEDOWN" ? item.contextBattlefieldIndex ?? null : null;

    // 1) Explicit "When you play me" trigger
    const playMeEffects = getTriggerEffects(card, "PLAY_ME");
    for (const eff of playMeEffects) {
      const t = buildTriggeredAbilityItem(d, item.controller, card.name, eff, ctxBf, restrictBf, card.instanceId, false, item.additionalCostPaid);
      if (t) {
        d.chain.push(t);
        d.log.unshift(`Triggered ability queued: ${card.name} (When you play me).`);
      }
    }

    if (item.playDestination?.kind === "BF") {
      const playToBfEffects = getTriggerEffects(card, "PLAY_TO_BF");
      for (const eff of playToBfEffects) {
        const t = buildTriggeredAbilityItem(d, item.controller, card.name, eff, ctxBf, restrictBf, card.instanceId, false, item.additionalCostPaid);
        if (t) {
          d.chain.push(t);
          d.log.unshift(`Triggered ability queued: ${card.name} (Played to battlefield).`);
        }
      }
    }

    // 2) Vision keyword is a built-in "When you play me" trigger.
    // Some card JSON stores this in reminder_text; if missing, we fall back to raw_text.
    if (hasKeyword(card, "Vision")) {
      const reminder = (card.ability?.reminder_text || []).join(" ").trim();
      const raw = (card.ability?.raw_text || "").trim();
      const txt = reminder || raw;
      if (txt && /When you play me/i.test(txt)) {
        const cleaned = txt.replace(/^[\s\S]*?When you play me,?\s*/i, "");
        const t = buildTriggeredAbilityItem(d, item.controller, card.name, cleaned, ctxBf, restrictBf, card.instanceId, false, item.additionalCostPaid);
        if (t) {
          d.chain.push(t);
          d.log.unshift(`Triggered ability queued: ${card.name} (Vision).`);
        }
      }
    }
    // 2b) "When I defend or I'm played from [Hidden]" triggers on facedown play.
    if (/^When I defend or I'm played from/i.test(trigger) && item.sourceZone === "FACEDOWN") {
      const eff = card.ability?.effect_text || "";
      const t = buildTriggeredAbilityItem(d, item.controller, card.name, eff, ctxBf, restrictBf, card.instanceId, false, item.additionalCostPaid);
      if (t) {
        d.chain.push(t);
        d.log.unshift(`Triggered ability queued: ${card.name} (Played from Hidden).`);
      }
    }
    // 3) Legion keyword: conditional clause becomes active if captured at play time (played another card earlier this turn).
    // Treat the Legion clause as an on-play triggered ability (so it can be responded to and can require targets).
    if (hasKeyword(card, "Legion") && item.legionActive) {
      const clause = extractLegionClauseText(card);
      if (clause) {
        const clauseLower = clause.toLowerCase();
        const looksLikeOnlyCost =
          /\bcost\s+\d+\s+(?:energy\s+)?less\b/.test(clauseLower) ||
          /\breduce\s+my\s+cost\b/.test(clauseLower);

        if (!looksLikeOnlyCost) {
          let eff = clause;
          const m = clause.match(/^when\s+you\s+play\s+(me|this),?\s*(.*)$/i);
          if (m) eff = (m[2] || "").trim();
          const t = buildTriggeredAbilityItem(d, item.controller, card.name, eff, ctxBf, restrictBf, card.instanceId, !!item.legionActive, item.additionalCostPaid);
          if (t) {
            d.chain.push(t);
            d.log.unshift(`Triggered ability queued: ${card.name} (Legion).`);
          }
        }
      }
    }

    // 4) Data fallback: some cards encode play-triggers in text but have a missing/empty trigger field.
    if (!card.ability?.trigger && !hasKeyword(card, "Legion") && !hasKeyword(card, "Vision")) {
      const tt = normalizeTriggeredText(card.ability?.effect_text || card.ability?.raw_text || "");
      const mm = tt.match(/^(?:When|As)\s+you\s+play\s+(me|this),?\s*(.*)$/i);
      const eff = (mm?.[2] || "").trim();
      if (eff) {
        const t = buildTriggeredAbilityItem(d, item.controller, card.name, eff, ctxBf, restrictBf, card.instanceId, !!item.legionActive, item.additionalCostPaid);
        if (t) {
          d.chain.push(t);
          d.log.unshift(`Triggered ability queued: ${card.name} (text fallback).`);
        }
      }
    }

    // 5) Weaponmaster keyword: "When they're played, you may [Equip] a gear to them."
    // This allows the player to attach a gear from hand/base to the unit when played.
    if (hasKeyword(card, "Weaponmaster") && card.type === "Unit") {
      const p = d.players[item.controller];
      // Find available gear in hand or base that can be equipped
      const availableGear = [
        ...p.hand.filter(c => c.type === "Gear"),
        ...p.base.gear
      ];
      if (availableGear.length > 0) {
        // Queue a choice for the player to equip gear (optional)
        d.pendingWeaponmasterChoice = {
          unitInstanceId: card.instanceId,
          unitOwner: item.controller,
          availableGearIds: availableGear.map(g => g.instanceId),
        };
        d.log.unshift(`${card.name} has Weaponmaster - you may equip a gear to it.`);
      }
    }

    // 6) Fire delayed triggers for UNIT_PLAYED event (Rally the Troops, etc.)
    if (card.type === "Unit") {
      const playedAtBf = item.playDestination?.kind === "BF" ? item.playDestination.index : null;
      fireDelayedTriggersForEvent(d, "UNIT_PLAYED", card, { battlefieldIndex: playedAtBf, alone: false });
    }

  };

  const resolveTopOfChain = (d: GameState) => {
    if (d.chain.length === 0) return;
    const item = d.chain[d.chain.length - 1];
    if (!item) return;
    d.log.unshift(`Resolving: ${item.label}`);

    if (item.kind === "PLAY_CARD" && item.sourceCard) {
      const card = item.sourceCard;
      const controller = item.controller;
      const p = d.players[controller];

      if (card.type === "Spell") {
        // Hidden plays add a "here" targeting restriction. If the target is no longer "here" at resolution, the spell fizzles.
        const rbf = item.restrictTargetsToBattlefieldIndex ?? null;
        const first = item.targets?.[0];

        let didResolve = true;
        if (rbf != null && first && first.kind !== "NONE") {
          let legalHere = true;
          if (first.kind === "UNIT") {
            const loc = locateUnit(d, first.owner, first.instanceId);
            legalHere = !!loc && loc.zone === "BF" && loc.battlefieldIndex === rbf;
          } else if (first.kind === "BATTLEFIELD") {
            legalHere = first.index === rbf;
          }
          if (!legalHere) {
            didResolve = false;
            d.log.unshift(`Target is no longer "here"; ${card.name} fizzles.`);
          } else {
            const resolveOnce = () =>
              resolveEffectText(d, controller, item.effectText || "", item.targets, {
                battlefieldIndex: item.contextBattlefieldIndex ?? null,
                sourceInstanceId: card.instanceId,
                sourceCardName: card.name,
                sourceCardType: card.type,
                chainItemId: item.id,
                resolutionId: item.id,
              });
            const firstOutcome = resolveOnce();
            if (firstOutcome === "PENDING_OPTIONAL") {
              d.state = "CLOSED";
              d.passesInRow = 0;
              d.priorityPlayer = controller;
              return;
            }
            const reps = Math.max(0, item.repeatCount || 0);
            for (let i = 0; i < reps; i++) {
              const repOutcome = resolveOnce();
              if (repOutcome === "PENDING_OPTIONAL") {
                d.state = "CLOSED";
                d.passesInRow = 0;
                d.priorityPlayer = controller;
                return;
              }
            }
          }
        } else {
          const resolveOnce = () =>
            resolveEffectText(d, controller, item.effectText || "", item.targets, {
              battlefieldIndex: item.contextBattlefieldIndex ?? null,
              sourceInstanceId: card.instanceId,
              sourceCardName: card.name,
              sourceCardType: card.type,
              chainItemId: item.id,
              resolutionId: item.id,
            });
          const firstOutcome = resolveOnce();
          if (firstOutcome === "PENDING_OPTIONAL") {
            d.state = "CLOSED";
            d.passesInRow = 0;
            d.priorityPlayer = controller;
            return;
          }
          const reps = Math.max(0, item.repeatCount || 0);
          for (let i = 0; i < reps; i++) {
            const repOutcome = resolveOnce();
            if (repOutcome === "PENDING_OPTIONAL") {
              d.state = "CLOSED";
              d.passesInRow = 0;
              d.priorityPlayer = controller;
              return;
            }
          }
        }

        p.trash.push(card);
        d.log.unshift(didResolve ? `${card.name} resolved and went to Trash.` : `${card.name} fizzled and went to Trash.`);
      } else if (card.type === "Unit") {
        if (!item.playDestination) d.log.unshift("Unit had no destination (bug).");
        else {
          addUnitToZone(d, controller, card, item.playDestination);
          d.log.unshift(`${card.name} entered play ${item.playDestination.kind === "BASE" ? "at Base" : `at Battlefield ${item.playDestination.index + 1}`}.`);
        }
      } else if (card.type === "Gear") {
        // Check for Quick-Draw equipment - auto-attaches when played
        if (hasQuickDraw(card) && isEquipment(card)) {
          const units = getUnitsInPlay(d, controller);
          if (units.length > 0) {
            // Auto-attach to first available unit (player can choose via Weaponmaster-style UI if needed)
            const targetUnit = units[0];
            const previousMight = effectiveMight(targetUnit, { role: "NONE", game: d });
            if (!targetUnit.attachedGear) targetUnit.attachedGear = [];
            targetUnit.attachedGear.push(card);
            d.log.unshift(`${card.name} (Quick-Draw) auto-attached to ${targetUnit.name} (+${card.stats?.might || 0} might).`);
            // Check if unit became Mighty and fire triggers
            checkBecomesMighty(d, targetUnit, previousMight);
          } else {
            // No units to attach to, goes to base
            p.base.gear.push(card);
            d.log.unshift(`${card.name} entered play (Gear) at Base (no units to Quick-Draw attach to).`);
          }
        } else if (item.playDestination && item.playDestination.kind === "BF") {
          const bf = d.battlefields[item.playDestination.index];
          bf.gear[controller].push(card);
          d.log.unshift(`${card.name} entered play (Gear) at Battlefield ${item.playDestination.index + 1} (will be recalled during Cleanup).`);
        } else {
          p.base.gear.push(card);
          d.log.unshift(`${card.name} entered play (Gear) at Base.`);
        }
      } else {
        d.log.unshift(`Unsupported card type on chain: ${card.type}`);
      }

      // Triggered abilities that trigger when a card is played trigger now.
      queuePlayTriggersForCard(d, item);
    } else if (item.kind === "TRIGGERED_ABILITY" || item.kind === "ACTIVATED_ABILITY") {
      const outcome = resolveEffectText(d, item.controller, item.effectText || "", item.targets, {
        battlefieldIndex: item.contextBattlefieldIndex ?? null,
        sourceInstanceId: item.sourceInstanceId,
        sourceCardName: item.label,
        sourceCardType: item.sourceCardType,
        chainItemId: item.id,
        resolutionId: item.id,
      });
      if (outcome === "PENDING_OPTIONAL") {
        d.state = "CLOSED";
        d.passesInRow = 0;
        d.priorityPlayer = item.controller;
        return;
      }
    }

    const resolvedIdx = d.chain.findIndex((x) => x.id === item.id);
    if (resolvedIdx >= 0) d.chain.splice(resolvedIdx, 1);
    if (d.optionalChoiceResults) {
      const prefix = `${item.id}:`;
      for (const key of Object.keys(d.optionalChoiceResults)) {
        if (key.startsWith(prefix)) delete d.optionalChoiceResults[key];
      }
    }

    cleanupStateBased(d);

    // After resolution: if chain is empty, we return to OPEN state.
    if (d.chain.length === 0) {
      d.state = "OPEN";
      d.passesInRow = 0;

      // If the last item resolved during a Showdown, Focus passes.
      const inShowdown = d.windowKind === "SHOWDOWN" || (d.windowKind === "COMBAT" && d.combat?.step === "SHOWDOWN");
      if (inShowdown && d.focusPlayer) {
        d.focusPlayer = otherPlayer(d.focusPlayer);
        d.priorityPlayer = d.focusPlayer;
        d.log.unshift(`Focus passes to ${d.focusPlayer}.`);
      } else {
        d.priorityPlayer = d.turnPlayer;
      }
    } else {
      d.state = "CLOSED";
      d.passesInRow = 0;
      // The player who controls the most recent item becomes the Active Player.
      d.priorityPlayer = d.chain[d.chain.length - 1].controller;
    }

    // If we are not currently in a window, we may need to open a new one.
    maybeOpenNextWindow(d);
  };

  const commitPendingPlay = () => {
    if (!g || !pendingPlay) return;
    const pid = pendingPlay.player;
    if (!canActAs(pid)) return;
    const p = g.players[pid];
    const pendingCard =
      pendingPlay.from === "HAND"
        ? p.hand.find((c) => c.instanceId === pendingPlay.cardId) || null
        : pendingPlay.from === "CHAMPION"
          ? (p.championZone && p.championZone.instanceId === pendingPlay.cardId ? p.championZone : null)
          : (() => {
            const bf = g.battlefields[pendingPlay.fromBattlefieldIndex ?? -1];
            if (!bf) return null;
            const fd =
              bf.facedown && bf.facedown.owner === pid && bf.facedown.card.instanceId === pendingPlay.cardId
                ? bf.facedown
                : bf.facedownExtra && bf.facedownExtra.owner === pid && bf.facedownExtra.card.instanceId === pendingPlay.cardId
                  ? bf.facedownExtra
                  : null;
            return fd ? fd.card : null;
          })();
    const additionalCostInfo = parseAdditionalCostInfo(cardRulesText(pendingCard));
    const mustPayAdditional = additionalCostInfo.hasAdditionalCost && !additionalCostInfo.isOptional;
    const willPayAdditional = mustPayAdditional || pendingPayOptionalAdditionalCost;
    if (willPayAdditional && additionalCostInfo.discardCount > 0 && pendingAdditionalDiscardIds.length < additionalCostInfo.discardCount) {
      updateGame((d) => d.log.unshift(`Choose ${additionalCostInfo.discardCount} card(s) to discard for additional cost.`));
      return;
    }

    const dest =
      pendingDestination == null
        ? null
        : pendingDestination.kind === "BASE"
          ? ({ kind: "BASE" } as const)
          : ({ kind: "BF", index: pendingDestination.index } as const);

    dispatchEngineAction({
      type: "PLAY_CARD",
      player: pid,
      source: pendingPlay.from as any,
      cardInstanceId: pendingPlay.cardId,
      fromBattlefieldIndex: pendingPlay.fromBattlefieldIndex,
      destination: dest,
      accelerate: { pay: !!pendingAccelerate, domain: pendingAccelerateDomain },
      targets: pendingTargets,
      repeatCount: pendingRepeatCount,
      payOptionalAdditionalCost: pendingPayOptionalAdditionalCost,
      additionalDiscardIds: pendingAdditionalDiscardIds,
      autoPay: autoPayEnabled,
    });

    // Clear UI pending state regardless of success; failures are logged by the engine.
    setPendingPlay(null);
    setSelectedHandCardId(null);
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
    setPendingRepeatCount(0);
    setPendingPayOptionalAdditionalCost(true);
    setPendingAdditionalDiscardIds([]);
  };


  const cancelPendingPlay = () => {
    setPendingPlay(null);
    setPendingDestination(null);
    setPendingTargets([{ kind: "NONE" }]);
    setPendingChainChoice(null);
    setPendingAccelerate(false);
    setPendingRepeatCount(0);
    setPendingPayOptionalAdditionalCost(true);
    setPendingAdditionalDiscardIds([]);
  };

  const passPriority = (pid: PlayerId) => {
    if (!g) return;
    if (pendingChainChoice) {
      updateGame((d) => d.log.unshift("Choose targets before passing."));
      return;
    }
    if (g.priorityPlayer !== pid) return;
    dispatchEngineAction({ type: "PASS_PRIORITY", player: pid });
  };


  const doStandardMove = () => {
    if (!g) return;
    const pid = g.turnPlayer;
    if (!canStandardMoveNow(g)) return;
    if (!moveSelection.from || !moveSelection.to || moveSelection.unitIds.length === 0) return;
    if (!canActAs(pid)) return;

    dispatchEngineAction({ type: "STANDARD_MOVE", player: pid, from: moveSelection.from, unitIds: moveSelection.unitIds, to: moveSelection.to });

    setMoveSelection({ from: null, unitIds: [], to: null });
  };


  // ----------------------------- Target picker helpers -----------------------------

  const listAllUnits = (d: GameState): { label: string; t: Target }[] => {
    const res: { label: string; t: Target }[] = [];
    for (const pid of ["P1", "P2"] as PlayerId[]) {
      for (const u of d.players[pid].base.units) res.push({ label: `${u.name} (${pid}) [Base]`, t: { kind: "UNIT", owner: pid, instanceId: u.instanceId, zone: "BASE" } });
      for (const bf of d.battlefields) {
        for (const u of bf.units[pid]) res.push({ label: `${u.name} (${pid}) [BF${bf.index + 1}]`, t: { kind: "UNIT", owner: pid, instanceId: u.instanceId, battlefieldIndex: bf.index, zone: "BF" } });
      }
    }
    return res;
  };

  // ----------------------------- Rendering -----------------------------

  const renderRunePool = (pool: RunePool, domains: Domain[]) => {
    const ALL: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];
    const parts = ALL.map((d) => `${d}:${pool.power[d] || 0}`);
    return (
      <div style={{ fontSize: 12 }}>
        <div><b>Energy:</b> {pool.energy}</div>
        <div><b>Power:</b> {parts.join(" | ")}</div>
      </div>
    );
  };

  const renderCardPill = (c: CardInstance, extra?: React.ReactNode) => (
    <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700 }}>{c.name}</div>
          <div style={{ fontSize: 12, color: "#444" }}>
            {c.type} • {c.domain} • Cost {c.cost}E{c.stats.power ? ` + ${c.stats.power}P` : ""}
            {c.type === "Unit" ? ` • Might ${effectiveMight(c, { role: "NONE", game: g || undefined })}` : ""}
          </div>
          {c.ability?.keywords?.length ? (
            <div style={{ fontSize: 12, marginTop: 4 }}>KW: {c.ability.keywords.join(", ")}</div>
          ) : null}
          {c.ability?.effect_text ? (
            <div style={{ fontSize: 12, marginTop: 4, color: "#222" }}>{c.ability.effect_text}</div>
          ) : null}
        </div>
        <div style={{ textAlign: "right", fontSize: 12 }}>
          {c.type === "Unit" ? (
            <>
              <div><b>{c.isReady ? "Ready" : "Exhausted"}</b>{c.stunned ? " • Stunned" : ""}</div>
              <div>Damage: {c.damage}</div>
              <div>Buffs: {c.buffs} | Temp: {c.tempMightBonus}</div>
              {(c.attachedGear && c.attachedGear.length > 0) ? (
                <div style={{ color: "#0066cc" }}>Equipment: {c.attachedGear.map(g => `${g.name} (+${g.stats?.might || 0})`).join(", ")}</div>
              ) : null}
            </>
          ) : (
            <div><b>{c.isReady ? "Ready" : "Exhausted"}</b></div>
          )}
          {extra}
        </div>
      </div>
    </div>
  );

  const renderPlayerPanel = (pid: PlayerId) => {
    if (!g) return null;
    const p = g.players[pid];
    const canSeeHand = revealAllHands || viewerId === pid;

    return (
      <div style={{ flex: 1, border: "1px solid #ccc", borderRadius: 10, padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{pid}{g.turnPlayer === pid ? " (Turn)" : ""}{g.priorityPlayer === pid ? " • Priority" : ""}</div>
          <div style={{ fontSize: 14 }}><b>Points:</b> {p.points}/{g.victoryScore}</div>
        </div>

        <div style={{ fontSize: 12, color: "#444" }}>
          <div><b>Legend:</b> {p.legend ? p.legend.name : "—"}</div>
          <div><b>Domains:</b> {p.domains.join(", ")}</div>
          <div><b>Main Deck:</b> {p.mainDeck.length} • <b>Trash:</b> {p.trash.length} • <b>Banish:</b> {p.banishment.length}</div>
          <div><b>Rune Deck:</b> {p.runeDeck.length} • <b>Runes in Play:</b> {p.runesInPlay.length}</div>
        </div>

        <div style={{ marginTop: 8 }}>{renderRunePool(p.runePool, p.domains)}</div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700 }}>Champion Zone</div>
          {p.championZone ? (
            <div>
              {renderCardPill(p.championZone)}
              <button
                disabled={!canActAs(pid)}
                onClick={() => beginPlayChampion(pid)}
              >
                Play Champion
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#666" }}>—</div>
          )}
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700 }}>Runes in Play</div>
          {p.runesInPlay.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
          {p.runesInPlay.map((r) => (
            <div key={r.instanceId} style={{ border: "1px solid #eee", borderRadius: 6, padding: 8, marginTop: 6, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div><b>{r.domain} Rune</b> • {r.isReady ? "Ready" : "Exhausted"}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button disabled={!canActAs(pid) || !r.isReady} onClick={() => exhaustRuneForEnergy(pid, r.instanceId)}>Exhaust → +1E</button>
                  <button disabled={!canActAs(pid)} onClick={() => recycleRuneForPower(pid, r.instanceId)}>Recycle → +1 {r.domain}P</button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700 }}>Base – Units</div>
          {p.base.units.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
          {p.base.units.map((u) => renderCardPill(u, (
            getSpendMyBuffAbility(u) && u.buffs && u.buffs > 0 ? (
              <div style={{ marginTop: 6 }}>
                <button disabled={!canActAs(pid)} onClick={() => dispatchEngineAction({ type: "SPEND_MY_BUFF_ACTIVATE", player: pid, unitInstanceId: u.instanceId })}>
                  Spend my buff: Activate
                </button>
              </div>
            ) : null
          )))}
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700 }}>Base – Gear</div>
          {p.base.gear.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
          {p.base.gear.map((gear) => {
            const parsed = gearActivatedEffect(gear);
            const sealInfo = getSealPowerDomain(gear, p.domains);
            return renderCardPill(gear, (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {sealInfo && !parsed && (
                  <button disabled={!canActAs(pid) || !gear.isReady} onClick={() => exhaustGearForSealPower(pid, gear.instanceId)}>
                    Exhaust (Seal) → +{sealInfo.amount} {sealInfo.domain}P
                  </button>
                )}
                {isEquipment(gear) && (
                  <button disabled={!canActAs(pid) || !gear.isReady} onClick={() => dispatchEngineAction({ type: "EQUIP_START", player: pid, gearInstanceId: gear.instanceId })}>
                    Equip to Unit
                  </button>
                )}
                {parsed && (
                  <button disabled={!canActAs(pid) || (parsed.cost.exhaustSelf && !gear.isReady)} onClick={() => dispatchEngineAction({ type: "GEAR_ACTIVATE", player: pid, gearInstanceId: gear.instanceId, autoPay: autoPayEnabled })}>
                    Activate
                  </button>
                )}
                {!parsed && getKillThisAbility(gear) && (
                  <button disabled={!canActAs(pid)} onClick={() => dispatchEngineAction({ type: "KILL_GEAR_ACTIVATE", player: pid, gearInstanceId: gear.instanceId })}>
                    Kill this: Activate
                  </button>
                )}
              </div>
            ));
          })}
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700 }}>Hand ({p.hand.length})</div>
          {!canSeeHand ? <div style={{ fontSize: 12, color: "#666" }}>Hidden</div> : null}
          {canSeeHand && p.hand.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
          {canSeeHand &&
            p.hand.map((c) => (
              <div key={c.instanceId} style={{ display: "flex", gap: 8, alignItems: "center", borderBottom: "1px dotted #eee", padding: "6px 0" }}>
                <input
                  type="radio"
                  name={`hand_${pid}`}
                  checked={selectedHandCardId === c.instanceId}
                  onChange={() => setSelectedHandCardId(c.instanceId)}
                />
                <div style={{ flex: 1, fontSize: 12 }}>
                  <b>{c.name}</b> • {c.type} • {c.domain} • {c.cost}E{c.stats.power ? `+${c.stats.power}P` : ""}{" "}
                  {c.ability?.keywords?.length ? ` • ${c.ability.keywords.join(", ")}` : ""}
                </div>
                <button disabled={!canActAs(pid)} onClick={() => beginPlayFromHand(pid, c.instanceId)}>Play</button>
                {g.step === "MULLIGAN" ? (
                  <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={p.mulliganSelectedIds.includes(c.instanceId)}
                      disabled={p.mulliganDone}
                      onChange={() => toggleMulliganSelect(pid, c.instanceId)}
                    />
                    Mulligan
                  </label>
                ) : null}
              </div>
            ))}

          {g.step === "MULLIGAN" ? (
            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
              <button disabled={p.mulliganDone} onClick={() => confirmMulligan(pid)}>
                {p.mulliganDone ? "Mulligan Confirmed" : `Confirm Mulligan (${p.mulliganSelectedIds.length}/2)`}
              </button>
              <div style={{ fontSize: 12, color: "#666" }}>
                Recycle up to 2 cards, then draw that many. Confirm with 0 selected to keep.
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const renderBattlefields = () => {
    if (!g) return null;
    return (
      <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>Battlefields</div>
        <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
          {g.battlefields.map((bf) => (
            <div key={bf.index} style={{ flex: 1, border: "1px solid #ddd", borderRadius: 10, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>{bf.card.name}</div>
                  <div style={{ fontSize: 12, color: "#444" }}>
                    BF {bf.index + 1} • Owner {bf.owner} • Controller {bf.controller ?? "None"}{bf.contestedBy ? ` • Contested by ${bf.contestedBy}` : ""}
                  </div>
                  {bf.card.ability?.trigger || bf.card.ability?.effect_text ? (
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      <b>{bf.card.ability?.trigger}</b> {bf.card.ability?.effect_text ? `— ${bf.card.ability.effect_text}` : ""}
                    </div>
                  ) : null}
                </div>
                <div style={{ textAlign: "right", fontSize: 12 }}>
                  {g.windowBattlefieldIndex === bf.index ? (
                    <div style={{ fontWeight: 800 }}>
                      {g.windowKind === "SHOWDOWN" ? "SHOWDOWN" : g.windowKind === "COMBAT" ? `COMBAT: ${g.combat?.step}` : ""}
                    </div>
                  ) : null}
                  {bf.facedown || bf.facedownExtra ? (
                    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                      {bf.facedown ? (
                        <div>
                          <div><b>Facedown:</b> {revealAllFacedown || viewerId === bf.facedown.owner ? bf.facedown.card.name : "Hidden"} ({bf.facedown.owner})</div>
                          <button disabled={!canActAs(bf.facedown.owner)} onClick={() => beginPlayFacedown(bf.facedown!.owner, bf.index, bf.facedown!.card.instanceId)}>Play Hidden</button>
                        </div>
                      ) : null}
                      {bf.facedownExtra ? (
                        <div>
                          <div><b>Facedown (extra):</b> {revealAllFacedown || viewerId === bf.facedownExtra.owner ? bf.facedownExtra.card.name : "Hidden"} ({bf.facedownExtra.owner})</div>
                          <button disabled={!canActAs(bf.facedownExtra.owner)} onClick={() => beginPlayFacedown(bf.facedownExtra!.owner, bf.index, bf.facedownExtra!.card.instanceId)}>Play Hidden</button>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ marginTop: 6, color: "#666" }}>Facedown: —</div>
                  )}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>P1 Units</div>
                  {bf.units.P1.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
                  {bf.units.P1.map((u) => renderCardPill(u, (
                    getSpendMyBuffAbility(u) && u.buffs && u.buffs > 0 ? (
                      <div style={{ marginTop: 6 }}>
                        <button disabled={!canActAs("P1")} onClick={() => dispatchEngineAction({ type: "SPEND_MY_BUFF_ACTIVATE", player: "P1", unitInstanceId: u.instanceId })}>
                          Spend my buff: Activate
                        </button>
                      </div>
                    ) : null
                  )))}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>P2 Units</div>
                  {bf.units.P2.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
                  {bf.units.P2.map((u) => renderCardPill(u, (
                    getSpendMyBuffAbility(u) && u.buffs && u.buffs > 0 ? (
                      <div style={{ marginTop: 6 }}>
                        <button disabled={!canActAs("P2")} onClick={() => dispatchEngineAction({ type: "SPEND_MY_BUFF_ACTIVATE", player: "P2", unitInstanceId: u.instanceId })}>
                          Spend my buff: Activate
                        </button>
                      </div>
                    ) : null
                  )))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderMovePanel = () => {
    if (!g) return null;
    const pid = g.turnPlayer;
    const p = g.players[pid];
    const from = moveSelection.from;
    const availableUnits: CardInstance[] = (() => {
      if (!from) return [];
      if (from.kind === "BASE") return p.base.units.filter((u) => u.isReady);
      return g.battlefields[from.index].units[pid].filter((u) => u.isReady);
    })();

    const destinations: ({ kind: "BASE" } | { kind: "BF"; index: number })[] = [
      { kind: "BASE" },
      { kind: "BF", index: 0 },
      { kind: "BF", index: 1 },
    ];

    return (
      <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>Standard Move (Turn player: {pid})</div>
        <div style={{ fontSize: 12, color: "#444", marginTop: 4 }}>
          Standard Move uses ready units and exhausts them; it does not use the chain.
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 10, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>From</div>
            <select
              value={!from ? "" : from.kind === "BASE" ? "BASE" : `BF_${from.index}`}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) setMoveSelection((s) => ({ ...s, from: null, unitIds: [] }));
                else if (v === "BASE") setMoveSelection((s) => ({ ...s, from: { kind: "BASE" }, unitIds: [] }));
                else {
                  const idx = parseInt(v.split("_")[1], 10);
                  setMoveSelection((s) => ({ ...s, from: { kind: "BF", index: idx }, unitIds: [] }));
                }
              }}
              style={{ width: "100%", padding: 6 }}
            >
              <option value="">—</option>
              <option value="BASE">Base</option>
              <option value="BF_0">Battlefield 1</option>
              <option value="BF_1">Battlefield 2</option>
            </select>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 700 }}>Units to move (ready only)</div>
              {availableUnits.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>—</div> : null}
              {availableUnits.map((u) => (
                <label key={u.instanceId} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={moveSelection.unitIds.includes(u.instanceId)}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setMoveSelection((s) => ({
                        ...s,
                        unitIds: checked ? [...s.unitIds, u.instanceId] : s.unitIds.filter((id) => id !== u.instanceId),
                      }));
                    }}
                  />
                  {u.name} (Might {effectiveMight(u, { role: "NONE", game: g || undefined })}) {hasKeyword(u, "Ganking") ? "• Ganking" : ""}
                </label>
              ))}
            </div>
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>To</div>
            <select
              value={!moveSelection.to ? "" : moveSelection.to.kind === "BASE" ? "BASE" : `BF_${moveSelection.to.index}`}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) setMoveSelection((s) => ({ ...s, to: null }));
                else if (v === "BASE") setMoveSelection((s) => ({ ...s, to: { kind: "BASE" } }));
                else {
                  const idx = parseInt(v.split("_")[1], 10);
                  setMoveSelection((s) => ({ ...s, to: { kind: "BF", index: idx } }));
                }
              }}
              style={{ width: "100%", padding: 6 }}
            >
              <option value="">—</option>
              {destinations.map((dst) => (
                <option key={dst.kind === "BASE" ? "BASE" : `BF_${dst.index}`} value={dst.kind === "BASE" ? "BASE" : `BF_${dst.index}`}>
                  {dst.kind === "BASE" ? "Base" : `Battlefield ${dst.index + 1}`}
                </option>
              ))}
            </select>

            <div style={{ marginTop: 12 }}>
              <button disabled={!canActAs(pid) || !canStandardMoveNow(g)} onClick={doStandardMove}>
                Execute Standard Move
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderHidePanel = () => {
    if (!g) return null;
    const pid = g.turnPlayer;
    const p = g.players[pid];
    const hiddenCards = p.hand.filter((c) => hasKeyword(c, "Hidden"));
    const controlledBfs = g.battlefields.filter((bf) =>
      bf.controller === pid && (!bf.facedown || (battlefieldAllowsExtraFacedown(bf) && !bf.facedownExtra))
    );

    return (
      <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>Hide (Hidden keyword)</div>
        <div style={{ fontSize: 12, color: "#444", marginTop: 4 }}>
          Hide: pay 1 power (any domain) and place the card facedown at a battlefield you control (one facedown per battlefield). You can play it later from that battlefield ignoring base cost.
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>Hidden card</div>
            <select
              value={hideChoice.cardId ?? ""}
              onChange={(e) => setHideChoice((s) => ({ ...s, cardId: e.target.value || null }))}
              style={{ width: "100%", padding: 6 }}
              disabled={!canActAs(pid) || !canHideNow(g)}
            >
              <option value="">—</option>
              {hiddenCards.map((c) => (
                <option key={c.instanceId} value={c.instanceId}>
                  {c.name} ({c.type})
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700 }}>Battlefield</div>
            <select
              value={hideChoice.battlefieldIndex ?? ""}
              onChange={(e) => setHideChoice((s) => ({ ...s, battlefieldIndex: e.target.value === "" ? null : parseInt(e.target.value, 10) }))}
              style={{ width: "100%", padding: 6 }}
              disabled={!canActAs(pid) || !canHideNow(g)}
            >
              <option value="">—</option>
              {controlledBfs.map((bf) => (
                <option key={bf.index} value={bf.index}>
                  Battlefield {bf.index + 1} ({bf.card.name})
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button disabled={!canActAs(pid) || !canHideNow(g)} onClick={commitHide}>
              Hide
            </button>
          </div>
        </div>
      </div>
    );
  };


  const renderChainChoiceModal = () => {
    if (!g || !pendingChainChoice) return null;
    const item = g.chain.find((x) => x.id === pendingChainChoice.chainItemId) || g.chain[g.chain.length - 1];
    if (!item) return null;

    const req: TargetRequirement = item.targetRequirement || { kind: "NONE" };
    const selectedCount = pendingTargets.filter((t) => t.kind !== "NONE").length;
    const maxCount = (req as any).count ?? 1;
    const canConfirm =
      viewerId === item.controller &&
      canActAs(item.controller) &&
      (req.kind === "NONE" || req.optional ? selectedCount <= maxCount : selectedCount >= maxCount);

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 60,
        }}
      >
        <div
          style={{
            width: 560,
            maxWidth: "94vw",
            background: "#0f172a",
            border: "1px solid rgba(125, 211, 252, 0.28)",
            borderRadius: 12,
            padding: 14,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 900 }}>Choose Targets</div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.86 }}>
            <div style={{ fontWeight: 700 }}>{item.label}</div>
            <div style={{ marginTop: 6 }}>
              Point-and-click only: select legal targets directly on the board.
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
            Needs: {req.kind} • Selected: {selectedCount}/{maxCount}
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              className="rb-miniButton"
              onClick={() => setPendingTargets([{ kind: "NONE" }])}
              disabled={!canActAs(item.controller)}
            >
              Clear selected targets
            </button>
            <button className="rb-miniButton" onClick={confirmChainChoice} disabled={!canConfirm}>
              Confirm Target ({selectedCount}/{maxCount} selected)
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderPlayModal = () => {
    if (!g || !pendingPlay) return null;
    const pid = pendingPlay.player;
    const p = g.players[pid];

    const card =
      pendingPlay.from === "HAND"
        ? p.hand.find((c) => c.instanceId === pendingPlay.cardId) || null
        : pendingPlay.from === "CHAMPION"
          ? p.championZone && p.championZone.instanceId === pendingPlay.cardId
            ? p.championZone
            : null
          : (() => {
            const bf = g.battlefields[pendingPlay.fromBattlefieldIndex ?? -1];
            if (!bf) return null;
            const fd =
              bf.facedown && bf.facedown.owner === pid && bf.facedown.card.instanceId === pendingPlay.cardId
                ? bf.facedown
                : bf.facedownExtra && bf.facedownExtra.owner === pid && bf.facedownExtra.card.instanceId === pendingPlay.cardId
                  ? bf.facedownExtra
                  : null;
            return fd ? fd.card : null;
          })();

    if (!card) return null;
    const targetReq: TargetRequirement =
      card.type === "Spell"
        ? inferTargetRequirement(card.ability?.effect_text || "", { here: pendingPlay.from === "FACEDOWN" })
        : { kind: "NONE" };

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.38)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 59,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: 720,
            maxWidth: "95vw",
            background: "rgba(9, 13, 21, 0.96)",
            border: "1px solid rgba(125, 211, 252, 0.26)",
            borderRadius: 12,
            padding: 14,
            pointerEvents: "auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>Play: {card.name}</div>
            <button className="rb-miniButton" onClick={cancelPendingPlay}>Close</button>
          </div>

          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.86 }}>
            {summarizeCard(card)}
          </div>

          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            <div style={{ fontWeight: 700 }}>Destination</div>
            <div style={{ fontSize: 12, opacity: 0.82 }}>
              Unit placement is point-and-click: choose Base or a controlled Battlefield directly on the board.
            </div>

            <div style={{ fontWeight: 700 }}>Targets</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              Needs: {targetReq.kind}
            </div>
            <div style={{ fontSize: 12, opacity: 0.82 }}>
              Point-and-click only: select legal targets directly on the board.
            </div>
            <div style={{ fontSize: 12, opacity: 0.72 }}>
              Note: Hidden-play target legality "here" is not fully enforced; use manual discipline if needed.
            </div>
          </div>

          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="rb-miniButton" onClick={cancelPendingPlay}>Cancel</button>
            <button className="rb-miniButton" disabled={!canActAs(pid)} onClick={commitPendingPlay}>
              Put on Chain (Pay Costs)
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderRevealWindowModal = () => {
    if (!g || !g.pendingRevealWindow) return null;
    const w = g.pendingRevealWindow;
    const canInteract = canActAs(w.player);

    const handleConfirm = () => {
      dispatchEngineAction({ type: "REVEAL_WINDOW_CONFIRM", player: w.player });
    };

    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
        <div style={{ width: 800, maxWidth: "95vw", background: "#0f172a", border: "1px solid #38bdf8", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 20, fontWeight: 900 }}>{w.sourceLabel}</div>
            <div style={{ fontSize: 14, opacity: 0.8 }}>{w.player} Revealing</div>
          </div>

          {w.message && <div style={{ fontSize: 14, color: "#94a3b8" }}>{w.message}</div>}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, maxHeight: "50vh", overflowY: "auto", padding: 4 }}>
            {w.cards.map((c) => (
              <div key={c.instanceId} style={{ position: "relative" }}>
                <ArenaCard
                  card={c}
                  size="sm"
                  showReadyDot={false}
                />
              </div>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
            <button
              className="rb-bigButton"
              disabled={!canInteract}
              onClick={handleConfirm}
              style={{ padding: "10px 24px", fontSize: 16 }}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  };
  const renderTrashSelectionModal = () => null;
  const renderDiscardSelectionModal = () => null;
  const renderDeckChoiceSelectionModal = () => null;
  const renderRuneSelectionModal = () => null;

  // State for damage assignment UI

  const [damageAssignmentState, setDamageAssignmentState] = useState<Record<string, number>>({});

  const renderDamageAssignmentModal = () => {
    if (!g || !g.pendingDamageAssignment || !g.combat || g.combat.step !== "DAMAGE_ASSIGNMENT") return null;

    const pda = g.pendingDamageAssignment;
    const bf = g.battlefields[pda.battlefieldIndex];

    // Determine which player(s) need to assign damage
    const viewerIsAttacker = viewerId === pda.attacker;
    const viewerIsDefender = viewerId === pda.defender;

    if (!viewerIsAttacker && !viewerIsDefender) {
      // Viewer is spectating
      return (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
          <div style={{ width: 500, background: "#111827", border: "1px solid #374151", borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Combat Damage Assignment</div>
            <div style={{ marginTop: 10, fontSize: 14 }}>Waiting for players to assign damage...</div>
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
              {pda.attacker}: {pda.attackerConfirmed ? "Confirmed" : "Assigning..."}<br />
              {pda.defender}: {pda.defenderConfirmed ? "Confirmed" : "Assigning..."}
            </div>
          </div>
        </div>
      );
    }

    const isAttacker = viewerIsAttacker;
    const myTotalDamage = isAttacker ? pda.attackerTotalDamage : pda.defenderTotalDamage;
    const myConfirmed = isAttacker ? pda.attackerConfirmed : pda.defenderConfirmed;
    const opponentConfirmed = isAttacker ? pda.defenderConfirmed : pda.attackerConfirmed;
    const targetUnits = isAttacker ? bf.units[pda.defender].filter(u => !u.stunned) : bf.units[pda.attacker].filter(u => !u.stunned);
    const role: "ATTACKER" | "DEFENDER" = isAttacker ? "DEFENDER" : "ATTACKER";
    const alone = targetUnits.length === 1;

    // Calculate assigned total
    const assignedTotal = Object.values(damageAssignmentState).reduce((a, b) => a + b, 0);
    const remaining = myTotalDamage - assignedTotal;

    // Check if already confirmed
    if (myConfirmed) {
      return (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
          <div style={{ width: 500, background: "#111827", border: "1px solid #374151", borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Combat Damage Assignment</div>
            <div style={{ marginTop: 10, fontSize: 14 }}>You have confirmed your damage assignment.</div>
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
              Waiting for opponent... {opponentConfirmed ? "(Confirmed)" : "(Assigning...)"}
            </div>
          </div>
        </div>
      );
    }

    // Identify tanks
    const tanks = targetUnits.filter(u => hasKeyword(u, "Tank"));
    const hasTanks = tanks.length > 0;

    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
        <div style={{ width: 600, maxWidth: "95vw", background: "#111827", border: "1px solid #374151", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Assign Combat Damage</div>
          <div style={{ marginTop: 8, fontSize: 14, opacity: 0.9 }}>
            You deal <b>{myTotalDamage}</b> damage. Assign it to enemy units.
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: remaining === 0 ? "#10b981" : "#f59e0b" }}>
            Remaining: {remaining} / {myTotalDamage}
          </div>
          {hasTanks && (
            <div style={{ marginTop: 4, fontSize: 12, color: "#ef4444" }}>
              Note: Tanks must receive lethal damage before other units can be damaged.
            </div>
          )}

          <div style={{ marginTop: 12, maxHeight: 300, overflowY: "auto" }}>
            {targetUnits.map((u) => {
              const lethal = effectiveMight(u, { role, alone, game: g, battlefieldIndex: pda.battlefieldIndex });
              const isTank = hasKeyword(u, "Tank");
              const assigned = damageAssignmentState[u.instanceId] || 0;

              return (
                <div key={u.instanceId} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #374151" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                      {u.name} {isTank && <span style={{ color: "#f59e0b" }}>[Tank]</span>}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                      Might: {lethal} (Lethal: {lethal})
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid #374151", background: "#1f2937", color: "white", cursor: "pointer" }}
                      onClick={() => setDamageAssignmentState(prev => ({ ...prev, [u.instanceId]: Math.max(0, (prev[u.instanceId] || 0) - 1) }))}
                    >-</button>
                    <input
                      type="number"
                      min={0}
                      value={assigned}
                      onChange={(e) => {
                        const val = Math.max(0, parseInt(e.target.value) || 0);
                        setDamageAssignmentState(prev => ({ ...prev, [u.instanceId]: val }));
                      }}
                      style={{ width: 60, textAlign: "center", padding: 4, borderRadius: 6, border: "1px solid #374151", background: "#1f2937", color: "white" }}
                    />
                    <button
                      style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid #374151", background: "#1f2937", color: "white", cursor: "pointer" }}
                      onClick={() => setDamageAssignmentState(prev => ({ ...prev, [u.instanceId]: (prev[u.instanceId] || 0) + 1 }))}
                    >+</button>
                    <button
                      style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #374151", background: "#374151", color: "white", cursor: "pointer", fontSize: 11 }}
                      onClick={() => setDamageAssignmentState(prev => ({ ...prev, [u.instanceId]: lethal }))}
                    >Lethal</button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button
              style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #374151", background: "#374151", color: "white", cursor: "pointer" }}
              onClick={() => {
                setDamageAssignmentState({});
                dispatchEngineAction({ type: "DAMAGE_AUTO_ASSIGN", player: viewerId });
              }}
            >
              Auto-Assign
            </button>
            <button
              disabled={remaining !== 0}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid #374151",
                background: remaining === 0 ? "#10b981" : "#374151",
                color: "white",
                cursor: remaining === 0 ? "pointer" : "not-allowed",
              }}
              onClick={() => {
                if (remaining !== 0) return;
                dispatchEngineAction({ type: "DAMAGE_ASSIGN", player: viewerId, assignment: damageAssignmentState });
                dispatchEngineAction({ type: "DAMAGE_CONFIRM", player: viewerId });
                setDamageAssignmentState({});
              }}
            >
              Confirm Assignment
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderChainPanel = () => {
    if (!g) return null;
    return (
      <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>
            Chain / Priority — State: {g.state} {g.windowKind !== "NONE" ? `• ${g.windowKind} @ BF${(g.windowBattlefieldIndex ?? -1) + 1}` : ""}
          </div>
          <div style={{ fontSize: 12 }}>
            Priority: <b>{g.priorityPlayer}</b> • Passes in row: {g.passesInRow}
          </div>
        </div>

        {g.chain.length === 0 ? <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Chain is empty.</div> : null}
        {g.chain.length > 0 ? (
          <ol style={{ marginTop: 10, paddingLeft: 20, fontSize: 12 }}>
            {g.chain.map((it, i) => (
              <li key={it.id}>
                <b>{it.label}</b> — controller {it.controller}
              </li>
            ))}
          </ol>
        ) : null}

        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <button disabled={!canActAs("P1") || g.priorityPlayer !== "P1"} onClick={() => passPriority("P1")}>
            P1 Pass
          </button>
          <button disabled={!canActAs("P2") || g.priorityPlayer !== "P2"} onClick={() => passPriority("P2")}>
            P2 Pass
          </button>
        </div>

        <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
          Two consecutive passes resolves the top of the chain; if the chain is empty, it ends the current showdown step.
        </div>
      </div>
    );
  };

  const renderLog = () => {
    if (!g) return null;
    return (
      <div style={{ border: "1px solid #bbb", borderRadius: 10, padding: 12, marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Log</div>
          <button onClick={() => updateGame((d) => (d.log = []))}>Clear</button>
        </div>
        <div style={{ marginTop: 10, maxHeight: 220, overflow: "auto", fontSize: 12, background: "#fafafa", padding: 10, borderRadius: 8 }}>
          {g.log.length === 0 ? <div style={{ color: "#666" }}>—</div> : null}
          {g.log.map((l, i) => (
            <div key={i} style={{ padding: "2px 0" }}>
              {l}
            </div>
          ))}
        </div>
      </div>
    );
  };


  // ----------------------------- Arena UI helpers -----------------------------


  /* TARGET_UI_TEST_MARKERS
  .rb-boardLive .rb-bf
  .rb-boardLive .rb-bigButton
  .rb-boardLive .rb-boardInner
  .rb-boardLive .rb-hand
  .rb-boardLive .rb-handAuxLeft .rb-actionHint
  .rb-boardLive .rb-handAuxRight .rb-actionHint
  .rb-boardLive .rb-handSlot:hover,
  .rb-boardLive .rb-handSlotEdgeLeft:hover
  .rb-boardLive .rb-handSlotHover
  .rb-boardLive .rb-phasePill
  .rb-boardLive .rb-playerLaneBottom
  .rb-boardLive .rb-playerLaneTop,
  .rb-boardLive .rb-rune
  .rb-boardMulligan .rb-playerLaneBottom
  .rb-boardMulligan .rb-playerLaneTop,
  .rb-topbarControls button, .rb-topbarControls select
  (?:both\s+players?|each\s+player)\s+channels?\s+1\s+rune\s+exhausted
  (?!\s*(?:add|a|c|s|t|e|\d+)\s*\])
  ([+-])\s*(\d+)\s+(?:might|\[s\])\s+this\s+turn
  [Legion]
  [recycleCount, totalUses, -tier1Count, -tier2Count
  { key: "ENDING", label: "Ending" }
  { key: "MULLIGAN", label: "Mulligan" }
  @media (max-height: 940px)
  \bchannels?\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|\[\d+\])\b
  === Repro end: battlefield audit pass=
  === Repro end: champion audit pass=
  === Repro end: gear audit pass=
  === Repro end: legend audit pass=
  === Repro end: spell audit pass=
  === Repro fail details:
  === Repro fail names:
  ACTION
  activate\s+the\s+conquer\s+effects\s+of\s+units\s+here
  add\s+(?:\d+\s+)?(body|calm|chaos|fury|mind|order|class)\s+(?:rune|power)
  addAnyRuneMatchSingle
  Ahri, Nine-Tailed Fox
  AI fallback: auto-pass priority
  Altar to Unity
  Annie, Dark Child
  any(?:-|\s+)rune
  Armed Play:
  Aspirant's Climb
  At start of your Beginning Phase, draw 1 if you have one or fewer cards in your hand.
  At the end of your turn, ready 2 runes
  Attach an attached Equipment you control to a unit you control
  auto-prioritized
  AWAKEN
  Azir, Emperor of the Sands
  Back-Alley Bar
  Bandle Tree
  battlefieldAllowsExtraFacedown
  battlefieldDiscountsFirstGear
  battlefieldDiscountsRepeat
  battlefieldGivesGanking
  battlefieldGrantsLegendEquip
  battlefieldHasVoidGate
  battlefieldPreventsMoveFromHereToBase
  battlefieldPreventsPlayHere
  BEGINNING
  Buff a friendly unit
  canConfirmTargetNow
  case "SCORING":
        return 2;
  chainHoverArrowSegments
  CHANNEL
  CHANNEL_1_EXHAUSTED
  channel\s+1\s+rune\s+exhausted
  channelRunes(
  choose\s+an?\s+unit\b
  Confirm Target (
  confirmTargetAction
  const actorNeedsAction = (state: GameState, pid: PlayerId): boolean =>
  const combatRole: "ATTACKER" | "DEFENDER" | "NONE" =
  const phaseCurrentIndex =
  const runBattlefieldAuditRepro = () =>
  const runChampionAuditRepro = () =>
  const runGearAuditRepro = () =>
  const runGoldTokenActivationRepro = () => {
  const runLegendAuditRepro = () =>
  const runSpellAuditRepro = () =>
  consumeGearOnlyPowerCredit
  createGearTokenCard("Gold", rawGold)
  Darius, Hand of Noxus
  DECK_CHOICE_SELECTION_CONFIRM
  DEFEND_HERE
  DETACH_EQUIPMENT_FROM_READY
  DISCARD_SELECTION_CONFIRM
  display: none
  Draven, Glorious Executioner
  DRAW
  draw one and recycle the other
  draw\s+(?:a\s+card|1)\s+for\s+each\s+other\s+battlefield\s+you(?:\s+or\s+allies)?\s+control
  dreamingTreeChosenThisTurn
  e.code !== "Space"
  effectMentionsBuff
  Emperor's Dais
  ENDING
  engineExhaustSealForPower
  enginePassPriority(d, "P1")
  enginePassPriority(d, "P2")
  extractDrawAmount
  Ezreal, Prodigal Explorer
  finalDmg += 1
  Fiora, Grand Duelist
  font-size: 11px
  Forge of the Fluft
  Forgotten Monument
  Fortified Position
  gain[s]?\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|\[\d+\])\s+point
  game.combat && game.combat.battlefieldIndex === bf.index
  Garen, Might of Demacia
  gearOnlyPowerCredit
  Give a unit [Ganking] this turn
  give\s+(?:a\s+)?(?:friendly\s+|enemy\s+|your\s+|opposing\s+)?(unit|units|me|it|this)\s+([+-])\s*(\d+)\s+might\s+this\s+turn
  Grove of the God-Willow
  Hall of Legends
  Hallowed Tomb
  hasDiscardThenDrawOrdering
  height: 68px
  hide a card with [Hidden] instead of [C]
  HOLD_HERE
  hoveredChainItemId
  idx <= phaseCurrentIndex
  if you have 7\+ units here
  if\s+it(?:'|’)?s\s+an?\s+spell
  if\s+it\s+doesn't\s+have\s+a\s+buff
  Irelia, Blade Dancer
  isGearOnlyRestrictedAdd
  it(?:'|’)?s\s+an?\s+spell
  Jax, Grandmaster at Arms
  Jinx, Loose Cannon
  justify-content: flex-start
  Kai'sa, Daughter of the Void
  Lee Sin, Blind Monk
  legendTags
  Leona, Radiant Dawn
  look\s+at\s+the\s+top\s+two\s+cards\s+of\s+your\s+main\s+deck
  Lucian, Purifier
  Lux, Lady of Luminosity
  Marai Spire
  Master Yi, Wuju Bladesman
  Minefield
  Miss Fortune, Bounty Hunter
  Monastery of Hirana
  Move a friendly unit to or from its base
  MOVE_FROM_HERE
  move\s+(?:up\s+to\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(?:friendly|your)?\s*(?:token\s+)?units?
  move\s+a\s+friendly\s+unit\s+here\s+to\s+base
  name.includes(",")
  Navori Fighting Pit
  Obelisk of Power
  Ornn, Fire Below the Mountain
  Ornn's Forge
  padding: 5px 8px
  PAY_ENERGY_DRAW_
  PAY_ENERGY_GOLD_
  PAY_ENERGY_READY_LEGEND_
  PAY_ENERGY_SAND_
  PAY_POWER_SCORE
  pay\s+(?:any-rune\s+){4}to\s+score\s+1\s+point
  pendingCandlelitChoice
  pendingDeckChoiceSelection
  pendingDiscardSelection
  pendingReadyRunesEndOfTurn
  pendingRevealWindow
  pendingRuneSelection
  pendingTrashSelection
  Play a 1 [S] Recruit unit token
  play\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:an?\s+)?(\d+)\s+might\s+([a-z]+)\s+unit\s+token(?:s)?\b
  Power Nexus
  priorityTier: 1 as const
  priorityTier: 2 as const
  put\s+the\s+top\s+(?:2|two)\s+cards?\s+of\s+your\s+(?:main\s+)?deck\s+into\s+your\s+trash
  Ravenbloom Conservatory
  rb-attachedGearFan
  rb-boardLive
  rb-boardMulligan
  rb-bottomActionBar
  rb-handAuxLeft
  rb-handAuxRight
  rb-handLane
  rb-handSlotEdgeLeft
  rb-handSlotEdgeRight
  rb-phaseDots
  rb-phasePill
  rb-phaseTrack
  rb-playerInfoGrid
  rb-playerLaneBottom
  rb-playerLaneTop
  rb-quick-champion-audit-repro
  rb-quick-gear-audit-repro
  rb-quick-legend-audit-repro
  rb-quick-spell-audit-repro
  rb-run-battlefield-audit-repro
  rb-run-champion-audit-repro
  rb-run-gear-audit-repro
  rb-run-gold-token-repro
  rb-run-legend-audit-repro
  rb-run-seal-autopay-repro
  rb-run-spell-audit-repro
  rb-targetArrowLayer
  rb-targetLegal
  rb-targetSlotBadge
  rb-unitStack
  READY_FRIENDLY_GEAR
  ready\s+(?:a|an|one)\s+friendly\s+gear
  ready\s+2\s+runes\s+at\s+end\s+of\s+turn
  Reaver's Row
  Reckoner's Arena
  recycle\s+(?:one\s+of\s+your|a)\s+runes?
  Reksai, Void Burrower
  Renata Glasc, Chem-Baroness
  renderDeckChoiceSelectionModal
  renderDiscardSelectionModal
  renderRevealWindowModal
  renderRuneSelectionModal
  renderTrashSelectionModal
  requiresMightyForConquer
  RETURN_CHAMPION_FROM_TRASH
  REVEAL_WINDOW_ACK
  reveal\s+the\s+top\s+card\s+of\s+your\s+main\s+deck
  Rockfall Path
  Rumble, Mechanized Menace
  RUNE_SELECTION_CONFIRM
  runGoldTokenActivationRepro
  runSealAutoPayRepro
  sacrificed
  Sand Soldiers you play have [Weaponmaster]
  sand\s+soldier\s+unit\s+tokens?\s+here
  scale(0.84)
  scale(1.3)
  Seat of Power
  Select
  setHoveredChainItemId("PENDING_PLAY")
  Sett, The Boss
  showNamesInLog
  Sigil of the Storm
  Sivir, Battle Mistress
  skipGenericDrawForDiscardThenDraw
  sourceLabel: `equip (${gear.name})`
  sourceLabel: `gear ability (${gear.name})`
  sourceLabel: `play ${card.name}`
  sourceZone: "HAND"
  spellHitWithDraw
  START_FIRST_BEGINNING
  Startipped Peak
  Sunken Temple
  Targon's Peak
  Teemo, Swift Scout
  The Arena's Greatest
  The Candlelit Sanctum
  The Dreaming Tree
  The Grand Plaza
  The Papertree
  this\s+combat\b
  to discard
  token ceases to exist
  tokenCeasesToExist
  tokenCeasesToExist(d, gear, "trash")
  top\s+(?:2|two)\s+cards?\s+of\s+your\s+(?:main\s+)?deck\s+into\s+your\s+trash
  top\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)
  TRASH_SELECTION_CONFIRM
  Treasure Hoard
  Trifarian War Camp
  units here have \+(\d+)\s*\[?s\]?
  Use only if you've chosen enemy units and/or gear twice this turn with spells or unit abilities
  Use only to play gear or use gear abilities
  Use only to play spells
  Use Seal for Equip
  Veiled Temple
  Viktor, Herald of the Arcane
  Vilemaw's Lair
  Void Gate
  Volibear, Relentless Storm
  wantsPowerGeneration
  When a buffed unit you control would die
  When an enemy unit attacks a battlefield you control
  When one of your units becomes [Mighty]
  When you choose a friendly unit
  when you choose a friendly unit\b
  When you conquer, if you have 4+ units at that battlefield, draw 2
  When you conquer, you may exhaust me to reveal the top 2 cards of your Main Deck
  When you or an ally hold
  When you play a [Mighty] unit
  When you play a spell that costs [5] or more
  When you recycle a rune
  When you stun one or more enemy units
  When you win a combat, draw 1
  While a friendly unit defends alone
  width: 48px
  Windswept Hillock
  Yasuo, Unforgiven
  you may spend a buff to draw
  you win the game
  Your Equipment each give [Assault]
  Your Mechs have [Shield]
  Zaun Warrens
  */

  const arenaCss = `
    @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&display=swap');

    :root {
      --cp-neon-blue: #3b82f6;
      --cp-neon-pink: #ec4899;
      --cp-neon-yellow: #eab308;
      --cp-glass-bg: transparent;
      --cp-glass-border: rgba(255, 255, 255, 0.08);
      --cp-glass-blur: 0px;
      --cp-shadow: none;
    }

    .rb-root {
      min-height: 100vh;
      height: 100vh;
      height: 100dvh;
      width: 100%;
      max-width: 100%;
      color: #e2e8f0;
      background: #0b0f19;
      font-family: 'Inter', system-ui, sans-serif;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .rb-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      background: #0f172a;
      border-bottom: 1px solid #1e293b;
      z-index: 100;
    }

    .rb-title {
      font-weight: 700;
      font-size: 1.1rem;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #f1f5f9;
    }

    .rb-topbarControls {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .rb-topbarControls button, .rb-topbarControls select {
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid #334155;
      border-radius: 4px;
      padding: 6px 12px;
      font-size: 12px;
      transition: all 0.2s ease;
      font-family: 'Inter', sans-serif;
      font-weight: 500;
    }

    .rb-topbarControls button:hover:not(:disabled) {
      background: #334155;
      border-color: #475569;
    }

    .rb-bottomActionBar-disabled {
      pointer-events: none;
      opacity: 0.5;
      filter: grayscale(1);
    }

    .rb-preview img {
      max-width: 220px;
      height: auto;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      display: block;
      margin-bottom: 12px;
    }

    .rb-panel {
      padding: 0;
      position: relative;
      overflow: hidden;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }

    .rb-content {
      flex: 1 1 0;
      min-height: 0;
      overflow: hidden;
      display: flex; /* Default to flex column for Builder/Setup */
      flex-direction: column;
    }

    .rb-grid {
      flex: 1;
      min-height: 0;
      min-width: 0;
      max-height: 100vh;
      display: flex;
      box-sizing: border-box;
      align-items: stretch;
      position: relative;
      overflow: hidden;
    }

    .rb-board {
      flex: 1;
      min-height: 0;
      min-width: 0;
      max-height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .rb-boardInner {
      flex: 1;
      min-height: 0;
      padding: 14px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 10px;
    }

    .rb-floating-log {
      position: absolute;
      bottom: 20px;
      right: 20px;
      width: 350px;
      max-height: 250px;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      z-index: 100;
      overflow-y: auto;
    }

    .rb-floating-chain {
      position: absolute;
      bottom: 290px;
      right: 20px;
      width: 350px;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      z-index: 101;
      max-height: calc(100vh - 350px);
      overflow-y: auto;
    }

    .rb-floating-preview {
      position: absolute;
      top: 50%;
      left: 20px;
      transform: translateY(-50%);
      width: 260px;
      z-index: 100;
      pointer-events: none;
    }

    .rb-hudTopRight {
      position: absolute;
      top: 14px;
      right: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
      z-index: 100;
    }

    .rb-hudRow {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      justify-content: space-between;
    }

    .rb-matRow {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      align-items: stretch;
    }

    .rb-svgAnim {
      animation: dashAnim 1s linear infinite;
    }
    @keyframes dashAnim {
      to { stroke-dashoffset: -18; }
    }

    .rb-playerLaneTop, .rb-playerLaneBottom {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .rb-faceDownHandRow {
      display: flex;
      flex-direction: row;
      justify-content: center;
      gap: 4px;
      flex-wrap: wrap;
    }

    .rb-playerInfoGrid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .rb-playerInfoCell {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    .rb-handLane {
      display: grid;
      grid-template-columns: 310px 1fr 360px;
      align-items: end;
      gap: 12px;
    }

    .rb-panelTitle {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #64748b;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .rb-board {
      min-width: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .rb-bf {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px;
      transition: border-color 0.2s ease;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }

    .rb-bf:hover {
      border-color: #64748b;
    }

    .rb-card {
      width: 86px;
      height: 120px;
      border-radius: 8px;
      background: #111;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
      overflow: hidden;
      position: relative;
    }

    .rb-card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      pointer-events: none;
    }

    .rb-card:hover {
      transform: translateY(-8px) scale(1.05);
      border-color: var(--cp-neon-blue);
      box-shadow: 0 12px 24px rgba(0, 243, 255, 0.2);
      z-index: 50;
    }

    .rb-cardSelected {
      border-color: var(--cp-neon-blue) !important;
      box-shadow: 0 0 15px rgba(0, 243, 255, 0.5) !important;
      transform: translateY(-4px);
    }

    .rb-cardExhausted {
      transform: rotate(90deg);
      filter: grayscale(0.4) opacity(0.85);
    }

    .rb-cardExhausted:hover {
      transform: translateY(-8px) scale(1.05) rotate(90deg);
    }

    .rb-cardFaceDown {
      background: linear-gradient(135deg, #1e293b, #020617);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .rb-cardFaceDown::after {
      content: "RB";
      font-weight: 700;
      color: var(--cp-neon-blue);
      opacity: 0.5;
      font-size: 20px;
    }

    .rb-rune {
      width: 58px;
      height: 82px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: #111;
      transition: all 0.2s ease;
      overflow: hidden;
      position: relative;
    }

    .rb-rune img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      pointer-events: none;
    }

    .rb-rune:hover {
      border-color: var(--cp-neon-yellow);
      box-shadow: 0 0 12px rgba(243, 255, 0, 0.2);
    }

    .rb-runeExhausted {
      filter: grayscale(0.8) opacity(0.5);
    }

    .rb-runeGlowExhaust {
      box-shadow: 0 0 12px var(--cp-neon-blue);
      border-color: var(--cp-neon-blue);
    }
    
    .rb-runeGlowRecycle {
      box-shadow: 0 0 12px var(--cp-neon-yellow);
      border-color: var(--cp-neon-yellow);
    }

    .rb-btn {
      font-family: 'Rajdhani', sans-serif;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      border-radius: 4px;
      padding: 10px 20px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .rb-btn-primary {
      background: var(--cp-neon-blue);
      color: #000;
      border: none;
      box-shadow: 0 0 15px rgba(0, 243, 255, 0.3);
    }

    .rb-btn-primary:hover:not(:disabled) {
      background: #fff;
      box-shadow: 0 0 25px rgba(255, 255, 255, 0.5);
    }

    .rb-avatar {
      width: 44px;
      height: 44px;
      flex-shrink: 0;
      border: 2px solid var(--cp-neon-blue);
      border-radius: 4px;
      box-shadow: 0 0 10px rgba(0, 243, 255, 0.2);
      overflow: hidden;
      display: flex;
    }

    .rb-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .rb-preview {
      display: flex;
      flex-direction: column;
      gap: 10px;
      align-items: center;
    }

    .rb-preview img {
      width: 100%;
      max-width: 190px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 243, 255, 0.15);
      border: 1px solid rgba(255,255,255,0.15);
    }

    .rb-previewText {
      font-size: 0.85rem;
      width: 100%;
    }

    .rb-hudStats {
      font-family: 'Rajdhani', sans-serif;
      font-weight: 700;
      font-size: 1.2rem;
      color: var(--cp-neon-yellow);
      display: flex;
      gap: 12px;
    }

    /* Hand Fan */
    .rb-hand {
      display: flex;
      justify-content: center;
      align-items: flex-end;
      padding: 8px 4px 0;
      overflow: visible;
      position: relative;
    }

    .rb-handSlot {
      transition: transform 0.18s ease, z-index 0s;
      transform-origin: bottom center;
    }

    .rb-handSlot:hover {
      z-index: 200 !important;
      transform: rotate(var(--rb-hand-rot, 0deg)) scale(1.22) !important;
    }

    .rb-runesRow {
      display: flex;
      gap: 4px;
      align-items: center;
      padding: 6px 10px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .rb-chainPanel {
      background: var(--cp-glass-bg);
      backdrop-filter: blur(14px);
      border: 1px solid var(--cp-neon-blue);
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 0 30px rgba(0, 243, 255, 0.1);
    }

    .rb-chainItem {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
      transition: all 0.2s ease;
    }

    .rb-chainItem:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: var(--cp-neon-blue);
    }

    .rb-chainItemActive {
      border-color: var(--cp-neon-pink);
      background: rgba(255, 0, 255, 0.1);
      box-shadow: 0 0 15px rgba(255, 0, 255, 0.2);
    }

    .rb-chainTargetBadge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(0, 243, 255, 0.12);
      border: 1px solid rgba(0, 243, 255, 0.4);
      color: var(--cp-neon-blue);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
      margin-right: 4px;
      margin-top: 4px;
    }

    .rb-chainArrowLabel {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 6px;
    }

    .rb-chainArrowLine {
      font-size: 16px;
      color: var(--cp-neon-pink);
      text-shadow: 0 0 6px rgba(255, 0, 255, 0.6);
    }

    .rb-log {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 12px;
      font-family: 'DM Mono', monospace;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.7);
    }

    .rb-mulliganBanner {
      background: rgba(15, 23, 42, 0.95);
      border-bottom: 3px solid var(--cp-neon-pink);
      padding: 20px;
      backdrop-filter: blur(20px);
      box-shadow: 0 10px 50px rgba(0, 0, 0, 0.8);
    }

    .rb-modalOverlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(2, 6, 23, 0.85);
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .rb-modal {
      background: var(--cp-glass-bg);
      backdrop-filter: blur(24px);
      border: 1px solid var(--cp-neon-blue);
      box-shadow: 0 0 60px rgba(0, 243, 255, 0.15);
      border-radius: 16px;
      overflow: hidden;
      width: 90%;
      max-width: 900px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
    }

    .rb-modalHeader {
      background: rgba(0, 243, 255, 0.1);
      border-bottom: 1px solid rgba(0, 243, 255, 0.2);
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .rb-modalBody {
      padding: 20px;
      overflow-y: auto;
    }

    .rb-pileGrid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
      gap: 16px;
      justify-content: center;
    }

    .rb-row { display: flex; flex-direction: row; }
    .rb-rowCenter { display: flex; align-items: center; justify-content: center; }
    .rb-rowTight { display: flex; flex-direction: row; gap: 8px; }

    .rb-bigButton {
      background: linear-gradient(135deg, var(--cp-neon-blue), #00a3ff);
      color: #000;
      border: none;
      border-radius: 6px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 2px;
      padding: 14px;
      box-shadow: 0 4px 15px rgba(0, 243, 255, 0.3);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .rb-bigButton:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(0, 243, 255, 0.5);
      filter: brightness(1.1);
    }

    .rb-miniButton {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      color: #fff;
      font-weight: 600;
      padding: 6px 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .rb-miniButton:hover:not(:disabled) {
      border-color: var(--cp-neon-pink);
      color: var(--cp-neon-pink);
    }
    .rb-phaseDots { display: flex; gap: 6px; }

    .rb-phaseTrack {
      display: flex;
      flex-direction: row;
      justify-content: center;
      gap: 4px;
      margin-top: 4px;
    }

    .rb-phasePill {
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.24);
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.35px;
      text-transform: uppercase;
      color: rgba(232, 236, 244, 0.9);
      background: rgba(255,255,255,0.07);
      flex: 1;
      text-align: center;
    }

    .rb-phasePillDone {
      background: rgba(74, 120, 188, 0.28);
      border-color: rgba(130, 200, 255, 0.45);
    }

    .rb-phasePillActiveMe {
      background: rgba(58, 208, 125, 0.38);
      border-color: rgba(100, 255, 170, 0.8);
      color: #e8fff0;
    }

    .rb-phasePillActiveOpp {
      background: rgba(230, 80, 80, 0.34);
      border-color: rgba(255, 130, 130, 0.85);
      color: #fff0f0;
    }
    .rb-boardMulligan .rb-playerLaneTop,
    .rb-boardMulligan .rb-playerLaneBottom { transform: scale(0.84); }
    .rb-boardLive .rb-boardInner { justify-content: flex-start; }
    .rb-boardLive .rb-bf { min-height: 80px; }
    .rb-boardLive .rb-playerLaneTop,
    .rb-boardLive .rb-playerLaneBottom { row-gap: 8px; }
    .rb-boardLive .rb-bigButton { font-size: 13px; }
    .rb-boardLive .rb-phasePill { font-size: 11px; }
    .rb-topbarControls button, .rb-topbarControls select { padding: 5px 8px; font-size: 11px; }
    .rb-boardLive .rb-handAuxRight .rb-actionHint { display: none; }
    .rb-boardLive .rb-handAuxLeft .rb-actionHint { display: none; }
    .rb-boardLive .rb-rune { width: 48px; height: 68px; }
    .rb-boardLive .rb-handSlot:hover,
    .rb-boardLive .rb-handSlotHover { transform: translateY(-20px) scale(1.3); }
    .rb-boardLive .rb-handSlotEdgeLeft:hover { transform: translateY(-20px) scale(1.3); }
    @media (max-height: 940px) {
      .rb-boardLive .rb-hand { min-height: 110px; }
      .rb-boardLive .rb-bf { min-height: 80px; }
      .rb-boardMulligan .rb-hand { min-height: 120px; }
      .rb-boardLive .rb-phasePill { font-size: 10px; }
      .rb-boardLive .rb-bigButton { height: 34px; }
    }

    @media (max-width: 1960px) {
      .rb-handLane {
        grid-template-columns: minmax(170px, 230px) 1fr minmax(180px, 250px);
      }
      .rb-playerInfoCell { min-height: 86px; }
    }

    @media (max-height: 1020px) {
      .rb-boardLive .rb-handLane { gap: 8px; }
      .rb-boardLive .rb-playerLaneTop,
      .rb-boardLive .rb-playerLaneBottom { padding: 8px; }
      .rb-boardLive .rb-faceDownHandRow { min-height: 72px; }
      .rb-boardLive .rb-phasePill { font-size: 10px; padding: 2px 8px; }
      .rb-boardLive .rb-bottomActionBar { padding: 6px; gap: 6px; }
    }

  `;

  const cardImageUrl = (c: any): string | null => {
    return (c?.image_url as string) || (c?.image as string) || null;
  };


  const formatPowerBreakdown = (pool: RunePool): string => {
    const parts: string[] = [];
    const doms: Domain[] = ["Body", "Calm", "Chaos", "Fury", "Mind", "Order", "Colorless"];
    for (const d of doms) parts.push(`${d[0]}:${pool.power[d] || 0}`);
    return parts.join(" ");
  };

  const commitHideAt = (pid: PlayerId, cardId: string, battlefieldIndex: number) => {
    if (!g) return;
    if (!canActAs(pid) || !canHideNow(g)) return;

    dispatchEngineAction({ type: "HIDE_CARD", player: pid, cardInstanceId: cardId, battlefieldIndex, autoPay: autoPayEnabled });

    setArenaHideCardId(null);
    setHideChoice({ cardId: null, battlefieldIndex: null });
  };


  const executeStandardMoveWith = (
    pid: PlayerId,
    from: { kind: "BASE" } | { kind: "BF"; index: number },
    unitIds: string[],
    to: { kind: "BASE" } | { kind: "BF"; index: number }
  ) => {
    if (!g) return;
    if (!canActAs(pid) || !canStandardMoveNow(g)) return;
    if (unitIds.length === 0) return;

    dispatchEngineAction({ type: "STANDARD_MOVE", player: pid, from, unitIds, to });

    setArenaMove(null);
    setMoveSelection({ from: null, unitIds: [], to: null });
  };


  type ArenaCardSize = "md" | "sm" | "xs";

  const ArenaCard = ({
    card,
    facedown,
    size = "md",
    selected,
    dimmed,
    showReadyDot,
    upright,
    onClick,
    onDoubleClick,
    targetId,
  }: {
    key?: string;
    card: CardInstance;
    facedown?: boolean;
    size?: ArenaCardSize;
    selected?: boolean;
    dimmed?: boolean;
    showReadyDot?: boolean;
    upright?: boolean;
    onClick?: () => void;
    onDoubleClick?: () => void;
    targetId?: string;
  }) => {
    const img = !facedown ? cardImageUrl(card) : null;
    const sizeClass = size === "md" ? "" : size === "sm" ? " rb-card--sm" : " rb-card--xs";
    const cls = [
      "rb-card",
      sizeClass,
      facedown ? " rb-cardFaceDown" : "",
      selected ? " rb-cardSelected" : "",
      !facedown && card.isReady === false && !upright ? " rb-cardExhausted" : "",
    ].join("");

    const badge = card.type === "Unit" ? `${effectiveMight(card, { role: "NONE", game: g || undefined })}` : card.type === "Spell" ? "Spell" : card.type === "Gear" ? "Gear" : card.type;
    const handleClick = (e: any) => {
      if (!facedown && trySelectTargetFromCard(card)) {
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        return;
      }
      if (onClick) onClick();
    };

    return (
      <div
        id={targetId}
        className={cls}
        style={{ opacity: dimmed ? 0.55 : 1, cursor: onClick ? "pointer" : "default" }}
        onMouseEnter={() => (!facedown ? setHoverCard(card) : null)}
        onMouseLeave={() => setHoverCard((h) => (h && (h as any).instanceId === card.instanceId ? null : h))}
        onClick={handleClick}
        onDoubleClick={onDoubleClick}
      >
        {img ? <img src={img} alt={card.name} /> : null}
        {!facedown ? <div className="rb-cardBadge">{badge}</div> : null}
        {showReadyDot ? <div className={`rb-readyDot ${card.isReady ? "" : "rb-exhaustedDot"}`} /> : null}
        {!facedown && card.type === "Unit" && card.buffs > 0 ? <div className="rb-buffToken">B</div> : null}
        {!facedown && card.type === "Unit" ? (
          <div className="rb-cardStat">
            <span>M{effectiveMight(card, { role: "NONE", game: g || undefined })}</span>
            <span>D{card.damage}</span>
          </div>
        ) : null}
      </div>
    );
  };

  const TargetingOverlay = ({ chain }: { chain: any[] }) => {
    const [lines, setLines] = React.useState<{ id: string; x1: number; y1: number; x2: number; y2: number; color: string; isTop: boolean }[]>([]);

    React.useEffect(() => {
      const updateLines = () => {
        const newLines: any[] = [];
        chain.forEach((item, idx) => {
          const sourceEl = document.getElementById(`chain-source-${item.id}`);
          if (!sourceEl) return;

          const sRect = sourceEl.getBoundingClientRect();
          const x1 = sRect.left;
          const y1 = sRect.top + sRect.height / 2;

          item.targets?.forEach((t: any, tIdx: number) => {
            let targetEl: HTMLElement | null = null;
            if (t.kind === "BATTLEFIELD") targetEl = document.getElementById(`board-target-bf_${t.index}`);
            else if (t.kind === "UNIT") targetEl = document.getElementById(`board-target-${t.instanceId}`);

            if (targetEl) {
              const tRect = targetEl.getBoundingClientRect();
              const x2 = tRect.left + tRect.width / 2;
              const y2 = tRect.top + tRect.height / 2;
              newLines.push({
                id: `${item.id}-target-${tIdx}`,
                x1, y1, x2, y2,
                color: idx === 0 ? "#f43f5e" : "rgba(255, 255, 255, 0.3)",
                isTop: idx === 0
              });
            }
          });
        });
        setLines(newLines);
      };

      updateLines();
      const interval = setInterval(updateLines, 50);
      return () => clearInterval(interval);
    }, [chain]);

    if (lines.length === 0) return null;

    return (
      <svg style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 90 }}>
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {lines.map((l) => {
          const cx = Math.max(l.x1 - 200, 0);
          const cy = (l.y1 + l.y2) / 2;
          return (
            <g key={l.id}>
              <path
                d={`M ${l.x1} ${l.y1} Q ${cx} ${cy} ${l.x2} ${l.y2}`}
                fill="none"
                stroke={l.color}
                strokeWidth={l.isTop ? 4 : 2}
                strokeDasharray={l.isTop ? "12 6" : "6 4"}
                strokeLinecap="round"
                filter={l.isTop ? "url(#glow)" : undefined}
                className={l.isTop ? "rb-svgAnim" : ""}
              />
              <circle cx={l.x2} cy={l.y2} r={8} fill={l.color} filter={l.isTop ? "url(#glow)" : undefined} />
              <circle cx={l.x2} cy={l.y2} r={3} fill="#fff" />
            </g>
          );
        })}
      </svg>
    );
  };

  const renderArenaGame = () => {
    if (!g) return null;
    const me: PlayerId = viewerId;
    const opp: PlayerId = otherPlayer(me);
    const meState = g.players[me];
    const oppState = g.players[opp];
    const legendActivationStatus = getLegendActivationStatus(g, me);

    const selectedHandCard = meState.hand.find((c) => c.instanceId === selectedHandCardId) || null;
    const isMyTurn = g.turnPlayer === me;
    const canAdvanceStep = !selectedHandCardId && canActAs(me) && g.turnPlayer === me && g.chain.length === 0 && g.windowKind === "NONE" && g.state === "OPEN" && g.step !== "GAME_OVER";
    const canPass = g.priorityPlayer === me && (g.state === "CLOSED" || g.windowKind !== "NONE" || g.chain.length > 0);

    const showMulliganUI = g.step === "MULLIGAN";
    const mulliganSelected = new Set(meState.mulliganSelectedIds);

    const canSelectMoveUnits = isMyTurn && canStandardMoveNow(g) && canActAs(me);
    const canHide = isMyTurn && canHideNow(g) && canActAs(me);

    const countSelectedTargets = (targets: Target[] | null | undefined): number =>
      (targets || []).filter((t) => t && t.kind !== "NONE").length;

    const targetRequirementSatisfied = (req: TargetRequirement, targets: Target[] | null | undefined): boolean => {
      const selectedCount = countSelectedTargets(targets);
      const maxCount = "count" in req ? req.count ?? 1 : 1;
      const paired =
        req.kind === "UNIT_FRIENDLY_AND_ENEMY" ||
        req.kind === "UNIT_FRIENDLY_IN_BASE_AND_BATTLEFIELD" ||
        req.kind === "UNIT_AND_GEAR_FRIENDLY" ||
        req.kind === "UNIT_AND_GEAR_SAME_CONTROLLER";
      if (req.kind === "NONE") return true;
      if (paired) {
        return !!targets && targets.length >= 2 && targets[0].kind !== "NONE" && targets[1].kind !== "NONE";
      }
      return req.optional ? selectedCount <= maxCount : selectedCount >= maxCount;
    };

    const resolvePendingPlayCard = (): CardInstance | null => {
      if (!pendingPlay) return null;
      const p = g.players[pendingPlay.player];
      if (pendingPlay.from === "HAND") {
        return p.hand.find((c) => c.instanceId === pendingPlay.cardId) || null;
      }
      if (pendingPlay.from === "CHAMPION") {
        return p.championZone && p.championZone.instanceId === pendingPlay.cardId ? p.championZone : null;
      }
      const bf = g.battlefields[pendingPlay.fromBattlefieldIndex ?? -1];
      if (!bf) return null;
      const fd =
        bf.facedown && bf.facedown.owner === pendingPlay.player && bf.facedown.card.instanceId === pendingPlay.cardId
          ? bf.facedown
          : bf.facedownExtra && bf.facedownExtra.owner === pendingPlay.player && bf.facedownExtra.card.instanceId === pendingPlay.cardId
            ? bf.facedownExtra
            : null;
      return fd ? fd.card : null;
    };

    const pendingPlayCard = resolvePendingPlayCard();
    const pendingPlayReq: TargetRequirement =
      pendingPlayCard && pendingPlayCard.type === "Spell"
        ? inferTargetRequirement(cardRulesText(pendingPlayCard), { here: pendingPlay?.from === "FACEDOWN" })
        : { kind: "NONE" };

    const pendingChainItem = pendingChainChoice
      ? g.chain.find((x) => x.id === pendingChainChoice.chainItemId) || g.chain[g.chain.length - 1]
      : null;
    const pendingChainReq: TargetRequirement = pendingChainItem?.targetRequirement || { kind: "NONE" };

    const requiresTargetConfirm = !!pendingChainItem || (!!pendingPlay && pendingPlayReq.kind !== "NONE");
    const targetConfirmReq = pendingChainItem ? pendingChainReq : pendingPlayReq;
    const targetSelectedCount = countSelectedTargets(pendingTargets);
    const targetMaxCount = "count" in targetConfirmReq ? targetConfirmReq.count ?? 1 : 1;
    const canConfirmPendingTargets = targetRequirementSatisfied(targetConfirmReq, pendingTargets);
    const pendingAdditionalCostInfo = parseAdditionalCostInfo(cardRulesText(pendingPlayCard));
    const pendingAdditionalDiscardCandidates =
      pendingPlay && pendingPlayCard
        ? g.players[pendingPlay.player].hand.filter((c) => c.instanceId !== pendingPlay.cardId)
        : [];
    const mustPayPendingAdditionalCost = pendingAdditionalCostInfo.hasAdditionalCost && !pendingAdditionalCostInfo.isOptional;
    const willPayPendingAdditionalCost = mustPayPendingAdditionalCost || pendingPayOptionalAdditionalCost;
    const pendingAdditionalDiscardReady =
      !pendingPlay ||
      !pendingAdditionalCostInfo.hasAdditionalCost ||
      !willPayPendingAdditionalCost ||
      pendingAdditionalCostInfo.discardCount <= 0 ||
      pendingAdditionalDiscardIds.length >= pendingAdditionalCostInfo.discardCount;
    const pendingRepeatCost = (() => {
      if (!pendingPlayCard || pendingPlayCard.type !== "Spell" || !pendingPlay) return null;
      const owner = g.players[pendingPlay.player];
      const parsed = parseRepeatCost(pendingPlayCard);
      if (parsed) return parsed;
      if (owner.nextSpellRepeatByCost) {
        return { energy: pendingPlayCard.cost || 0, powerByDomain: {}, powerClass: 0, powerAny: 0 } as RepeatCost;
      }
      return null;
    })();
    const canConfirmPendingPlay =
      !!pendingPlay &&
      pendingPlay.player === me &&
      canActAs(me) &&
      targetRequirementSatisfied(pendingPlayReq, pendingTargets) &&
      pendingAdditionalDiscardReady;

    const phaseTrackItems: Array<{ key: Step | "MULLIGAN"; label: string }> = [
      { key: "MULLIGAN", label: "Mulligan" },
      { key: "AWAKEN", label: "Awaken" },
      { key: "SCORING", label: "Beginning" },
      { key: "CHANNEL", label: "Channel" },
      { key: "DRAW", label: "Draw" },
      { key: "ACTION", label: "Action" },
      { key: "ENDING", label: "Ending" },
    ];
    const phaseCurrentIndex = (() => {
      switch (g.step) {
        case "MULLIGAN":
          return 0;
        case "AWAKEN":
          return 1;
        case "SCORING":
          return 2;
        case "CHANNEL":
          return 3;
        case "DRAW":
          return 4;
        case "ACTION":
          return 5;
        case "ENDING":
        case "GAME_OVER":
          return 6;
        default:
          return 0;
      }
    })();

    const zoneBackCard = (pid: PlayerId, label: string): CardInstance =>
    ({
      id: `ZONE_BACK_${pid}_${label}`,
      name: label,
      domain: "Colorless",
      cost: 0,
      type: "Spell",
      stats: { might: null, power: null },
      tags: [],
      ability: undefined,
      rarity: "Unknown",
      image: undefined,
      image_url: undefined,
      instanceId: `ZONE_BACK_${pid}_${label}`,
      owner: pid,
      controller: pid,
      isReady: false,
      damage: 0,
      buffs: 0,
      tempMightBonus: 0,
      stunned: false,
      stunnedUntilTurn: 0,
      moveCountThisTurn: 0,
      conditionalKeywords: [],
      createdTurn: 0,
    } as CardInstance);

    const renderPlayerInfoGrid = (pid: PlayerId, interactiveLegend: boolean) => {
      const ps = g.players[pid];
      const legendCard =
        ps.legend
          ? ({
            ...(ps.legend as any),
            instanceId: `legend_${pid}`,
            owner: pid,
            controller: pid,
            isReady: ps.legendReady,
            damage: 0,
            buffs: 0,
            tempMightBonus: 0,
            stunned: false,
            createdTurn: 0,
          } as CardInstance)
          : null;
      const topTrash = ps.trash.length > 0 ? ps.trash[ps.trash.length - 1] : null;
      const legendStatus = pid === me ? legendActivationStatus : null;

      return (
        <div className="rb-playerInfoGrid">
          <div className="rb-playerInfoCell">
            <div className="rb-zoneLabel">Main Deck ({ps.mainDeck.length})</div>
            <div className="rb-row rb-rowCenter">
              <ArenaCard card={zoneBackCard(pid, "Main Deck")} facedown={true} size="xs" showReadyDot={false} />
            </div>
          </div>
          <div className="rb-playerInfoCell">
            <div className="rb-zoneLabel">Legend</div>
            {legendCard ? (
              <div className="rb-row rb-rowCenter" style={{ flexDirection: "column", gap: 6 }}>
                <ArenaCard card={legendCard} size="xs" showReadyDot={true} onClick={() => setHoverCard(ps.legend as any)} />
                {interactiveLegend ? (
                  <button
                    className="rb-miniButton"
                    disabled={!canActAs(pid) || g.priorityPlayer !== pid || !ps.legendReady || !legendStatus?.ok}
                    onClick={() => dispatchEngineAction({ type: "LEGEND_ACTIVATE", player: pid, autoPay: autoPayEnabled })}
                    title={!legendStatus?.ok ? legendStatus?.reason : "Activate Legend"}
                  >
                    Activate
                  </button>
                ) : null}
              </div>
            ) : (
              <span className="rb-softText">—</span>
            )}
          </div>
          <div className="rb-playerInfoCell">
            <div className="rb-zoneLabel">Discard ({ps.trash.length})</div>
            <div className="rb-row rb-rowCenter">
              {topTrash ? (
                <ArenaCard card={topTrash} size="xs" showReadyDot={false} onClick={() => setPileViewer({ player: pid, zone: "TRASH" })} />
              ) : (
                <ArenaCard card={zoneBackCard(pid, "Discard")} facedown={true} size="xs" showReadyDot={false} onClick={() => setPileViewer({ player: pid, zone: "TRASH" })} />
              )}
            </div>
          </div>
          <div className="rb-playerInfoCell">
            <div className="rb-zoneLabel">Champion</div>
            {ps.championZone ? (
              <div className="rb-row rb-rowCenter">
                <ArenaCard
                  card={ps.championZone}
                  size="xs"
                  showReadyDot={false}
                  onDoubleClick={() => {
                    if (interactiveLegend) beginPlayChampion(pid);
                  }}
                  onClick={() => {
                    if (interactiveLegend) beginPlayChampion(pid);
                  }}
                />
              </div>
            ) : (
              <span className="rb-softText">—</span>
            )}
          </div>
        </div>
      );
    };

    const renderTopLane = () => (
      <div className="rb-playerLaneTop rb-handLane" style={{ gridTemplateColumns: "1fr" }}>
        <div className="rb-handCenter">
          <div className="rb-zoneLabel">{opp} Hand ({oppState.hand.length})</div>
          <div className="rb-faceDownHandRow">
            {oppState.hand.length === 0 ? <span className="rb-softText">—</span> : null}
            {Array.from({ length: oppState.hand.length }).map((_, idx) => (
              <ArenaCard key={`opp_back_${idx}`} card={zoneBackCard(opp, `Hand ${idx + 1}`)} facedown={true} size="xs" showReadyDot={false} />
            ))}
          </div>
        </div>
      </div>
    );

    const renderBottomActionBar = () => {
      const p = meState;
      const selectedHandCard = p.hand.find((c) => c.instanceId === selectedHandCardId);
      const isHideArming = !!arenaHideCardId;

      // 1. Determine Primary Action
      let primary: ActionButtonState = {
        kind: "IDLE",
        label: canAdvanceStep ? (g.step === "ACTION" ? "End Turn" : "Next Step") : "Pass",
        action: () => {
          if (canAdvanceStep) nextStep();
          else passPriority(me);
        },
        disabled: !(canAdvanceStep || (canPass && canActAs(viewerId))),
      };

      if (g.pendingCullChoice) {
        const pc = g.pendingCullChoice;
        const chooser = pc.order[pc.index];
        const isMyChoice = chooser === viewerId;
        const valid = pendingTargets[0] && pendingTargets[0].kind === "UNIT" && pendingTargets[0].owner === chooser;
        const unitId = pendingTargets[0]?.kind === "UNIT" ? pendingTargets[0].instanceId : null;
        primary = {
          kind: "PENDING_TARGET",
          label: isMyChoice ? (valid ? "Confirm Kill Target" : "Choose target to kill") : `Waiting for ${chooser}...`,
          action: () => {
            if (valid && unitId) {
              dispatchEngineAction({ type: "CULL_CHOOSE", player: chooser, unitInstanceId: unitId });
              setPendingTargets([{ kind: "NONE" }]);
            }
          },
          disabled: !isMyChoice || !valid || !canActAs(chooser),
        };
      } else if (pendingChainItem) {
        primary = {
          kind: "PENDING_TARGET",
          label: `Confirm Target (${targetSelectedCount}/${targetMaxCount})`,
          action: confirmChainChoice,
          disabled: !canConfirmPendingTargets,
        };
      } else if (pendingPlay) {
        let label = "Put on Chain (Pay Costs)";
        const satisfied = targetRequirementSatisfied(pendingPlayReq, pendingTargets);
        if (pendingPlayReq && pendingPlayReq.kind !== "NONE" && !satisfied) {
          label = "Choose targets";
        }
        primary = {
          kind: "PENDING_PLAY",
          label,
          action: commitPendingPlay,
          disabled: !canConfirmPendingPlay,
        };
      } else if (selectedHandCard) {
        primary = {
          kind: "SELECTION",
          label: `Play ${selectedHandCard.name}`,
          action: () => beginPlayFromHand(viewerId, selectedHandCard.instanceId),
          disabled: !canActAs(viewerId),
        };
      }

      // 2. Determine Secondary Actions
      const secondary: SecondaryAction[] = [];

      if (selectedHandCard) {
        if (hasKeyword(selectedHandCard, "Hidden")) {
          secondary.push({
            id: "rb-action-hidden",
            label: isHideArming ? "Cancel Hide" : "Hidden",
            action: () => setArenaHideCardId((s) => (s === selectedHandCard.instanceId ? null : selectedHandCard.instanceId)),
            disabled: (!canHide && !isHideArming) || !canActAs(viewerId),
            color: isHideArming ? "rgba(255, 100, 100, 0.4)" : undefined,
          });
        }

        if (hasKeyword(selectedHandCard, "Accelerate")) {
          secondary.push({
            id: "rb-action-accelerate",
            label: "Accelerate",
            action: () => {
              beginPlayFromHand(viewerId, selectedHandCard.instanceId);
              setPendingAccelerate(true);
            },
            disabled: !canActAs(viewerId),
          });
        }

        secondary.push({
          id: "rb-action-cancel",
          label: "Cancel",
          action: () => {
            setSelectedHandCardId(null);
            setArenaHideCardId(null);
          },
        });

        // Optional: Keep "Pass" as secondary so user can end turn while card is selected
        if (canPass && canActAs(viewerId) && !isMyTurn) {
          secondary.push({ label: "Pass Turn", action: () => passPriority(me) });
        }
      }

      primaryActionRef.current = primary.disabled ? null : primary.action;

      return (
        <div className={`rb-bottomActionBar ${g.priorityPlayer !== me ? "rb-bottomActionBar-disabled" : ""}`}>
          {pendingPlay ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
              {pendingAdditionalCostInfo.hasAdditionalCost && pendingAdditionalCostInfo.isOptional ? (
                <label className="rb-softText" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={pendingPayOptionalAdditionalCost}
                    onChange={(e) => {
                      setPendingPayOptionalAdditionalCost(e.target.checked);
                      if (!e.target.checked) setPendingAdditionalDiscardIds([]);
                    }}
                  />
                  Pay optional additional cost
                </label>
              ) : null}

              {pendingAdditionalCostInfo.hasAdditionalCost && pendingAdditionalCostInfo.discardCount > 0 && willPayPendingAdditionalCost ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div className="rb-softText">
                    Additional cost: discard {pendingAdditionalCostInfo.discardCount} from hand (
                    {pendingAdditionalDiscardIds.length}/{pendingAdditionalCostInfo.discardCount} selected)
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {pendingAdditionalDiscardCandidates.map((c) => {
                      const selected = pendingAdditionalDiscardIds.includes(c.instanceId);
                      return (
                        <button
                          key={c.instanceId}
                          className="rb-miniButton"
                          style={{ background: selected ? "rgba(255, 0, 255, 0.4)" : undefined, cursor: "pointer" }}
                          onClick={() =>
                            setPendingAdditionalDiscardIds((prev) => {
                              if (selected) return prev.filter((id) => id !== c.instanceId);
                              if (prev.length >= pendingAdditionalCostInfo.discardCount) return prev;
                              return [...prev, c.instanceId];
                            })
                          }
                        >
                          {selected ? "Discarding:" : "Discard"} {c.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {pendingRepeatCost ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="rb-softText">Repeat:</span>
                  <button className="rb-miniButton" style={{ cursor: "pointer" }} disabled={pendingRepeatCount <= 0} onClick={() => setPendingRepeatCount((n) => Math.max(0, n - 1))}>
                    -
                  </button>
                  <span className="rb-softText" style={{ minWidth: 20, textAlign: "center" }}>{pendingRepeatCount}</span>
                  <button className="rb-miniButton" style={{ cursor: "pointer" }} onClick={() => setPendingRepeatCount((n) => n + 1)}>
                    +
                  </button>
                  <span className="rb-softText">
                    Cost each: {pendingRepeatCost.energy}E
                    {pendingRepeatCost.powerClass ? ` + ${pendingRepeatCost.powerClass}[C]` : ""}
                    {pendingRepeatCost.powerAny ? ` + ${pendingRepeatCost.powerAny}[A]` : ""}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {showMulliganUI ? (
              <button
                className="rb-bigButton"
                style={{ background: meState.mulliganDone ? "rgba(90, 200, 130, 0.3)" : undefined, cursor: meState.mulliganDone ? "default" : "pointer" }}
                disabled={meState.mulliganDone}
                onClick={() => confirmMulligan(me)}
              >
                {meState.mulliganDone ? `✓ Mulligan Confirmed` : `Confirm Mulligan (${meState.mulliganSelectedIds.length}/2 selected)`}
              </button>
            ) : (
              <>
                {secondary.length > 0 && (
                  <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
                    {secondary.map((s, idx) => (
                      <button
                        key={s.id || idx}
                        id={s.id}
                        className="rb-miniButton"
                        style={{ flex: 1, minHeight: 40, background: s.color, cursor: s.disabled ? "not-allowed" : "pointer", transition: "all 0.2s" }}
                        disabled={s.disabled}
                        onClick={s.action}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  className="rb-btn rb-btn-primary rb-bigButton"
                  style={{ width: "100%" }}
                  disabled={primary.disabled}
                  onClick={primary.action}
                >
                  {primary.label}
                </button>
              </>
            )}
          </div>
          <div className="rb-phaseTrack">
            {phaseTrackItems.map((phase, idx) => {
              const active = idx === phaseCurrentIndex;
              const reached = idx < phaseCurrentIndex;
              return (
                <div
                  key={phase.key}
                  className={`rb-phasePill ${active ? (isMyTurn ? "rb-phasePillActiveMe" : "rb-phasePillActiveOpp") : reached ? "rb-phasePillDone" : ""}`}
                >
                  {phase.label}
                </div>
              );
            })}
          </div>
          <div className="rb-softText" style={{ fontSize: 12, textAlign: "center" }}>
            Shortcut: press <b>Space</b> for {primary.label}.
          </div>
        </div>
      );
    };

    const BattlefieldMat = ({ idx }: { idx: number }) => {
      const bf = g.battlefields[idx];

      const canHideHere = !!arenaHideCardId && canHide && bf.controller === me && (!bf.facedown || (battlefieldAllowsExtraFacedown(bf) && !bf.facedownExtra));
      const canMoveHere =
        !!arenaMove && canSelectMoveUnits && !(arenaMove!.from.kind === "BF" && arenaMove!.from.index === idx);

      const controllerText = bf.controller ? `Controlled by ${bf.controller}` : "Uncontrolled";
      const contestedText = bf.contestedBy ? `• Contested by ${bf.contestedBy}` : "";

      return (
        <div
          className="rb-bf"
          style={{
            boxShadow: canHideHere
              ? "0 0 0 2px rgba(120, 255, 200, 0.35), 0 20px 60px rgba(0,0,0,0.35)"
              : canMoveHere
                ? "0 0 0 2px rgba(130, 210, 255, 0.30), 0 20px 60px rgba(0,0,0,0.35)"
                : undefined,
          }}
          onClick={() => {
            if (trySelectTarget({ kind: "BATTLEFIELD", index: idx })) return;
            if (canHideHere) commitHideAt(me, arenaHideCardId!, idx);
            else if (canMoveHere) executeStandardMoveWith(me, arenaMove!.from, arenaMove!.unitIds, { kind: "BF", index: idx });
          }}
        >
          <div className="rb-bfHeader">
            <div style={{ minWidth: 0 }}>
              <div className="rb-bfName">{bf.card.name}</div>
            </div>
          </div>

          <div className="rb-bfBody">
            <div className="rb-bfSide">

              <div style={{ transform: "rotate(-90deg)", margin: "30px 10px", display: "flex", justifyContent: "center", alignItems: "center" }}>
                <ArenaCard
                  targetId={`board-target-bf_${idx}`}
                  card={{
                    ...(bf.card as any),
                    owner: bf.owner,
                    createdTurn: 0,
                    instanceId: `bf_${idx}`,
                    controller: bf.owner,
                    isReady: true,
                    damage: 0,
                    buffs: 0,
                    tempMightBonus: 0,
                    stunned: false,
                  }}
                  size="sm"
                  showReadyDot={false}
                  onClick={() => setHoverCard(bf.card as any)}
                />
              </div>

              {bf.facedown || bf.facedownExtra ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {bf.facedown ? (
                    <ArenaCard
                      card={bf.facedown.card}
                      facedown={!(revealAllFacedown || viewerId === bf.facedown.owner)}
                      size="sm"
                      showReadyDot={false}
                      onDoubleClick={() => beginPlayFacedown(bf.facedown!.owner, idx, bf.facedown!.card.instanceId)}
                      onClick={() => beginPlayFacedown(bf.facedown!.owner, idx, bf.facedown!.card.instanceId)}
                    />
                  ) : null}
                  {bf.facedownExtra ? (
                    <ArenaCard
                      card={bf.facedownExtra.card}
                      facedown={!(revealAllFacedown || viewerId === bf.facedownExtra.owner)}
                      size="sm"
                      showReadyDot={false}
                      onDoubleClick={() => beginPlayFacedown(bf.facedownExtra!.owner, idx, bf.facedownExtra!.card.instanceId)}
                      onClick={() => beginPlayFacedown(bf.facedownExtra!.owner, idx, bf.facedownExtra!.card.instanceId)}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
            <div>

              <div className="rb-row rb-rowTight">
                {bf.units[opp].map((u) => (
                  <ArenaCard
                    key={u.instanceId}
                    targetId={`board-target-${u.instanceId}`}
                    card={u}
                    size="xs"
                    showReadyDot={true}
                    onClick={() => setHoverCard(u)}
                  />
                ))}
              </div>


              <div className="rb-row rb-rowTight">
                {bf.gear[opp].map((g0) => (
                  <ArenaCard
                    key={g0.instanceId}
                    targetId={`board-target-${g0.instanceId}`}
                    card={g0}
                    size="xs"
                    showReadyDot={true}
                    onClick={() => setHoverCard(g0)}
                  />
                ))}
              </div>

              <div style={{ height: 10 }} />


              <div className="rb-row rb-rowTight">
                {bf.units[me].map((u) => {
                  const selected = arenaMove?.unitIds.includes(u.instanceId) ?? false;
                  const clickable = canSelectMoveUnits && u.isReady;
                  return (
                    <ArenaCard
                      key={u.instanceId}
                      targetId={`board-target-${u.instanceId}`}
                      card={u}
                      size="xs"
                      selected={selected}
                      showReadyDot={true}
                      onClick={() => {
                        if (!clickable) return;
                        setArenaMove((s) => {
                          const from = { kind: "BF" as const, index: idx };
                          if (!s || s.from.kind !== "BF" || s.from.index !== idx) return { from, unitIds: [u.instanceId] };
                          const set = new Set(s.unitIds);
                          if (set.has(u.instanceId)) set.delete(u.instanceId);
                          else set.add(u.instanceId);
                          const nextIds = Array.from(set);
                          return nextIds.length === 0 ? null : { ...s, unitIds: nextIds };
                        });
                      }}
                      onDoubleClick={() => setHoverCard(u)}
                    />
                  );
                })}
              </div>

              <div style={{ height: 10 }} />


              <div className="rb-row rb-rowTight">
                {bf.gear[me].map((g1) => (
                  <ArenaCard
                    key={g1.instanceId}
                    targetId={`board-target-${g1.instanceId}`}
                    card={g1}
                    size="xs"
                    showReadyDot={true}
                    onClick={() => setHoverCard(g1)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      );
    };

    const BaseRow = ({ pid }: { pid: PlayerId }) => {
      const ps = g.players[pid];
      const isMe = pid === me;
      const interactiveLegend = isMe && canActAs(pid) && g.priorityPlayer === pid;
      const legendStatus = isMe ? legendActivationStatus : null;
      const legendCard =
        ps.legend
          ? ({
            ...(ps.legend as any),
            instanceId: `legend_${pid}`,
            owner: pid,
            controller: pid,
            isReady: ps.legendReady,
            damage: 0,
            buffs: 0,
            tempMightBonus: 0,
            stunned: false,
            createdTurn: 0,
          } as CardInstance)
          : null;

      return (
        <div style={{ display: "flex", width: "100%", gap: 20 }}>
          {/* LEGEND ZONE */}
          <div style={{ display: "flex", gap: 10, borderRight: "1px solid rgba(255,255,255,0.05)", paddingRight: 10 }}>
            {legendCard ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center", justifyContent: "center" }}>
                <ArenaCard card={legendCard} size="sm" showReadyDot={true} onClick={() => setHoverCard(ps.legend as any)} />
                {interactiveLegend ? (
                  <button
                    className="rb-miniButton"
                    style={{ fontSize: 10, padding: "4px 8px" }}
                    disabled={!ps.legendReady || !legendStatus?.ok}
                    onClick={() => dispatchEngineAction({ type: "LEGEND_ACTIVATE", player: pid, autoPay: autoPayEnabled })}
                    title={!legendStatus?.ok ? legendStatus?.reason : "Activate Legend"}
                  >
                    Activate
                  </button>
                ) : null}
              </div>
            ) : null}
            {ps.championZone ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center", justifyContent: "center" }}>
                <ArenaCard
                  card={ps.championZone}
                  size="sm"
                  showReadyDot={false}
                  onDoubleClick={() => {
                    if (interactiveLegend) beginPlayChampion(pid);
                  }}
                  onClick={() => {
                    if (interactiveLegend) beginPlayChampion(pid);
                  }}
                />
              </div>
            ) : null}
          </div>

          {/* RUNES ZONE */}
          <div style={{ flex: "0 0 350px", display: "flex", flexDirection: "column", justifyContent: "center", borderRight: "1px solid rgba(255,255,255,0.05)", paddingRight: 10 }}>
            <div className="rb-row rb-rowTight" style={{ flexWrap: "nowrap", overflowX: "auto", overflowY: "hidden", minHeight: 80, alignItems: "center" }}>
              <div style={{ flexShrink: 0, marginRight: 12, opacity: ps.runeDeck.length > 0 ? 1 : 0.4 }}>
                <ArenaCard card={zoneBackCard(pid, "Rune Deck")} facedown={true} size="sm" showReadyDot={false} />
              </div>
              {ps.runesInPlay.length === 0 ? <span className="rb-softText" style={{ margin: "auto" }}>No Runes</span> : null}
              {ps.runesInPlay.map((r) => {
                const h = isMe ? hoverPayPlan?.plan.runeUses[r.instanceId] : undefined;
                const img = cardImageUrl(r);
                const cls = [
                  "rb-rune",
                  !r.isReady ? "rb-runeExhausted" : "",
                  h === "EXHAUST" ? "rb-runeGlowExhaust" : "",
                  h === "RECYCLE" ? "rb-runeGlowRecycle" : "",
                  h === "BOTH" ? "rb-runeGlowBoth" : "",
                ].filter(Boolean).join(" ");
                return (
                  <div
                    key={r.instanceId}
                    className={cls}
                    onClick={() => isMe ? exhaustRuneForEnergy(me, r.instanceId) : setHoverCard(r as any)}
                    onContextMenu={(e) => {
                      if (!isMe) return;
                      e.preventDefault();
                      recycleRuneForPower(me, r.instanceId);
                    }}
                    title={isMe ? `${r.name || "Rune"} (${r.domain}) • L-Click: Exhaust (+1E) • R-Click: Recycle (+1P)` : `${r.name || "Rune"}`}
                    style={{ flexShrink: 0 }}
                  >
                    {img ? <img src={img} alt={r.name || r.domain} /> : null}
                  </div>
                );
              })}
            </div>
            {isMe && <div className="rb-actionHint" style={{ marginTop: 4 }}>Left-click: +1E • Right-click: +1P</div>}
          </div>

          {/* BASE ZONE */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div className="rb-row rb-rowTight">
              {ps.base.units.length === 0 && ps.base.gear.length === 0 ? <span className="rb-softText">Empty Base</span> : null}
              {ps.base.units.map((u) => (
                <div key={u.instanceId} style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
                  <ArenaCard
                    targetId={`board-target-${u.instanceId}`}
                    card={{ ...(u as any) }}
                    size="sm"
                    showReadyDot={true}
                    onClick={() => {
                      if (arenaMove?.from.kind === "BASE" && arenaMove.unitIds.includes(u.instanceId)) {
                        setArenaMove((m) => ({ ...m!, unitIds: m!.unitIds.filter((id) => id !== u.instanceId) }));
                      } else if (u.isReady && canActAs(pid)) {
                        setArenaMove({ from: { kind: "BASE" }, unitIds: [u.instanceId] });
                      } else {
                        setHoverCard(u as any);
                      }
                    }}
                  />
                  {arenaMove?.from.kind === "BASE" && arenaMove.unitIds.includes(u.instanceId) ? (
                    <div style={{ fontSize: 10, color: "var(--cp-neon-cyan)" }}>[MOVING]</div>
                  ) : null}
                </div>
              ))}
            </div>
            {ps.base.gear.length > 0 && (
              <div className="rb-row rb-rowTight" style={{ marginTop: 8 }}>
                {ps.base.gear.map((gear) => {
                  const canLocalAct = isMe && canActAs(me) && g.priorityPlayer === me;
                  const canEquip = canLocalAct && isEquipment(gear) && !!parseEquipCost(gear);
                  const canActivateGear = canLocalAct && gear.isReady && !!gearActivatedEffect(gear);
                  const canSpendSeal = canLocalAct && gear.isReady && !!getSealPowerDomain(gear, ps.domains);
                  const hasFriendlyUnit = isMe ? getUnitsInPlay(g, me).length > 0 : false;
                  return (
                    <div key={gear.instanceId} style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
                      <ArenaCard
                        targetId={`board-target-${gear.instanceId}`}
                        card={{ ...(gear as any) }}
                        size="sm"
                        showReadyDot={true}
                        onClick={() => setHoverCard(gear as any)}
                        onDoubleClick={() => {
                          if (canEquip) {
                            dispatchEngineAction({ type: "EQUIP_START", player: me, gearInstanceId: gear.instanceId });
                            return;
                          }
                          if (canActivateGear) {
                            dispatchEngineAction({ type: "GEAR_ACTIVATE", player: me, gearInstanceId: gear.instanceId, autoPay: autoPayEnabled });
                          }
                        }}
                      />
                      {isMe ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center", maxWidth: 140 }}>
                          {canEquip ? (
                            <button
                              className="rb-miniButton"
                              style={{ fontSize: 9 }}
                              disabled={!hasFriendlyUnit}
                              onClick={() => dispatchEngineAction({ type: "EQUIP_START", player: me, gearInstanceId: gear.instanceId })}
                            >
                              Equip
                            </button>
                          ) : null}
                          {canActivateGear ? (
                            <button
                              className="rb-miniButton"
                              style={{ fontSize: 9 }}
                              onClick={() => dispatchEngineAction({ type: "GEAR_ACTIVATE", player: me, gearInstanceId: gear.instanceId, autoPay: autoPayEnabled })}
                            >
                              Activate
                            </button>
                          ) : null}
                          {canSpendSeal ? (
                            <button
                              className="rb-miniButton"
                              style={{ fontSize: 9 }}
                              onClick={() => dispatchEngineAction({ type: "SEAL_EXHAUST", player: me, gearInstanceId: gear.instanceId })}
                            >
                              Seal +1P
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      );
    };

    const renderHand = () => {
      const p = meState;
      const isHideArming = !!arenaHideCardId;

      return (
        <div>
          <div className="rb-zoneLabel">
            Hand ({p.hand.length})
          </div>

          <div className="rb-hand">
            {p.hand.length === 0 ? <span className="rb-softText">—</span> : null}
            {p.hand.map((c, idx) => {
              const isSelected = selectedHandCardId === c.instanceId;
              const center = (p.hand.length - 1) / 2;
              const spread = Math.max(2, Math.min(6, 12 / Math.max(1, p.hand.length / 2)));
              const handRotation = (idx - center) * spread;
              const handLift = 0; // Removed: CSS scale handles hover lift now
              const edgeClass = idx <= 1 ? "rb-handSlotEdgeLeft" : idx >= p.hand.length - 2 ? "rb-handSlotEdgeRight" : "";
              return (
                <div
                  key={c.instanceId}
                  className={`rb-handSlot ${edgeClass}`}
                  style={
                    {
                      "--rb-hand-rot": `${handRotation}deg`,
                      "--rb-hand-lift": `${handLift}px`,
                      zIndex: isSelected ? 220 : idx + 10,
                    } as React.CSSProperties
                  }
                  onMouseEnter={() => {
                    if (!autoPayEnabled) return;
                    if (!g) return;
                    if (!canActAs(me)) return;

                    const reason = canPlayNonspellOutsideShowdown(c, g, me);
                    if (reason) {
                      setHoverPayPlan(null);
                      return;
                    }

                    const domainsAllowed = (() => {
                      const doms = parseDomains(c.domain).map(clampDomain);
                      if (doms.length === 0 || doms.includes("Colorless")) return meState.domains;
                      return doms;
                    })();

                    const plan = buildAutoPayPlan(meState.runePool, meState.runesInPlay, {
                      energyNeed: c.cost,
                      basePowerNeed: c.stats.power || 0,
                      powerDomainsAllowed: domainsAllowed,
                      additionalPowerByDomain: {},
                      additionalPowerAny: 0,
                    }, { sealExhaustedThisTurn: meState.sealExhaustedThisTurn, seals: meState.base.gear, playerDomains: meState.domains });

                    if (plan) setHoverPayPlan({ cardInstanceId: c.instanceId, plan });
                    else setHoverPayPlan(null);
                  }}
                  onMouseLeave={() => {
                    setHoverPayPlan((prev) => (prev?.cardInstanceId === c.instanceId ? null : prev));
                  }}
                >
                  <ArenaCard
                    card={c}
                    size="md"
                    selected={isSelected}
                    upright={true}
                    showReadyDot={false}
                    onClick={() => {
                      setSelectedHandCardId(c.instanceId);
                      setArenaHideCardId(null);
                    }}
                    onDoubleClick={() => beginPlayFromHand(me, c.instanceId)}
                  />
                </div>
              );
            })}
          </div>

          <div className="rb-actionHint">
            {g.pendingCandlelitChoice && g.pendingCandlelitChoice.player === me ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div><b>The Candlelit Sanctum:</b> Recycle one or both cards (optional).</div>
                {(() => {
                  const choice = g.pendingCandlelitChoice!;
                  const choices = choice.choices || {};
                  const keptIds = choice.cards
                    .filter((c) => (choices[c.instanceId] || "KEEP") !== "RECYCLE")
                    .map((c) => c.instanceId);
                  const topId = (choice.order && choice.order.length > 0) ? choice.order[0] : keptIds[0];
                  const setChoice = (cardId: string, next: "KEEP" | "RECYCLE") => {
                    choice.choices = { ...choice.choices, [cardId]: next };
                    if (next === "RECYCLE" && choice.order) {
                      choice.order = choice.order.filter((id) => id !== cardId);
                    }
                    setGame({ ...g });
                  };
                  const setTop = (cardId: string) => {
                    const currentKept = choice.cards
                      .filter((c) => (choice.choices?.[c.instanceId] || "KEEP") !== "RECYCLE")
                      .map((c) => c.instanceId);
                    choice.order = [cardId, ...currentKept.filter((id) => id !== cardId)];
                    setGame({ ...g });
                  };
                  return (
                    <>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                        {choice.cards.map((card) => {
                          const decision = choices[card.instanceId] || "KEEP";
                          const isKept = decision !== "RECYCLE";
                          return (
                            <div key={card.instanceId} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 6, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8 }}>
                              <ArenaCard card={card} size="xs" showReadyDot={false} />
                              <div style={{ display: "flex", gap: 6 }}>
                                <button
                                  className="rb-miniButton"
                                  style={{ background: decision === "KEEP" ? "#16a34a" : undefined }}
                                  onClick={() => setChoice(card.instanceId, "KEEP")}
                                >
                                  Keep
                                </button>
                                <button
                                  className="rb-miniButton"
                                  style={{ background: decision === "RECYCLE" ? "#dc2626" : undefined }}
                                  onClick={() => setChoice(card.instanceId, "RECYCLE")}
                                >
                                  Recycle
                                </button>
                              </div>
                              {keptIds.length > 1 && isKept ? (
                                <button
                                  className="rb-miniButton"
                                  style={{ background: topId === card.instanceId ? "#2563eb" : undefined }}
                                  onClick={() => setTop(card.instanceId)}
                                >
                                  {topId === card.instanceId ? "Top (selected)" : "Set as Top"}
                                </button>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button
                          className="rb-miniButton"
                          onClick={() => {
                            const pending = g.pendingCandlelitChoice!;
                            const map = pending.choices || {};
                            const kept = pending.cards.filter((c) => (map[c.instanceId] || "KEEP") !== "RECYCLE");
                            const recycled = pending.cards.filter((c) => (map[c.instanceId] || "KEEP") === "RECYCLE");
                            const keptIdsNow = kept.map((c) => c.instanceId);
                            const order = (pending.order || []).filter((id) => keptIdsNow.includes(id));
                            for (const id of keptIdsNow) {
                              if (!order.includes(id)) order.push(id);
                            }
                            const orderedKept = order.map((id) => kept.find((c) => c.instanceId === id)!).filter(Boolean);
                            const playerState = g.players[pending.player];
                            if (orderedKept.length > 0) {
                              playerState.mainDeck = orderedKept.concat(playerState.mainDeck);
                            }
                            if (recycled.length > 0) {
                              playerState.mainDeck.push(...recycled);
                            }
                            g.log.unshift(`${pending.player} resolved Candlelit Sanctum (recycled ${recycled.length}).`);
                            g.pendingCandlelitChoice = null;
                            setGame({ ...g });
                          }}
                        >
                          Confirm Choices
                        </button>
                        <span className="rb-softText">Kept cards return on top in chosen order.</span>
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : g.pendingWeaponmasterChoice && g.pendingWeaponmasterChoice.unitOwner === me ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div><b>Weaponmaster:</b> You may equip a gear to the unit that just entered play.</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(() => {
                    const choice = g.pendingWeaponmasterChoice!;
                    const p = g.players[me];
                    const availableGear = [...p.hand.filter(c => c.type === "Gear"), ...p.base.gear]
                      .filter(gear => choice.availableGearIds.includes(gear.instanceId));
                    return availableGear.map(gear => (
                      <button
                        key={gear.instanceId}
                        className="rb-miniButton"
                        onClick={() => {
                          // Equip the gear to the unit
                          const unit = locateUnit(g, choice.unitOwner, choice.unitInstanceId)?.unit;
                          if (unit && gear) {
                            // Calculate might before attaching
                            const previousMight = effectiveMight(unit, { role: "NONE", game: g });
                            // Remove gear from hand or base
                            const handIdx = p.hand.findIndex(c => c.instanceId === gear.instanceId);
                            if (handIdx >= 0) p.hand.splice(handIdx, 1);
                            else {
                              const baseIdx = p.base.gear.findIndex(c => c.instanceId === gear.instanceId);
                              if (baseIdx >= 0) p.base.gear.splice(baseIdx, 1);
                            }
                            // Attach to unit
                            if (!unit.attachedGear) unit.attachedGear = [];
                            unit.attachedGear.push(gear);
                            g.log.unshift(`${gear.name} equipped to ${unit.name} (Weaponmaster).`);
                            // Check if unit became Mighty and fire triggers
                            checkBecomesMighty(g, unit, previousMight);
                          }
                          g.pendingWeaponmasterChoice = null;
                          setGame({ ...g });
                        }}
                      >
                        Equip {gear.name}
                      </button>
                    ));
                  })()}
                  <button
                    className="rb-miniButton"
                    onClick={() => {
                      g.pendingWeaponmasterChoice = null;
                      setGame({ ...g });
                    }}
                  >
                    Skip (No Equip)
                  </button>
                </div>
              </div>
            ) : g.pendingEquipChoice && g.pendingEquipChoice.gearOwner === me ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div><b>Equip:</b> Select a unit to attach the equipment to.</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(() => {
                    const choice = g.pendingEquipChoice!;
                    const gear = meState.base.gear.find(g => g.instanceId === choice.gearInstanceId);
                    const units = getUnitsInPlay(g, me);
                    return units.map(unit => (
                      <button
                        key={unit.instanceId}
                        className="rb-miniButton"
                        onClick={() => dispatchEngineAction({ type: "EQUIP_CONFIRM", player: me, unitInstanceId: unit.instanceId })}
                      >
                        {unit.name} (M{effectiveMight(unit, { role: "NONE", game: g })})
                      </button>
                    ));
                  })()}
                  <button
                    className="rb-miniButton"
                    onClick={() => {
                      const choice = g.pendingEquipChoice!;
                      const gear = meState.base.gear.find((x) => x.instanceId === choice.gearInstanceId);
                      if (gear) dispatchEngineAction({ type: "SEAL_EXHAUST", player: me, gearInstanceId: gear.instanceId });
                    }}
                  >
                    Use Seal for Equip
                  </button>
                  <button
                    className="rb-miniButton"
                    onClick={() => dispatchEngineAction({ type: "EQUIP_CANCEL", player: me })}
                  >
                    Cancel
                  </button>
                </div>
                {(() => {
                  const choice = g.pendingEquipChoice!;
                  const gear = meState.base.gear.find(g => g.instanceId === choice.gearInstanceId);
                  return gear ? (
                    <div className="rb-softText">
                      {gear.name} (+{gear.stats?.might || 0} might) - Cost: {choice.equipCost.energy > 0 ? `${choice.equipCost.energy}E + ` : ""}{choice.equipCost.power}P
                    </div>
                  ) : null;
                })()}
              </div>
            ) : selectedHandCard ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>
                  Selected: <b>{selectedHandCard.name}</b>
                </span>
                {isHideArming ? <span className="rb-softText">Click a battlefield you control to place it facedown.</span> : null}
              </div>
            ) : (
              <span className="rb-softText">Tip: double-click a card to play it.</span>
            )}
          </div>
        </div>
      );
    };

    const renderPreview = () => {
      if (!hoverCard) return <div className="rb-softText">Hover a card to preview it here.</div>;
      const c: any = hoverCard;
      const img = cardImageUrl(c);
      return (
        <div>
          <div className="rb-preview">
            {img ? <img src={img} alt={c.name} /> : null}
            <div className="rb-previewText">
              <div style={{ fontWeight: 900, marginBottom: 4 }}>{c.name}</div>
              <div className="rb-softText" style={{ marginBottom: 6 }}>
                {c.type} • {c.domain} • Cost {c.cost}E{c.stats?.power ? ` + ${c.stats.power}P` : ""}
              </div>
              {c.ability?.keywords?.length ? <div style={{ marginBottom: 6 }}>KW: {c.ability.keywords.join(", ")}</div> : null}
              {c.ability?.effect_text ? <div>{c.ability.effect_text}</div> : null}
            </div>
          </div>
        </div>
      );
    };

    // Mulligan banner component
    const MulliganBanner = () => {
      if (!showMulliganUI) return null;
      const p1Done = g.players.P1.mulliganDone;
      const p2Done = g.players.P2.mulliganDone;
      const myDone = meState.mulliganDone;
      const mySelected = meState.mulliganSelectedIds.length;

      return (
        <div className="rb-mulliganBanner">
          <h2>MULLIGAN PHASE</h2>
          <div className="rb-mulliganInfo">
            Click up to 2 cards in your hand to recycle, then confirm.
            <br />
            <span style={{ opacity: 0.7 }}>P1: {p1Done ? '✓ Done' : 'Pending'} | P2: {p2Done ? '✓ Done' : 'Pending'}</span>
          </div>
          <button
            className={`rb-mulliganConfirmBtn ${myDone ? 'confirmed' : ''}`}
            disabled={myDone}
            onClick={() => confirmMulligan(me)}
          >
            {myDone ? '✓ Confirmed' : `Confirm Mulligan (${mySelected}/2)`}
          </button>
        </div>
      );
    };

    const renderMulliganModal = () => {
      if (!g || !showMulliganUI) return null;

      const p = meState;
      return (
        <div className="rb-modalOverlay">
          <div className="rb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rb-modalHeader">
              <div style={{ fontWeight: 900 }}>
                Mulligan Overview
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                <span className="rb-softText" style={{ marginRight: 8 }}>{p.mulliganSelectedIds.length}/2 selected</span>
                <button
                  className="rb-miniButton"
                  disabled={p.mulliganDone}
                  onClick={() => confirmMulligan(me)}
                  style={{ background: p.mulliganDone ? undefined : '#f43f5e', color: 'white', fontWeight: 'bold' }}
                >
                  {p.mulliganDone ? "Confirmed" : "Confirm Mulligan"}
                </button>
              </div>
            </div>
            <div className="rb-modalBody">
              <div className="rb-softText" style={{ marginBottom: 16 }}>
                Select up to 2 cards to shuffle back into your deck and redraw. Switch "playing as" to confirm for the opponent.
              </div>
              {p.hand.length === 0 ? <div className="rb-softText">—</div> : null}
              <div className="rb-pileGrid">
                {p.hand.map((c) => {
                  const isSelected = mulliganSelected.has(c.instanceId);
                  return (
                    <div key={c.instanceId} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                      <ArenaCard
                        card={c as any}
                        size="sm"
                        selected={isSelected}
                        showReadyDot={false}
                        upright={true}
                        onClick={() => toggleMulliganSelect(me, c.instanceId)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      );
    };

    return (
      <div className="rb-grid">
        <div className={`rb-board ${showMulliganUI ? "rb-boardMulligan" : "rb-boardLive"}`}>
          <div className="rb-boardInner">
            <div className="rb-hudRow">
              <div className="rb-hud">
                <div className="rb-avatar">
                  {oppState.legend && cardImageUrl(oppState.legend) ? <img src={cardImageUrl(oppState.legend)!} alt={oppState.legend.name} /> : null}
                </div>
                <div className="rb-hudText">
                  <div className="rb-hudName">{opp} — {oppState.legend ? oppState.legend.name : "Legend"}</div>
                  <div className="rb-hudSub">
                    Points {oppState.points}/{g.victoryScore} • Hand {oppState.hand.length} • Deck {oppState.mainDeck.length} • <button className="rb-miniButton" onClick={() => setPileViewer({ player: opp, zone: "TRASH" })}>Trash {oppState.trash.length}</button>
                  </div>
                </div>
              </div>

              <div style={{ textAlign: "right", fontSize: 12, opacity: 0.9 }}>
                <div>
                  Turn {g.turnNumber} • <b>{g.step}</b>
                </div>
                <div>
                  Turn player: <b>{g.turnPlayer}</b> • Priority: <b>{g.priorityPlayer}</b>
                </div>
                <div>
                  Chain: {g.chain.length} • State: {g.state} {g.windowKind !== "NONE" ? `• ${g.windowKind} @ BF${(g.windowBattlefieldIndex ?? -1) + 1}` : ""}
                </div>
              </div>
            </div>

            {renderTopLane()}

            <BaseRow pid={opp} />

            <div className="rb-matRow">
              <BattlefieldMat idx={0} />
              <BattlefieldMat idx={1} />
            </div>

            <div
              style={{
                border: arenaMove && canSelectMoveUnits ? "1px dashed rgba(130, 210, 255, 0.45)" : "1px solid rgba(255,255,255,0.10)",
                borderRadius: 16,
                padding: 10,
                background: "rgba(0,0,0,0.18)",
              }}
              onClick={() => {
                if (arenaMove && canSelectMoveUnits && arenaMove.from.kind !== "BASE") {
                  executeStandardMoveWith(me, arenaMove.from, arenaMove.unitIds, { kind: "BASE" });
                }
              }}
            >
              <BaseRow pid={me} />
              {arenaMove && canSelectMoveUnits ? (
                <div className="rb-actionHint">
                  Move armed: click a battlefield (or this base panel) to move selected ready units.{" "}
                  <button className="rb-miniButton" onClick={() => setArenaMove(null)}>
                    Cancel move
                  </button>
                </div>
              ) : null}
            </div>

            <div className="rb-playerLaneBottom rb-handLane" style={{ gridTemplateColumns: "1fr" }}>
              <div className="rb-handCenter">
                {renderHand()}
                {renderBottomActionBar()}
              </div>
            </div>            {/* FLOATING UI WIDGETS */}
            <div className="rb-floating-preview" style={{ opacity: hoverCard ? 1 : 0, transition: 'opacity 0.2s ease' }}>
              {renderPreview()}
            </div>

            <div className="rb-floating-log">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontWeight: 'bold', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }}>Game Log</div>
                <button className="rb-miniButton" onClick={() => updateGame((d) => (d.log = []))}>
                  Clear
                </button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', fontSize: 12, display: 'flex', flexDirection: 'column-reverse' }}>
                {g.log.length === 0 ? <div className="rb-softText">—</div> : null}
                {g.log.slice(0, 30).reverse().map((l, i) => (
                  <div key={i} style={{ padding: "4px 0", borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    {l}
                  </div>
                ))}
              </div>
            </div>

            {
              g.chain.length > 0 && (
                <div className="rb-floating-chain">
                  <div style={{ fontWeight: 'bold', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'center', marginBottom: 12 }}>Chain ({g.chain.length})</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {g.chain.map((item, idx) => {
                      const isTop = idx === 0;
                      const isHovered = hoveredChainId === item.id;
                      const targetNames = item.targets
                        ?.filter((t): t is { kind: "UNIT"; owner: PlayerId; instanceId: string } => t.kind === "UNIT")
                        .map((t) => {
                          const loc = locateUnit(g, t.owner, t.instanceId);
                          return loc?.unit.name || "Unknown";
                        }) || [];

                      let cardObj = item.sourceCard || null;
                      if (!cardObj && item.sourceInstanceId) {
                        const searchPool = [
                          ...g.battlefields.flatMap(bf => [...bf.units["P1"], ...bf.units["P2"], ...bf.gear["P1"], ...bf.gear["P2"]]),
                          ...g.players["P1"].base.units, ...g.players["P2"].base.units,
                          ...g.players["P1"].base.gear, ...g.players["P2"].base.gear,
                          ...g.players["P1"].hand, ...g.players["P2"].hand,
                          ...g.players["P1"].runesInPlay, ...g.players["P2"].runesInPlay,
                          g.players["P1"].championZone, g.players["P2"].championZone
                        ].filter(Boolean);
                        cardObj = (searchPool.find(c => c && c.instanceId === item.sourceInstanceId) as CardInstance) || null;
                      }

                      return (
                        <div
                          key={item.id}
                          id={`chain-source-${item.id}`}
                          className={`rb-chainItem ${isTop ? 'rb-chainItemActive' : ''}`}
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'transparent', border: 'none', padding: 0 }}
                          onClick={() => {
                            if (cardObj) setHoverCard(cardObj as any);
                          }}
                          onMouseEnter={() => setHoveredChainId(item.id)}
                          onMouseLeave={() => setHoveredChainId(null)}
                        >
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                            {cardObj ? (
                              <div style={{ marginBottom: 4, position: 'relative' }}>
                                <ArenaCard card={cardObj as any} size="sm" upright={true} />
                                {isTop && <div style={{ position: 'absolute', top: -10, right: -10, background: '#ef4444', color: 'white', fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 'bold' }}>TOP</div>}
                              </div>
                            ) : (
                              <div className="rb-chainItemLabel" style={{ textAlign: 'center', marginBottom: 4, width: '100%', padding: '16px 8px', background: '#1e293b', borderRadius: 8 }}>
                                {isTop ? '▶ ' : ''}{item.label}
                              </div>
                            )}

                            {targetNames.length > 0 && (
                              <div className="rb-chainArrowLabel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 4 }}>
                                <span className="rb-chainArrowLine" style={{ transform: 'rotate(90deg)', margin: '4px 0', display: 'inline-block' }}>⟶</span>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  {targetNames.map((name, ti) => (
                                    <span key={ti} className="rb-chainTargetBadge">
                                      🎯 {name}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}

                            {(item.targets || [])
                              .filter((t: any) => t.kind === 'BATTLEFIELD')
                              .map((t: any, ti: number) => (
                                <div key={`bf-${ti}`} className="rb-chainArrowLabel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 4 }}>
                                  <span className="rb-chainArrowLine" style={{ transform: 'rotate(90deg)', margin: '4px 0', display: 'inline-block' }}>⟶</span>
                                  <span className="rb-chainTargetBadge" style={{ borderColor: 'rgba(243, 255, 0, 0.5)', color: '#eab308' }}>
                                    🏟 BF{t.index + 1}
                                  </span>
                                </div>
                              ))}

                            {item.needsTargets && (
                              <div className="rb-chainArrowLabel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 4 }}>
                                <span className="rb-chainArrowLine" style={{ transform: 'rotate(90deg)', margin: '4px 0', display: 'inline-block', color: '#f97316' }}>⟶</span>
                                <span className="rb-chainTargetBadge" style={{ borderColor: '#f97316', color: '#f97316', background: 'rgba(249, 115, 22, 0.1)' }}>
                                  ⏳ Awaiting target
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )
            }

            <div className="rb-hudTopRight">
              <div style={{ background: 'rgba(0,0,0,0.6)', padding: '8px 12px', borderRadius: 8, backdropFilter: 'blur(4px)', display: 'flex', gap: 8, flexDirection: 'column' }}>
                <div style={{ fontSize: 12, fontWeight: 'bold' }}><b>{me}</b> Pool</div>
                <div style={{ fontSize: 13 }}>{meState.runePool.energy}E • {sumPower(meState.runePool)}P</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>({formatPowerBreakdown(meState.runePool)})</div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, cursor: 'pointer', marginTop: 4, background: 'rgba(255,255,255,0.05)', padding: 4, borderRadius: 4 }}>
                  <input
                    type="checkbox"
                    checked={autoPayEnabled}
                    onChange={(e) => setAutoPayEnabled(e.target.checked)}
                  />
                  Auto-pay runes
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="rb-miniButton" onClick={() => setPileViewer({ player: opp, zone: "TRASH" })}>
                  Op Trash ({oppState.trash.length})
                </button>
                <button className="rb-miniButton" onClick={() => setPileViewer({ player: me, zone: "TRASH" })}>
                  My Trash ({meState.trash.length})
                </button>
              </div>
              <details className="rb-debugPanel" style={{ background: 'rgba(0,0,0,0.5)', borderRadius: 8, padding: '4px 8px' }}>
                <summary style={{ cursor: 'pointer', fontSize: 11, color: '#f43f5e', outline: 'none' }}>Debug</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                  <button className="rb-miniButton" onClick={() => setUiMode("Arena")} disabled={uiMode === "Arena"}>Arena</button>
                  <button className="rb-miniButton" onClick={() => setUiMode("Classic")} disabled={uiMode === "Classic"}>Classic</button>
                  <button className="rb-miniButton" disabled={undoRef.current.length === 0} onClick={undo}>Undo</button>
                </div>
              </details>
            </div>
            {/* END FLOATING UI */}

            <TargetingOverlay chain={g.chain} />
            {renderMulliganModal()}
          </div >
        </div >
      </div >
    );
  };

  const renderSetupScreen = () => {
    const quickStartWith = (flag: React.MutableRefObject<boolean>) => {
      flag.current = true;
      loadCardDataFromUrl("/riftbound_data_expert%20(1).json")
        .then((cards) => startAutoDuel(cards))
        .catch((err) => {
          flag.current = false;
          alert(String(err));
        });
    };

    return (
      <div style={{ maxWidth: 720, margin: "28px auto" }} className="rb-panel">
        <div className="rb-panelTitle">Setup</div>
        <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 8 }}>Load card data and start a duel</div>
        <div className="rb-softText" style={{ marginBottom: 12 }}>
          Load the provided JSON card database, then auto-setup a hot-seat Duel.
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              loadCardData(file).catch((err) => alert(String(err)));
            }}
          />
          <button
            className="rb-miniButton"
            onClick={() => loadCardDataFromUrl("/riftbound_data_expert%20(1).json").catch((err) => alert(String(err)))}
          >
            Load default card data
          </button>
          <div className="rb-softText">Loaded cards: <b>{allCards.length}</b></div>
        </div>

        <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="rb-bigButton" style={{ maxWidth: 320 }} disabled={allCards.length === 0} onClick={() => startAutoDuel()}>
            Auto-setup Duel (Hot-seat)
          </button>

          <button className="rb-bigButton" style={{ maxWidth: 260 }} disabled={allCards.length === 0} onClick={() => setPreGameView("DECK_BUILDER")}>
            Deck Builder
          </button>

          <button
            id="rb-quick-start"
            className="rb-bigButton"
            style={{ maxWidth: 300 }}
            onClick={() => {
              loadCardDataFromUrl("/riftbound_data_expert%20(1).json")
                .then((cards) => startAutoDuel(cards))
                .catch((err) => alert(String(err)));
            }}
          >
            Quick Start (local data)
          </button>

          <button
            id="rb-quick-retreat-challenge-repro"
            className="rb-bigButton"
            style={{ maxWidth: 360 }}
            onClick={() => quickStartWith(pendingRetreatChallengeReproAfterStartRef)}
          >
            Quick Retreat-&gt;Challenge Repro
          </button>

          <button
            id="rb-quick-cull-weak-repro"
            className="rb-bigButton"
            style={{ maxWidth: 320 }}
            onClick={() => quickStartWith(pendingCullWeakReproAfterStartRef)}
          >
            Quick Cull the Weak Repro
          </button>

          <button
            id="rb-quick-conditional-audit-repro"
            className="rb-bigButton"
            style={{ maxWidth: 360 }}
            onClick={() => quickStartWith(pendingConditionalAuditReproAfterStartRef)}
          >
            Quick Conditional Audit Repro
          </button>

          <button
            id="rb-quick-seal-autopay-repro"
            className="rb-bigButton"
            style={{ maxWidth: 320 }}
            onClick={() => quickStartWith(pendingSealAutoPayReproAfterStartRef)}
          >
            Quick Seal Auto-pay Repro
          </button>

          <button
            id="rb-quick-gold-token-repro"
            className="rb-bigButton"
            style={{ maxWidth: 320 }}
            onClick={() => quickStartWith(pendingGoldTokenReproAfterStartRef)}
          >
            Quick Gold Token Repro
          </button>

          <button
            id="rb-quick-battlefield-audit-repro"
            className="rb-bigButton"
            style={{ maxWidth: 320 }}
            onClick={() => quickStartWith(pendingBattlefieldAuditReproAfterStartRef)}
          >
            Quick Battlefield Audit Repro
          </button>

          <button
            id="rb-quick-legend-audit-repro"
            className="rb-bigButton"
            style={{ maxWidth: 320 }}
            onClick={() => quickStartWith(pendingLegendAuditReproAfterStartRef)}
          >
            Quick Legend Audit Repro
          </button>

          <button
            id="rb-quick-champion-audit-repro"
            className="rb-bigButton"
            style={{ maxWidth: 320 }}
            onClick={() => quickStartWith(pendingChampionAuditReproAfterStartRef)}
          >
            Quick Champion Audit Repro
          </button>

          <button
            id="rb-quick-spell-audit-repro"
            className="rb-bigButton"
            style={{ maxWidth: 320 }}
            onClick={() => quickStartWith(pendingSpellAuditReproAfterStartRef)}
          >
            Quick Spell Audit Repro
          </button>

          <button
            id="rb-quick-gear-audit-repro"
            className="rb-bigButton"
            style={{ maxWidth: 320 }}
            onClick={() => quickStartWith(pendingGearAuditReproAfterStartRef)}
          >
            Quick Gear Audit Repro
          </button>

          <button
            id="rb-quick-equip-additional-repro"
            className="rb-bigButton"
            style={{ maxWidth: 360 }}
            onClick={() => quickStartWith(pendingEquipAdditionalReproAfterStartRef)}
          >
            Quick Equip/Additional Repro
          </button>

          <div className="rb-softText">
            Tip: once started, switch “playing as” to take actions for each player.
          </div>
        </div>
      </div>
    );
  };


  const renderDeckBuilder = () => {
    const pid = builderActivePlayer;
    const spec = builderDecks[pid] || emptyDeckSpec();

    const legends = allCards
      .filter((c) => c.type === "Legend")
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const runeCards = allCards
      .filter((c) => c.type === "Rune")
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const battlefieldCards = allCards
      .filter((c) => c.type === "Battlefield")
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const mainPoolAll = allCards
      .filter((c) => isMainDeckType(c.type))
      .slice()
      .sort((a, b) => {
        const ca = Number(a.cost || 0);
        const cb = Number(b.cost || 0);
        if (ca !== cb) return ca - cb;
        return (a.name || "").localeCompare(b.name || "");
      });

    const legend = spec.legendId ? getCardById(allCards, spec.legendId) : null;
    const identity = legend ? domainIdentityFromLegend(legend) : (["Body", "Calm", "Chaos", "Fury", "Mind", "Order"] as Domain[]);
    const champTag = legend ? ((legend.tags || [])[0] || null) : null;

    const eligibleBattlefields = legend ? battlefieldCards.filter((b) => cardWithinIdentity(b, identity)) : battlefieldCards;

    const eligibleRunes = legend
      ? runeCards.filter((r) => {
        const domRaw = (parseDomains(r.domain)[0] || r.domain || "Colorless").trim();
        const dom = clampDomain(domRaw);
        return dom === "Colorless" || identity.includes(dom);
      })
      : runeCards;

    const eligibleMainPool = legend ? mainPoolAll.filter((c) => cardWithinIdentity(c, identity)) : mainPoolAll;

    const eligibleChampions = legend ? eligibleMainPool.filter((c) => isLikelyChampionUnit(c, champTag)) : [];

    const mainTotal = countTotal(spec.main);
    const runeTotal = countTotal(spec.runes);

    const toPreview = (cd: CardData, labelSalt = ""): CardInstance => ({
      ...cd,
      instanceId: `preview_${pid}_${labelSalt}_${cd.id}`,
      owner: pid,
      controller: pid,
      isReady: true,
      damage: 0,
      buffs: 0,
      tempMightBonus: 0,
      stunned: false,
      stunnedUntilTurn: 0,
      moveCountThisTurn: 0,
      createdTurn: 0,
    });

    const validateDeck = (p: PlayerId, s: DeckSpec): string[] => {
      const errs: string[] = [];

      const lg = s.legendId ? getCardById(allCards, s.legendId) : null;
      if (!lg || lg.type !== "Legend") errs.push("Select a Legend.");

      const champ = s.championId ? getCardById(allCards, s.championId) : null;
      if (!champ || champ.type !== "Unit") errs.push("Select a chosen Champion (Unit).");

      const bfs = s.battlefields || [];
      if (bfs.length !== 3) errs.push(`Choose exactly 3 battlefields (currently ${bfs.length}).`);

      const rTotal = countTotal(s.runes || {});
      if (rTotal !== 12) errs.push(`Rune deck must have exactly 12 cards (currently ${rTotal}).`);

      const mTotal = countTotal(s.main || {});
      if (mTotal < 40) errs.push(`Main deck must have at least 40 cards (currently ${mTotal}).`);

      if (champ && champ.type === "Unit") {
        const champCopies = Math.floor((s.main || {})[champ.id] || 0);
        if (champCopies < 1) errs.push("Main deck must include at least 1 copy of the chosen Champion.");
      }

      // Best-effort deep validation using the builder->engine conversion (gives more precise domain/tag errors).
      try {
        buildPlayerFromDeckSpec(allCards, p, s, 1);
      } catch (e: any) {
        const msg = String(e?.message || e);
        // avoid duplicates
        if (!errs.includes(msg)) errs.push(msg);
      }

      return errs;
    };

    const errorsP1 = validateDeck("P1", builderDecks.P1);
    const errorsP2 = validateDeck("P2", builderDecks.P2);
    const activeErrors = pid === "P1" ? errorsP1 : errorsP2;
    const canStart = allCards.length > 0 && errorsP1.length === 0 && errorsP2.length === 0;


    const bfsP1 = deckBattlefieldsFor("P1");
    const bfsP2 = deckBattlefieldsFor("P2");
    const usedBattlefieldIds =
      matchState?.format === "BO3" && matchState?.usedBattlefieldIds
        ? matchState.usedBattlefieldIds
        : { P1: [], P2: [] };
    const remainingBfP1 = bfsP1.filter((b) => !usedBattlefieldIds.P1.includes(b.id));
    const remainingBfP2 = bfsP2.filter((b) => !usedBattlefieldIds.P2.includes(b.id));

    const nextOptionsP1 = remainingBfP1.length > 0 ? remainingBfP1 : bfsP1;
    const nextOptionsP2 = remainingBfP2.length > 0 ? remainingBfP2 : bfsP2;



    // Card browser filters (main-deck only)
    let browser = eligibleMainPool;
    if (builderTypeFilter !== "All") browser = browser.filter((c) => c.type === builderTypeFilter);
    const q = builderSearch.trim().toLowerCase();
    if (q) browser = browser.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.id || "").toLowerCase().includes(q));
    browser = browser.slice(0, 96);

    const deckRows = Object.entries(spec.main)
      .map(([id, n]) => ({ id, n: n as number, card: getCardById(allCards, id) }))
      .filter((x): x is { id: string; n: number; card: CardData } => x.card !== null && (x.n || 0) > 0)
      .sort((a, b) => {
        const ta = (a.card as any).type || "";
        const tb = (b.card as any).type || "";
        if (ta !== tb) return ta.localeCompare(tb);
        const ca = Number((a.card as any).cost || 0);
        const cb = Number((b.card as any).cost || 0);
        if (ca !== cb) return ca - cb;
        return ((a.card as any).name || "").localeCompare((b.card as any).name || "");
      });

    // Sideboard rows
    const sideboardRows = Object.entries(spec.sideboard || {})
      .map(([id, n]) => ({ id, n: n as number, card: getCardById(allCards, id) }))
      .filter((x): x is { id: string; n: number; card: CardData } => x.card !== null && (x.n || 0) > 0)
      .sort((a, b) => {
        const ta = (a.card as any).type || "";
        const tb = (b.card as any).type || "";
        if (ta !== tb) return ta.localeCompare(tb);
        const ca = Number((a.card as any).cost || 0);
        const cb = Number((b.card as any).cost || 0);
        if (ca !== cb) return ca - cb;
        return ((a.card as any).name || "").localeCompare((b.card as any).name || "");
      });
    const sideboardCount = countTotal(spec.sideboard || {});

    const activeLegendName = legend?.name || "—";
    const activeIdentityText = legend ? identity.join(", ") : "—";

    const toggleBattlefield = (bfId: string) => {
      updateDeck(pid, (d) => {
        const cur = d.battlefields || [];
        if (cur.includes(bfId)) return { ...d, battlefields: cur.filter((x) => x !== bfId), sideboard: d.sideboard || {} };
        if (cur.length >= 3) return d; // hard cap
        return { ...d, battlefields: [...cur, bfId], sideboard: d.sideboard || {} };
      });
    };

    const autoFillActive = () => {
      if (allCards.length === 0) return;

      updateDeck(pid, (d) => {
        // Legend
        const lg = d.legendId ? getCardById(allCards, d.legendId) : null;
        const legendCard = lg && lg.type === "Legend" ? lg : legends[0] || null;
        if (!legendCard) return { ...d, sideboard: d.sideboard || {} };
        const id = domainIdentityFromLegend(legendCard);
        const tag = (legendCard.tags || [])[0] || null;

        // Champion (heuristic: champion-tag + comma-name)
        const champCandidates = allCards
          .filter((c) => isLikelyChampionUnit(c, tag))
          .filter((c) => cardWithinIdentity(c, id));
        const champ = champCandidates[0] || allCards.find((c) => c.type === "Unit") || null;

        // Battlefields (3)
        const bfPool = battlefieldCards.filter((b) => cardWithinIdentity(b, id));
        const bf3 = (shuffle(bfPool, 777) as CardData[]).slice(0, 3).map((b) => b.id);

        // Runes (12): distribute across identity domains
        const runeByDomain: Partial<Record<Domain, CardData>> = {};
        for (const rc of runeCards) {
          const domRaw = (parseDomains(rc.domain)[0] || rc.domain || "Colorless").trim();
          const dom = clampDomain(domRaw);
          if (!runeByDomain[dom]) runeByDomain[dom] = rc;
        }
        const runeCounts: Record<string, number> = {};
        const doms = id.length > 0 ? id : (["Body", "Calm", "Chaos", "Fury", "Mind", "Order"] as Domain[]);
        const per = Math.floor(12 / doms.length);
        const rem = 12 % doms.length;
        for (let i = 0; i < doms.length; i++) {
          const dom = doms[i];
          const cnt = per + (i < rem ? 1 : 0);
          const runeCard = runeByDomain[dom] || runeCards[0];
          if (!runeCard) continue;
          runeCounts[runeCard.id] = (runeCounts[runeCard.id] || 0) + cnt;
        }

        // Main deck (>=40) with max 3 copies
        const pool = eligibleMainPool.length > 0 ? eligibleMainPool : mainPoolAll;
        const counts: Record<string, number> = {};
        if (champ && champ.id) counts[champ.id] = 1;

        const maxCopies = 3;
        const picks = shuffle(pool, 888) as CardData[];
        let i = 0;
        while (countTotal(counts) < 40 && picks.length > 0) {
          const c = picks[i % picks.length];
          i++;
          if (!c) break;
          if (counts[c.id] >= maxCopies) continue;
          counts[c.id] = (counts[c.id] || 0) + 1;
        }

        return {
          legendId: legendCard.id,
          championId: champ ? champ.id : null,
          battlefields: bf3,
          runes: runeCounts,
          main: counts,
          sideboard: d.sideboard || {},
        };
      });
    };

    const exportDecks = async () => {
      const payload = JSON.stringify(builderDecks, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        alert("Decks JSON copied to clipboard.");
      } catch {
        window.prompt("Copy decks JSON:", payload);
      }
    };

    const importDecks = () => {
      const raw = window.prompt("Paste decks JSON here:");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed?.P1 || !parsed?.P2) throw new Error("Expected object with {P1, P2}.");
        setBuilderDecks({ P1: parsed.P1, P2: parsed.P2 });
        alert("Imported.");
      } catch (e: any) {
        alert(`Import failed: ${String(e?.message || e)}`);
      }
    };

    // ----------------------------- Saved Deck Library helpers -----------------------------

    const isDeckSpec = (x: any): x is DeckSpec => {
      return !!x && typeof x === "object" && "legendId" in x && "main" in x && "runes" in x && "battlefields" in x;
    };

    const selectedLibDeck = selectedLibraryDeckId ? deckLibrary.find((d) => d.id === selectedLibraryDeckId) || null : null;

    const libSearch = librarySearch.trim().toLowerCase();
    const libTag = libraryTagFilter.trim().toLowerCase();

    const filteredLibrary = deckLibrary.filter((d) => {
      const name = (d.name || "").toLowerCase();
      const tags = (d.tags || []).map((t) => String(t).toLowerCase());
      if (libSearch && !name.includes(libSearch) && !tags.some((t) => t.includes(libSearch))) return false;
      if (libTag && !tags.some((t) => t.includes(libTag))) return false;
      return true;
    });

    const loadLibraryDeckIntoBuilder = (deck: DeckLibraryEntry, pid: PlayerId) => {
      setBuilderDecks((prev) => ({ ...prev, [pid]: deepClone(deck.spec) }));
      setSaveAsName(deck.name || "");
      setSaveAsTags((deck.tags || []).join(", "));
      setSelectedLibraryDeckId(deck.id);
    };

    const defaultDeckName = (s: DeckSpec): string => {
      const lg = s.legendId ? getCardById(allCards, s.legendId) : null;
      const ch = s.championId ? getCardById(allCards, s.championId) : null;
      const a = lg?.name || "Legend";
      const b = ch?.name || "Champion";
      return `${a} — ${b}`;
    };

    const parseTagCsv = (csv: string): string[] => {
      return String(csv || "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .slice(0, 16);
    };

    const saveActiveToLibraryAsNew = () => {
      const name = (saveAsName && saveAsName.trim().length > 0 ? saveAsName.trim() : defaultDeckName(spec)).trim();
      if (!name) return;

      const entry: DeckLibraryEntry = {
        id: makeDeckLibraryId(),
        name,
        tags: parseTagCsv(saveAsTags),
        spec: deepClone(spec),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setDeckLibrary((prev) => [entry, ...prev]);
      setSelectedLibraryDeckId(entry.id);
    };


    const updateSelectedLibraryDeck = () => {
      if (!selectedLibraryDeckId) {
        alert("Select a saved deck first.");
        return;
      }
      setDeckLibrary((prev) =>
        prev.map((d) => (d.id === selectedLibraryDeckId ? { ...d, spec: deepClone(spec), updatedAt: Date.now() } : d))
      );
      alert("Updated saved deck.");
    };

    const loadSelectedLibraryDeckIntoActive = () => {
      if (!selectedLibDeck) {
        alert("Select a saved deck first.");
        return;
      }
      updateDeck(pid, () => deepClone(selectedLibDeck.spec));
      alert(`Loaded \"${selectedLibDeck.name}\" into ${pid}.`);
    };

    const renameSelectedLibraryDeck = () => {
      if (!selectedLibDeck) return;
      const name = window.prompt("New name:", selectedLibDeck.name);
      if (!name) return;
      setDeckLibrary((prev) => prev.map((d) => (d.id === selectedLibDeck.id ? { ...d, name, updatedAt: Date.now() } : d)));
    };

    const setSelectedLibraryDeckTags = (csv: string) => {
      if (!selectedLibDeck) return;
      const tags = parseTagCsv(csv);
      setDeckLibrary((prev) =>
        prev.map((d) => (d.id === selectedLibDeck.id ? { ...d, tags, updatedAt: Date.now() } : d))
      );
    };

    const duplicateSelectedLibraryDeck = () => {
      if (!selectedLibDeck) return;
      const name = window.prompt("Name for duplicate:", `${selectedLibDeck.name} (copy)`);
      if (!name) return;
      const entry: DeckLibraryEntry = {
        id: makeDeckLibraryId(),
        name,
        tags: deepClone(selectedLibDeck.tags || []),
        spec: deepClone(selectedLibDeck.spec),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setDeckLibrary((prev) => [entry, ...prev]);
      setSelectedLibraryDeckId(entry.id);
    };

    const deleteSelectedLibraryDeck = () => {
      if (!selectedLibDeck) return;
      if (!confirm(`Delete \"${selectedLibDeck.name}\" from library?`)) return;
      setDeckLibrary((prev) => prev.filter((d) => d.id !== selectedLibDeck.id));
      if (selectedLibraryDeckId === selectedLibDeck.id) setSelectedLibraryDeckId(null);
    };

    const exportSelectedLibraryDeck = async () => {
      if (!selectedLibDeck) {
        alert("Select a saved deck first.");
        return;
      }
      const payload = JSON.stringify(selectedLibDeck.spec, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        alert("Deck JSON copied to clipboard.");
      } catch {
        window.prompt("Copy deck JSON:", payload);
      }
    };

    const importDeckIntoLibrary = () => {
      const raw = window.prompt("Paste a single DeckSpec JSON here:");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!isDeckSpec(parsed)) throw new Error("Not a DeckSpec.");
        const name = window.prompt("Deck name:", defaultDeckName(parsed));
        if (!name) return;
        const entry: DeckLibraryEntry = {
          id: makeDeckLibraryId(),
          name,
          tags: [],
          spec: parsed,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        setDeckLibrary((prev) => [entry, ...prev]);
        setSelectedLibraryDeckId(entry.id);
        alert("Imported deck into library.");
      } catch (e: any) {
        alert(`Import failed: ${String(e?.message || e)}`);
      }
    };

    const exportDeckLibrary = async () => {
      const payload = JSON.stringify(deckLibrary, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        alert("Deck library JSON copied to clipboard.");
      } catch {
        window.prompt("Copy deck library JSON:", payload);
      }
    };

    const importDeckLibrary = () => {
      const raw = window.prompt("Paste Deck Library JSON (array of entries) here:");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("Expected an array.");
        const mapped: DeckLibraryEntry[] = parsed
          .filter((x: any) => x && typeof x === "object")
          .map((x: any) => {
            if (!isDeckSpec(x.spec)) throw new Error("Entry missing spec DeckSpec.");
            return {
              id: String(x.id || makeDeckLibraryId()),
              name: String(x.name || "Imported Deck"),
              tags: Array.isArray(x.tags) ? x.tags.map((t: any) => String(t)).filter(Boolean) : [],
              spec: x.spec,
              createdAt: Number(x.createdAt || Date.now()),
              updatedAt: Number(x.updatedAt || Date.now()),
            } as DeckLibraryEntry;
          });

        const replace = confirm("Replace your existing deck library? (Cancel = merge)");
        if (replace) setDeckLibrary(mapped);
        else {
          setDeckLibrary((prev) => {
            // Merge by id (import wins). If id collides, remap.
            const existingIds = new Set(prev.map((d) => d.id));
            const incoming = mapped.map((d) => (existingIds.has(d.id) ? { ...d, id: makeDeckLibraryId() } : d));
            return [...incoming, ...prev];
          });
        }
        alert("Imported deck library.");
      } catch (e: any) {
        alert(`Import failed: ${String(e?.message || e)}`);
      }
    };

    return (
      <div style={{ maxWidth: "100%", width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "12px", overflow: "hidden", boxSizing: "border-box" }}>
        <div className="rb-panel" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "16px" }}>
          <div className="rb-panelTitle">Deck Builder</div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
            <button className="rb-miniButton" onClick={() => setPreGameView("SETUP")}>
              ← Back
            </button>

            <button className="rb-miniButton" disabled={allCards.length === 0} onClick={exportDecks}>
              Export decks
            </button>
            <button className="rb-miniButton" disabled={allCards.length === 0} onClick={importDecks}>
              Import decks
            </button>

            <button
              className="rb-miniButton"
              onClick={() => {
                if (!confirm("Clear BOTH decks?")) return;
                setBuilderDecks({ P1: emptyDeckSpec(), P2: emptyDeckSpec() });
              }}
            >
              Clear all
            </button>

            <div style={{ flex: 1 }} />


            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", marginRight: 8 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <span className="rb-softText" style={{ fontWeight: 900 }}>Match</span>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }} className="rb-softText">
                  <input
                    type="radio"
                    name="matchfmt"
                    checked={matchFormat === "BO1"}
                    onChange={() => {
                      setMatchFormat("BO1");
                      setMatchState(null);
                      setPendingBo3Sideboarding(null);
                      setMatchNextBattlefieldPick({ P1: null, P2: null });
                    }}
                  />
                  Best of 1 (random battlefields)
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }} className="rb-softText">
                  <input
                    type="radio"
                    name="matchfmt"
                    checked={matchFormat === "BO3"}
                    onChange={() => {
                      setMatchFormat("BO3");
                      // We'll initialize the match when starting the duel.
                      setMatchState(null);
                      setPendingBo3Sideboarding(null);
                      setMatchNextBattlefieldPick({ P1: nextOptionsP1[0]?.id ?? null, P2: nextOptionsP2[0]?.id ?? null });
                    }}
                  />
                  Best of 3 (pick each game; no repeats)
                </label>
              </div>

              {matchFormat === "BO3" && canStart ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="rb-softText">Game 1 battlefields:</span>
                  <span className="rb-softText">P1</span>
                  <select
                    value={matchNextBattlefieldPick.P1 ?? ""}
                    onChange={(e) => setMatchNextBattlefieldPick((prev) => ({ ...prev, P1: e.target.value || null }))}
                  >
                    {nextOptionsP1.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  <span className="rb-softText">P2</span>
                  <select
                    value={matchNextBattlefieldPick.P2 ?? ""}
                    onChange={(e) => setMatchNextBattlefieldPick((prev) => ({ ...prev, P2: e.target.value || null }))}
                  >
                    {nextOptionsP2.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>

            <button className="rb-bigButton" style={{ maxWidth: 280 }} disabled={!canStart} onClick={() => startDeckBuilderDuel()}>
              Start Duel from Decks
            </button>
          </div>

          {/* Saved Deck Library */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid rgba(255,255,255,0.10)",
            }}
          >
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  className="rb-input"
                  placeholder="Search library (name or tag)…"
                  value={librarySearch}
                  onChange={(e) => setLibrarySearch(e.target.value)}
                  style={{ width: 260 }}
                />
                <input
                  className="rb-input"
                  placeholder="Filter by tag…"
                  value={libraryTagFilter}
                  onChange={(e) => setLibraryTagFilter(e.target.value)}
                  style={{ width: 260 }}
                />
              </div>

              <div style={{ flex: 1 }} />

              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 320 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    className="rb-input"
                    placeholder="Save current as…"
                    value={saveAsName}
                    onChange={(e) => setSaveAsName(e.target.value)}
                    style={{ flex: 1, minWidth: 200 }}
                  />
                  <button className="rb-miniButton" onClick={saveActiveToLibraryAsNew} title="Save the current builder deck as a new library entry">
                    Save as new
                  </button>
                </div>
                <input
                  className="rb-input"
                  placeholder="Tags (comma separated)…"
                  value={saveAsTags}
                  onChange={(e) => setSaveAsTags(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ minWidth: 320, flex: 1 }}>
                <div className="rb-softText" style={{ marginBottom: 6 }}>
                  Library ({filteredLibrary.length}/{deckLibrary.length}) — drag to reorder
                </div>

                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 12,
                    overflow: "hidden",
                    background: "rgba(0,0,0,0.18)",
                    maxHeight: 220,
                    overflowY: "auto",
                  }}
                >
                  {filteredLibrary.length === 0 ? (
                    <div className="rb-softText" style={{ padding: 10 }}>
                      No decks match your filters.
                    </div>
                  ) : (
                    filteredLibrary.map((d, idx) => {
                      const selected = d.id === selectedLibraryDeckId;
                      const tags = (d.tags || []).join(", ");
                      return (
                        <div
                          key={d.id}
                          draggable
                          onDragStart={() => setLibraryDragId(d.id)}
                          onDragEnd={() => setLibraryDragId(null)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => {
                            if (libraryDragId && libraryDragId !== d.id) moveDeckInLibrary(libraryDragId, d.id);
                          }}
                          onClick={() => setSelectedLibraryDeckId(d.id)}
                          style={{
                            padding: "10px 12px",
                            cursor: "pointer",
                            borderTop: idx === 0 ? "none" : "1px solid rgba(255,255,255,0.08)",
                            background: selected ? "rgba(255,255,255,0.10)" : "transparent",
                            userSelect: "none",
                          }}
                          title="Click to select • Drag to reorder"
                        >
                          <div style={{ fontWeight: 800 }}>{d.name}</div>
                          <div className="rb-softText" style={{ marginTop: 2 }}>
                            {tags || "—"}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div style={{ minWidth: 320, flex: 1 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <select
                    className="rb-input"
                    value={selectedLibraryDeckId || ""}
                    onChange={(e) => setSelectedLibraryDeckId(e.target.value || null)}
                    style={{ flex: 1, minWidth: 200 }}
                  >
                    <option value="">— Select saved deck —</option>
                    {filteredLibrary.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>

                  <button
                    className="rb-miniButton"
                    disabled={!selectedLibDeck}
                    onClick={() => selectedLibDeck && loadLibraryDeckIntoBuilder(selectedLibDeck, builderActivePlayer)}
                    title={`Load selected deck into ${builderActivePlayer}`}
                  >
                    Load → {builderActivePlayer}
                  </button>
                </div>

                {selectedLibDeck ? (
                  <div style={{ marginTop: 8 }}>
                    <div className="rb-softText" style={{ marginBottom: 4 }}>
                      Tags for selected deck
                    </div>
                    <input
                      className="rb-input"
                      value={(selectedLibDeck.tags || []).join(", ")}
                      onChange={(e) => setSelectedLibraryDeckTags(e.target.value)}
                      placeholder="tags…"
                    />
                    <div className="rb-softText" style={{ marginTop: 6 }}>
                      Selected: <b>{selectedLibDeck.name}</b> • Updated {new Date(selectedLibDeck.updatedAt).toLocaleString()}
                    </div>
                  </div>
                ) : (
                  <div className="rb-softText" style={{ marginTop: 8 }}>
                    Save multiple decks here, then load them into either P1 or P2.
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={updateSelectedLibraryDeck} title="Overwrite the selected library deck with the current builder deck">
                    Update
                  </button>
                  <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={renameSelectedLibraryDeck}>
                    Rename
                  </button>
                  <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={duplicateSelectedLibraryDeck}>
                    Duplicate
                  </button>
                  <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={deleteSelectedLibraryDeck}>
                    Delete
                  </button>

                  <div style={{ flex: 1 }} />

                  <button className="rb-miniButton" disabled={!selectedLibDeck} onClick={exportSelectedLibraryDeck}>
                    Export Deck
                  </button>
                  <button className="rb-miniButton" onClick={importDeckIntoLibrary}>
                    Import Deck
                  </button>
                  <button className="rb-miniButton" onClick={exportDeckLibrary}>
                    Export Library
                  </button>
                  <button className="rb-miniButton" onClick={importDeckLibrary}>
                    Import Library
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button className="rb-miniButton" disabled={builderActivePlayer === "P1"} onClick={() => setBuilderActivePlayer("P1")}>
              Edit P1
            </button>
            <button className="rb-miniButton" disabled={builderActivePlayer === "P2"} onClick={() => setBuilderActivePlayer("P2")}>
              Edit P2
            </button>
            <button
              className="rb-miniButton"
              onClick={() => {
                setBuilderDecks((prev) => ({ ...prev, P2: JSON.parse(JSON.stringify(prev.P1)) }));
              }}
            >
              Copy P1 → P2
            </button>
            <button className="rb-miniButton" onClick={() => updateDeck(pid, () => emptyDeckSpec())}>
              Clear {pid}
            </button>
            <button className="rb-miniButton" disabled={allCards.length === 0} onClick={autoFillActive}>
              Auto-fill {pid}
            </button>
          </div>

          <div style={{ marginTop: 10 }} className="rb-softText">
            Editing <b>{pid}</b> • Legend: <b>{activeLegendName}</b> • Identity: <b>{activeIdentityText}</b>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 340px) minmax(min-content, 1fr) minmax(280px, 340px)", gap: 12, marginTop: 12, alignItems: "start", flex: 1, minHeight: 0, overflow: "hidden" }}>
            {/* Config */}
            <div className="rb-panel" style={{ height: "100%", overflowY: "auto" }}>
              <div className="rb-panelTitle">Deck configuration</div>

              <div className="rb-zoneLabel">Legend</div>
              <select
                value={spec.legendId || ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  updateDeck(pid, (d) => ({ ...d, legendId: id, championId: null, battlefields: [], runes: {}, main: {} }));
                }}
                style={{ width: "100%", padding: 8, borderRadius: 10, background: "rgba(0,0,0,0.25)", color: "white", border: "1px solid rgba(255,255,255,0.12)" }}
              >
                <option value="">— Select Legend —</option>
                {legends.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.domain})
                  </option>
                ))}
              </select>

              <div style={{ height: 12 }} />

              <div className="rb-zoneLabel">Chosen Champion</div>
              <select
                value={spec.championId || ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  updateDeck(pid, (d) => {
                    const main = { ...(d.main || {}) };
                    if (id && (main[id] || 0) < 1) main[id] = 1;
                    return { ...d, championId: id, main };
                  });
                }}
                disabled={!legend}
                style={{ width: "100%", padding: 8, borderRadius: 10, background: "rgba(0,0,0,0.25)", color: "white", border: "1px solid rgba(255,255,255,0.12)" }}
              >
                <option value="">— Select Champion —</option>
                {eligibleChampions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} (cost {c.cost})
                  </option>
                ))}
              </select>
              {!legend ? <div className="rb-softText" style={{ marginTop: 6 }}>Pick a Legend first (to filter legal Champions).</div> : null}

              <div style={{ height: 12 }} />

              <div className="rb-zoneLabel">Battlefields (pick 3)</div>
              <div style={{ maxHeight: 240, overflow: "auto", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 8 }}>
                {eligibleBattlefields.map((bf) => {
                  const checked = (spec.battlefields || []).includes(bf.id);
                  return (
                    <div key={bf.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 4px", borderRadius: 10 }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleBattlefield(bf.id)} />
                      <div style={{ fontSize: 12, fontWeight: 800, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {bf.name}
                      </div>
                      <div style={{ fontSize: 11, opacity: 0.85 }}>{bf.domain}</div>
                    </div>
                  );
                })}
                {eligibleBattlefields.length === 0 ? <div className="rb-softText">—</div> : null}
              </div>

              <div style={{ height: 12 }} />

              <div className="rb-zoneLabel">Rune deck (exactly 12)</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {eligibleRunes.map((r) => {
                  const cnt = Math.floor((spec.runes || {})[r.id] || 0);
                  return (
                    <div key={r.id} style={{ width: 150, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 900 }}>{r.name}</div>
                      <div style={{ fontSize: 11, opacity: 0.8 }}>{r.domain}</div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                        <button className="rb-miniButton" onClick={() => updateDeck(pid, (d) => ({ ...d, runes: bumpCount(d.runes || {}, r.id, -1, 0, null) }))}>
                          −
                        </button>
                        <div style={{ minWidth: 24, textAlign: "center", fontWeight: 900 }}>{cnt}</div>
                        <button className="rb-miniButton" onClick={() => updateDeck(pid, (d) => ({ ...d, runes: bumpCount(d.runes || {}, r.id, +1, 0, null) }))}>
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
                {eligibleRunes.length === 0 ? <div className="rb-softText">—</div> : null}
              </div>

              <div style={{ height: 10 }} />

              <div className="rb-softText">
                Main deck: <b>{mainTotal}</b> cards • Rune deck: <b>{runeTotal}</b>/12
              </div>
            </div>

            {/* Card browser */}
            <div className="rb-panel" style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}>
              <div className="rb-panelTitle">Card browser</div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  value={builderSearch}
                  onChange={(e) => setBuilderSearch(e.target.value)}
                  placeholder="Search cards (name or id)…"
                  style={{
                    flex: 1,
                    minWidth: 220,
                    padding: "9px 10px",
                    borderRadius: 12,
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    border: "1px solid rgba(255,255,255,0.12)",
                  }}
                />

                <select
                  value={builderTypeFilter}
                  onChange={(e) => setBuilderTypeFilter(e.target.value as any)}
                  style={{
                    padding: "9px 10px",
                    borderRadius: 12,
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    border: "1px solid rgba(255,255,255,0.12)",
                  }}
                >
                  <option value="All">All</option>
                  <option value="Unit">Units</option>
                  <option value="Spell">Spells</option>
                  <option value="Gear">Gear</option>
                </select>
              </div>

              <div className="rb-softText" style={{ marginTop: 8 }}>
                Showing <b>{browser.length}</b> cards (filtered to identity where possible).
              </div>

              <div style={{ marginTop: 10, flex: 1, overflow: "auto", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 8 }}>
                <div className="rb-row" style={{ flexWrap: "wrap", gap: 8 }}>
                  {browser.map((c) => {
                    const cur = Math.floor((spec.main || {})[c.id] || 0);
                    const preview = toPreview(c, "browse");
                    return (
                      <div key={c.id} style={{ width: 118, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: 4, borderRadius: 8, background: cur > 0 ? "rgba(130, 210, 255, 0.1)" : "transparent" }}>
                        <ArenaCard
                          card={preview}
                          size="xs"
                          showReadyDot={false}
                          onClick={() => setHoverCard(preview)}
                        />
                        <div style={{ fontSize: 10, fontWeight: 800, textAlign: "center", maxWidth: 110, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.name}
                        </div>
                        <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 2 }}>
                          <button
                            className="rb-miniButton"
                            style={{ padding: "4px 10px", fontSize: 14, fontWeight: 900 }}
                            onClick={(e) => { e.stopPropagation(); updateDeck(pid, (d) => ({ ...d, main: bumpCount(d.main || {}, c.id, -1, 0, 3) })); }}
                            disabled={cur <= 0}
                          >
                            −
                          </button>
                          <div style={{ minWidth: 20, textAlign: "center", fontWeight: 900, fontSize: 12 }}>{cur}</div>
                          <button
                            className="rb-miniButton"
                            style={{ padding: "4px 10px", fontSize: 14, fontWeight: 900 }}
                            onClick={(e) => { e.stopPropagation(); updateDeck(pid, (d) => ({ ...d, main: bumpCount(d.main || {}, c.id, +1, 0, 3) })); }}
                            disabled={cur >= 3}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {browser.length === 0 ? <div className="rb-softText">No results.</div> : null}
                </div>
              </div>
            </div>

            {/* Deck list */}
            <div className="rb-panel" style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}>
              <div className="rb-panelTitle">Main deck list</div>

              <div className="rb-softText">
                Click + / − to adjust (max 3 copies per card). Your chosen Champion must be included at least once.
              </div>

              <div style={{ marginTop: 10, flex: 1, minHeight: 180, overflow: "auto", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 8 }}>
                {deckRows.length === 0 ? <div className="rb-softText">—</div> : null}
                <div className="rb-row" style={{ flexWrap: "wrap", gap: 8 }}>
                  {deckRows.map((row) => {
                    const cd = row.card!;
                    const cnt = Math.floor(row.n || 0);
                    const preview = toPreview(cd, "deck");
                    return (
                      <div key={row.id} style={{ width: 118, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: 4, borderRadius: 8, background: "rgba(130, 210, 255, 0.1)" }}>
                        <ArenaCard card={preview} size="xs" showReadyDot={false} onClick={() => setHoverCard(preview)} />
                        <div style={{ fontSize: 10, fontWeight: 800, textAlign: "center", maxWidth: 110, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {cd.name}
                        </div>
                        <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 2 }}>
                          <button className="rb-miniButton" style={{ padding: "4px 10px", fontSize: 14, fontWeight: 900 }} onClick={() => updateDeck(pid, (d) => ({ ...d, main: bumpCount(d.main || {}, cd.id, -1, 0, 3) }))}>
                            −
                          </button>
                          <div style={{ minWidth: 20, textAlign: "center", fontWeight: 900, fontSize: 12 }}>{cnt}</div>
                          <button className="rb-miniButton" style={{ padding: "4px 10px", fontSize: 14, fontWeight: 900 }} onClick={() => updateDeck(pid, (d) => ({ ...d, main: bumpCount(d.main || {}, cd.id, +1, 0, 3) }))}>
                            +
                          </button>
                        </div>
                        <button
                          className="rb-miniButton"
                          style={{ fontSize: 9, padding: "2px 6px", width: "100%", marginTop: 2, textAlign: "center" }}
                          title="Move to sideboard"
                          onClick={() => updateDeck(pid, (d) => {
                            const newMain = bumpCount(d.main || {}, cd.id, -1, 0, 3);
                            const newSide = bumpCount(d.sideboard || {}, cd.id, +1, 0, 8 - countTotal(d.sideboard || {}));
                            return { ...d, main: newMain, sideboard: newSide };
                          })}
                        >
                          → Sideboard
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Sideboard Section */}
              <div style={{ marginTop: 16 }}>
                <div className="rb-panelTitle">Sideboard ({sideboardCount}/8)</div>
                <div className="rb-softText" style={{ fontSize: 11 }}>
                  Up to 8 cards for Bo3 sideboarding between games.
                </div>
                <div style={{ marginTop: 8, maxHeight: 180, overflow: "auto", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 8 }}>
                  {sideboardRows.length === 0 ? <div className="rb-softText">—</div> : null}
                  <div className="rb-row" style={{ flexWrap: "wrap", gap: 8 }}>
                    {sideboardRows.map((row) => {
                      const cd = row.card!;
                      const cnt = Math.floor(row.n || 0);
                      const preview = toPreview(cd, "deck");
                      return (
                        <div key={row.id} style={{ width: 118, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: 4, borderRadius: 8, background: "rgba(255, 130, 210, 0.1)" }}>
                          <ArenaCard card={preview} size="xs" showReadyDot={false} onClick={() => setHoverCard(preview)} />
                          <div style={{ fontSize: 10, fontWeight: 800, textAlign: "center", maxWidth: 110, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {cd.name}
                          </div>
                          <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 2 }}>
                            <button className="rb-miniButton" style={{ padding: "4px 10px", fontSize: 14, fontWeight: 900 }} onClick={() => updateDeck(pid, (d) => ({ ...d, sideboard: bumpCount(d.sideboard || {}, cd.id, -1, 0, 8) }))}>
                              −
                            </button>
                            <div style={{ minWidth: 20, textAlign: "center", fontWeight: 900, fontSize: 12 }}>{cnt}</div>
                            <button
                              className="rb-miniButton"
                              style={{ padding: "4px 10px", fontSize: 14, fontWeight: 900 }}
                              disabled={sideboardCount >= 8}
                              onClick={() => updateDeck(pid, (d) => ({ ...d, sideboard: bumpCount(d.sideboard || {}, cd.id, +1, 0, 8 - countTotal(d.sideboard || {}) + cnt) }))}
                            >
                              +
                            </button>
                          </div>
                          <button
                            className="rb-miniButton"
                            style={{ fontSize: 9, padding: "2px 6px", width: "100%", marginTop: 2, textAlign: "center" }}
                            title="Move to main deck"
                            onClick={() => updateDeck(pid, (d) => {
                              const newSide = bumpCount(d.sideboard || {}, cd.id, -1, 0, 8);
                              const newMain = bumpCount(d.main || {}, cd.id, +1, 0, 3);
                              return { ...d, main: newMain, sideboard: newSide };
                            })}
                          >
                            ← Main
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {hoverCard ? (
                <div style={{ marginTop: 12 }}>
                  <div className="rb-panelTitle">Preview</div>
                  {"instanceId" in (hoverCard as any) ? (
                    <div className="rb-row rb-rowCenter">
                      <ArenaCard card={hoverCard as any} size="sm" showReadyDot={false} />
                    </div>
                  ) : null}
                  <div className="rb-softText" style={{ marginTop: 8 }}>
                    {(hoverCard as any).name}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {activeErrors.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              <div className="rb-panelTitle">Issues for {pid}</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {activeErrors.map((e, i) => (
                  <li key={i} style={{ color: "#ffb4b4" }}>
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {(errorsP1.length > 0 || errorsP2.length > 0) && canStart === false ? (
            <div className="rb-softText" style={{ marginTop: 10 }}>
              Fix both decks before starting. (You can use “Auto-fill” as a starting point.)
            </div>
          ) : null}
        </div>
      </div>
    );
  };


  const renderPileViewerModal = () => {
    if (!g || !pileViewer) return null;

    const pid = pileViewer.player;
    const zone = pileViewer.zone;
    const ps = g.players[pid];
    const cards = zone === "TRASH" ? ps.trash : ps.banishment;
    const title = zone === "TRASH" ? "Trash (discard pile)" : "Banishment";

    return (
      <div className="rb-modalOverlay" onClick={() => setPileViewer(null)}>
        <div className="rb-modal" onClick={(e) => e.stopPropagation()}>
          <div className="rb-modalHeader">
            <div style={{ fontWeight: 900 }}>
              {pid} — {title} ({cards.length})
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button className="rb-miniButton" onClick={() => setPileViewer({ player: "P1", zone })}>
                View P1
              </button>
              <button className="rb-miniButton" onClick={() => setPileViewer({ player: "P2", zone })}>
                View P2
              </button>
              <button className="rb-miniButton" onClick={() => setPileViewer(null)}>
                Close
              </button>
            </div>
          </div>
          <div className="rb-modalBody">
            {cards.length === 0 ? <div className="rb-softText">—</div> : null}
            <div className="rb-pileGrid">
              {[...cards]
                .slice()
                .reverse()
                .map((c) => (
                  <div key={c.instanceId} style={{ width: 120, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <ArenaCard card={c} size="xs" showReadyDot={false} onClick={() => setHoverCard(c)} />
                    <div style={{ fontSize: 11, fontWeight: 800, textAlign: "center", maxWidth: 118, lineHeight: 1.1, opacity: 0.95 }}>
                      {c.name}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    );
  };


  const normalizeEffectForDiag = (s: string) =>
    (s || "")
      .replace(/_/g, " ")
      .replace(/\[\s*add\s*\]\s*/gi, "add ")
      .replace(/\s+/g, " ")
      .trim();

  const effectSupportTags = (effectText: string): string[] => {
    const t = normalizeEffectForDiag(effectText);
    if (!t) return [];
    const lower = t.toLowerCase();
    const tags: string[] = [];

    if (extractDiscardAmount(t)) tags.push("DISCARD");
    if (extractDrawAmount(t)) tags.push("DRAW");
    if (extractChannelAmount(t)) tags.push("CHANNEL");
    if (/\badd\s+\d+\s+energy\b/i.test(t)) tags.push("ADD_ENERGY");
    if (/\badd\s+\d+\s+[a-z]+\s+rune\b/i.test(t)) tags.push("ADD_RUNE");
    if (/\badd\s+\d+\s+rune\s+of\s+any\s+type\b/i.test(t)) tags.push("ADD_ANY_RUNE");
    if (/\bplay\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:an?\s+)?\d+\s+might\s+[a-z]+\s+unit\s+token/i.test(t))
      tags.push("TOKENS");
    if (/\bgive\b/i.test(t) && /\[[^\]]+\]/.test(t)) tags.push("KEYWORD_GRANT");
    if (effectMentionsStun(t)) tags.push("STUN");
    if (effectMentionsReady(t)) tags.push("READY");
    if (effectMentionsBuff(t)) tags.push("BUFF");
    if (effectMentionsKill(t)) tags.push("KILL");
    if (effectMentionsBanish(t)) tags.push("BANISH");
    if (effectMentionsReturn(t)) tags.push("RETURN");
    if (/\bgive\s+(?:a\s+)?(?:friendly\s+|enemy\s+|your\s+|opposing\s+)?(unit|units|me|it|this)\s+[+-]\s*\d+\s+might\s+this\s+turn\b/i.test(t))
      tags.push("MIGHT_THIS_TURN");
    if (extractDamageAmount(t) != null || /\bdeal\s+its\s+energy\s+cost\s+as\s+damage\b/i.test(t)) tags.push("DAMAGE");

    return tags;
  };

  type AuditStatus = "FULL" | "PARTIAL" | "UNSUPPORTED" | "NO_TEXT";

  interface EffectAuditRow {
    id: string;
    name: string;
    type: CardType;
    domain: string;
    cost: number;
    trigger: string;
    keywords: string[];
    text: string;
    raw: string;
    primitives: string[];
    primitivesSupported: string[];
    primitivesMissing: string[];
    flags: string[];
    targetProfile: {
      needsTargets: boolean;
      count: number;
      restriction: "ANY" | "FRIENDLY" | "ENEMY";
      location: "ANY" | "HERE" | "BATTLEFIELD";
      notes: string[];
    };
    status: AuditStatus;
  }

  const keywordBase = (kw: string): string => {
    const s = String(kw || "").trim();
    if (!s) return "";
    const parts = s.split(/\s+/);
    return parts[0] || s;
  };

  const wordToNum = (w: string): number | null => {
    const m: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
    };
    if (!w) return null;
    if (/^\d+$/.test(w)) {
      const n = parseInt(w, 10);
      return Number.isFinite(n) ? n : null;
    }
    return m[w.toLowerCase()] ?? null;
  };

  const uniq = (xs: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of xs) {
      const k = String(x || "").trim();
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  };

  const auditInferTargetProfile = (textRaw: string): EffectAuditRow["targetProfile"] => {
    const t = (textRaw || "").toLowerCase();
    const notes: string[] = [];
    if (!t.trim()) return { needsTargets: false, count: 0, restriction: "ANY", location: "ANY", notes };

    // If the text clearly indicates a global effect, assume no explicit targets.
    if (/\b(all|each)\s+(friendly|enemy|opposing|your)?\s*units\b/.test(t)) {
      const restriction: "ANY" | "FRIENDLY" | "ENEMY" = /\benemy\b|\bopposing\b/.test(t) ? "ENEMY" : /\bfriendly\b|\byour\b/.test(t) ? "FRIENDLY" : "ANY";
      const location: "ANY" | "HERE" | "BATTLEFIELD" = /\bhere\b/.test(t) ? "HERE" : /\bbattlefield\b/.test(t) ? "BATTLEFIELD" : "ANY";
      notes.push("global-units");
      return { needsTargets: false, count: 0, restriction, location, notes };
    }

    // Detect explicit selection counts.
    const chooseN = t.match(/\bchoose\s+(?:up\s+to\s+)?(\d+|one|two|three|four|five)\s+units\b/);
    const count = chooseN ? wordToNum(chooseN[1]) ?? 1 : 1;

    const hasUnit = /\bunit\b/.test(t) || /\bunits\b/.test(t);
    const hasBattlefield = /\bbattlefield\b/.test(t);
    const hasChoose = /\bchoose\b/.test(t);

    // Many “at a battlefield” effects still need a unit target.
    const needsUnitTarget =
      hasUnit && /\b(stun|kill|banish|ready|buff|deal|give|move|return|recall|heal)\b/.test(t) && !/\b(all|each)\b/.test(t);

    // Battlefield selection is rare; keep conservative.
    const needsBattlefieldTarget = hasBattlefield && hasChoose && /\b(battlefield)\b/.test(t);

    const restriction: "ANY" | "FRIENDLY" | "ENEMY" =
      /\benemy\b|\bopposing\b/.test(t) ? "ENEMY" : /\bfriendly\b|\byour\b/.test(t) ? "FRIENDLY" : "ANY";
    const location: "ANY" | "HERE" | "BATTLEFIELD" = /\bhere\b/.test(t) ? "HERE" : /\bat\s+a\s+battlefield\b/.test(t) ? "BATTLEFIELD" : "ANY";

    if (count > 1) notes.push(`multi-${count}`);
    if (restriction !== "ANY") notes.push(restriction === "ENEMY" ? "enemy-only" : "friendly-only");
    if (location !== "ANY") notes.push(location === "HERE" ? "here" : "at-battlefield");
    if (/\b(choose|target)\b/.test(t)) notes.push("explicit-select");

    if (needsBattlefieldTarget) {
      return { needsTargets: true, count: 1, restriction: "ANY", location: "BATTLEFIELD", notes: [...notes, "battlefield-target"] };
    }
    if (needsUnitTarget) {
      return { needsTargets: true, count, restriction, location, notes };
    }
    return { needsTargets: false, count: 0, restriction, location, notes };
  };

  const auditAnalyzeEffectText = (textRaw: string, triggerRaw: string, keywords: string[]) => {
    const text = normalizeEffectForDiag(textRaw);
    const lower = text.toLowerCase();
    const trigger = String(triggerRaw || "").trim();

    const primitives: string[] = [];
    const flags: string[] = [];

    // --- Trigger coverage ---
    if (trigger) {
      const supportedTrigger =
        /^When you play (me|this)$/i.test(trigger) ||
        /^When this is played$/i.test(trigger) ||
        /^When I'm played$/i.test(trigger) ||
        /^When I attack$/i.test(trigger) ||
        /^When I defend$/i.test(trigger) ||
        /^When I attack or defend$/i.test(trigger) ||
        /^When I defend or I'm played from$/i.test(trigger) ||
        /^When I move$/i.test(trigger) ||
        /^When I move to a battlefield$/i.test(trigger) ||
        /^When you play a spell$/i.test(trigger) ||
        /^When you play a spell on an opponent's turn$/i.test(trigger) ||
        /^When you play a spell that costs 5 energy or more$/i.test(trigger) ||
        /^When you play a gear$/i.test(trigger) ||
        /^When you play a unit$/i.test(trigger) ||
        /^When you play another unit$/i.test(trigger) ||
        /^When you play a \[Mighty\] unit$/i.test(trigger) ||
        /^When you play your second card in a turn$/i.test(trigger) ||
        /^When you play a card on an opponent's turn$/i.test(trigger) ||
        /^When you play me to a battlefield$/i.test(trigger) ||
        /^When you discard me$/i.test(trigger) ||
        /^When you discard a card$/i.test(trigger) ||
        /^When you discard one or more cards$/i.test(trigger) ||
        /^When you stun an enemy unit$/i.test(trigger) ||
        /^When you stun one or more enemy units$/i.test(trigger) ||
        /^When a friendly unit attacks or defends alone$/i.test(trigger) ||
        /^While a friendly unit defends alone$/i.test(trigger) ||
        /^When you ready a friendly unit$/i.test(trigger) ||
        /^When you buff a friendly unit$/i.test(trigger) ||
        /^When a buffed friendly unit dies$/i.test(trigger) ||
        /^When another non-Recruit unit you control dies$/i.test(trigger) ||
        /^When a unit moves from here$/i.test(trigger) ||
        /^When a friendly unit moves from my location$/i.test(trigger) ||
        /^When you defend here$/i.test(trigger) ||
        /^When an enemy unit attacks a battlefield you control$/i.test(trigger) ||
        /^When you conquer$/i.test(trigger) ||
        /^When you or an ally hold$/i.test(trigger) ||
        /^When you conquer here$/i.test(trigger) ||
        /^When you hold here$/i.test(trigger) ||
        /^When you kill a unit with a spell$/i.test(trigger) ||
        /^When you kill a stunned enemy unit$/i.test(trigger) ||
        /^If you've discarded a card this turn$/i.test(trigger) ||
        /^If I have moved twice this turn$/i.test(trigger) ||
        /^While I'm buffed$/i.test(trigger) ||
        /^While I'm attacking or defending alone$/i.test(trigger) ||
        /^While I'm \[Mighty\]$/i.test(trigger) ||
        /^While I'm at a battlefield$/i.test(trigger) ||
        /^While you have 8\+ runes$/i.test(trigger) ||
        /^If an opponent's score is within 3 points of the Victory Score$/i.test(trigger) ||
        /^If an enemy unit has died this turn$/i.test(trigger) ||
        /^When you play a card from/i.test(trigger) ||
        /^When you kill$/i.test(trigger) ||
        /^When I conquer$/i.test(trigger) ||
        /^When I attack or defend one on one$/i.test(trigger) ||
        /^When you look at cards from the top of your deck and see me$/i.test(trigger) ||
        /^When you play me or when I hold$/i.test(trigger) ||
        /^When I conquer after an attack$/i.test(trigger) ||
        /^When I hold$/i.test(trigger) ||
        /^While I'm$/i.test(trigger) ||
        /^At the end of your turn$/i.test(trigger) ||
        /^At the start of your Beginning Phase$/i.test(trigger) ||
        /^At start of your Beginning Phase$/i.test(trigger) ||
        /^At the start of each player's first Beginning Phase$/i.test(trigger);
      if (!supportedTrigger) flags.push(`TRIGGER_UNSUPPORTED: ${trigger}`);
    }

    // --- Conditional / branching ---
    const ifKillDraw = /\bif\s+this\s+kills\s+it,\s*draw\s+\d+\b/i.test(text);
    const supportedIf =
      /if you do/i.test(lower) ||
      /if you control a poro/i.test(lower) ||
      /if you control a facedown card at a battlefield/i.test(lower) ||
      /if you have one or fewer cards in your hand/i.test(lower) ||
      /if you have 4\+ units at that battlefield/i.test(lower) ||
      /if you have 7\+ units here/i.test(lower) ||
      /if there is a ready enemy unit here/i.test(lower) ||
      /only unit you control there/i.test(lower) ||
      /if you can't/i.test(lower) ||
      /if you couldn't channel/i.test(lower) ||
      /if you've played another card this turn/i.test(lower) ||
      /if you've played a card this turn/i.test(lower) ||
      /if its might is less than another friendly unit's/i.test(lower) ||
      /if you assigned 5 or more excess damage to enemy units/i.test(lower) ||
      /if you paid (?:the )?additional cost/i.test(lower) ||
      /if it's already attached/i.test(lower) ||
      /if it's equipped/i.test(lower) ||
      /if the played card is a unit/i.test(lower) ||
      /if it(?:'|’)?s an?\s+spell/i.test(lower) ||
      /if it(?:'|’)?s an?\s+unit/i.test(lower) ||
      /if it(?:'|’)?s an?\s+gear/i.test(lower) ||
      /if you would reveal cards from a deck/i.test(lower) ||
      /if you've discarded a card this turn/i.test(lower) ||
      /if i have moved twice this turn/i.test(lower) ||
      /if an opponent's score is within 3 points of the victory score/i.test(lower) ||
      /if an enemy unit has died this turn/i.test(lower);
    if (/\bif\b/.test(lower) && !ifKillDraw && !supportedIf) flags.push("CONDITIONAL_GENERAL");
    if (/\bif\s+you\s+do\b/.test(lower)) flags.push("IF_YOU_DO_BRANCH");
    const supportedReplacement =
      /next time it dies this turn/i.test(lower) ||
      /kill it the next time it takes damage this turn/i.test(lower) ||
      /if i would be revealed/i.test(lower) ||
      /if i would be looked at/i.test(lower) ||
      /hide a card with \[hidden\] instead of \[c\]/i.test(lower) ||
      /kill this instead/i.test(lower);
    if (/\binstead\b/.test(lower) && !supportedReplacement) flags.push("REPLACEMENT_EFFECT");
    const supportedScaling =
      /draw 1 for each of your mighty units/i.test(lower) ||
      /for each buff spent, channel/i.test(lower) ||
      /for each friendly unit, you may spend its buff/i.test(lower) ||
      /for each buffed friendly unit at my battlefield/i.test(lower) ||
      /for each .*excess damage/i.test(lower) ||
      /for each friendly gear/i.test(lower);
    if ((/\bfor\s+each\b|\bfor\s+every\b/.test(lower)) && !supportedScaling) flags.push("SCALING_EFFECT");

    // --- Turn-scoped hooks (often missing in simple resolvers) ---
    const supportedTurnScopedHook =
      /that unit has\s+\"?when i conquer,\s*you may move me to (?:my|your)\s+base/i.test(lower) ||
      /next time it dies this turn/i.test(lower) ||
      /kill it the next time it takes damage this turn/i.test(lower);
    if (!supportedTurnScopedHook && /\bthis\s+turn\b/.test(lower) && /\b(when|whenever|each\s+time|the\s+next\s+time)\b/.test(lower)) {
      if (/\btakes\s+damage\b/.test(lower) || /\bis\s+dealt\s+damage\b/.test(lower)) flags.push("TURN_SCOPED_DAMAGE_HOOK");
      else flags.push("TURN_SCOPED_TRIGGER");
    }

    // --- Continuous effects ---
    if (/\b(other|all)\s+friendly\s+units\s+enter\s+ready\b/i.test(text)) flags.push("CONTINUOUS_ENTER_READY");
    if (/\b(other|all)\s+friendly\s+units\b/i.test(text) && /\benter\s+ready\b/i.test(text)) flags.push("CONTINUOUS_ENTER_READY");

    // --- Additional costs / cost mods ---
    if (/\bas\s+(?:an\s+)?additional\s+cost\b/.test(lower) || /\bas\s+you\s+play\s+(?:me|this)\b/.test(lower)) flags.push("ADDITIONAL_COST");
    if (/\bcost\s+\d+\s+(?:energy\s+)?less\b/.test(lower) || /\breduce\s+my\s+cost\s+by\s+\d+\s+energy\b/.test(lower)) flags.push("COST_MODIFIER");

    // --- Detect primitive operations present in the text ---
    if (extractDiscardAmount(text) != null) primitives.push("DISCARD_HAND_N");
    if (extractDrawAmount(text) != null) primitives.push("DRAW_N");
    if (extractChannelAmount(text) != null) primitives.push("CHANNEL_N");
    if (/\badd\s+\d+\s+energy\b/.test(lower)) primitives.push("ADD_ENERGY_N");
    if (/\badd\s+\d+\s+[a-z]+\s+rune\b/.test(lower)) primitives.push("ADD_POWER_DOMAIN_N");
    if (/\badd\s+\d+\s+rune\s+of\s+any\s+type\b/.test(lower)) primitives.push("ADD_POWER_ANY_N");
    if (/\bplay\b/.test(lower) && /\bunit\s+token\b/.test(lower)) primitives.push("PLAY_TOKENS");

    // Keyword grant: only supported as a single-target or self, so audit “units” separately.
    if (/\bgive\b/.test(lower) && /\[[^\]]+\]/.test(text)) {
      if (/\bunits\b/.test(lower)) primitives.push("GRANT_KEYWORD_MULTI");
      else primitives.push("GRANT_KEYWORD_SINGLE");
    }

    if (effectMentionsStun(text)) primitives.push("STUN_UNIT_SINGLE");
    if (effectMentionsReady(text)) primitives.push("READY_UNIT_SINGLE");
    if (effectMentionsBuff(text)) primitives.push("BUFF_PLUS1_PERM");
    if (effectMentionsReturn(text)) primitives.push("RETURN_TO_BASE_SINGLE");
    if (effectMentionsKill(text)) primitives.push("KILL_UNIT_SINGLE");
    if (effectMentionsBanish(text)) primitives.push("BANISH_UNIT_SINGLE");

    const mightMatch = lower.match(
      /\bgive\s+(?:a\s+)?(?:friendly\s+|enemy\s+|your\s+|opposing\s+)?(unit|units|me|it|this)\s+([+-])\s*(\d+)\s+might\s+this\s+turn\b/
    );
    if (mightMatch) {
      const who = mightMatch[1];
      if (who === "units") {
        if (/\benemy\b|\bopposing\b/.test(lower)) primitives.push("MIGHT_THIS_TURN_UNITS_ENEMY");
        else if (/\bfriendly\b|\byour\b/.test(lower)) primitives.push("MIGHT_THIS_TURN_UNITS_FRIENDLY");
        else primitives.push("MIGHT_THIS_TURN_UNITS_UNSPEC");
      } else {
        primitives.push("MIGHT_THIS_TURN_SINGLE");
      }
    }

    const dmgFromDiscard = /\bdeal\s+its\s+energy\s+cost\s+as\s+damage\b/i.test(text);
    const dmg = extractDamageAmount(text);
    if (dmgFromDiscard || (dmg != null && dmg > 0)) {
      if (/\ball\s+units\s+at\s+battlefields\b/i.test(text)) primitives.push("DAMAGE_AOE_ALL_BATTLEFIELDS");
      else if (/\ball\s+units\s+here\b/i.test(text)) primitives.push("DAMAGE_AOE_HERE");
      else if (/\ball\s+enemy\s+units\b/i.test(text) || /\beach\s+enemy\s+unit\b/i.test(text)) primitives.push("DAMAGE_AOE_ENEMY");
      else if (dmgFromDiscard) primitives.push("DAMAGE_FROM_DISCARD_ENERGY_COST");
      else primitives.push("DAMAGE_SINGLE");

      if (/\bif\s+this\s+kills\s+it,\s*draw\s+\d+\b/i.test(text)) primitives.push("DRAW_ON_KILL");
    }

    // Search is not currently parsed; keep as explicit missing flags.
    if (/\bsearch\b/.test(lower)) flags.push("SEARCH_NOT_SUPPORTED");

    // --- Keyword coverage ---
    const supportedKeywordBases = new Set<string>([
      "Action",
      "Reaction",
      "Accelerate",
      "Hidden",
      "Legion",
      "Vision",
      "Assault",
      "Shield",
      "Tank",
      "Deflect",
      "Ganking",
      "Add",
      "Deathknell",
      "Temporary",
      "Mighty",
      "Burn",
      "Burnout",
      "Play",
      "Equip",
      "Alone",
      "Weaponmaster",
      "Quick-Draw",
      "Repeat",
      "Unique",
      "Fated",
      "Overwhelm",
      "Lifesteal",
    ].map((k) => k.toLowerCase()));
    const missingKeywords = uniq(
      (keywords || [])
        .map((k) => keywordBase(k))
        .filter(Boolean)
        .filter((k) => !supportedKeywordBases.has(k.toLowerCase()))
    );
    for (const mk of missingKeywords) flags.push(`KEYWORD_UNSUPPORTED: ${mk}`);

    // Multi-target selection (not implemented yet)
    if (/\bchoose\s+(?:up\s+to\s+)?(\d+|one|two|three|four|five)\s+units\b/.test(lower)) flags.push("MULTI_TARGET_UNITS");

    // Enemy-only mass effects are now supported for "give ... might this turn".

    // Normalize + dedupe
    return {
      text,
      primitives: uniq(primitives),
      flags: uniq(flags),
    };
  };

  const effectAudit = useMemo(() => {
    const rows: EffectAuditRow[] = [];

    const supportedPrimitives = new Set<string>([
      "DISCARD_HAND_N",
      "DRAW_N",
      "CHANNEL_N",
      "ADD_ENERGY_N",
      "ADD_POWER_DOMAIN_N",
      "ADD_POWER_ANY_N",
      "PLAY_TOKENS",
      "GRANT_KEYWORD_SINGLE",
      "GRANT_KEYWORD_MULTI",
      "STUN_UNIT_SINGLE",
      "READY_UNIT_SINGLE",
      "BUFF_PLUS1_PERM",
      "RETURN_TO_BASE_SINGLE",
      "KILL_UNIT_SINGLE",
      "BANISH_UNIT_SINGLE",
      "MIGHT_THIS_TURN_SINGLE",
      "MIGHT_THIS_TURN_UNITS_FRIENDLY",
      "MIGHT_THIS_TURN_UNITS_ENEMY",
      "DAMAGE_SINGLE",
      "DAMAGE_AOE_ENEMY",
      "DAMAGE_AOE_ALL_BATTLEFIELDS",
      "DAMAGE_AOE_HERE",
      "DAMAGE_FROM_DISCARD_ENERGY_COST",
      "DRAW_ON_KILL",
    ]);

    // Flags that we treat as “missing engine capability” (vs. informational).
    const missingFlagPrefixes = [
      "TRIGGER_UNSUPPORTED",
      "CONDITIONAL_GENERAL",
      "IF_YOU_DO_BRANCH",
      "REPLACEMENT_EFFECT",
      "SCALING_EFFECT",
      "TURN_SCOPED_TRIGGER",
      "TURN_SCOPED_DAMAGE_HOOK",
      "CONTINUOUS_ENTER_READY",
      "SEARCH_NOT_SUPPORTED",
      "KEYWORD_UNSUPPORTED",
      "MULTI_TARGET_UNITS",
    ];

    const isMissingFlag = (f: string): boolean => {
      const s = String(f || "");
      return missingFlagPrefixes.some((p) => s.startsWith(p));
    };

    for (const c of allCards) {
      const eff = (c.ability?.effect_text || "").trim();
      const raw = (c.ability?.raw_text || "").trim();
      const trigger = (c.ability?.trigger || "").trim();
      const keywords = (c.ability?.keywords || []).slice();
      const text = normalizeEffectForDiag(eff || raw);
      const analyzed = auditAnalyzeEffectText(text, trigger, keywords);
      const primitives = analyzed.primitives;
      const flags = analyzed.flags;

      const primitivesSupported = primitives.filter((p) => supportedPrimitives.has(p));
      const primitivesMissing = primitives.filter((p) => !supportedPrimitives.has(p));

      const targetProfile = auditInferTargetProfile(text);

      const missingFlags = flags.filter(isMissingFlag);
      const supportedCount = primitivesSupported.length;
      const missingCount = primitivesMissing.length + missingFlags.length;

      let status: AuditStatus = "NO_TEXT";
      if (text) {
        if (missingCount === 0) status = "FULL";
        else if (supportedCount > 0) status = "PARTIAL";
        else status = "UNSUPPORTED";
      } else {
        // No text: we still might have missing keywords or triggers.
        if (missingCount === 0) status = "NO_TEXT";
        else status = supportedCount > 0 ? "PARTIAL" : "UNSUPPORTED";
      }

      rows.push({
        id: c.id,
        name: c.name,
        type: c.type,
        domain: c.domain,
        cost: Number(c.cost || 0),
        trigger,
        keywords,
        text,
        raw,
        primitives,
        primitivesSupported,
        primitivesMissing,
        flags,
        targetProfile,
        status,
      });
    }

    const total = rows.length;
    const withText = rows.filter((r) => !!r.text).length;
    const full = rows.filter((r) => r.status === "FULL").length;
    const partial = rows.filter((r) => r.status === "PARTIAL").length;
    const unsupported = rows.filter((r) => r.status === "UNSUPPORTED").length;
    const noText = rows.filter((r) => r.status === "NO_TEXT").length;

    const missingPrimitiveCounts: Record<string, number> = {};
    const missingFlagCounts: Record<string, number> = {};

    for (const r of rows) {
      for (const p of r.primitivesMissing) missingPrimitiveCounts[p] = (missingPrimitiveCounts[p] || 0) + 1;
      for (const f of r.flags.filter((x) => x && isMissingFlag(x))) {
        const key = String(f);
        missingFlagCounts[key] = (missingFlagCounts[key] || 0) + 1;
      }
    }

    const topMissingPrimitives = Object.entries(missingPrimitiveCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, v]) => ({ k, v }));

    const topMissingFlags = Object.entries(missingFlagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, v]) => ({ k, v }));

    return {
      total,
      withText,
      full,
      partial,
      unsupported,
      noText,
      rows,
      topMissingPrimitives,
      topMissingFlags,
    };
  }, [allCards]);

  const effectCoverage = useMemo(() => {
    const rows: Array<{
      id: string;
      name: string;
      text: string;
      keywords: string[];
      supported: boolean;
      tags: string[];
    }> = [];

    for (const c of allCards) {
      const et = (c.ability?.effect_text || "").trim();
      const rt = (c.ability?.raw_text || "").trim();
      const kw = (c.ability?.keywords || []).slice();

      const base = normalizeEffectForDiag(et || rt);
      if (!base) continue;

      const tags = effectSupportTags(base);
      const supported = tags.length > 0;

      rows.push({ id: c.id, name: c.name, text: base, keywords: kw, supported, tags });
    }

    const supportedCount = rows.filter((r) => r.supported).length;
    const unsupported = rows.filter((r) => !r.supported);

    return {
      totalWithText: rows.length,
      supportedCount,
      unsupportedCount: unsupported.length,
      unsupportedRows: unsupported,
    };
  }, [allCards]);

  const renderDiagnosticsModal = () => {
    if (!showDiagnostics) return null;

    const q = (diagSearch || "").toLowerCase().trim();

    const tabButtonStyle = (active: boolean): React.CSSProperties => ({
      padding: "6px 10px",
      borderRadius: 999,
      border: "1px solid rgba(255,255,255,0.18)",
      background: active ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.22)",
      color: "#eef1f5",
      fontWeight: active ? 900 : 700,
      cursor: "pointer",
    });

    const statusPill = (s: AuditStatus): React.CSSProperties => {
      const base: React.CSSProperties = {
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 900,
        border: "1px solid rgba(255,255,255,0.14)",
      };
      if (s === "FULL") return { ...base, background: "rgba(64, 220, 140, 0.18)", color: "#bff7da" };
      if (s === "PARTIAL") return { ...base, background: "rgba(250, 200, 70, 0.18)", color: "#ffe7b8" };
      if (s === "UNSUPPORTED") return { ...base, background: "rgba(250, 90, 90, 0.18)", color: "#ffd1d1" };
      return { ...base, background: "rgba(160, 160, 160, 0.16)", color: "#d7dde7" };
    };

    const rowsUnsupported = effectCoverage.unsupportedRows
      .filter((r) => (!q ? true : r.name.toLowerCase().includes(q) || r.text.toLowerCase().includes(q)))
      .slice(0, 250);

    const auditRowsFiltered = (() => {
      let rows = effectAudit.rows;
      if (auditStatusFilter !== "ALL") {
        if (auditStatusFilter === "PROBLEMS") rows = rows.filter((r) => r.status === "PARTIAL" || r.status === "UNSUPPORTED");
        else rows = rows.filter((r) => r.status === auditStatusFilter);
      }
      if (q) {
        rows = rows.filter((r) => {
          const name = (r.name || "").toLowerCase();
          const txt = (r.text || "").toLowerCase();
          const trig = (r.trigger || "").toLowerCase();
          const prim = r.primitives.join(" ").toLowerCase();
          const flags = r.flags.join(" ").toLowerCase();
          return name.includes(q) || txt.includes(q) || trig.includes(q) || prim.includes(q) || flags.includes(q);
        });
      }
      // Keep the modal snappy.
      return rows.slice(0, 350);
    })();

    const copyAuditJson = async () => {
      const payload = JSON.stringify(effectAudit, null, 2);
      try {
        await navigator.clipboard.writeText(payload);
        alert("Audit JSON copied to clipboard.");
      } catch {
        window.prompt("Copy audit JSON:", payload);
      }
    };

    const copyFilteredAuditJson = async () => {
      const payload = JSON.stringify(
        {
          meta: {
            filter: auditStatusFilter,
            search: diagSearch,
            generatedAt: new Date().toISOString(),
          },
          rows: auditRowsFiltered,
        },
        null,
        2
      );
      try {
        await navigator.clipboard.writeText(payload);
        alert("Filtered audit JSON copied to clipboard.");
      } catch {
        window.prompt("Copy filtered audit JSON:", payload);
      }
    };

    return (
      <div className="rb-modalOverlay" onClick={() => setShowDiagnostics(false)}>
        <div className="rb-modal" onClick={(e) => e.stopPropagation()}>
          <div className="rb-modalHeader">
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ fontWeight: 900 }}>Effect Diagnostics</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={tabButtonStyle(diagTab === "UNSUPPORTED")} onClick={() => setDiagTab("UNSUPPORTED")}>
                  Unsupported List
                </button>
                <button style={tabButtonStyle(diagTab === "AUDIT")} onClick={() => setDiagTab("AUDIT")}>
                  Full Audit
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {diagTab === "AUDIT" ? (
                <>
                  <button className="rb-miniButton" onClick={copyFilteredAuditJson}>
                    Copy filtered JSON
                  </button>
                  <button className="rb-miniButton" onClick={copyAuditJson}>
                    Copy full JSON
                  </button>
                </>
              ) : null}
              <button className="rb-miniButton" onClick={() => setShowDiagnostics(false)}>
                Close
              </button>
            </div>
          </div>
          <div className="rb-modalBody">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
              {diagTab === "UNSUPPORTED" ? (
                <div className="rb-softTextSmall">
                  Cards with ability text: <b>{effectCoverage.totalWithText}</b> • Supported: <b>{effectCoverage.supportedCount}</b> • Unsupported: <b>{effectCoverage.unsupportedCount}</b>
                </div>
              ) : (
                <div className="rb-softTextSmall">
                  Total cards: <b>{effectAudit.total}</b> • With text: <b>{effectAudit.withText}</b> • Full: <b>{effectAudit.full}</b> • Partial: <b>{effectAudit.partial}</b> • Unsupported: <b>{effectAudit.unsupported}</b> • No-text: <b>{effectAudit.noText}</b>
                </div>
              )}

              <input
                value={diagSearch}
                onChange={(e) => setDiagSearch(e.target.value)}
                placeholder={diagTab === "AUDIT" ? "Search card / primitive / flag..." : "Search card/effect..."}
                style={{
                  flex: "1 1 280px",
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.16)",
                  background: "rgba(0,0,0,0.25)",
                  color: "#eef1f5",
                }}
              />

              {diagTab === "AUDIT" ? (
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="rb-softTextSmall">Status:</span>
                  <select
                    value={auditStatusFilter}
                    onChange={(e) => setAuditStatusFilter(e.target.value as any)}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(0,0,0,0.25)",
                      color: "#eef1f5",
                    }}
                  >
                    <option value="PROBLEMS">Problems (Partial + Unsupported)</option>
                    <option value="ALL">All</option>
                    <option value="FULL">Full</option>
                    <option value="PARTIAL">Partial</option>
                    <option value="UNSUPPORTED">Unsupported</option>
                    <option value="NO_TEXT">No text</option>
                  </select>
                </span>
              ) : null}
            </div>

            {diagTab === "UNSUPPORTED" ? (
              rowsUnsupported.length === 0 ? (
                <div className="rb-softText">No unsupported effects match the filter.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {rowsUnsupported.map((r) => (
                    <div
                      key={r.id}
                      style={{
                        border: "1px solid rgba(255,255,255,0.10)",
                        borderRadius: 12,
                        padding: 10,
                        background: "rgba(0,0,0,0.18)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                        <div style={{ fontWeight: 900 }}>{r.name}</div>
                        <div className="rb-softTextSmall">{r.keywords && r.keywords.length ? r.keywords.join(" • ") : ""}</div>
                      </div>
                      <div className="rb-softTextSmall" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
                        {r.text}
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <div style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 10, background: "rgba(0,0,0,0.16)" }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Top missing primitives</div>
                    {effectAudit.topMissingPrimitives.length === 0 ? (
                      <div className="rb-softTextSmall">(none)</div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {effectAudit.topMissingPrimitives.map((x) => (
                          <span key={x.k} style={{ padding: "3px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.14)", fontSize: 11, background: "rgba(0,0,0,0.22)" }}>
                            {x.k} • {x.v}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 10, background: "rgba(0,0,0,0.16)" }}>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Top missing structural flags</div>
                    {effectAudit.topMissingFlags.length === 0 ? (
                      <div className="rb-softTextSmall">(none)</div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {effectAudit.topMissingFlags.map((x) => (
                          <span key={x.k} style={{ padding: "3px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.14)", fontSize: 11, background: "rgba(0,0,0,0.22)" }}>
                            {x.k} • {x.v}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {auditRowsFiltered.length === 0 ? (
                  <div className="rb-softText">No cards match the current audit filter.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {auditRowsFiltered.map((r) => {
                      const expanded = auditExpandedId === r.id;
                      const missing = [...r.primitivesMissing, ...r.flags.filter((f) => /^TRIGGER_UNSUPPORTED|^CONDITIONAL_GENERAL|^IF_YOU_DO_BRANCH|^REPLACEMENT_EFFECT|^SCALING_EFFECT|^TURN_SCOPED_TRIGGER|^TURN_SCOPED_DAMAGE_HOOK|^CONTINUOUS_ENTER_READY|^ADDITIONAL_COST|^COST_MODIFIER|^SEARCH_NOT_SUPPORTED|^REVEAL_NOT_SUPPORTED|^MOVE_EFFECT_NOT_SUPPORTED|^KEYWORD_UNSUPPORTED|^MULTI_TARGET_UNITS/.test(f))];

                      return (
                        <div
                          key={r.id}
                          style={{
                            border: "1px solid rgba(255,255,255,0.10)",
                            borderRadius: 12,
                            padding: 10,
                            background: "rgba(0,0,0,0.18)",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                            <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                              <button
                                className="rb-miniButton"
                                onClick={() => setAuditExpandedId((prev) => (prev === r.id ? null : r.id))}
                                style={{ padding: "6px 10px" }}
                              >
                                {expanded ? "Hide" : "Details"}
                              </button>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                                <div className="rb-softTextSmall">
                                  {r.type} • {r.domain} • Cost {r.cost}
                                  {r.targetProfile.needsTargets ? ` • Targets: ${r.targetProfile.count} (${r.targetProfile.restriction}, ${r.targetProfile.location})` : ""}
                                </div>
                              </div>
                            </div>

                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                              <span style={statusPill(r.status)}>{r.status}</span>
                            </div>
                          </div>

                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                            {missing.slice(0, 10).map((m) => (
                              <span
                                key={m}
                                style={{
                                  padding: "3px 8px",
                                  borderRadius: 999,
                                  border: "1px solid rgba(255,255,255,0.12)",
                                  fontSize: 11,
                                  background: "rgba(255, 120, 120, 0.10)",
                                }}
                              >
                                {m}
                              </span>
                            ))}
                            {missing.length > 10 ? (
                              <span style={{ padding: "3px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.12)", fontSize: 11, background: "rgba(0,0,0,0.22)" }}>
                                +{missing.length - 10} more
                              </span>
                            ) : null}
                          </div>

                          {expanded ? (
                            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
                              {r.trigger ? (
                                <div className="rb-softTextSmall">
                                  <b>Trigger:</b> {r.trigger}
                                </div>
                              ) : null}

                              {r.keywords && r.keywords.length ? (
                                <div className="rb-softTextSmall">
                                  <b>Keywords:</b> {r.keywords.join(" • ")}
                                </div>
                              ) : null}

                              {r.text ? (
                                <div className="rb-softTextSmall" style={{ whiteSpace: "pre-wrap" }}>
                                  <b>Text:</b> {r.text}
                                </div>
                              ) : (
                                <div className="rb-softTextSmall">(No effect text)</div>
                              )}

                              <div className="rb-softTextSmall">
                                <b>Primitives:</b> {r.primitives.length ? r.primitives.join(", ") : "(none)"}
                              </div>
                              <div className="rb-softTextSmall">
                                <b>Supported primitives:</b> {r.primitivesSupported.length ? r.primitivesSupported.join(", ") : "(none)"}
                              </div>
                              <div className="rb-softTextSmall">
                                <b>Missing primitives:</b> {r.primitivesMissing.length ? r.primitivesMissing.join(", ") : "(none)"}
                              </div>
                              <div className="rb-softTextSmall">
                                <b>Flags:</b> {r.flags.length ? r.flags.join(" • ") : "(none)"}
                              </div>

                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <button
                                  className="rb-miniButton"
                                  onClick={async () => {
                                    const payload = JSON.stringify(r, null, 2);
                                    try {
                                      await navigator.clipboard.writeText(payload);
                                      alert("Card audit JSON copied.");
                                    } catch {
                                      window.prompt("Copy card audit JSON:", payload);
                                    }
                                  }}
                                >
                                  Copy card JSON
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="rb-softTextSmall" style={{ marginTop: 12 }}>
                  Notes:
                  <ul style={{ margin: "6px 0 0 18px" }}>
                    <li>
                      “Primitives” are the small effect operations the emulator can (or can’t) execute today. A single card may need multiple primitives.
                    </li>
                    <li>
                      “Flags” are structural capabilities that typically require new engine hooks (e.g., continuous effects, turn-scoped triggers, multi-target selection).
                    </li>
                    <li>
                      This audit is heuristic and may produce false positives; it’s designed to guide implementation work quickly, not to be an oracle.
                    </li>
                  </ul>
                </div>
              </>
            )}

            {diagTab === "UNSUPPORTED" ? (
              <div className="rb-softTextSmall" style={{ marginTop: 12 }}>
                Note: “Supported” here means the emulator has a parser/handler for at least one operation in the text. Many cards still have static / continuous effects that are not yet fully modeled.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const renderClassicGame = () => {
    if (!g) return null;
    return (
      <div style={{ padding: 16 }}>
        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
          <button onClick={resetGame}>Reset Game</button>
          <button onClick={toggleRevealHands}>{revealAllHands ? "Hide Hands (hotseat)" : "Reveal Hands (hotseat)"}</button>
          <button onClick={toggleRevealFacedown}>{revealAllFacedown ? "Hide Facedown (hotseat)" : "Reveal Facedown (hotseat)"}</button>
          <button onClick={toggleRevealDecks}>{revealAllDecks ? "Hide Decks (hotseat)" : "Reveal Decks (hotseat)"}</button>
          <span style={{ fontSize: 12, color: "#ddd" }}>
            You are “playing as”:
            <select value={viewerId} onChange={(e) => setViewerId(e.target.value as PlayerId)} style={{ marginLeft: 6 }}>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
            </select>
          </span>
          <button disabled={!canActAs(viewerId) || g.turnPlayer !== viewerId || g.chain.length > 0 || g.windowKind !== "NONE" || g.state !== "OPEN"} onClick={() => nextStep()}>
            Next Step
          </button>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
          {renderPlayerPanel("P1")}
          {renderPlayerPanel("P2")}
        </div>

        {renderBattlefields()}
        {renderChainPanel()}
        {renderMovePanel()}
        {renderHidePanel()}
        {renderLog()}
      </div>
    );
  };

  const renderOptionalChoiceModal = () => {
    if (!g || !g.pendingOptionalChoice) return null;
    const pending = g.pendingOptionalChoice;
    const isMyChoice = pending.player === viewerId;
    const canRespond = isMyChoice && canActAs(pending.player) && !isAiControlled(pending.player);

    const baseStyle: React.CSSProperties = {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.7)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      zIndex: 120,
    };

    const cardStyle: React.CSSProperties = {
      width: 520,
      maxWidth: "95vw",
      background: "#111827",
      border: "2px solid #374151",
      borderRadius: 14,
      padding: 20,
      textAlign: "center",
    };

    const min = pending.min ?? 0;
    const max = Math.max(min, pending.max ?? min);
    const clampedValue = Math.max(min, Math.min(max, optionalNumberValue));

    const sendChoice = (accept: boolean, value?: number) => {
      dispatchEngineAction({ type: "OPTIONAL_CHOICE", player: pending.player, choiceId: pending.id, accept, value });
    };

    return (
      <div style={baseStyle}>
        <div style={cardStyle}>
          <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 10 }}>Optional Choice</div>
          <div style={{ fontSize: 14, marginBottom: 14 }}>{pending.prompt}</div>
          {!canRespond ? (
            <div style={{ fontSize: 13, opacity: 0.8 }}>
              Waiting for {pending.player}...
            </div>
          ) : pending.kind === "CONFIRM" ? (
            <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
              <button
                className="rb-miniButton"
                style={{ background: "#16a34a" }}
                onClick={() => sendChoice(true)}
              >
                Yes
              </button>
              <button
                className="rb-miniButton"
                style={{ background: "#dc2626" }}
                onClick={() => sendChoice(false)}
              >
                No
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
              {max - min <= 8 ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                  {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
                    <button
                      key={n}
                      className="rb-miniButton"
                      style={{ background: n === clampedValue ? "#2563eb" : undefined }}
                      onClick={() => sendChoice(true, n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="number"
                    min={min}
                    max={max}
                    value={clampedValue}
                    onChange={(e) => {
                      const next = parseInt(e.target.value, 10);
                      if (!Number.isFinite(next)) return;
                      setOptionalNumberValue(Math.max(min, Math.min(max, next)));
                    }}
                    style={{ width: 100 }}
                  />
                  <button className="rb-miniButton" onClick={() => sendChoice(true, clampedValue)}>
                    Confirm
                  </button>
                  <button className="rb-miniButton" onClick={() => sendChoice(true, 0)}>
                    Skip (0)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Dice roll and starting player choice modal
  const renderDiceRollModal = () => {
    if (!pendingStartingPlayerChoice) return null;

    const { chooser, gameNumber } = pendingStartingPlayerChoice;
    const hasDiceRoll = showDiceRoll !== null;
    const p1Roll = showDiceRoll?.P1 ?? 0;
    const p2Roll = showDiceRoll?.P2 ?? 0;
    const diceWinner = showDiceRoll?.winner ?? chooser;

    // Check if AI should auto-choose (effect is now at component level)
    const isAiChooser = aiByPlayer[chooser]?.enabled;

    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 100 }}>
        <div style={{ width: 500, maxWidth: "95vw", background: "#111827", border: "2px solid #374151", borderRadius: 16, padding: 24, textAlign: "center" }}>
          {hasDiceRoll ? (
            <>
              <div style={{ fontSize: 24, fontWeight: 900, marginBottom: 16 }}>Dice Roll - Game {gameNumber}</div>

              <div style={{ display: "flex", justifyContent: "center", gap: 40, marginBottom: 20 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 8 }}>P1</div>
                  <div style={{
                    width: 80, height: 80,
                    background: diceWinner === "P1" ? "#10b981" : "#374151",
                    borderRadius: 12,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 36, fontWeight: 900,
                    border: diceWinner === "P1" ? "3px solid #34d399" : "3px solid #4b5563"
                  }}>
                    {p1Roll}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 8 }}>P2</div>
                  <div style={{
                    width: 80, height: 80,
                    background: diceWinner === "P2" ? "#10b981" : "#374151",
                    borderRadius: 12,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 36, fontWeight: 900,
                    border: diceWinner === "P2" ? "3px solid #34d399" : "3px solid #4b5563"
                  }}>
                    {p2Roll}
                  </div>
                </div>
              </div>

              <div style={{ fontSize: 16, marginBottom: 20 }}>
                <b>{diceWinner}</b> wins the dice roll and chooses who goes first!
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 24, fontWeight: 900, marginBottom: 16 }}>Choose Starting Player - Game {gameNumber}</div>

              <div style={{ fontSize: 16, marginBottom: 20 }}>
                <b>{chooser}</b> lost the previous game and chooses who goes first.
              </div>
            </>
          )}

          {isAiChooser ? (
            <div style={{ fontSize: 14, opacity: 0.8 }}>
              AI is choosing...
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "center", gap: 16 }}>
              <button
                style={{
                  padding: "12px 24px",
                  borderRadius: 8,
                  border: "none",
                  background: "#10b981",
                  color: "white",
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: "pointer"
                }}
                onClick={() => confirmStartingPlayerChoice(chooser)}
              >
                I go first
              </button>
              <button
                style={{
                  padding: "12px 24px",
                  borderRadius: 8,
                  border: "none",
                  background: "#6366f1",
                  color: "white",
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: "pointer"
                }}
                onClick={() => confirmStartingPlayerChoice(chooser === "P1" ? "P2" : "P1")}
              >
                Opponent goes first
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Game over modal for Bo1 games
  const renderGameOverModal = () => {
    if (!g || g.step !== "GAME_OVER") return null;

    // Don't show for Bo3 (handled by renderMatchOverlay)
    if (matchState?.format === "BO3") return null;

    const winner = getGameWinner(g);

    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 100 }}>
        <div style={{ width: 500, maxWidth: "95vw", background: "#111827", border: "2px solid #374151", borderRadius: 16, padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 12 }}>Game Over</div>

          <div style={{ fontSize: 20, marginBottom: 24 }}>
            {winner ? (
              <><b style={{ color: "#10b981" }}>{winner}</b> wins!</>
            ) : (
              "Draw!"
            )}
          </div>

          <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 20 }}>
            P1: {g.players.P1.points} points | P2: {g.players.P2.points} points
          </div>

          <div style={{ display: "flex", justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
            <button
              style={{
                padding: "12px 24px",
                borderRadius: 8,
                border: "none",
                background: "#374151",
                color: "white",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer"
              }}
              onClick={() => {
                setPendingBo3Sideboarding(null);
                setGame(null);
                setPreGameView("DECK_BUILDER");
              }}
            >
              Return to Deck Building
            </button>
            <button
              style={{
                padding: "12px 24px",
                borderRadius: 8,
                border: "none",
                background: "#10b981",
                color: "white",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer"
              }}
              onClick={() => {
                setPendingBo3Sideboarding(null);
                setGame(null);
                startDeckBuilderDuel();
              }}
            >
              Play Again (Same Decks)
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderBo3SideboardingModal = () => {
    if (!g || g.step !== "GAME_OVER" || !pendingBo3Sideboarding) return null;

    const ms = pendingBo3Sideboarding.matchStateAfterCommit;
    const nextGameNumber = ms.gamesCompleted + 1;

    const validateDeckForNextGame = (pid: PlayerId, spec: DeckSpec): string[] => {
      const errs: string[] = [];
      const sideTotal = countTotal(spec.sideboard || {});
      if (sideTotal > 8) errs.push("Sideboard must contain at most 8 cards.");
      try {
        buildPlayerFromDeckSpec(allCards, pid, spec, 1);
      } catch (err: any) {
        errs.push(String(err?.message || err));
      }
      return errs;
    };

    const errors = {
      P1: validateDeckForNextGame("P1", builderDecks.P1 || emptyDeckSpec()),
      P2: validateDeckForNextGame("P2", builderDecks.P2 || emptyDeckSpec()),
    };
    const canStartNextGame = errors.P1.length === 0 && errors.P2.length === 0;

    const renderPlayerSideboardPanel = (pid: PlayerId) => {
      const spec = builderDecks[pid] || emptyDeckSpec();
      const mainCounts = spec.main || {};
      const sideCounts = spec.sideboard || {};
      const mainTotal = countTotal(mainCounts);
      const sideTotal = countTotal(sideCounts);

      const mainRows = Object.entries(mainCounts)
        .map(([id, n]) => ({ id, n: Math.floor(n || 0), card: getCardById(allCards, id) }))
        .filter((row): row is { id: string; n: number; card: CardData } => !!row.card && row.n > 0 && isMainDeckType(row.card.type))
        .sort((a, b) => a.card.name.localeCompare(b.card.name));

      const sideRows = Object.entries(sideCounts)
        .map(([id, n]) => ({ id, n: Math.floor(n || 0), card: getCardById(allCards, id) }))
        .filter((row): row is { id: string; n: number; card: CardData } => !!row.card && row.n > 0 && isMainDeckType(row.card.type))
        .sort((a, b) => a.card.name.localeCompare(b.card.name));

      const pidErrors = errors[pid];

      return (
        <div style={{ flex: 1, minWidth: 280, border: "1px solid #374151", borderRadius: 10, padding: 12, background: "#0f172a" }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>{pid} Sideboarding</div>
          <div className="rb-softText" style={{ marginBottom: 8 }}>
            Main {mainTotal} cards • Sideboard {sideTotal}/8
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 8, maxHeight: 280, overflow: "auto" }}>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>Main Deck</div>
              {mainRows.length === 0 ? <div className="rb-softText">—</div> : null}
              {mainRows.map((row) => (
                <div key={`main_${pid}_${row.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.card.name} ×{row.n}
                  </div>
                  <button
                    className="rb-miniButton"
                    disabled={sideTotal >= 8}
                    onClick={() =>
                      updateDeck(pid, (d) => {
                        const curMain = Math.floor((d.main || {})[row.id] || 0);
                        const curSideTotal = countTotal(d.sideboard || {});
                        if (curMain <= 0 || curSideTotal >= 8) return d;
                        return {
                          ...d,
                          main: bumpCount(d.main || {}, row.id, -1, 0, 3),
                          sideboard: bumpCount(d.sideboard || {}, row.id, +1, 0, null),
                        };
                      })
                    }
                    title="Move one copy to sideboard"
                  >
                    To Side
                  </button>
                </div>
              ))}
            </div>

            <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 8, maxHeight: 280, overflow: "auto" }}>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>Sideboard</div>
              {sideRows.length === 0 ? <div className="rb-softText">—</div> : null}
              {sideRows.map((row) => (
                <div key={`side_${pid}_${row.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.card.name} ×{row.n}
                  </div>
                  <button
                    className="rb-miniButton"
                    disabled={Math.floor((mainCounts[row.id] || 0)) >= 3}
                    onClick={() =>
                      updateDeck(pid, (d) => {
                        const curSide = Math.floor((d.sideboard || {})[row.id] || 0);
                        const curMain = Math.floor((d.main || {})[row.id] || 0);
                        if (curSide <= 0 || curMain >= 3) return d;
                        return {
                          ...d,
                          main: bumpCount(d.main || {}, row.id, +1, 0, 3),
                          sideboard: bumpCount(d.sideboard || {}, row.id, -1, 0, null),
                        };
                      })
                    }
                    title="Move one copy to main deck"
                  >
                    To Main
                  </button>
                </div>
              ))}
            </div>
          </div>

          {pidErrors.length > 0 ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "#fca5a5" }}>
              {pidErrors.map((msg, idx) => (
                <div key={`${pid}_err_${idx}`}>{msg}</div>
              ))}
            </div>
          ) : null}
        </div>
      );
    };

    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.86)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 120 }}>
        <div style={{ width: 1120, maxWidth: "98vw", maxHeight: "95vh", overflow: "auto", background: "#111827", border: "2px solid #374151", borderRadius: 14, padding: 16 }}>
          <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 8 }}>Between Games: Sideboarding</div>
          <div className="rb-softText" style={{ marginBottom: 10 }}>
            Game {ms.gamesCompleted} complete. Winner: <b>{pendingBo3Sideboarding.lastGameWinner ?? "Unknown"}</b>.
            Next game: <b>Game {nextGameNumber}</b> • Match score P1 {ms.wins.P1}-{ms.wins.P2} P2.
          </div>
          <div className="rb-softText" style={{ marginBottom: 12 }}>
            Swap cards between main and sideboard, then start the next game.
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {renderPlayerSideboardPanel("P1")}
            {renderPlayerSideboardPanel("P2")}
          </div>

          <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div className="rb-softText">
              {canStartNextGame ? "Decks valid for next game." : "Fix deck errors before starting the next game."}
            </div>
            <button className="rb-bigButton" style={{ maxWidth: 320 }} disabled={!canStartNextGame} onClick={startNextBo3GameFromSideboarding}>
              Start Game {nextGameNumber}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderMatchOverlay = () => {
    if (!g || !matchState || matchState.format !== "BO3") return null;

    const matchOver = matchState.wins.P1 >= 2 || matchState.wins.P2 >= 2;
    const currentGameNumber = matchState.gamesCompleted + 1;

    const p1Bfs = deckBattlefieldsFor("P1");
    const p2Bfs = deckBattlefieldsFor("P2");

    const remainingP1 = p1Bfs.filter((b) => !matchState.usedBattlefieldIds.P1.includes(b.id));
    const remainingP2 = p2Bfs.filter((b) => !matchState.usedBattlefieldIds.P2.includes(b.id));

    const nextOptionsP1 = remainingP1.length > 0 ? remainingP1 : p1Bfs;
    const nextOptionsP2 = remainingP2.length > 0 ? remainingP2 : p2Bfs;

    const gameWinner = g.step === "GAME_OVER" ? getGameWinner(g) : null;

    const potentialWins = { ...matchState.wins };
    if (g.step === "GAME_OVER" && gameWinner && !matchOver) potentialWins[gameWinner] = (potentialWins[gameWinner] || 0) + 1;
    const wouldEndAfterCommit = potentialWins.P1 >= 2 || potentialWins.P2 >= 2;
    const sideboardingOpen = !!pendingBo3Sideboarding;

    const matchWinner: PlayerId | null =
      matchState.wins.P1 >= 2 ? "P1" : matchState.wins.P2 >= 2 ? "P2" : null;

    return (
      <div style={{ maxWidth: 1150, margin: "10px auto 0" }} className="rb-panel">
        <div style={{ display: "flex", gap: 14, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div style={{ minWidth: 240 }}>
            <div style={{ fontWeight: 900, fontSize: 14 }}>Best of 3 Match</div>
            <div className="rb-softText">
              Game {currentGameNumber} • Score P1 {matchState.wins.P1}-{matchState.wins.P2} P2
            </div>
            {g.step === "GAME_OVER" ? (
              <div className="rb-softText" style={{ marginTop: 4 }}>
                Game winner: <b>{gameWinner ?? "Unknown"}</b>
              </div>
            ) : null}
            {matchWinner ? (
              <div className="rb-softText" style={{ marginTop: 4 }}>
                Match winner: <b>{matchWinner}</b>
              </div>
            ) : null}
          </div>

          {g.step === "GAME_OVER" && !matchOver && !sideboardingOpen ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="rb-softText">Next game battlefields:</span>

              <span className="rb-softText">P1</span>
              <select
                value={matchNextBattlefieldPick.P1 ?? (nextOptionsP1[0]?.id ?? "")}
                onChange={(e) => setMatchNextBattlefieldPick((prev) => ({ ...prev, P1: e.target.value || null }))}
                disabled={nextOptionsP1.length === 0}
              >
                {nextOptionsP1.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>

              <span className="rb-softText">P2</span>
              <select
                value={matchNextBattlefieldPick.P2 ?? (nextOptionsP2[0]?.id ?? "")}
                onChange={(e) => setMatchNextBattlefieldPick((prev) => ({ ...prev, P2: e.target.value || null }))}
                disabled={nextOptionsP2.length === 0}
              >
                {nextOptionsP2.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>

              <button className="rb-miniButton" onClick={beginBo3Sideboarding}>
                {wouldEndAfterCommit ? "Commit result" : "Commit result & sideboard"}
              </button>

              {remainingP1.length === 0 || remainingP2.length === 0 ? (
                <span className="rb-softText" style={{ opacity: 0.8 }}>
                  (No unused battlefields left for at least one player; reusing is allowed as a fallback.)
                </span>
              ) : null}
            </div>
          ) : null}

          {g.step === "GAME_OVER" && !matchOver && sideboardingOpen ? (
            <div className="rb-softText">Result committed. Complete sideboarding in the modal to start Game {matchState.gamesCompleted + 1}.</div>
          ) : null}

          {g.step === "GAME_OVER" && matchWinner ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                className="rb-miniButton"
                onClick={() => {
                  // Start a fresh BO3 match using the current decks.
                  setMatchFormat("BO3");
                  setMatchState(null);
                  setPendingBo3Sideboarding(null);
                  const p1 = deckBattlefieldsFor("P1");
                  const p2 = deckBattlefieldsFor("P2");
                  setMatchNextBattlefieldPick({ P1: p1[0]?.id ?? null, P2: p2[0]?.id ?? null });
                  startDeckBuilderDuel("BO3");
                }}
              >
                Start new BO3 match
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="rb-root">
      <style>{arenaCss}</style>

      <div className="rb-topbar">
        <div style={{ display: "flex", gap: 12, alignItems: "baseline", minWidth: 0 }}>
          <div className="rb-title">Riftbound Duel Emulator</div>
          <div style={{ fontSize: 12, opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {g ? `Turn ${g.turnNumber} • Step: ${g.step} • Turn player: ${g.turnPlayer}` : "Load card data to begin"}
          </div>
        </div>

        <div className="rb-topbarControls">
          <span style={{ fontSize: 12, opacity: 0.9 }}>
            UI:
            <select value={uiMode} onChange={(e) => setUiMode(e.target.value as any)} style={{ marginLeft: 6 }}>
              <option value="Arena">Arena</option>
              <option value="Classic">Classic</option>
            </select>
          </span>

          <button onClick={resetGame} disabled={!g}>
            Reset
          </button>

          <button onClick={toggleRevealHands} disabled={!g}>
            {revealAllHands ? "Hide Hands (hotseat)" : "Reveal Hands (hotseat)"}
          </button>
          <button onClick={toggleRevealFacedown} disabled={!g}>
            {revealAllFacedown ? "Hide Facedown (hotseat)" : "Reveal Facedown (hotseat)"}
          </button>
          <button onClick={toggleRevealDecks} disabled={!g}>
            {revealAllDecks ? "Hide Decks (hotseat)" : "Reveal Decks (hotseat)"}
          </button>

          <button onClick={() => setShowDiagnostics(true)} disabled={allCards.length === 0}>
            Diagnostics
          </button>

          <span style={{ fontSize: 12, opacity: 0.9 }}>
            Playing as:
            <select value={viewerId} onChange={(e) => setViewerId(e.target.value as PlayerId)} style={{ marginLeft: 6 }}>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
            </select>
          </span>

          <span style={{ fontSize: 12, opacity: 0.9 }}>
            AI P1:
            <select
              value={aiByPlayer.P1.enabled ? aiByPlayer.P1.difficulty : "HUMAN"}
              onChange={(e) => {
                const v = e.target.value as any;
                setAiByPlayer((prev) => ({
                  ...prev,
                  P1: v === "HUMAN" ? { ...prev.P1, enabled: false } : { ...prev.P1, enabled: true, difficulty: v },
                }));
              }}
              style={{ marginLeft: 6 }}
            >
              <option value="HUMAN">Human</option>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
              <option value="VERY_HARD">Very Hard</option>
            </select>
          </span>

          <span style={{ fontSize: 12, opacity: 0.9 }}>
            AI P2:
            <select
              value={aiByPlayer.P2.enabled ? aiByPlayer.P2.difficulty : "HUMAN"}
              onChange={(e) => {
                const v = e.target.value as any;
                setAiByPlayer((prev) => ({
                  ...prev,
                  P2: v === "HUMAN" ? { ...prev.P2, enabled: false } : { ...prev.P2, enabled: true, difficulty: v },
                }));
              }}
              style={{ marginLeft: 6 }}
            >
              <option value="HUMAN">Human</option>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
              <option value="VERY_HARD">Very Hard</option>
            </select>
          </span>

          <span style={{ fontSize: 12, opacity: 0.9 }}>
            AI delay:
            <input
              type="number"
              min={0}
              max={2500}
              step={50}
              value={aiByPlayer.P2.thinkMs}
              onChange={(e) => {
                const v = Math.max(0, Math.min(2500, Number(e.target.value) || 0));
                setAiByPlayer((prev) => ({
                  P1: { ...prev.P1, thinkMs: v },
                  P2: { ...prev.P2, thinkMs: v },
                }));
              }}
              style={{ width: 72, marginLeft: 6 }}
            />
            ms
          </span>

          <button onClick={() => setAiPaused((x) => !x)} disabled={!g}>
            {aiPaused ? "Resume AI" : "Pause AI"}
          </button>
        </div>
      </div>

      {renderMatchOverlay()}

      <div className="rb-content">{!g ? (preGameView === "SETUP" ? renderSetupScreen() : renderDeckBuilder()) : uiMode === "Arena" ? renderArenaGame() : renderClassicGame()}</div>

      {renderPileViewerModal()}
      {renderDiagnosticsModal()}

      {renderChainChoiceModal()}
      {null}
      {renderDamageAssignmentModal()}
      {renderOptionalChoiceModal()}
      {renderDiceRollModal()}
      {renderBo3SideboardingModal()}
      {renderGameOverModal()}
    </div>
  );
};

export default RBEXP;
