import { test, expect } from '@playwright/test';

test('Reveal Mechanics Repro', async ({ page }) => {
    // Debug: Print console logs
    page.on('console', msg => console.log(`BROWSER LOG: ${msg.text()}`));
    page.on('pageerror', err => console.log(`BROWSER ERROR: ${err.message}`));

    // 1. Visit the app
    await page.goto('http://localhost:5173/');

    // 2. Load card data (Setup screen)
    // Assuming the "Load default card data" button exists on the setup screen or dev tools
    // The Dev Tools usually appear or are part of the main UI?
    // RBEXP.tsx usually starts in Setup mode if no game.
    // Wait for "Load default card data" button.
    const loadBtn = page.getByText('Load default card data');
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();

    // Wait for "Loaded cards:" to show a number > 0
    await expect(page.getByText('Loaded cards:')).toBeVisible();

    // 3. Start Auto Duel to get into the game view where Dev Tools are
    // Or use "Quick Start (local data)" which does both?
    // Let's use "Quick Start (local data)" if available, or just use the "Auto-setup Duel" button.
    // The repro button "Run Reveal Repro" is inside the "Actions" panel which requires a running game.

    // Actually, I added the button to the "Actions" panel (renderDevToolsModal is separate?).
    // No, `renderDevToolsModal` IS the setup screen?
    // Let's check `renderSetupScreen`.
    // `renderSetupScreen` has "Load default card data".
    // `renderDevToolsModal` has "Run Seal Auto-pay Repro" etc.
    // But wait, where is `renderDevToolsModal` used?
    // It's likely the "Classic" view or a popup.
    // In `renderArenaGame`, there is a sidebar?

    // Let's assume we need to start the game first.
    await page.getByText('Auto-setup Duel (Hot-seat)').click();

    // 4. Locate "Run Reveal Repro" button
    // It might be in the "Actions" panel on the right/bottom.
    // ID: #rb-run-reveal-audit-repro
    const revealBtn = page.locator('#rb-run-reveal-audit-repro');
    await expect(revealBtn).toBeVisible();
    await revealBtn.click();

    // 5. Verify Modal appears
    // The log should say: "1. Play 'Dazzling Aurora'..."
    // But we need to PLAY the card to start the sequence.
    // The repro just SETS UP the hand.
    // We need to Find 'Dazzling Aurora' in hand and click it.

    // 6. Play Dazzling Aurora
    // Locate card in hand (P1). Since text might be hidden by image, pick the first card (we stacked the deck).
    try {
        const auroraCard = page.locator('.rb-handSlot').first().locator('.rb-card'); // First card in hand
        await expect(auroraCard).toBeVisible({ timeout: 5000 });
        await auroraCard.click();
    } catch (e) {
        console.log('BROWSER LOG: Hand Content:', await page.locator('.rb-handCenter').first().innerText());
        throw e;
    }

    // 7. Click "Play" or confirm if needed.
    // If it's a spell, clicking it might just select it?
    // Usually need to click target? Dazzling Aurora has NO targets?
    // "Reveal cards..."
    // If it has no targets, it might just play or require confirmation.
    // If it requires Play button:
    const playBtn = page.getByText('Play This Card'); // or similar
    // If it's direct click-to-play:
    // We might need to check if a "Play" button appears.
    // In Arena, clicking a card usually selects it and shows "Play" option?
    // Or standard `enginePlayCard` is triggered.

    // Let's assume standard interaction: Click card -> Click "Play" button if ambiguous, or it plays.
    // If it needs target, we'd know.

    // 8. Verify Reveal Window
    const modal = page.locator('.rb-modalWindow');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Revealed 4 cards');
    await expect(modal).toContainText('Matched: Revealed Spell');

    // 9. Click Continue
    await modal.getByText('Continue').click();

    // 10. Verify Result
    // "Revealed Spell" should be played automatically (no targets).
    await expect(page.locator('.rb-logPanel')).toContainText('P1 plays Revealed Spell for free');
    await expect(page.locator('.rb-logPanel')).toContainText('P1 draws 1 card');

});
