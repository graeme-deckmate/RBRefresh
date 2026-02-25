# RBEXP.tsx Feature Reference + API Convert Parity Audit

## 1) Purpose

This document is a handoff reference for GPT-5.3-Codex Extra High.

It describes:

- What `RBEXP.tsx` currently supports as a full player-facing Riftbound duel emulator.
- How players interact with those systems in UI terms.
- Where `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/arena` is currently not equivalent, especially for rules correctness and deck-building behavior.

This is intentionally feature-first, not card-script-first.

## 2) Scope and Sources

Primary source files:

- `/Users/grae/Desktop/Riftbound/RBv Clone/RBEXP.tsx`
- `/Users/grae/Desktop/Riftbound/RBv Clone/src/App.tsx`

Comparison target (API convert):

- `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/App.tsx`
- `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/arena/ArenaApp.tsx`
- `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/arena/engine/reducer.ts`
- `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/arena/engine/types.ts`
- `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/arena/rules/pattern-compiler.ts`
- `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/arena/rules/effect-ops.ts`
- `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/arena/data/decks.ts`
- `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/arena/ui/modals/DeckBuilderModal.tsx`

## 3) RBEXP High-Level Product Surface

### 3.1 Runtime modes and entry flow

- Supports setup screen with:
- JSON file upload.
- Default local dataset load (`riftbound_data_expert (1).json`).
- One-click quick start.
- Optional debug repro quick starts.
- Supports two full game UIs:
- `Arena` mode (board-focused).
- `Classic` mode (debug-heavy panel layout).
- Supports hot-seat visibility controls:
- Reveal/hide hands.
- Reveal/hide facedown.
- Reveal/hide decks.
- Supports "playing as" controller switch (`P1`/`P2`).
- Supports per-player AI enable/difficulty and AI pause/resume.

### 3.2 Card data ingestion and normalization

- Loads expert JSON schema and normalizes into internal `CardData`.
- Merges with legacy card data for compatibility fallback fields where needed.
- Extracts and normalizes:
- Card type, cost, stats, domain, tags.
- Trigger/effect text from rules text.
- Keywords from bracket syntax and explicit keyword markers.
- Filters icon-like tokens from keyword lists so diagnostics do not over-report false keyword misses.
- Detects mixed expert datasets and filters legacy no-slash IDs when slash IDs are present.
- Keeps image data if present (supports card-art rendering in both UI modes).

### 3.3 Full duel state model

- Full turn/step model:
- `SETUP`, `MULLIGAN`, `AWAKEN`, `SCORING`, `CHANNEL`, `DRAW`, `ACTION`, `ENDING`, `GAME_OVER`.
- Window model and priority model:
- `OPEN`/`CLOSED` chain state.
- `SHOWDOWN` and `COMBAT` windows.
- Priority player with consecutive-pass handling.
- Tracks broad rules state:
- Delayed triggers.
- Replacement-like temporary flags.
- Pending optional choices.
- Pending each-player choices.
- Pending damage assignment.
- Last combat excess damage context.

### 3.4 Core resource model

- Rune deck + runes in play + rune pool model (energy and domain power).
- Manual rune actions:
- Exhaust rune to gain energy.
- Recycle rune to gain domain power.
- Seal interactions:
- Seals represented as gear.
- Seal activation/exhaust contributes to payment systems.
- Hide payment and card payment can be auto-paid from pooled resources and rune manipulations.

### 3.5 Auto-pay planning and application

- Computes auto-pay plans from current pool and available runes/seals.
- Plans include:
- Exhaust, recycle, both modes, and seal usage.
- Applies plan deterministically and logs decisions.
- Supports affordability preview in UI when hovering hand cards.
- Includes deflect-related any-domain tax planning where relevant.
- Intended behavior is rules-aligned payment planning, not random resource spending.

### 3.6 Timing and chain management

- Uses a real chain for:
- Spell plays.
- Triggered abilities.
- Activated abilities.
- Supports target-gated chain entries:
- Target requirements inferred from effect text.
- Chain item can remain pending until targets are selected.
- Priority passing:
- Two passes resolve top chain item.
- If chain empty in showdown, progresses window flow.
- Enforces timing restrictions for:
- Action vs reaction contexts.
- Window ownership/legality.
- Showdown/combat step constraints.

### 3.7 Targeting and choices

- Supports typed target model:
- Unit targets.
- Gear targets.
- Battlefield targets.
- Optional no-target (`NONE`) for optional effects.
- Supports multi-target patterns for many "up to N units" cases.
- Supports per-slot target legality filtering (friendly/enemy/zone constraints).
- Supports optional-choice modal for "you may" effects:
- Confirm choices.
- Number-input choices.
- Resume mechanism for direct effects or chain resolution.
- Supports special per-player choose flow (each player chooses own unit) without raw prompt hacks.

### 3.8 Movement, hide, and board interaction

- Standard move system for ready units across base/battlefields with move legality checks.
- Hide system for hiding eligible cards to controlled battlefield, including extra hidden slot where allowed.
- Facedown state tracked per battlefield.
- Arena supports direct selection flow for move and hide interactions.

### 3.9 Combat and damage systems

- Showdown opening and combat transition integrated into turn windows.
- Supports attacker/defender roles and role-sensitive might evaluation.
- Supports "alone" conditions in might/effect timing.
- Supports tank-aware damage assignment logic and manual assignment mode.
- Supports excess-damage tracking and turn-scoped references.
- Resolves combat outcomes including conquer/defend/tie flows.
- Handles cleanup and heal/recall sequences per combat outcome rules encoded in engine.

### 3.10 Scoring and victory

- Supports hold/conquer scoring paths by battlefield.
- Supports final-point handling with rules constraints encoded in `attemptScore`.
- Supports game-over transition when victory score reached.
- Supports Burn Out handling path when deck/trash cannot sustain draw.

### 3.11 Effect engine capability profile

- Hybrid effect resolver:
- Trigger extraction and trigger-to-event mapping.
- Broad text-pattern operation resolver.
- Additional-cost parsing and gating.
- Optional-branch handling (`you may`, `if you do` style flows where implemented).
- Supports many operation classes:
- Draw, discard, channel, add resource, token creation.
- Stun, ready, buff, kill, banish, return, move, damage.
- Temporary might and permanent buff handling.
- Cost reduction and next-spell modifiers.
- Delayed this-turn trigger scheduling and dispatch.
- Supports important trigger surfaces:
- Play, attack, defend, move, conquer, hold.
- Battlefield-specific defend/attack triggers.
- Event-driven delayed triggers.
- Supports choose-trigger hooks where choosing a target can trigger additional abilities.

### 3.12 Keywords and static/continuous handling

- Handles many keyword and static-condition checks in resolver/timing logic.
- Supports dynamic might computation from:
- Base stats.
- Buff token.
- Temporary modifiers.
- Attached gear.
- Battlefield aura-like effects and conditions where implemented.
- Supports mighty detection and "becomes mighty" trigger checks.

### 3.13 Gear and legend systems

- Gear in base and battlefield zones.
- Gear attach flow with equip start/confirm/cancel.
- Gear activated ability dispatch with parsed costs.
- Kill-this gear abilities.
- Buff-spend activated paths.
- Legend activation:
- Cost payment.
- Exhaust/readiness model.
- Queue onto chain or immediate resolve for non-reactable resource adds.
- Deflect tax on targeted activated/triggered ability targets.

### 3.14 Deck builder and match systems

- Full pre-game deck builder for both players with independent decks.
- Deck constraints and validation:
- Must select legend.
- Must select chosen champion.
- Champion-tag and domain-identity checks.
- Main deck minimum and copy limits.
- Rune deck exact-count checks.
- Battlefield selection checks.
- Supports:
- Card browser with filters.
- Rune counts management.
- Main deck list management.
- Sideboard management.
- Supports saved deck library:
- Save as new, update, rename, duplicate, delete.
- Search and tag filtering.
- Drag reorder.
- Import/export single decks and full library.
- Supports match formats:
- BO1.
- BO3 with match state, score tracking, no-repeat battlefield pool logic (with fallback reuse when exhausted).
- BO3 game flow includes:
- Result commit.
- Between-game sideboarding modal.
- Next-game battlefield picks.
- Loser chooses starting player for games 2/3.
- Dedicated BO1 game-over modal actions:
- Return to deck builder.
- Play again with same decks.

### 3.15 UX and visual interaction model

- Arena mode provides:
- Visual board lanes and card art.
- Hand fan with play interactions.
- Action side panel with runes, gear, legend/champion controls.
- Chain panel and chain state visibility.
- Modal overlays for target selection, choice prompts, cull selection, damage assignment, pile browsing, diagnostics, sideboarding.
- Classic mode provides:
- Dense debug controls and lower-level panel interaction.
- Pile viewer modal for both players.
- Hover/inspect preview support.

### 3.16 Diagnostics, audits, and reproducibility

- Built-in diagnostics modal with:
- Unsupported list.
- Full audit list.
- Primitive and structural-flag breakdown.
- Status buckets (`FULL`, `PARTIAL`, `UNSUPPORTED`, `NO_TEXT`).
- Search and filtering.
- JSON export of diagnostics/audit data.
- Includes deterministic repro shortcuts for targeted regression scenarios.
- Exposes `window.render_game_to_text` for automated test harnesses and state snapshots.

### 3.17 Engine action surface (complete interactive command set)

`RBEXP` supports these player/system actions in active match state:

- `NEXT_STEP`
- `PASS_PRIORITY`
- `MULLIGAN_CONFIRM`
- `SET_CHAIN_TARGETS`
- `OPTIONAL_CHOICE`
- `PLAY_CARD` (hand/champion/facedown source)
- `HIDE_CARD`
- `STANDARD_MOVE`
- `RUNE_EXHAUST`
- `RUNE_RECYCLE`
- `SEAL_EXHAUST`
- `LEGEND_ACTIVATE`
- `GEAR_ACTIVATE`
- `EQUIP_START`
- `EQUIP_CONFIRM`
- `EQUIP_CANCEL`
- `DAMAGE_ASSIGN`
- `DAMAGE_CONFIRM`
- `DAMAGE_AUTO_ASSIGN`
- `KILL_GEAR_ACTIVATE`
- `SPEND_MY_BUFF_ACTIVATE`
- `CULL_CHOOSE`

These are surfaced across Arena UI, Classic UI, modals, and AI dispatch.

### 3.18 Modal and overlay surface (complete)

`RBEXP` presents dedicated interaction overlays for:

- Chain target choice (`renderChainChoiceModal`)
- Card play flow (`renderPlayModal`)
- Combat damage assignment (`renderDamageAssignmentModal`)
- Optional "you may" choices (`renderOptionalChoiceModal`)
- Each-player sacrifice/selection (`renderCullChoiceModal`)
- Pile browser (`renderPileViewerModal`)
- Diagnostics (`renderDiagnosticsModal`)
- Starting-player choice/dice flow (`renderDiceRollModal`)
- BO1 post-game (`renderGameOverModal`)
- BO3 sideboarding (`renderBo3SideboardingModal`)

This is the main reason the current emulator can support rules-heavy interaction without relying on browser prompts.

## 4) Player Interaction Model in RBEXP

This section describes "what a player can do" rather than implementation internals.

### 4.1 Before match

- Load card data from file or default local JSON.
- Choose auto-setup or custom deck builder flow.
- Build or load decks for both players.
- Configure BO1 or BO3.
- Configure AI controller settings.

### 4.2 During match

- Play from hand/champion/facedown with modal-assisted destination and target selection.
- Move units, hide cards, channel runes, recycle runes.
- Activate legend and gear abilities.
- Pass priority/focus and manage chain responses.
- Assign combat damage manually when required.
- Resolve optional effects through in-UI modal confirmations.
- Inspect piles and card previews without leaving match.

### 4.3 Between BO3 games

- Commit result.
- Perform sideboarding for both players.
- Pick next battlefields.
- Choose starting player according to match rules.
- Start next game with updated lists and state.

## 5) API Convert Build: Parity-Gap Audit

Target analyzed: `/Users/grae/Desktop/Riftbound Emulator API Convert/RBv Clone/src/arena`.

## 5.1 Architectural mismatch vs RBEXP

- Default app path is `ArenaApp` (API-driven rebuild), not `RBEXP`.
- Legacy mode exists but is opt-in via query param (`?legacy=1`), so users land on non-parity rules engine by default.
- API build is intentionally a reduced action model and does not preserve full RBEXP timing/state model.

## 5.2 Rules/timing parity gaps

- Phase model is simplified to `AWAKEN|DRAW|MAIN|ENDING|GAME_OVER`; no RBEXP showdown/combat window stack model.
- No RBEXP open/closed chain-state semantics.
- No equivalent standard move timing class and reaction-window gating model.
- No mulligan phase/state flow.
- No hide/facedown system at all.
- No equivalent damage-assignment phase (RBEXP has dedicated assignment/confirm flow).
- Combat interaction model is simplified direct attack/deploy/conquer actions, not full windowed showdown flow.
- Scoring model in API build is mostly conquer-point based and does not mirror RBEXP hold/conquer/full final-point semantics.
- API state model still includes a `health` axis, which is not part of RBEXP duel scoring semantics.

## 5.3 Effect-system parity gaps

- Pattern compiler supports only a narrow text subset (draw/channel/ready rune/basic target damage/kill/stun/buff/return).
- Unsupported effects fall back to generic "resolve as no-op or cancel" prompt.
- Override list is very small and named-script based; coverage is not close to RBEXP text resolver breadth.
- No broad RBEXP-style trigger extraction pipeline (`play`, `attack`, `defend`, `move`, `hold`, battlefield triggers, delayed event breadth).
- No robust optional-branch model equivalent to RBEXP pending optional choice resume system.
- No comparable diagnostics/audit system in active gameplay UI for unsupported effect visibility.

## 5.4 Economy and payment parity gaps

- API build channels rune as combined energy and power gain in one action; it does not mirror RBEXP exhaust/recycle split interactions.
- API `Channel` operations can add energy without equivalent rune-state consumption in some paths, which diverges from RBEXP resource sequencing expectations.
- No auto-pay planner equivalent.
- No seal-equipment payment integration.
- No equivalent deflect tax handling across activated/triggered ability target setting.
- No equivalent hide-cost auto payment behavior.

## 5.5 Deck builder parity gaps

- API builder supports only:
- Main deck counts.
- Rune deck counts.
- Champion and legend selectors.
- It does not support:
- Battlefield picks.
- Sideboard construction.
- BO3 sideboarding flow.
- Saved deck library (search, tags, reorder, duplicate, merge import/export).
- Domain identity enforcement at RBEXP level.
- Champion-tag compatibility enforcement at RBEXP level.
- API validation requires exact 40 main and exact 12 runes; RBEXP supports richer construction constraints/flows tied to full rules model.

## 5.6 Match-flow parity gaps

- No equivalent BO3 match-state UX:
- No result-commit overlay with battlefield picks.
- No between-game sideboarding modal.
- No loser-chooses-starting-player flow.
- No equivalent BO1 game-over action modal with restart/deckbuilder choices.

## 5.7 Visual interaction parity gaps

- API UI has cleaner board presentation, but interaction scope is reduced:
- No classic debug mode fallback.
- No equivalent chain panel depth and chain-target modal behavior.
- No equivalent runes/seals controls and payment previews.
- No equivalent diagnostics modal with primitive/flag audit reporting.
- No equivalent hot-seat privacy toggles for hidden information management.
- No equivalent play-destination UX for unit play (API flow generally plays units to base then deploys as separate action, instead of RBEXP destination-aware play flow).

## 5.8 Why API Convert currently "feels wrong" in play

At mechanic level, the API build currently behaves as a reduced tactical prototype, not as a parity replacement for RBEXP duel rules.

Main reasons:

- Reduced timing model.
- Reduced payment model.
- Reduced effect compiler coverage.
- Reduced deck/match systems.
- Reduced diagnostics and rule-surface transparency.

## 6) Practical Parity Checklist for GPT-5.3-Codex Extra High

If the API build is to replace RBEXP as default, it must reach parity in these feature classes:

1. Full turn/step/window/priority model parity.
2. Full payment model parity (exhaust/recycle/seals/auto-pay/deflect tax).
3. Full chain + target + optional-choice parity.
4. Combat + damage-assignment + scoring parity.
5. Deck builder parity:
- battlefields, sideboard, match format controls, library workflows, identity/tag validation.
6. Match-flow parity:
- BO3 commit/sideboard/start-player loops and BO1 post-game flow.
7. Diagnostics parity:
- unsupported effect visibility and structured audit export.

Until those are complete, `RBEXP.tsx` remains the authoritative rules-faithful interactive implementation in this workspace.
