import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rbexpPath = path.resolve("/Users/grae/Desktop/Riftbound/RBv PointClick/RBEXP.tsx");
const source = fs.readFileSync(rbexpPath, "utf8");

const functionBody = (fnName) => {
  const start = source.indexOf(`const ${fnName} = () => {`);
  assert.notEqual(start, -1, `Missing function: ${fnName}`);
  const end = source.indexOf("\n  const ", start + 1);
  assert.notEqual(end, -1, `Unable to locate end for ${fnName}`);
  return source.slice(start, end);
};

const functionBodyBetween = (fnName, nextFnName) => {
  const start = source.indexOf(`const ${fnName} =`);
  assert.notEqual(start, -1, `Missing function: ${fnName}`);
  const end = source.indexOf(`const ${nextFnName} =`, start + 1);
  assert.notEqual(end, -1, `Unable to locate end for ${fnName}`);
  return source.slice(start, end);
};

test("renderChainChoiceModal does not use dropdown selectors", () => {
  const body = functionBody("renderChainChoiceModal");
  assert.equal(body.includes("<select"), false, "renderChainChoiceModal should be click-first, not dropdown-based.");
});

test("renderPlayModal target section does not use dropdown selectors", () => {
  const body = functionBody("renderPlayModal");
  const targetsStart = body.indexOf("<div style={{ fontWeight: 700 }}>Targets</div>");
  assert.notEqual(targetsStart, -1, "Unable to locate renderPlayModal target section.");
  const targetsEnd = body.indexOf("Note: Hidden-play target legality", targetsStart);
  assert.notEqual(targetsEnd, -1, "Unable to locate renderPlayModal target section end marker.");
  const targetSection = body.slice(targetsStart, targetsEnd);
  assert.equal(targetSection.includes("<select"), false, "renderPlayModal target section should be click-first, not dropdown-based.");
});

test("renderPlayModal target section does not render target button-box pickers", () => {
  const body = functionBody("renderPlayModal");
  const targetsStart = body.indexOf("<div style={{ fontWeight: 700 }}>Targets</div>");
  assert.notEqual(targetsStart, -1, "Unable to locate renderPlayModal target section.");
  const targetsEnd = body.indexOf("Note: Hidden-play target legality", targetsStart);
  assert.notEqual(targetsEnd, -1, "Unable to locate renderPlayModal target section end marker.");
  const targetSection = body.slice(targetsStart, targetsEnd);
  assert.equal(
    targetSection.includes("renderTargetButtonList("),
    false,
    "renderPlayModal target section should rely on board click targeting, not button-box pickers."
  );
});

test("arena target UX exposes legal-target glow class", () => {
  assert.equal(
    source.includes("rb-targetLegal"),
    true,
    "Arena target cards should expose a legal-target glow class."
  );
});

test("arena target UX exposes pinned slot label class", () => {
  assert.equal(
    source.includes("rb-targetSlotBadge"),
    true,
    "Arena target cards should expose per-slot pinned labels."
  );
});

test("arena target UX exposes arrow overlay layer", () => {
  assert.equal(
    source.includes("rb-targetArrowLayer"),
    true,
    "Arena board should render an SVG target arrow overlay."
  );
});

test("target node registration does not set state in ref callback", () => {
  assert.equal(
    source.includes("setTargetNodeVersion"),
    false,
    "Ref registration should not trigger state updates during commit."
  );
});

test("arena layout includes bottom action bar and phase dots", () => {
  assert.equal(
    source.includes("rb-bottomActionBar"),
    true,
    "Arena UI should provide a bottom action bar below hand cards."
  );
  assert.equal(
    source.includes("rb-phaseDots"),
    true,
    "Arena UI should provide phase indicator dots near bottom controls."
  );
});

test("spacebar shortcut is implemented for pass/next in Arena", () => {
  assert.equal(
    source.includes("e.code !== \"Space\""),
    true,
    "Arena should handle Space key for pass/next shortcut."
  );
});

test("runtime does not reference undefined equipment helper symbols", () => {
  assert.equal(
    source.includes("isEquipmentCard("),
    false,
    "RBEXP runtime should use the defined isEquipment helper, not undefined isEquipmentCard."
  );
});

test("auto-pay scoring includes explicit seal-first priority for power generation", () => {
  assert.equal(
    source.includes("wantsPowerGeneration"),
    true,
    "Auto-pay planner should use explicit seal-first scoring for power-generation scenarios."
  );
});

test("effect reveal/look flow exposes a reveal window with explicit acknowledgement action", () => {
  assert.equal(
    source.includes("pendingRevealWindow"),
    true,
    "Game state should track reveal/look effect windows."
  );
  assert.equal(
    source.includes("REVEAL_WINDOW_ACK"),
    true,
    "Reveal/look windows should have an explicit acknowledgement action."
  );
  assert.equal(
    source.includes("renderRevealWindowModal"),
    true,
    "Arena UI should render a reveal/look interaction modal."
  );
});

test("trash search flow exposes pending selector and confirm action", () => {
  assert.equal(
    source.includes("pendingTrashSelection"),
    true,
    "Game state should track pending trash selection flows."
  );
  assert.equal(
    source.includes("TRASH_SELECTION_CONFIRM"),
    true,
    "Trash selection should dispatch a dedicated confirm action."
  );
  assert.equal(
    source.includes("renderTrashSelectionModal"),
    true,
    "Arena UI should render a trash selection modal."
  );
});

test("deterministic repro hooks include seal auto-pay and gold activation scenarios", () => {
  assert.equal(
    source.includes("runSealAutoPayRepro"),
    true,
    "Code should include a deterministic Seal auto-pay repro helper."
  );
  assert.equal(
    source.includes("runGoldTokenActivationRepro"),
    true,
    "Code should include a deterministic Gold token activation repro helper."
  );
  assert.equal(
    source.includes("rb-run-seal-autopay-repro"),
    true,
    "UI should expose a Seal auto-pay repro trigger button."
  );
  assert.equal(
    source.includes("rb-run-gold-token-repro"),
    true,
    "UI should expose a Gold token activation repro trigger button."
  );
});

test("gold activation repro resolves the chain before validating pool delta", () => {
  const body = functionBody("runGoldTokenActivationRepro");
  assert.equal(
    /enginePassPriority\(d,\s*\"P1\"\)/.test(body) || /enginePassPriority\(d,\s*'P1'\)/.test(body),
    true,
    "Gold repro should pass priority for P1 so the chain item resolves."
  );
  assert.equal(
    /enginePassPriority\(d,\s*\"P2\"\)/.test(body) || /enginePassPriority\(d,\s*'P2'\)/.test(body),
    true,
    "Gold repro should pass priority for P2 so the chain item resolves."
  );
});

test("resource add parsing supports non-numeric 'add any-rune' effects", () => {
  assert.equal(
    source.includes("addAnyRuneMatchSingle"),
    true,
    "resolveEffectText should explicitly support non-numeric 'add any-rune' effects."
  );
  assert.equal(
    source.includes("any(?:-|\\s+)rune"),
    true,
    "Activation parser should treat both 'any-rune' and 'any rune' as non-reactable resource-add effects."
  );
});

test("gear activated parser preserves bracketed resource symbols in effect text", () => {
  assert.equal(
    source.includes("(?!\\s*(?:add|a|c|s|t|e|\\d+)\\s*\\])"),
    true,
    "gearActivatedEffect should not strip [Add]/[A]/[C]/[S]/[T]/[E]/[N] markers from the effect payload."
  );
});

test("arena does not mount the legacy play popup modal", () => {
  assert.equal(
    source.includes("{renderPlayModal()}"),
    false,
    "Arena should not mount the legacy play popup modal."
  );
});

test("bottom action lane exposes confirm-target flow and spacebar path", () => {
  assert.equal(
    source.includes("Confirm Target ("),
    true,
    "Bottom action lane should expose Confirm Target with selected-count label."
  );
  assert.equal(
    source.includes("canConfirmTargetNow"),
    true,
    "Keyboard and button flow should compute a confirm-target action state."
  );
  assert.equal(
    source.includes("confirmTargetAction"),
    true,
    "Spacebar path should dispatch the same confirm-target action as the button."
  );
});

test("stack hover targeting adds dedicated hover-arrow state", () => {
  assert.equal(
    source.includes("hoveredChainItemId"),
    true,
    "Stack hover should track the currently hovered chain item."
  );
  assert.equal(
    source.includes("chainHoverArrowSegments"),
    true,
    "Stack hover should project target arrows for the hovered chain item."
  );
});

test("token units cease to exist when moved to non-board zones", () => {
  assert.equal(
    source.includes("tokenCeasesToExist"),
    true,
    "Token handling should include explicit cease-to-exist behavior for non-board moves."
  );
  assert.equal(
    source.includes("token ceases to exist"),
    true,
    "Token zone transitions should log cease-to-exist behavior."
  );
});

test("arena hand lane includes dedicated rune and legend/champion side zones", () => {
  assert.equal(
    source.includes("rb-handLane"),
    true,
    "Arena hand region should include a dedicated hand lane container."
  );
  assert.equal(
    source.includes("rb-handAuxLeft"),
    true,
    "Arena hand region should include a left auxiliary lane (runes)."
  );
  assert.equal(
    source.includes("rb-handAuxRight"),
    true,
    "Arena hand region should include a right auxiliary lane (legend/champion)."
  );
});

test("stack panel includes an armed-play entry for pending casts", () => {
  assert.equal(
    source.includes("Armed Play:"),
    true,
    "Board overlay should expose an Armed Play source chip for pending plays."
  );
  assert.equal(
    source.includes("setHoveredChainItemId(\"PENDING_PLAY\")"),
    true,
    "Stack panel should allow hovering the pending-play entry for arrow projection."
  );
});

test("hide auto-pay prioritizes ready seals before rune recycling", () => {
  assert.equal(
    source.includes("auto-prioritized"),
    true,
    "Hide auto-pay should explicitly prioritize ready seals."
  );
  assert.equal(
    source.includes("engineExhaustSealForPower"),
    true,
    "Hide flow should be able to exhaust a Seal for payment."
  );
});

test("token gear also ceases to exist when moved to trash", () => {
  assert.equal(
    source.includes("sacrificed") && source.includes("tokenCeasesToExist(d, gear, \"trash\")"),
    true,
    "Gear token sacrifices should remove the token from the game instead of sending it to trash."
  );
});

test("ai loop has a no-intent fallback to prevent priority deadlocks", () => {
  assert.equal(
    source.includes("const actorNeedsAction = (state: GameState, pid: PlayerId): boolean =>"),
    true,
    "AI turn scheduler should pick an actor based on game obligations, not only scored intents."
  );
  assert.equal(
    source.includes("AI fallback: auto-pass priority"),
    true,
    "AI should explicitly fall back to passing priority when no legal intent is scored."
  );
});

test("discard effects support hand-card selection instead of auto-discarding from top", () => {
  assert.equal(
    source.includes("sourceZone: \"HAND\""),
    true,
    "Discard effects should create a hand-selection flow when multiple cards are eligible."
  );
  assert.equal(
    source.includes("Select") && source.includes("to discard"),
    true,
    "Discard selection flow should expose an explicit discard prompt."
  );
});

test("mana abilities treat both rune and power add patterns as non-reactable", () => {
  assert.equal(
    source.includes("add\\s+(?:\\d+\\s+)?(body|calm|chaos|fury|mind|order|class)\\s+(?:rune|power)"),
    true,
    "Immediate mana-ability path should recognize both 'add ... rune' and 'add ... power' text."
  );
});

test("state-based lethal checks respect attacker/defender combat role during active combat", () => {
  assert.equal(
    source.includes("const combatRole: \"ATTACKER\" | \"DEFENDER\" | \"NONE\" ="),
    true,
    "cleanupStateBased should derive a combat role for units at the active combat battlefield."
  );
  assert.equal(
    source.includes("game.combat && game.combat.battlefieldIndex === bf.index"),
    true,
    "cleanupStateBased should apply combat-role lethal checks only at the active combat battlefield."
  );
});

test("auto-pay power source priority is seals first, then non-rune gear, then rune recycle", () => {
  assert.equal(
    source.includes("priorityTier: 1 as const"),
    true,
    "Auto-pay should explicitly classify Seal-like power sources as tier 1."
  );
  assert.equal(
    source.includes("priorityTier: 2 as const"),
    true,
    "Auto-pay should explicitly classify non-rune gear power sources (e.g., Gold) as tier 2."
  );
  assert.equal(
    source.includes("[recycleCount, totalUses, -tier1Count, -tier2Count"),
    true,
    "When power generation is needed, planner score should prefer fewer rune recycles, then tier-1 usage, then tier-2 usage."
  );
});

test("discard effects open an explicit hand selection flow", () => {
  assert.equal(
    source.includes("pendingDiscardSelection"),
    true,
    "Game state should track pending discard-selection prompts."
  );
  assert.equal(
    source.includes("DISCARD_SELECTION_CONFIRM"),
    true,
    "Engine actions should include a dedicated discard-selection confirm action."
  );
  assert.equal(
    source.includes("renderDiscardSelectionModal"),
    true,
    "Arena UI should render a discard-selection modal for hand choices."
  );
});

test("top-of-main-deck choose-and-recycle effects expose a dedicated choice flow", () => {
  assert.equal(
    source.includes("pendingDeckChoiceSelection"),
    true,
    "Game state should track pending top-of-deck choice flows."
  );
  assert.equal(
    source.includes("DECK_CHOICE_SELECTION_CONFIRM"),
    true,
    "Engine actions should include a dedicated top-deck selection confirm action."
  );
  assert.equal(
    source.includes("renderDeckChoiceSelectionModal"),
    true,
    "Arena UI should render a top-deck choice modal for effects like Called Shot."
  );
  assert.equal(
    source.includes("draw one and recycle the other"),
    true,
    "Resolver should explicitly support draw-one/recycle-rest flow from main deck."
  );
});

test("arena phase indicator uses ordered named phase boxes", () => {
  assert.equal(
    source.includes("rb-phaseTrack"),
    true,
    "Arena should use a named phase track container."
  );
  assert.equal(
    source.includes("rb-phasePill"),
    true,
    "Arena should render named phase pills instead of anonymous dots."
  );
  assert.equal(
    source.includes("AWAKEN") && source.includes("BEGINNING") && source.includes("CHANNEL") && source.includes("DRAW") && source.includes("ACTION") && source.includes("ENDING"),
    true,
    "Phase track should expose the ordered named phases."
  );
});

test("arena board exposes mirrored top and bottom status lanes", () => {
  assert.equal(
    source.includes("rb-playerLaneTop"),
    true,
    "Arena should expose an opponent top status lane."
  );
  assert.equal(
    source.includes("rb-playerLaneBottom"),
    true,
    "Arena should expose a current-player bottom status lane."
  );
  assert.equal(
    source.includes("rb-playerInfoGrid"),
    true,
    "Arena lanes should include the 2x2 main-deck/legend/discard/champion information grid."
  );
});

test("seal domain parser recognizes icon-style class rune text", () => {
  const body = functionBodyBetween("getSealPowerDomain", "getAutoPayPowerSource");
  assert.equal(
    body.includes("\\[\\s*c\\s*\\]"),
    true,
    "getSealPowerDomain should normalize [C] icon text into class-rune semantics."
  );
});

test("seal activation parser recognizes icon-style class rune text", () => {
  const body = functionBodyBetween("engineExhaustSealForPower", "engineEquipStart");
  assert.equal(
    body.includes("\\[\\s*c\\s*\\]"),
    true,
    "engineExhaustSealForPower should normalize [C] icon text into class-rune semantics."
  );
});

test("resource-add fast path recognizes icon-style class rune text", () => {
  const legendBody = functionBodyBetween("engineActivateLegend", "getLegendActivationStatus");
  const gearBody = functionBodyBetween("engineActivateGearAbility", "applyEngineAction");
  assert.equal(
    legendBody.includes("\\[\\s*c\\s*\\]") && gearBody.includes("\\[\\s*c\\s*\\]"),
    true,
    "Legend and gear mana-ability fast paths should normalize [C] icon text."
  );
});

test("minefield-style milling supports 'Main Deck' phrasing", () => {
  assert.equal(
    source.includes("top\\s+(?:2|two)\\s+cards?\\s+of\\s+your\\s+(?:main\\s+)?deck\\s+into\\s+your\\s+trash"),
    true,
    "Milling parser should match battlefield text that explicitly says Main Deck."
  );
});

test("reveal-top conditional parser handles straight and curly apostrophes", () => {
  assert.equal(
    source.includes("it(?:'|’)?s\\s+an?\\s+spell"),
    true,
    "Reveal-top conditional should match both it's and it’s phrasing."
  );
});

test("look effects keep card names private in global logs", () => {
  assert.equal(
    source.includes("showNamesInLog"),
    true,
    "Look/reveal resolver should gate card-name logging by reveal mode."
  );
});

test("veiled-temple style single friendly gear ready + optional detach is supported", () => {
  assert.equal(
    source.includes("ready\\s+(?:a|an|one)\\s+friendly\\s+gear"),
    true,
    "Resolver should support single-friendly-gear ready effects (not only mass ready)."
  );
  assert.equal(
    source.includes("READY_FRIENDLY_GEAR"),
    true,
    "Resolver should include a dedicated optional-choice key for single friendly gear ready effects."
  );
});

test("discard-then-draw effects resolve discard before draw", () => {
  assert.equal(
    source.includes("hasDiscardThenDrawOrdering"),
    true,
    "Resolver should detect explicit discard-then-draw ordering."
  );
  assert.equal(
    source.includes("skipGenericDrawForDiscardThenDraw"),
    true,
    "Resolver should defer generic draw handling when discard must happen first."
  );
});

test("hallowed-tomb style champion return is optional when available", () => {
  assert.equal(
    source.includes("RETURN_CHAMPION_FROM_TRASH"),
    true,
    "Champion-return battlefield effects should preserve optional choice semantics."
  );
});

test("single-rune recycle effects provide explicit rune selection flow", () => {
  assert.equal(
    source.includes("pendingRuneSelection"),
    true,
    "Game state should track pending rune selection prompts."
  );
  assert.equal(
    source.includes("RUNE_SELECTION_CONFIRM"),
    true,
    "Engine actions should include a rune-selection confirm action."
  );
  assert.equal(
    source.includes("renderRuneSelectionModal"),
    true,
    "Arena UI should render a rune-selection modal when choice is required."
  );
});

test("seat-of-power style scaling draw supports 'you or allies control' wording", () => {
  assert.equal(
    source.includes("draw\\s+(?:a\\s+card|1)\\s+for\\s+each\\s+other\\s+battlefield\\s+you(?:\\s+or\\s+allies)?\\s+control"),
    true,
    "Seat of Power parser should match both 'draw a card' and 'draw 1', including 'you or allies control' wording."
  );
});

test("papertree style channel effect supports 'each player channels 1 rune exhausted' wording", () => {
  assert.equal(
    source.includes("(?:both\\s+players?|each\\s+player)\\s+channels?\\s+1\\s+rune\\s+exhausted"),
    true,
    "Channel parser should support both 'both players channel' and 'each player channels' text."
  );
});

test("battlefield coverage matrix tracks all core battlefield rule texts", () => {
  const battlefieldMarkers = {
    "Altar to Unity": ["play\\s+(?:(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+)?(?:an?\\s+)?(\\d+)\\s+might\\s+([a-z]+)\\s+unit\\s+token(?:s)?\\b"],
    "Aspirant's Climb": ["Aspirant's Climb"],
    "Back-Alley Bar": ["MOVE_FROM_HERE", "give\\s+(?:a\\s+)?(?:friendly\\s+|enemy\\s+|your\\s+|opposing\\s+)?(unit|units|me|it|this)\\s+([+-])\\s*(\\d+)\\s+might\\s+this\\s+turn"],
    "Bandle Tree": ["Bandle Tree", "battlefieldAllowsExtraFacedown"],
    "Emperor's Dais": ["PAY_ENERGY_SAND_", "sand\\s+soldier\\s+unit\\s+tokens?\\s+here"],
    "Forge of the Fluft": ["Forge of the Fluft", "battlefieldGrantsLegendEquip"],
    "Forgotten Monument": ["Forgotten Monument"],
    "Fortified Position": ["DEFEND_HERE", "this\\s+combat\\b"],
    "Grove of the God-Willow": ["HOLD_HERE", "extractDrawAmount"],
    "Hall of Legends": ["PAY_ENERGY_READY_LEGEND_"],
    "Hallowed Tomb": ["RETURN_CHAMPION_FROM_TRASH"],
    "Marai Spire": ["Marai Spire", "battlefieldDiscountsRepeat"],
    "Minefield": ["top\\s+(?:2|two)\\s+cards?\\s+of\\s+your\\s+(?:main\\s+)?deck\\s+into\\s+your\\s+trash"],
    "Monastery of Hirana": ["you may spend a buff to draw"],
    "Navori Fighting Pit": ["effectMentionsBuff", "if\\s+it\\s+doesn't\\s+have\\s+a\\s+buff"],
    "Obelisk of Power": ["START_FIRST_BEGINNING", "channelRunes("],
    "Ornn's Forge": ["Ornn's Forge", "battlefieldDiscountsFirstGear"],
    "Power Nexus": ["PAY_POWER_SCORE", "pay\\s+(?:any-rune\\s+){4}to\\s+score\\s+1\\s+point"],
    "Ravenbloom Conservatory": ["reveal\\s+the\\s+top\\s+card\\s+of\\s+your\\s+main\\s+deck", "if\\s+it(?:'|’)?s\\s+an?\\s+spell"],
    "Reaver's Row": ["DEFEND_HERE", "move\\s+(?:up\\s+to\\s+)?(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\\s*(?:friendly|your)?\\s*(?:token\\s+)?units?"],
    "Reckoner's Arena": ["activate\\s+the\\s+conquer\\s+effects\\s+of\\s+units\\s+here"],
    "Rockfall Path": ["Rockfall Path", "battlefieldPreventsPlayHere"],
    "Seat of Power": ["draw\\s+(?:a\\s+card|1)\\s+for\\s+each\\s+other\\s+battlefield\\s+you(?:\\s+or\\s+allies)?\\s+control"],
    "Sigil of the Storm": ["recycle\\s+(?:one\\s+of\\s+your|a)\\s+runes?", "pendingRuneSelection"],
    "Startipped Peak": ["CHANNEL_1_EXHAUSTED", "channel\\s+1\\s+rune\\s+exhausted"],
    "Sunken Temple": ["requiresMightyForConquer", "PAY_ENERGY_DRAW_"],
    "Targon's Peak": ["pendingReadyRunesEndOfTurn", "ready\\s+2\\s+runes\\s+at\\s+end\\s+of\\s+turn"],
    "The Arena's Greatest": ["START_FIRST_BEGINNING", "gain[s]?\\s+(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|\\[\\d+\\])\\s+point"],
    "The Candlelit Sanctum": ["pendingCandlelitChoice", "look\\s+at\\s+the\\s+top\\s+two\\s+cards\\s+of\\s+your\\s+main\\s+deck"],
    "The Dreaming Tree": ["dreamingTreeChosenThisTurn", "when you choose a friendly unit\\b"],
    "The Grand Plaza": ["if you have 7\\+ units here", "you win the game"],
    "The Papertree": ["(?:both\\s+players?|each\\s+player)\\s+channels?\\s+1\\s+rune\\s+exhausted"],
    "Treasure Hoard": ["PAY_ENERGY_GOLD_", "createGearTokenCard(\"Gold\", rawGold)"],
    "Trifarian War Camp": ["units here have \\+(\\d+)\\s*\\[?s\\]?"],
    "Veiled Temple": ["READY_FRIENDLY_GEAR", "DETACH_EQUIPMENT_FROM_READY"],
    "Vilemaw's Lair": ["battlefieldPreventsMoveFromHereToBase", "Vilemaw's Lair"],
    "Void Gate": ["battlefieldHasVoidGate", "finalDmg += 1"],
    "Windswept Hillock": ["battlefieldGivesGanking", "Windswept Hillock"],
    "Zaun Warrens": ["hasDiscardThenDrawOrdering", "skipGenericDrawForDiscardThenDraw"],
  };

  assert.equal(
    Object.keys(battlefieldMarkers).length,
    39,
    "Coverage matrix should include all 39 battlefields from the current card data set."
  );

  for (const [name, markers] of Object.entries(battlefieldMarkers)) {
    assert.equal(markers.length > 0, true, `Battlefield ${name} should have at least one coverage marker.`);
    for (const marker of markers) {
      assert.equal(
        source.includes(marker),
        true,
        `Missing coverage marker for battlefield ${name}: ${marker}`
      );
    }
  }
});

test("arena exposes full deterministic battlefield repro runner", () => {
  assert.equal(
    source.includes("const runBattlefieldAuditRepro = () =>"),
    true,
    "Arena should provide a deterministic battlefield audit repro helper."
  );
  assert.equal(
    source.includes("rb-run-battlefield-audit-repro"),
    true,
    "Arena should expose a button id for the battlefield audit repro."
  );
  assert.equal(
    source.includes("=== Repro end: battlefield audit pass="),
    true,
    "Battlefield audit repro should emit an explicit pass/fail summary line."
  );
});

test("minefield parser supports both numeric and word-form top-two milling text", () => {
  assert.equal(
    source.includes("put\\s+the\\s+top\\s+(?:2|two)\\s+cards?\\s+of\\s+your\\s+(?:main\\s+)?deck\\s+into\\s+your\\s+trash"),
    true,
    "Minefield-style milling should match both 'top 2 cards' and 'top two cards' wording."
  );
});

test("ravenbloom reveal branch treats spell-hit draw wording as a hand-hit path", () => {
  assert.equal(
    source.includes("spellHitWithDraw"),
    true,
    "Reveal-top spell checks should treat draw wording as a hit that keeps card flow correct for Ravenbloom patterns."
  );
});

test("inferTargetRequirement handles plain 'choose a unit' battlefield prompts", () => {
  assert.equal(
    source.includes("choose\\s+an?\\s+unit\\b"),
    true,
    "Target inference should support plain 'choose a unit' prompts used by battlefield triggers."
  );
});

test("look/reveal parser supports word-form top counts like 'top two cards'", () => {
  assert.equal(
    source.includes("top\\s+(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)"),
    true,
    "Top-of-deck parser should support both numeric and word-form counts."
  );
});

test("point gain parser supports word-form counts for battlefield text", () => {
  assert.equal(
    source.includes("gain[s]?\\s+(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|\\[\\d+\\])\\s+point"),
    true,
    "Point gain parser should support both numeric and word-form counts (e.g., 'gains one point')."
  );
});

test("channel parser supports 'channels one rune' wording", () => {
  assert.equal(
    source.includes("\\bchannels?\\s+(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|\\[\\d+\\])\\b"),
    true,
    "Channel parser should support singular/plural verb forms and word-form counts."
  );
});

test("move parser handles 'move a friendly unit here to base' wording", () => {
  assert.equal(
    source.includes("move\\s+a\\s+friendly\\s+unit\\s+here\\s+to\\s+base"),
    true,
    "Move parser should explicitly support battlefield text that moves a friendly unit here to base."
  );
});

test("might modifier parser accepts +N [S] this turn templates", () => {
  assert.equal(
    source.includes("([+-])\\s*(\\d+)\\s+(?:might|\\[s\\])\\s+this\\s+turn"),
    true,
    "Might parser should accept both 'might' and '[S]' symbols for temporary buffs."
  );
});

test("legend coverage matrix tracks all core legend rule texts", () => {
  const legendMarkers = {
    "Kai'sa, Daughter of the Void": ["Use only to play spells"],
    "Jinx, Loose Cannon": ["At start of your Beginning Phase, draw 1 if you have one or fewer cards in your hand."],
    "Darius, Hand of Noxus": ["[Legion]"],
    "Ahri, Nine-Tailed Fox": ["When an enemy unit attacks a battlefield you control"],
    "Yasuo, Unforgiven": ["Move a friendly unit to or from its base"],
    "Leona, Radiant Dawn": ["When you stun one or more enemy units"],
    "Teemo, Swift Scout": ["hide a card with [Hidden] instead of [C]"],
    "Volibear, Relentless Storm": ["When you play a [Mighty] unit"],
    "Lee Sin, Blind Monk": ["Buff a friendly unit"],
    "Viktor, Herald of the Arcane": ["Play a 1 [S] Recruit unit token"],
    "Miss Fortune, Bounty Hunter": ["Give a unit [Ganking] this turn"],
    "Sett, The Boss": ["When a buffed unit you control would die"],
    "Annie, Dark Child": ["At the end of your turn, ready 2 runes"],
    "Master Yi, Wuju Bladesman": ["While a friendly unit defends alone"],
    "Lux, Lady of Luminosity": ["When you play a spell that costs [5] or more"],
    "Garen, Might of Demacia": ["When you conquer, if you have 4+ units at that battlefield, draw 2"],
    "Lucian, Purifier": ["Your Equipment each give [Assault]"],
    "Draven, Glorious Executioner": ["When you win a combat, draw 1"],
    "Reksai, Void Burrower": ["When you conquer, you may exhaust me to reveal the top 2 cards of your Main Deck"],
    "Ornn, Fire Below the Mountain": ["Use only to play gear or use gear abilities"],
    "Irelia, Blade Dancer": ["When you choose a friendly unit"],
    "Azir, Emperor of the Sands": ["Sand Soldiers you play have [Weaponmaster]"],
    "Renata Glasc, Chem-Baroness": ["When you or an ally hold"],
    "Sivir, Battle Mistress": ["When you recycle a rune"],
    "Fiora, Grand Duelist": ["When one of your units becomes [Mighty]"],
    "Rumble, Mechanized Menace": ["Your Mechs have [Shield]"],
    "Jax, Grandmaster at Arms": ["Attach an attached Equipment you control to a unit you control"],
    "Ezreal, Prodigal Explorer": ["Use only if you've chosen enemy units and/or gear twice this turn with spells or unit abilities"],
  };

  assert.equal(
    Object.keys(legendMarkers).length,
    28,
    "Coverage matrix should include all 28 core legends from the current card data set."
  );

  for (const [name, markers] of Object.entries(legendMarkers)) {
    assert.equal(markers.length > 0, true, `Legend ${name} should have at least one coverage marker.`);
    for (const marker of markers) {
      assert.equal(
        source.includes(marker),
        true,
        `Missing coverage marker for legend ${name}: ${marker}`
      );
    }
  }
});

test("arena exposes full deterministic legend repro runner", () => {
  assert.equal(
    source.includes("const runLegendAuditRepro = () =>"),
    true,
    "Arena should provide a deterministic legend audit repro helper."
  );
  assert.equal(
    source.includes("rb-run-legend-audit-repro"),
    true,
    "Arena should expose a button id for the legend audit repro."
  );
  assert.equal(
    source.includes("rb-quick-legend-audit-repro"),
    true,
    "Setup should expose a quick legend audit repro trigger."
  );
  assert.equal(
    source.includes("=== Repro end: legend audit pass="),
    true,
    "Legend audit repro should emit an explicit pass/fail summary line."
  );
});

test("arena exposes full deterministic champion repro runner", () => {
  assert.equal(
    source.includes("const runChampionAuditRepro = () =>"),
    true,
    "Arena should provide a deterministic champion audit repro helper."
  );
  assert.equal(
    source.includes("rb-run-champion-audit-repro"),
    true,
    "Arena should expose a button id for the champion audit repro."
  );
  assert.equal(
    source.includes("rb-quick-champion-audit-repro"),
    true,
    "Setup should expose a quick champion audit repro trigger."
  );
  assert.equal(
    source.includes("=== Repro end: champion audit pass="),
    true,
    "Champion audit repro should emit an explicit pass/fail summary line."
  );
});

test("champion audit candidate set is constrained to legend-tagged comma-name units", () => {
  assert.equal(
    source.includes("legendTags"),
    true,
    "Champion audit should derive candidate units from known legend tags."
  );
  assert.equal(
    source.includes("name.includes(\",\")"),
    true,
    "Champion audit should use a comma-name heuristic to avoid non-champion unit rows."
  );
});

test("equip confirmation auto-pay can consume seal-style power sources", () => {
  const body = functionBodyBetween("engineEquipConfirm", "getKillThisAbility");
  assert.equal(
    body.includes("buildAutoPayPlan"),
    true,
    "Equip confirmation should attempt auto-pay planning before rejecting unaffordable costs."
  );
  assert.equal(
    body.includes("applyAutoPayPlan"),
    true,
    "Equip confirmation should apply the computed auto-pay plan for equip costs."
  );
  assert.equal(
    body.includes("classDomainsForPlayer"),
    true,
    "Equip power payment should use class-domain legality (class rune semantics)."
  );
});

test("equip flow keeps manual seal spending available while choosing attach target", () => {
  assert.equal(
    source.includes("Use Seal for Equip"),
    true,
    "Pending equip UI should expose manual seal spend controls."
  );
});

test("arena base gear row exposes direct equip and activation actions", () => {
  assert.equal(
    source.includes("type: \"EQUIP_START\""),
    true,
    "Arena base gear interactions should be able to start equip directly from the base row."
  );
  assert.equal(
    source.includes("type: \"GEAR_ACTIVATE\""),
    true,
    "Arena base gear interactions should expose manual gear activation in the base row."
  );
});

test("play flow carries optional additional-cost choice and selected discard ids", () => {
  assert.equal(
    source.includes("payOptionalAdditionalCost"),
    true,
    "Play flow should carry an explicit optional additional-cost choice."
  );
  assert.equal(
    source.includes("additionalDiscardIds"),
    true,
    "Play flow should carry explicit hand-card ids for discard additional costs."
  );
});

test("arena pending-play UI exposes additional-cost and repeat controls", () => {
  assert.equal(
    source.includes("Pay optional additional cost"),
    true,
    "Pending-play UI should let the player choose whether to pay optional additional costs."
  );
  assert.equal(
    source.includes("Repeat:"),
    true,
    "Pending-play UI should expose repeat count controls when repeat is available."
  );
});

test("active-player points are displayed in arena live lane", () => {
  assert.equal(
    source.includes("Points {meState.points}/{g.victoryScore}"),
    true,
    "Arena HUD should display active-player points, not only opponent points."
  );
});

test("token return-to-hand and kill flows use cease-to-exist handling", () => {
  assert.equal(
    source.includes("tokenCeasesToExist(game, removed, \"hand\")"),
    true,
    "Return-to-hand effects should remove tokens from the game instead of moving them to hand."
  );
  assert.equal(
    source.includes("tokenCeasesToExist(game, unit, \"trash\")"),
    true,
    "Kill resolution should remove tokens from the game instead of moving them to trash."
  );
});

test("arena exposes deterministic spell audit repro runner with fail details", () => {
  assert.equal(
    source.includes("const runSpellAuditRepro = () =>"),
    true,
    "Arena should provide a deterministic spell audit repro helper."
  );
  assert.equal(
    source.includes("rb-run-spell-audit-repro"),
    true,
    "Arena should expose a button id for the spell audit repro."
  );
  assert.equal(
    source.includes("rb-quick-spell-audit-repro"),
    true,
    "Setup should expose a quick spell audit repro trigger."
  );
  assert.equal(
    source.includes("=== Repro end: spell audit pass="),
    true,
    "Spell audit repro should emit an explicit pass/fail summary line."
  );
  assert.equal(
    source.includes("=== Repro fail names:"),
    true,
    "Spell audit repro should emit a fail-name summary line."
  );
  assert.equal(
    source.includes("=== Repro fail details:"),
    true,
    "Spell audit repro should emit fail-detail diagnostics."
  );
});

test("arena exposes deterministic gear audit repro runner with fail details", () => {
  assert.equal(
    source.includes("const runGearAuditRepro = () =>"),
    true,
    "Arena should provide a deterministic gear audit repro helper."
  );
  assert.equal(
    source.includes("rb-run-gear-audit-repro"),
    true,
    "Arena should expose a button id for the gear audit repro."
  );
  assert.equal(
    source.includes("rb-quick-gear-audit-repro"),
    true,
    "Setup should expose a quick gear audit repro trigger."
  );
  assert.equal(
    source.includes("=== Repro end: gear audit pass="),
    true,
    "Gear audit repro should emit an explicit pass/fail summary line."
  );
  assert.equal(
    source.includes("=== Repro fail names:"),
    true,
    "Gear audit repro should emit a fail-name summary line."
  );
  assert.equal(
    source.includes("=== Repro fail details:"),
    true,
    "Gear audit repro should emit fail-detail diagnostics."
  );
});

test("legend activation parser preserves bracketed resource symbols in effect text", () => {
  const body = functionBodyBetween("legendActivatedEffect", "parseRepeatCost");
  assert.equal(
    body.includes("(?!\\s*(?:add|a|c|s|t|e|\\d+)\\s*\\])"),
    true,
    "legendActivatedEffect should not strip [Add]/[A]/[C]/[S]/[T]/[E]/[N] markers from the effect payload."
  );
});

test("ornn-style legend resource credit is tracked and consumed by gear actions", () => {
  assert.equal(
    source.includes("gearOnlyPowerCredit"),
    true,
    "Player state should track gear-only power credit from restricted legend resource abilities."
  );
  assert.equal(
    source.includes("consumeGearOnlyPowerCredit"),
    true,
    "Engine should consume Ornn-style gear-only credit when paying gear play/activation/equip costs."
  );
  assert.equal(
    source.includes("sourceLabel: `play ${card.name}`"),
    true,
    "Gear play payment should consume Ornn-style credit."
  );
  assert.equal(
    source.includes("sourceLabel: `gear ability (${gear.name})`"),
    true,
    "Gear activated abilities should consume Ornn-style credit."
  );
  assert.equal(
    source.includes("sourceLabel: `equip (${gear.name})`"),
    true,
    "Equip payment should consume Ornn-style credit."
  );
  assert.equal(
    source.includes("isGearOnlyRestrictedAdd"),
    true,
    "Legend activation should branch restricted resource-add effects into non-reactable immediate credit resolution."
  );
});

test("arena unit rendering includes staggered attached gear fan", () => {
  assert.equal(
    source.includes("rb-unitStack"),
    true,
    "Arena should render units inside a dedicated stack wrapper."
  );
  assert.equal(
    source.includes("rb-attachedGearFan"),
    true,
    "Arena should render attached equipment in a staggered fan under the unit."
  );
});

test("hand hover lane has edge-clamp classes to keep enlarged cards in frame", () => {
  assert.equal(
    source.includes("rb-handSlotEdgeLeft"),
    true,
    "Hand fan should classify left edge cards for safe hover scaling."
  );
  assert.equal(
    source.includes("rb-handSlotEdgeRight"),
    true,
    "Hand fan should classify right edge cards for safe hover scaling."
  );
});

test("arena board applies compact mulligan mode for viewport fit", () => {
  assert.equal(
    source.includes("rb-boardMulligan"),
    true,
    "Arena should expose a compact mulligan board mode class for tighter vertical fit."
  );
});

test("bottom action lane remains visible via sticky positioning", () => {
  const css = functionBodyBetween("renderLog", "cardImageUrl");
  assert.equal(
    css.includes(".rb-bottomActionBar"),
    true,
    "Arena CSS should define a bottom action bar block."
  );
  assert.equal(
    css.includes("position: sticky"),
    true,
    "Bottom action controls should use sticky positioning to stay visible."
  );
});

test("mulligan compact mode tightens lane columns for 1080p fit", () => {
  assert.equal(
    source.includes(".rb-boardMulligan .rb-playerLaneTop,") && source.includes(".rb-boardMulligan .rb-playerLaneBottom"),
    true,
    "Mulligan compact mode should explicitly tighten top/bottom lane grid columns."
  );
});

test("mulligan compact mode scales right info grid aggressively", () => {
  assert.equal(
    source.includes("scale(0.84)"),
    true,
    "Mulligan compact mode should shrink the right info grid enough to avoid bottom clipping at 1920x981."
  );
});

test("live board mode is explicitly tagged for dense viewport compaction", () => {
  assert.equal(
    source.includes("rb-boardLive"),
    true,
    "Non-mulligan board rendering should expose a live-mode class for targeted dense-layout CSS."
  );
});

test("dense viewport profile compacts live board battlefield and lane sizing", () => {
  assert.equal(
    source.includes(".rb-boardLive .rb-bf") &&
      source.includes(".rb-boardLive .rb-playerLaneTop,") &&
      source.includes(".rb-boardLive .rb-playerLaneBottom"),
    true,
    "Low-height dense profile should explicitly compact live board battlefields and top/bottom lanes."
  );
});

test("dense live profile uses top-packed board flow instead of space-between", () => {
  assert.equal(
    source.includes(".rb-boardLive .rb-boardInner") && source.includes("justify-content: flex-start"),
    true,
    "Dense live profile should top-pack board sections to avoid bottom-control clipping."
  );
});

test("dense live profile compacts bottom action controls and phase pills", () => {
  assert.equal(
    source.includes(".rb-boardLive .rb-bigButton") &&
      source.includes(".rb-boardLive .rb-phasePill"),
    true,
    "Dense live profile should explicitly shrink end-turn/pass buttons and phase pills."
  );
});

test("low-height profile compacts topbar controls for extra board space", () => {
  assert.equal(
    source.includes(".rb-topbarControls button, .rb-topbarControls select") &&
      source.includes("padding: 5px 8px") &&
      source.includes("font-size: 11px"),
    true,
    "Low-height profile should shrink topbar control padding/font to free vertical space for the board."
  );
});

test("dense live profile suppresses secondary hand-lane hint text to avoid clipping", () => {
  assert.equal(
    source.includes(".rb-boardLive .rb-handAuxRight .rb-actionHint") &&
      source.includes("display: none"),
    true,
    "Dense live profile should hide non-critical right-lane hint text at low heights."
  );
});

test("phase track progression uses a single current index and lights stages left-to-right", () => {
  assert.equal(
    source.includes("const phaseCurrentIndex =") &&
      source.includes("idx <= phaseCurrentIndex"),
    true,
    "Phase pills should activate in strict sequence from left to right up to the current stage."
  );
});

test("phase track includes an explicit mulligan stage before awaken", () => {
  assert.equal(
    source.includes("{ key: \"MULLIGAN\", label: \"Mulligan\" }"),
    true,
    "Phase track should include a Mulligan stage so early-game progression is visually ordered."
  );
});

test("phase progression maps scoring into beginning stage to keep left-to-right order", () => {
  assert.equal(
    /case "SCORING":[\s\S]*?return 2;/.test(source),
    true,
    "SCORING should map to the beginning-stage index so phase progression does not jump forward then backward."
  );
});

test("dense live profile hides left hand-lane helper hint and shrinks rune cards", () => {
  assert.equal(
    source.includes(".rb-boardLive .rb-handAuxLeft .rb-actionHint") &&
      source.includes(".rb-boardLive .rb-rune") &&
      source.includes("width: 48px") &&
      source.includes("height: 68px"),
    true,
    "Low-height live mode should hide left helper text and shrink rune cards to reduce bottom overlap."
  );
});

test("dense live profile clamps hand hover pop-out so cards stay inside the bottom lane", () => {
  assert.equal(
    source.includes(".rb-boardLive .rb-handSlot:hover,") &&
      source.includes(".rb-boardLive .rb-handSlotHover") &&
      source.includes("scale(1.3)") &&
      source.includes(".rb-boardLive .rb-handSlotEdgeLeft:hover"),
    true,
    "Low-height live mode should reduce hand hover lift/scale and edge offsets to avoid overlap with bottom controls."
  );
});

test("phase track uses explicit 'Ending' label for the final stage", () => {
  assert.equal(
    source.includes("{ key: \"ENDING\", label: \"Ending\" }"),
    true,
    "Final phase pill should use clear 'Ending' wording to match the phase naming convention."
  );
});

test("ultra-tight live profile exists for very short viewports", () => {
  assert.equal(
    source.includes("@media (max-height: 940px)") &&
      source.includes(".rb-boardLive .rb-hand") &&
      source.includes(".rb-boardLive .rb-phasePill") &&
      source.includes(".rb-boardLive .rb-bigButton"),
    true,
    "Very short viewports should have an explicit extra compact profile for hand, phase pills, and primary action buttons."
  );
});
