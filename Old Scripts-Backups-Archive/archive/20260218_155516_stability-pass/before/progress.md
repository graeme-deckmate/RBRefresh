Original prompt: Implement the "Full Card Paraphrase Audit + Engine Corrections (RBv Clone)" plan: rebuild expert JSON from the corrected CSV, generate paraphrase audit CSV, fix Hold final-point scoring, Seal auto-pay, Singularity up to 2 targets, Cull the Weak each-player choice, Salvage optional gear, and minimal UI cleanup in RBEXP.tsx.

Notes:
- Initialized progress tracking.

Update: Updated rebuild_card_data.py to use local RBv Clone paths and added manual seal image fallbacks.
Update: Rebuilt riftbound_data_expert (1).json from corrected CSV (537 rows) + 25 legacy fallbacks (total 562 cards). Seal image URLs injected via fallback mapping.
Update: Generated card_paraphrase_audit.csv from corrected CSV, with paraphrases and diagnostics-based status/flags.
Update: Implemented engine/UI fixes in RBEXP.tsx: hold final-point rule removed, optional target handling for spells, multi-target unit selection (up to N), Cull the Weak per-player choice modal + action, gear kill support, multi-target deflect tax, and Seal-only exhaust buttons in Classic/Arena UI.
TODO:
- Manual verification: Hold final point, Seals auto-pay, Singularity (0–2 targets), Cull the Weak per-player selection, Salvage optional gear kill.
- Decide whether to keep legacy fallback cards in riftbound_data_expert (1).json or restrict to CSV-only.
- Consider running UI checks (hand cut-off, chain panel sizing) in Arena if needed later.
Update: Adjusted auto-pay scoring to prefer seals over recycling; hid Seal exhaust button when a gear has an activated ability; made Cull the Weak detection more robust.
Update: Added active UI context wiring for resolveEffectText optional prompts (avoids viewerId/canActAs/isAiControlled ReferenceErrors).
Testing:
- Installed Playwright and downloaded browsers.
- Started Vite dev server on port 5173 with escalated permissions.
- Playwright client ran against http://localhost:5173 with PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=mac15-arm64.
- Captured screenshots at `output/web-game/shot-0.png` and `output/web-game/shot-1.png`. No console error file emitted.
- Added `window.render_game_to_text` snapshot output; quick-start actions now produce live snapshots (MULLIGAN step) in `output/web-game/state-0.json` and `state-1.json`.
Update: effectiveMight now infers battlefield index from unit location so battlefield auras apply outside combat (e.g., Trifarian War Camp), and added support for "buff each/all friendly unit(s) there" effects.
Testing: Ran Playwright quick-start flow again; updated screenshots and state files in `output/web-game/`.
Update: Prevented double-channel for legend triggers that include "Exhaust me to channel 1 rune exhausted"; added battle‑aura might display in Arena cards via effectiveMight(game context).
Update: Mighty trigger now reacts to temp might gains (e.g., Punch) by funneling temp might changes through applyTempMightBonus.
TODO:
- Create a Playwright action sequence that starts a game (or auto-start in UI) so snapshots include live game state.
Update: Fixed Mighty legend trigger plumbing so legend-triggered chain items include source card type/source instance metadata and robust trigger text matching (trigger/effect/raw), then reset passes correctly when queued.
Update: Fixed "exhaust me to channel N rune exhausted" resolution for legend sources: legend triggers now properly exhaust the legend (legendReady=false) and log correctly, and generic channel parsing now skips duplicate channeling when an Exhaust Me clause is present.
Update: Added explicit BO3 sideboarding phase between games. End-of-game BO3 flow now commits result first, opens a sideboarding modal, validates both decks for next game, and only then starts the next game/starting-player prompt.
Update: Added persistent active-player points display in Arena HUD (runes/pool row now includes Points X/Y).
Testing:
- `npm run build` passed after changes.
- Ran Playwright client against `http://127.0.0.1:5173` with quick-start actions and captured updated artifacts in `output/web-game/` (`shot-0.png`, `shot-1.png`, `state-0.json`, `state-1.json`).
- Quick-start screenshots confirm active-player points are visible in Arena HUD and no Playwright console error file was produced.
TODO:
- Add a deterministic Playwright scenario (actions JSON) that reaches live ACTION gameplay to directly verify: Vanguard Captain + Trifarian War Camp -> Fiora trigger -> legend exhausts.
- Add a Playwright scenario that reaches BO3 game end and verifies sideboarding modal + next game start flow end-to-end.
Update: Arena layout scrolling/clipping fix pass 1 — switched root/content to flex-driven sizing (100dvh-aware), allowed content panel scrolling, removed hard row lock, and gave board inner extra bottom padding.
Update: Arena layout scrolling/clipping fix pass 2 — root now supports vertical page scrolling, content overflow is visible, and grid rows use auto/start alignment so bottom card rows are no longer clipped when top controls wrap.
Testing:
- `npm run build` passed after each layout adjustment.
- Verified dev server served updated CSS selectors via curl at `http://127.0.0.1:5173/RBEXP.tsx`.
- Ran Playwright quick-start capture after each pass; latest screenshots (`output/web-game/shot-0.png`, `shot-1.png`) show hand cards visible at the bottom (no hard cutoff at card bottoms in this viewport).
Update: Fixed scoring-step game-over progression regression in `engineNextStep` by guarding `SCORING` from overwriting `GAME_OVER` with `CHANNEL`.
Update: AI now has explicit legend activation intent + execution path (`AiIntent`, `applyAiIntent`, `aiEnumerateIntents`, `aiChooseIntent` simulation scoring), so all four difficulties can consider and execute legend abilities.
Update: Improved AI targeting heuristics for multi-target effects (`req.count`), including battlefield/gear/unit selection paths; Hard/Very Hard now choose best N targets instead of only one.
Update: Tightened target inference for delayed “when ... this turn” clauses and gear-token creation text. This prevents false immediate targeting for cards like Rally the Troops and fixes Wages of Pain being mis-read as requiring gear target selection.
Testing:
- `npm run build` passed after the AI/engine patch set.
- Dev server started on `http://127.0.0.1:5173/` via `npm run dev -- --host 127.0.0.1 --port 5173`.
- Playwright quick-start run succeeded and updated artifacts in `/Users/grae/Desktop/Riftbound/output/web-game/` (`shot-0.png`, `shot-1.png`, `state-0.json`, `state-1.json`).
- Additional start-action Playwright run executed with escalated permissions; it remained in MULLIGAN (action payload likely no longer clicks current confirm controls in this layout).
Audit snapshot:
- `card_paraphrase_audit.csv` currently has 537 cards with implementation_status counts: `FULL=110`, `PARTIAL=172`, `UNSUPPORTED=98`, `UNKNOWN=143`, `NO_TEXT=14`.
TODO:
- Build a deterministic Playwright action payload that reliably exits mulligan and reaches ACTION/SCORING for end-to-end regression checks (BO3 transition, Viktor legend use, Singularity/Wages targeting).
- Continue card-audit closure pass on `PARTIAL/UNSUPPORTED` rows in `card_paraphrase_audit.csv` (starting with triggers and unsupported keywords flagged in `issues_or_mismatches`).
Update: Investigated and fixed the reported Retreat/Challenge interaction bug chain:
- Return effects now prioritize true hand-return patterns (Retreat) instead of always doing battlefield->base first.
- Challenge now re-validates target relationship at resolution (must still be one friendly + one enemy for the controller).
- Dreaming Tree trigger detection now keys off the actual chosen friendly unit battlefield(s), not only source spell context battlefield.
Update: Expanded move-effect support pass (`MOVE_EFFECT_NOT_SUPPORTED` batch 1):
- Added generic move resolution for non-friendly/non-enemy "move a unit" to base/here patterns.
- Added move-trigger firing on spell/ability-driven moves (not just manual STANDARD_MOVE), so move-trigger cards consistently react.
- Added Dragon's Rage follow-up clash handling (`another enemy unit at its destination`) with explicit-or-fallback destination target selection.
- Added "move a friendly unit to or from its base" resolution (Yasuo legend pattern).
- Improved generic "move a friendly unit" destination heuristics (Ride the Wind / Zenith Blade style flows).
Update: Added turn-scoped conquer trigger support for Relentless Pursuit:
- Temporary marker grant for `this turn, that unit has "When I conquer, you may move me to my base."`
- Conquer scoring now queues that temporary trigger with source binding.
- Resolver supports `move me to ... base` using the triggering source unit.
Audit pass (batch 1) updates in `card_paraphrase_audit.csv`:
- Updated 15 rows after re-review.
- New status counts: `FULL=116`, `PARTIAL=175`, `UNSUPPORTED=89`, `UNKNOWN=143`, `NO_TEXT=14`.
Testing:
- `npm run build` passed after each patch batch.
- Local host check passed at `http://127.0.0.1:5173` (HTTP 200).
- Re-ran Playwright quick-start capture after patches; updated screenshots/state artifacts in `/Users/grae/Desktop/Riftbound/output/web-game/`.
TODO:
- Build deterministic Playwright scripts that reproduce the Retreat->Challenge sequence directly so we can verify the exact scenario end-to-end post-fix.
- Continue category sweeps: `TURN_SCOPED_TRIGGER` batch 2 and `CONDITIONAL_GENERAL` batch 1, then re-baseline audit statuses.
Update: MOVE_EFFECT_NOT_SUPPORTED batch 2 completed in RBEXP.tsx.
- Added a dual-target requirement kind (`UNIT_FRIENDLY_IN_BASE_AND_BATTLEFIELD`) and full UI/AI support for spells that choose a friendly unit in base plus a battlefield target (e.g., Stormbringer).
- Fixed battlefield target extraction in resolver to use first explicit battlefield target from raw targets (not just first target slot).
- Added `to there` destination handling in friendly move resolver for battlefield-targeted move clauses.
- Implemented location-swap move resolution for text pattern `Move me to its location and it to my original location` (Tideturner-style), including move trigger dispatch and move-prevention checks.
- Improved dynamic damage parsing for `damage equal to its might` to compute from effective might of the chosen unit in context.
Testing:
- `npm run build` passed.
- Playwright quick-start run passed (`output/web-game/shot-0.png`, `shot-1.png`, `state-0.json`, `state-1.json`).
Audit updates:
- Updated `card_paraphrase_audit.csv` for MOVE batch 2: Flash (OGS-011/024), Stormbringer (OGN-250/298), Tideturner (OGN-199/298) no longer flagged `MOVE_EFFECT_NOT_SUPPORTED`; status set to PARTIAL pending deeper edge-case verification.
- Remaining MOVE flag row: Vilemaw's Lair (OGN-295/298), expected as a static battlefield restriction primitive.
TODO:
- Build deterministic in-game action sequence to directly exercise Retreat->Challenge chain and the new Stormbringer/Tideturner targeting flows.
- Continue TURN_SCOPED_TRIGGER batch 2, then CONDITIONAL_GENERAL batch 1.
Update: TURN_SCOPED_TRIGGER batch 2 completed in RBEXP.tsx.
- Added trigger event support for `CHOOSE_ME` and `READY_ME` (`when you choose me`, `when you ready me`, and combined `when you choose or ready me`).
- `fireChooseTriggers` now includes self-trigger effects from the chosen source unit when appropriate.
- Ready resolution now explicitly queues self ready-triggers for units that were readied by effects.
- Added explicit parser/resolver support for `you may pay [C]. If you do, give me +N might this turn.` (Draven Vanquisher style) with class-rune payment and optional choice handling.
- Added Kato the Arm pattern support: `give a friendly unit my keywords and +[S] equal to my Might this turn.`
Testing:
- `npm run build` passed.
- Playwright quick-start run passed (`output/web-game/shot-0.png`, `shot-1.png`, `state-0.json`, `state-1.json`).
Audit updates:
- Updated `card_paraphrase_audit.csv` row SFD-184/221 (Relentless Pursuit) to remove `TURN_SCOPED_TRIGGER` flag; it is now tracked under conditional behavior only.
TODO:
- Deterministic in-game reproducer remains needed for direct end-to-end validation of Retreat->Challenge + detailed combat math logs.
- Continue `CONDITIONAL_GENERAL` batch 1 focusing on high-impact UNSUPPORTED rows.
Update: CONDITIONAL_GENERAL batch 1 completed in RBEXP.tsx.
- Added legion-activation gating for legends: `[Legion]` activated legend abilities now require another card played this turn.
- Added reveal-top conditional resolution support:
  - `Reveal the top card of your Main Deck. If it's a spell/gear/unit, put it in your hand/draw it. Otherwise, recycle it.`
  - covers battlefield/unit trigger patterns like Ravenbloom Conservatory and Apprentice Smith.
- Existing channel fallback (`if you couldn't channel`, draw 1) and dynamic-cost handling retained and revalidated.
Testing:
- `npm run build` passed.
- Playwright quick-start run passed (`output/web-game/shot-0.png`, `shot-1.png`, `state-0.json`, `state-1.json`).
Audit updates:
- Updated `card_paraphrase_audit.csv` statuses/issues:
  - SFD-215/221 Ravenbloom Conservatory: UNSUPPORTED -> PARTIAL.
  - SFD-041/221 Apprentice Smith: UNSUPPORTED -> PARTIAL.
  - OGN-253/298 Darius, Hand of Noxus: UNSUPPORTED -> PARTIAL.
- Current status counts now: `FULL=116`, `PARTIAL=180`, `UNSUPPORTED=84`, `UNKNOWN=143`, `NO_TEXT=14`.
TODO:
- Deterministic action script still needed to directly reproduce Retreat->Challenge chain and verify combat math/target reassignment from live gameplay logs.
- Continue CONDITIONAL_GENERAL batch 2 (remaining UNSUPPORTED rows tied to advanced weaponmaster/equipment transfer and reveal-play clauses).

Update: Chain timing legality + delayed token trigger pass completed in `RBEXP.tsx`.
- Fixed spell timing gate by routing spell plays through `inferCardTimingClass` + `canUseTimingClassNow`.
  - Result: during chain response windows only `Reaction` timing is legal; `Action` effects like Challenge can no longer be played in response illegally.
- Added activated timing enforcement for legend and gear activations in `engineActivateLegend` / `engineActivateGearAbility`.
  - `NORMAL` activated abilities are now main-action speed only.
  - UI legend button now uses the same timing check (`getLegendActivationStatus`) and shows timing reason in tooltip.
- Fixed `Rally the Troops` delayed-trigger semantics:
  - `inferTargetRequirement` now avoids false immediate target prompts for `when a friendly unit is played this turn` clauses.
  - Removed duplicate inline UNIT_PLAYED handling in `queuePlayTriggersForCard` and unified on `fireDelayedTriggersForEvent`.
- Fixed token-play interactions for delayed triggers + Viktor destination support:
  - Unit tokens created in `resolveEffectText` now fire `UNIT_PLAYED` delayed triggers (base and battlefield).
  - Added optional battlefield targeting for token-play effects with unspecified destination.
  - If unspecified token destination is targeted to battlefield, enforce controlled battlefield; otherwise default to base.

Testing:
- `npm run build` passed.
- Host check passed: `http://127.0.0.1:5173` returns HTTP 200.
- Playwright quick-start run executed (escalated due browser sandbox constraints) and updated artifacts:
  - `/Users/grae/Desktop/Riftbound/output/web-game/shot-0.png`
  - `/Users/grae/Desktop/Riftbound/output/web-game/state-0.json`
- Current quick-start script still lands in MULLIGAN state; deterministic ACTION/chain reproducer remains TODO.

TODO:
- Build deterministic Playwright action script that exits mulligan and reproduces Retreat -> Challenge stack interaction end-to-end, then verify logs/damage.
- Continue `CONDITIONAL_GENERAL` UNSUPPORTED closure batch after deterministic chain reproducer is in place.

Follow-up: token delayed-trigger path now preserves optional-choice pauses.
- In token creation resolver, each token UNIT_PLAYED delayed-trigger firing is checked for `PENDING_OPTIONAL`; resolver now early-returns pending state to avoid continuing incorrectly while a choice modal is open.
- Rebuilt after patch (`npm run build` passed).
- Re-ran Playwright quick-start smoke; updated `/Users/grae/Desktop/Riftbound/output/web-game/shot-0.png` and `/Users/grae/Desktop/Riftbound/output/web-game/state-0.json`.

Update: Added six missing OGN cards to `riftbound_data_expert (1).json` from updated CSV.
- Source CSV: `/Users/grae/Downloads/RiftboundCardData  - All Current Card Data (2).csv`.
- Added card IDs: `OGN-035/298`, `OGN-119/298`, `OGN-121/298`, `OGN-164a/298`, `OGN-205/298`, `OGN-243/298`.
- `rebuild_card_data.py` now supports CLI paths and includes fallback image mappings for these cards.

Update: Deterministic Retreat->Challenge reproducer completed and verified.
- Added quick-start control `#rb-quick-retreat-challenge-repro` and deterministic scenario runner in `RBEXP.tsx`.
- Scenario result confirms fixed behavior: Retreat returns target to hand, then Challenge resolves with invalid target check and fizzles damage exchange when one target is gone.

Testing:
- `npm run build` passed.
- Dev host is serving current code at `http://127.0.0.1:5173`.
- Deterministic Playwright repro ran with:
  - selector: `#rb-quick-retreat-challenge-repro`
  - actions: `/Users/grae/Desktop/Riftbound/output/web-game/riftbound_retreat_challenge_repro_actions.json`
- Updated artifacts:
  - `/Users/grae/Desktop/Riftbound/output/web-game/shot-0.png`
  - `/Users/grae/Desktop/Riftbound/output/web-game/state-0.json`

Update: CONDITIONAL_GENERAL unsupported audit batch resumed (phase 2).
- Tightened audit heuristics in `RBEXP.tsx` so already-implemented patterns are not mis-flagged:
  - trigger support now includes `When I conquer after an attack`.
  - supported `if` conditions now include:
    - `if you've played another card this turn`
    - `if its Might is less than another friendly unit's`
    - `if you assigned 5 or more excess damage to enemy units`
- Updated `card_paraphrase_audit.csv` rows from `UNSUPPORTED` to `PARTIAL` where engine paths are implemented:
  - `OGN-293/298` The Grand Plaza
  - `OGN-108/298` Convergent Mutation
  - `OGN-012/298` Noxus Hopeful
  - `OGN-034/298` Tryndamere, Barbarian
- Current status counts after this batch:
  - `FULL=116`, `PARTIAL=184`, `UNSUPPORTED=80`, `UNKNOWN=143`, `NO_TEXT=14`.
  - `UNSUPPORTED + CONDITIONAL_GENERAL` rows reduced from 16 to 12.

TODO:
- Continue the remaining 12 `UNSUPPORTED + CONDITIONAL_GENERAL` rows (Weaponmaster/additional-cost and reveal/swap edge cases), then re-run the same deterministic Playwright smoke.

Update: Fixed `Cull the Weak` board-state regression in `RBEXP.tsx`.
- Root cause: resolver logged kills but did not remove chosen units from play zones before calling `killUnit`, so units remained visible on board.
- Fix: in the each-player choice resolution branch, replaced `locateUnit + killUnit` with `removeUnitFromWherever + killUnit`.
- Added deterministic repro helper `runCullWeakRepro` and UI quick actions:
  - Setup button: `#rb-quick-cull-weak-repro`
  - Actions panel button: `#rb-run-cull-weak-repro`
- Repro script now:
  - sets legal payment for `Cull the Weak` (Order class rune),
  - resolves pass order correctly,
  - auto-submits both cull choices,
  - logs end-state summary for in-play checks.

Testing:
- `npm run build` passed after fix.
- Playwright deterministic cull repro passed:
  - selector: `#rb-quick-cull-weak-repro`
  - actions: `/Users/grae/Desktop/Riftbound/output/web-game/riftbound_cull_weak_repro_actions.json`
  - artifacts:
    - `/Users/grae/Desktop/Riftbound/output/web-game/shot-0.png`
    - `/Users/grae/Desktop/Riftbound/output/web-game/state-0.json`
- Verified end-state from snapshot:
  - both chosen units removed from base (`P1 base units=[]`, `P2 base units=[]`),
  - trash counts incremented,
  - chain closed (`chain=0`, `state=OPEN`).

Update: `CONDITIONAL_GENERAL` batch (Weaponmaster/additional-cost cluster) completed in `RBEXP.tsx`.
- Additional-cost parser robustness:
  - normalized escaped/adjacent bracket tokens (`\[C]\[C]` style).
  - class/any rune additional-cost detection now supports tokenized forms (`class-rune`, `any-rune`) and counted repeats.
  - added additional-cost support for `exhaust your legend`.
  - added conditional branch handling for `if you paid the additional cost`.
- Trigger queue gating:
  - play-trigger queue now carries `additionalCostPaid` and skips paid-only trigger branches when the cost wasn't paid.
- Effect resolution support:
  - Akshan-style `move an enemy gear to your base` implemented with control transfer and optional self-attach if equipment.
  - Azir-style location swap now supports optional transfer of one attached equipment from the chosen unit to the source unit.
  - move resolver now recognizes `to an open battlefield` destination (first open/neutral battlefield heuristic).
- Stat scaling support:
  - added dynamic `+N might for each friendly gear` handling in `effectiveMight` (Ornn pattern).
- Audit heuristic support updates:
  - supported `if` clauses now include:
    - `if you paid the additional cost`
    - `if it's already attached`
    - `if it's equipped`
  - supported scaling now includes `for each friendly gear`.

Audit updates in `card_paraphrase_audit.csv`:
- Set to `PARTIAL` (8 rows):
  - `SFD-109/221` Akshan, Mischievous
  - `SFD-050/221` Azir, Ascendant
  - `SFD-079/221` Bard, Mercurial
  - `SFD-092/221` Combat Chef
  - `SFD-127/221` Master Bingwen
  - `SFD-085/221` Ornn, Forge God
  - `SFD-008/221` Sentinel Adept
  - `SFD-099/221` Veteran Poro
- Remaining `UNSUPPORTED + CONDITIONAL_GENERAL` rows now:
  - `SFD-170a/221` Rek'Sai, Swarm Queen
  - `SFD-120/221` Sivir, Ambitious
  - `SFD-018/221` Void Hatchling
- Status counts now:
  - `FULL=116`, `PARTIAL=193`, `UNSUPPORTED=71`, `UNKNOWN=143`, `NO_TEXT=14`.

Testing:
- `npm run build` passed after cluster patch.
- Deterministic Playwright regressions passed:
  - Retreat->Challenge quick repro (`#rb-quick-retreat-challenge-repro`): expected hand/chain/trash state preserved.
  - Cull the Weak quick repro (`#rb-quick-cull-weak-repro`): both chosen units removed from play and moved to trash.

Follow-up: `SFD-116/221` Yone, Blademaster moved to `PARTIAL`.
- Reason: Weaponmaster flow plus conquer-trigger damage behavior are implemented.
- Remaining gap is strict open-battlefield specificity and edge target validation.
Update: Added `/Users/grae/Desktop/Riftbound/RBv Clone/RBEXP_FEATURES_AND_API_CONVERT_PARITY.md` with an exhaustive RBEXP feature inventory and API-convert parity-gap analysis focused on rules fidelity, interaction model, and deck-building/match systems.
Update: MTGA-like point-click target UX pass completed in Arena view.
- Added board-level target visualization state (`buildArenaTargetVisualState`) derived from active target context + legal options + slot assignment.
- Added legal/selected/hover visual affordances for clickable targets (`rb-targetLegal`, `rb-targetSelected`, `rb-targetHover`) on cards and battlefields.
- Added pinned slot badges (`rb-targetSlotBadge`) so dual-slot and multi-target assignments are visible directly on board objects.
- Added SVG arrow overlay layer (`rb-targetArrowLayer`) that draws curved source->target lines with arrowheads during active targeting.
- Added target node registration + geometry recalculation (`registerArenaTargetNode`, `boardInnerRef`, center recompute effect) to keep overlays aligned while scrolling/resizing.
- Added reset/cleanup hooks for target-hover state when targeting closes.
TDD/validation:
- Added RED tests for the new UI contracts in `tests/target-ui.test.mjs` (glow class, slot badge class, arrow layer class), observed fail, then implemented GREEN.
- `npm run test:target-ui` now passes (5/5).
- `npm run build` passes.
- Ran Playwright loop via develop-web-game client against local app; no console-errors file generated, and fresh screenshots/states produced under `output/web-game/`.
Notes:
- Playwright run currently lands in setup/mulligan flows (no deterministic scripted spell-target scenario yet), so visual verification of active target arrows/glow was validated through static test contracts + compile/build checks in this pass.
TODO:
- Add a deterministic Playwright actions JSON that reaches an active spell/chain target prompt to snapshot live arrow/glow/slot-badge behavior end-to-end.
Update: point-click UX + bottom action lane + seal-priority resource patch set completed.
- Auto-pay planner now has explicit `wantsPowerGeneration` seal-priority scoring branch, preferring seal usage before rune recycling when extra power generation is needed.
- Added `autoPayActivationCost(...)` and invoked it in legend and gear activation flows so auto-pay for activated abilities can consume Seals/runes consistently.
- Expanded unreactable resource-add detection to include `add any rune` (no numeric literal) so Gold-style activations resolve immediately in the non-reactable path.
- Active-player rune strip on board now supports manual activation directly: left-click Exhaust (+1E), right-click Recycle (+1P).
- Rendered play-target area in `renderPlayModal` is now point-and-click only (target button-box pickers removed); selected targets are shown as chips with clear action.
- Added MTGA-style bottom action lane below hand (`rb-bottomActionBar`) with Next/Pass buttons and phase dots (`rb-phaseDots`), and moved primary turn controls out of right actions panel.
- Added Arena keyboard shortcut: Space triggers Pass if legal, otherwise Next Step if legal.
- Updated hand layout to fanned presentation with stronger hover magnification via `rb-handSlot` transforms.
- Updated Cull the Weak inline action hint to point-click-only confirmation messaging.

Testing:
- `npm run test:target-ui` passed (10/10).
- `npm run build` passed.

TODO (remaining from user request, not yet implemented in this patch):
- Implement effect-driven reveal/look-at/top-of-deck interaction window with opponent acknowledgement before hidden.
- Implement trash-search selector modal with friendly/opponent toggle for effects that target cards in trash.
- Re-run deterministic gameplay validation for Grand Strategem + Seal usage in live gameplay sequence (not just static/build tests).
Update: Fixed AI deadlock when no intent is scored but the AI still has an obligation to act.
- AI scheduler now picks actor by game obligation (`actorNeedsAction`) instead of requiring a pre-scored intent first.
- Added no-intent fallback actions in AI timer callback:
  - damage assignment -> `DAMAGE_AUTO_ASSIGN`
  - mulligan -> `MULLIGAN_CONFIRM`
  - chain target requirement -> `SET_CHAIN_TARGETS`
  - priority windows with no intent -> `PASS_PRIORITY`
  - open turn progression -> `NEXT_STEP`
- Added regression test: `ai loop has a no-intent fallback to prevent priority deadlocks`.
Testing:
- `npm run test:target-ui` passed (25/25).
- `npm run build` passed.
- Playwright smoke run against `http://127.0.0.1:5173/` completed after quick seal repro click; output refreshed in `output/web-game/`.
Update: Fixed combat lethal checks so defender/attacker role-based might is respected during state-based deaths.
- Root cause: `cleanupStateBased` always used `effectiveMight(... role: "NONE")` even during active combat resolution.
- Fix: in battlefield lethal checks, derive `combatRole` (`ATTACKER` / `DEFENDER` / `NONE`) when `game.combat` is active at that battlefield, and pass role/alone/battlefield context into `effectiveMight`.
- Effect: units with defend-time might bonuses (e.g., Shen, Kinkou) no longer die incorrectly from damage that is below their defending might.

TDD:
- Added RED regression test in `tests/target-ui.test.mjs`:
  - `state-based lethal checks respect attacker/defender combat role during active combat`
- Implemented GREEN in `RBEXP.tsx` and re-ran tests.

Verification:
- `npm run test:target-ui` now passes the new combat-role lethal test.
- `npm run build` passed.
- Note: suite still has two pre-existing failing tests from prior pending scope (`discard selection prompt` and `mana ability rune|power regex`) unrelated to this Shen lethal fix.
Update: Auto-pay power-source priority fixed to explicit tier order.
- Implemented tiered auto-pay source classification for gear-based power generation:
  - Tier 1: Seal-like permanent exhaust sources.
  - Tier 2: Non-rune gear power sources (e.g., Gold / kill+exhaust sources).
  - Tier 3: Rune recycle.
- `buildAutoPayPlan` now evaluates gear power sources as a separate dimension and uses a priority score that favors:
  - fewer rune recycles,
  - then higher tier-1 usage,
  - then higher tier-2 usage,
  - with total-use tie-breaking.
- Removed the old pruning logic that could skip higher-seal plans after a recycle-only plan was found.
- `applyAutoPayPlan` now applies tiered gear uses first and handles kill-self sources by sacrificing the gear into trash (or ceasing to exist for tokens).
- Added regression test in `tests/target-ui.test.mjs`:
  - `auto-pay power source priority is seals first, then non-rune gear, then rune recycle`

Validation:
- RED/GREEN: new priority regression test added and passing.
- `npm run build` passes.
- Playwright smoke runs (quick seal repro + quick gold repro) complete with no console errors.

Update: Discard/top-deck choice flow + mirrored arena lane pass completed in `RBEXP.tsx`.
- Added explicit hand discard selection flow:
  - New state/actions: `pendingDiscardSelection`, `discardSelectionResults`, `DISCARD_SELECTION_CONFIRM`.
  - `resolveEffectText` discard primitive now prompts hand choice (when interactive), then discards chosen cards and fires discard triggers.
- Added explicit top-of-main-deck choose/draw/recycle flow (Called Shot pattern):
  - New state/actions: `pendingDeckChoiceSelection`, `deckChoiceSelectionResults`, `deckChoiceSelectionPools`, `DECK_CHOICE_SELECTION_CONFIRM`.
  - Supports `Look at/Revel top N cards of your Main Deck. Draw one and recycle the other/rest.` with deterministic AI fallback.
  - Explicit reveal mode continues to gate hiddening behind opponent acknowledgement (`pendingRevealWindow`).
- Added new modals:
  - `renderDiscardSelectionModal`
  - `renderDeckChoiceSelectionModal`
- Updated viewer projection privacy for top-deck LOOK windows.

Update: Arena layout/UI structure updated toward requested mirrored board.
- Added mirrored top status lane:
  - `rb-playerLaneTop` with opponent runes-in-play (left), facedown hand count display (center), and 2x2 info grid (right).
- Added bottom status lane structure:
  - `rb-playerLaneBottom` with current-player runes + rune deck (left), fan hand + bottom action lane (center), and 2x2 info grid (right).
- Added 2x2 info grid component `rb-playerInfoGrid` for both players:
  - Main Deck | Legend
  - Discard   | Champion
- Replaced unnamed phase dots with ordered named phase pills:
  - `Awaken -> Beginning -> Channel -> Draw -> Action -> End`
  - Active phase coloring remains green (current player) / red (opponent).

Update: Hide auto-pay source ordering tightened.
- Hide auto-pay now picks highest-priority non-rune source using `getAutoPayPowerSource` tiering before rune recycling fallback, matching seal-first policy.

Testing:
- `npm run test:target-ui` passed (33/33).
- `npm run build` passed.
- Playwright quick runs executed against `http://127.0.0.1:5173` (quick-start + conditional repro); screenshots/state updated in:
  - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/shot-0.png`
  - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/shot-1.png`
  - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/state-0.json`
  - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/state-1.json`

TODO:
- Validate Seal-of-Insight class-rune parsing for all icon-text variants (`[Add] [C]` vs written "class rune") in live gameplay and adjust parser normalization if needed.
- Continue full-card audit for remaining reveal/look/search patterns not yet represented by deterministic repro scripts.
Update: Post-handoff verification run completed after the latest pending-state patch.
- `npm run test:target-ui`: PASS (33/33)
- `npm run build`: PASS
- No additional code changes were required for this verification-only step.
Update: Closed Seal icon parsing gap (`[Add] [C]`) using test-first patching in `RBEXP.tsx`.
- Added RED tests in `tests/target-ui.test.mjs` for:
  - icon-style class-rune parsing in `getSealPowerDomain`
  - icon-style class-rune parsing in `engineExhaustSealForPower`
  - icon-style class-rune normalization in legend/gear mana fast paths
- Engine patch:
  - normalize `[C]` -> `class rune` and `[A]` -> `any rune` in `getSealPowerDomain` and `engineExhaustSealForPower`
  - support optional numeric `add` forms for any-rune/power (`add any rune` => amount 1)
  - normalize icon add tokens in `engineActivateLegend` / `engineActivateGearAbility` unreactable resource-add detection
  - normalize icon add tokens in `resolveEffectText` resource-add branch
Validation:
- `npm run test:target-ui`: PASS (36/36)
- `npm run build`: PASS
- Playwright smoke (`#rb-quick-start`) executed via `$WEB_GAME_CLIENT` at `http://127.0.0.1:5173`.
  - Artifacts: `output/web-game/shot-0.png`, `output/web-game/shot-1.png`, `output/web-game/state-0.json`, `output/web-game/state-1.json`
  - Snapshot reached MULLIGAN state without new console error file.

Update: Battlefield resolver pass (current batch) completed with TDD for remaining high-impact gaps.
- Added RED/GREEN tests in `tests/target-ui.test.mjs`:
  - `veiled-temple style single friendly gear ready + optional detach is supported`
  - `discard-then-draw effects resolve discard before draw`
- Engine updates in `RBEXP.tsx`:
  - Added explicit `discard -> then draw` ordering support:
    - `hasDiscardThenDrawOrdering`
    - `skipGenericDrawForDiscardThenDraw`
    - draw now happens *after* discard resolution for effects like Zaun Warrens.
  - Added `Veiled Temple`-style single-gear flow:
    - supports `ready a/an/one friendly gear`
    - supports optional `if it's an Equipment, you may detach it` from that selected gear.
    - optional-choice key added: `READY_FRIENDLY_GEAR`.
- Existing prior fixes for this battlefield batch remain in place:
  - Minefield: supports `top 2 cards of your Main Deck ... into your trash`.
  - Ravenbloom conditional reveal parser handles straight/curly apostrophes and type matching.
  - LOOK vs REVEAL logs preserve privacy for LOOK effects.

Validation:
- `npm run test:target-ui`: PASS (41/41)
- `npm run build`: PASS
- Playwright smoke executed with `$WEB_GAME_CLIENT`:
  - URL: `http://127.0.0.1:5173`
  - Click selector: `#rb-quick-conditional-audit-repro`
  - Actions: `/Users/grae/Desktop/Riftbound/output/web-game/riftbound_conditional_audit_repro_actions.json`
  - Updated artifacts:
    - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/shot-0.png`
    - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/state-0.json`

Update: Battlefield pass continued (choice-correctness closure for hold/conquer triggers).
- Added explicit rune-choice flow for effects that say "recycle one of your runes" (e.g., Sigil of the Storm):
  - New state/actions: `pendingRuneSelection`, `runeSelectionResults`, `RUNE_SELECTION_CONFIRM`.
  - New UI modal: `renderRuneSelectionModal`.
  - Resolver now prompts for rune selection when multiple runes are available (interactive mode); AI/non-interactive falls back deterministically.
- Added optional-choice support for Hallowed Tomb pattern:
  - `RETURN_CHAMPION_FROM_TRASH` prompt now appears when champion-zone is empty and a valid champion is in trash.
- Added test coverage:
  - `hallowed-tomb style champion return is optional when available`
  - `single-rune recycle effects provide explicit rune selection flow`

Validation:
- `npm run test:target-ui`: PASS (43/43)
- `npm run build`: PASS
- Playwright smoke rerun (`#rb-quick-conditional-audit-repro`) at `http://127.0.0.1:5173`; latest:
  - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/shot-0.png`
  - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/state-0.json`
Update: Battlefield wording-coverage pass extended for full battlefield sweep continuity.
- Added TDD checks for battlefield phrasings that were previously uncovered:
  - Seat of Power wording variant: "draw 1 for each other battlefield you or allies control"
  - The Papertree wording variant: "each player channels 1 rune exhausted"
- Patched `resolveEffectText` patterns:
  - Seat scaling draw now matches both "draw a card" and "draw 1", and supports optional "or allies" wording.
  - Multi-player exhausted channel now matches both "both players channel" and "each player channels".
Validation:
- `npm run test:target-ui`: PASS (45/45)
- `npm run build`: PASS
- Playwright smoke via `$WEB_GAME_CLIENT` at `http://127.0.0.1:5173` (`#rb-quick-conditional-audit-repro`) produced fresh `output/web-game/shot-0.png` + `state-0.json` with no `errors-0.json`.
Update: Completed all-battlefield coverage pass (matrix-level) and fixed new wording gaps.
- Added a 39-battlefield coverage matrix test in `tests/target-ui.test.mjs` that tracks implementation markers for every battlefield from current data.
- Fixed battlefield wording behavior in resolver:
  - Seat of Power: now matches `draw 1 for each other battlefield you or allies control` (and prior `draw a card` wording).
  - The Papertree: now matches `each player channels 1 rune exhausted` in addition to `both players` wording.
Validation:
- `npm run test:target-ui`: PASS (46/46)
- `npm run build`: PASS
- Playwright smoke rerun via `$WEB_GAME_CLIENT` (`#rb-quick-conditional-audit-repro`) on `http://127.0.0.1:5173` produced fresh `output/web-game/shot-0.png` + `state-0.json` and no `errors-0.json`.
Update: Completed deterministic battlefield repro closure pass (all 39 battlefields).
- Added RED tests first, then implemented resolver/parser fixes for remaining battlefield misses:
  - Trigger clause extraction now appends continuation sentences to the same trigger effect.
  - Target inference now supports plain `choose a unit` prompts.
  - Reveal/look parser now supports word-form top counts (`top two cards`).
  - Channel parser now supports `channels` and word-form counts.
  - Point-gain parser now supports word-form/bracket counts and no longer double-applies.
  - Unsupported fallback logging in `resolveEffectText` now only fires when effect still unresolved after scoring/gain checks.
  - Added explicit Reaver's Row movement pattern support (`move a friendly unit here to base`).
  - Might parser now supports symbol wording (`+N [S] this turn`) and `it gets ... this turn/combat` templates.
  - Battlefield audit runner now injects implicit moved-unit target context for MOVE_FROM_HERE effects.
  - Ravenbloom audit check now accepts HOLD_HERE or DEFEND_HERE trigger shape and validates spell-hit draw path.

Validation:
- `npm run test:target-ui`: PASS (55/55).
- `npm run build`: PASS.
- Deterministic in-UI repro (`#rb-quick-battlefield-audit-repro`):
  - `=== Repro end: battlefield audit pass=39 fail=0 ===`

TODO:
- Continue with the next user-requested pass (full card-level discard/reveal/look choice UX parity) using the same deterministic repro pattern per mechanic family.
Update: Implemented Ornn restricted legend-resource fix + Arena unit attachment/layout polish.
- Legend activation parse now preserves bracketed resource symbols in effect payload (keeps `[Add]/[A]/[C]/...` tokens intact).
- Ornn-style restricted add now resolves as non-reactable immediate legend activation (no chain item), grants `gearOnlyPowerCredit`, and logs gain.
- Added `gearOnlyPowerCredit` consumption plumbing for all gear spend paths:
  - Gear play (`enginePlayCard`): pre-adjust afford check + pay, then consume on success.
  - Gear activated abilities (`engineActivateGearAbility`): pre-adjust domain/class/any needs + consume on success.
  - Equip confirm (`engineEquipConfirm`): pre-adjust equip power need + consume on success.
- Added attached-equipment board UI:
  - New unit wrapper/fan classes: `rb-unitStack`, `rb-attachedGearFan`, `rb-attachedGearSlot`.
  - Battlefield and Base unit rows now render attached gear staggered under each unit, hoverable for preview and targetable.
- Added hand hover edge-clamp classes/logic:
  - `rb-handSlotEdgeLeft`, `rb-handSlotEdgeRight` applied to edge cards.
  - Edge-specific transform-origin and hover translation to keep enlarged cards in frame.
- Added Arena viewport/layout stability updates for 1080p/2k:
  - Grid columns switched to minmax clamps; board/panels fixed to full column height.
  - Board uses internal vertical scrolling; content overflow constrained to avoid panel drift.
  - Added responsive rules for <=1960px width and <=1020px height.

Validation:
- `npm run test:target-ui -- --runInBand` => PASS (68/68).
- `npm run build` => PASS.
- `npx tsc --noEmit` => FAIL with pre-existing broad RBEXP type debt (unrelated baseline issues across many areas; not introduced by this patch set).
- Playwright loop (`web_game_playwright_client.js`) executed successfully against `http://127.0.0.1:5173`; latest run produced setup/mulligan screenshots without new pageerror artifacts in the fresh output folder.

Next recommended verification sweep (manual in-browser):
- Ornn activation: verify credit is consumed by (1) playing gear, (2) activating gear ability, and (3) equip.
- Attachment fan: verify multiple attached gear cards remain individually hoverable/clickable.
- Hand edge cards on 1920x981 and 2560x1308: verify enlarged card stays on-screen at both ends.
Update: Strengthened Ornn regression assertions in `/tests/target-ui.test.mjs` to require explicit hook points for play/equip/gear-activation credit consumption and restricted-add branch detection.
Validation refresh:
- `npm run test:target-ui -- --runInBand` => PASS (68/68).
- `npm run build` => PASS.
Update: Mulligan viewport-fit refinement pass (next-level improvement) completed in `RBEXP.tsx`.
- Tightened compact mulligan board sizing for 1920x981:
  - Battlefield min height reduced in mulligan mode.
  - Top/bottom lane auxiliary areas reduced.
  - Hand lane min height and padding reduced.
  - Board inner gaps/padding reduced.
- Added explicit compact lane grid override in mulligan mode:
  - `.rb-boardMulligan .rb-playerLaneTop, .rb-boardMulligan .rb-playerLaneBottom`
- Increased mulligan right-side info-grid compaction:
  - `rb-playerInfoGrid` now scales to `0.84` in mulligan mode.

TDD:
- Added RED tests first in `tests/target-ui.test.mjs`:
  - `mulligan compact mode tightens lane columns for 1080p fit`
  - `mulligan compact mode scales right info grid aggressively`
- Implemented GREEN CSS changes and re-ran suite.

Validation:
- `npm run test:target-ui -- --runInBand`: PASS (72/72).
- `npm run build`: PASS.
- `npx tsc --noEmit`: FAIL (pre-existing broad RBEXP baseline type debt; unchanged scope).
- `npm audit --audit-level=high`: 2 moderate (esbuild via vite), requires breaking vite upgrade to remediate.

Visual verification:
- Captured updated 1920x981 mulligan screenshot after patch:
  - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/layout-check-v4/arena-1920x981-live.png`
- Ran Playwright smoke with quick-start:
  - screenshots/state in `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/fit-pass-v2/`

Next-level TODO candidates:
- Apply an ACTION-phase compact profile (not only MULLIGAN) for dense board states at 1920x981.
- Add topbar control compaction at <=1080px height (button padding/label shortening) to preserve extra board height.
Update: Next-level layout improvement pass completed (post-plan continuation) for viewport stability at 1920x981 and 2560x1308.

TDD additions (`tests/target-ui.test.mjs`):
- `mulligan compact mode tightens lane columns for 1080p fit`
- `mulligan compact mode scales right info grid aggressively`
- `live board mode is explicitly tagged for dense viewport compaction`
- `dense viewport profile compacts live board battlefield and lane sizing`
- `dense live profile uses top-packed board flow instead of space-between`
- `dense live profile compacts bottom action controls and phase pills`
- `low-height profile compacts topbar controls for extra board space`
- `dense live profile suppresses secondary hand-lane hint text to avoid clipping`

Implementation (`RBEXP.tsx`):
- Board class split:
  - non-mulligan now explicitly tagged: `rb-boardLive`
  - mulligan remains: `rb-boardMulligan`
- Mulligan compact profile tightened further:
  - smaller battlefield/lane heights, tighter gaps/padding, stronger right-grid scale.
- New low-height dense live profile (`@media (max-height: 1020px)`):
  - compact top/bottom lane columns for `rb-boardLive`
  - reduced battlefield min-height and hand/aux heights
  - right info grid and cells compacted
  - board inner now top-packed (`justify-content: flex-start`) with tighter padding
  - bottom action controls compacted (`rb-bigButton`, `rb-phasePill`, spacing)
  - topbar controls compacted (`rb-topbarControls button/select`)
  - suppressed secondary right-lane hint in dense live mode (`rb-handAuxRight .rb-actionHint { display: none; }`)

Validation:
- `npm run test:target-ui -- --runInBand`: PASS (78/78)
- `npm run build`: PASS
- `npx tsc --noEmit`: still FAIL with pre-existing baseline type debt (unchanged scope)
- `npm audit --audit-level=high`: unchanged 2 moderate (`esbuild` via `vite`, breaking upgrade required)

Visual verification captures:
- `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/layout-check-final-v2/arena-1920x981-mulligan.png`
- `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/layout-check-final-v2/arena-1920x981-action.png`
- `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/layout-check-final-v2/arena-2560x1308-mulligan.png`

Status:
- Plan continuation goals addressed; next-level viewport compaction pass completed and validated.
Update: ACTION-lane 1920x981 compact pass + ordered phase-track progression completed.

TDD (RED -> GREEN):
- Added test: `phase progression maps scoring into beginning stage to keep left-to-right order`.
- Added test: `dense live profile clamps hand hover pop-out so cards stay inside the bottom lane`.
- Both tests initially failed, then passed after implementation.

Implementation (`RBEXP.tsx`):
- Fixed phase progression ordering by remapping `SCORING` to the `Beginning` track index:
  - `case "SCORING": return 2;`
- Tightened dense live ACTION layout (`@media (max-height: 1020px)`):
  - Bottom hand lane reduced (`min-height` and vertical padding).
  - Bottom action bar compacted with tighter full padding.
  - Added dense-mode hand hover clamp rules to reduce pop/lift and edge overshoot:
    - `.rb-boardLive .rb-handSlot:hover, .rb-boardLive .rb-handSlotHover`
    - `.rb-boardLive .rb-handSlotEdgeLeft:hover` / `.rb-boardLive .rb-handSlotEdgeRight:hover`

Validation:
- `npm run test:target-ui -- --runInBand`: PASS (83/83)
- `npm run build`: PASS
- `npx tsc --noEmit`: FAIL (existing project-wide TS debt; unchanged by this pass)
- `npm audit --audit-level=high`: PASS with existing report only (2 moderate: vite/esbuild, breaking upgrade required)

Visual verification:
- New 1920x981 ACTION screenshot:
  - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/layout-check-action-v4/arena-1920x981-action.png`
- Phase-pill capture confirms strict left->right lighting in ACTION:
  - `/Users/grae/Desktop/Riftbound/RBv PointClick/output/web-game/layout-check-action-v4/phase-track.json`
  - sequence observed: `Mulligan -> Awaken -> Beginning -> Channel -> Draw -> Action (active) -> End`.

Next improvement candidates:
- Add a second dense breakpoint (`max-height: 940px`) for ultra-tight laptop docks.
- Normalize phase labels against internal step names (e.g., `Ending` vs `End`) if you want exact rulebook wording.
Update: Arena rebuild continuation pass completed to resolve old-UI runtime behavior and Space shortcut regression.

Scope completed in `RBEXP.tsx`:
- Fixed Spacebar action handler scope bug:
  - `confirmTargetAction` no longer references out-of-scope `canPass`/`canAdvanceStep` from `renderArenaGame`.
  - It now computes legality from in-scope `g + viewerId` and dispatches:
    - Confirm target (if pending chain target choice)
    - Pass (if legal priority pass)
    - Next Step (if legal turn advance)
- Implemented active mirrored lane structure in live Arena render (not marker-only):
  - Added top lane: opponent runes + facedown hand + right 2x2 info grid.
  - Added bottom lane: current-player runes + hand + right 2x2 info grid.
  - Added reusable `renderPlayerInfoGrid(pid, interactiveLegend)` helper (Main Deck | Legend / Discard | Champion).
- Implemented bottom action lane under hand (`rb-bottomActionBar`) with:
  - Next/End button
  - Pass / Confirm Target / Put on Chain contextual button
  - Ordered phase tracker pills (`Mulligan -> Awaken -> Beginning -> Channel -> Draw -> Action -> Ending`), left-to-right progression
  - Explicit Space shortcut hint text
- Removed primary turn controls, legend/champion/runes panels from right-side Actions panel to keep it secondary-tool focused.
- Added/activated lane and phase CSS used by the live JSX path:
  - `rb-handLane`, `rb-playerLaneTop`, `rb-playerLaneBottom`, `rb-playerInfoGrid`, `rb-playerInfoCell`, `rb-faceDownHandRow`
  - `rb-bottomActionBar`, `rb-phaseTrack`, `rb-phasePill*` variants
  - responsive compaction rules for <=1960 width and <=1020 height
- Hand fan polish applied in live hand render:
  - `rb-handSlot` rotation/lift variables
  - edge clamp classes and hover transforms (`rb-handSlotEdgeLeft/right`)

Validation:
- `npm run test:target-ui -- --runInBand` => PASS (85/85)
- `npm run build` => PASS
- `npx tsc --noEmit` => FAIL (pre-existing broad RBEXP type debt remains; no new blocking build/runtime issues)

Playwright smoke:
- Ran quick-start + conditional-audit click flows via `web_game_playwright_client.js` at `http://127.0.0.1:5173`.
- Verified fresh screenshot and state output in `/Users/grae/Desktop/Riftbound/output/web-game/`.
- New screenshot confirms live mirrored lane UI is active (not legacy right-side legend/champion/runes layout).

Runtime:
- Dev server restarted and currently serving on `http://127.0.0.1:5173/`.
