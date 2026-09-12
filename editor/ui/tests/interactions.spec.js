import { test, expect } from '@playwright/test';

test.describe('Editor Interactions', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('should display main layout components', async ({ page }) => {
        // Menu bar
        await expect(page.getByRole('menuitem', { name: 'File' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'View' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Displays' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Help' })).toBeVisible();

        // Timeline. Play is a toggle now, so there is no separate Pause button
        // until playback starts.
        await expect(page.getByTestId('timeline-title')).toBeVisible();
        await expect(page.getByLabel('Play')).toBeVisible();
        await expect(page.getByLabel('Stop')).toBeVisible();
        await expect(page.getByLabel('Go to Start')).toBeVisible();

        // Media bin
        await expect(page.getByText('Media Bin', { exact: true })).toBeVisible();
        await expect(page.getByLabel('Add New')).toBeVisible();

        // Status bar
        await expect(page.getByText('Untitled')).toBeVisible();
    });

    test('should open and navigate File menu', async ({ page }) => {
        await page.getByRole('menuitem', { name: 'File' }).click();

        await expect(page.getByRole('menuitem', { name: /New Show/ })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: /Open Show/ })).toBeVisible();
        // Exact names: Save and Save As are two separate items, so a loose
        // match would resolve to both and fail strict mode.
        await expect(page.getByRole('menuitem', { name: 'Save Show', exact: true })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Save Show As…' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Quit' })).toBeVisible();
    });

    test('Edit menu exposes undo, redo and selection commands', async ({ page }) => {
        await page.getByRole('menuitem', { name: 'Edit' }).click();

        // Nothing has been edited yet, so Undo and Redo are unavailable.
        await expect(page.getByRole('menuitem', { name: 'Undo' })).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('menuitem', { name: 'Redo' })).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('menuitem', { name: /Select All Clips/ })).toBeVisible();
    });

    test('View menu shows viewport and panel toggles', async ({ page }) => {
        await page.getByRole('menuitem', { name: 'View' }).click();

        await expect(page.getByRole('menuitemradio', { name: '2D Stage' })).toBeVisible();
        await expect(page.getByRole('menuitemradio', { name: '3D Scene' })).toBeVisible();
        await expect(page.getByRole('menuitemradio', { name: 'Output' })).toBeVisible();
        await expect(page.getByRole('menuitemcheckbox', { name: 'Output Overlay' })).toBeVisible();

        await expect(page.getByRole('menuitemradio', { name: 'Move' })).toBeVisible();
        await expect(page.getByRole('menuitemradio', { name: 'Rotate' })).toBeVisible();
        await expect(page.getByRole('menuitemradio', { name: 'Scale' })).toBeVisible();

        await expect(page.getByRole('menuitemcheckbox', { name: 'Timeline' })).toBeVisible();
    });

    test('menus are keyboard operable', async ({ page }) => {
        const file = page.getByRole('menuitem', { name: 'File' });
        await file.focus();
        await page.keyboard.press('ArrowDown');
        await expect(file).toHaveAttribute('aria-expanded', 'true');

        // Escape closes and returns focus to the trigger.
        await page.keyboard.press('Escape');
        await expect(file).toHaveAttribute('aria-expanded', 'false');
        await expect(file).toBeFocused();
    });

    test('New Show only warns when there are unsaved changes', async ({ page }) => {
        // A clean document goes straight through, with no dialog.
        await page.getByRole('menuitem', { name: 'File' }).click();
        await page.getByRole('menuitem', { name: /New Show/ }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);

        // Dirty it, then the styled confirmation appears (no native dialog).
        await page.getByLabel('Add Track').click();
        await page.getByRole('menuitem', { name: 'File' }).click();
        await page.getByRole('menuitem', { name: /New Show/ }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('unsaved changes');
        await dialog.getByRole('button', { name: 'Discard' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('should add a new track', async ({ page }) => {
        await page.getByLabel('Add Track').click();
        await expect(page.getByLabel('Add Track')).toBeVisible();
        // A track exists and can be renamed from its header.
        await expect(page.getByText('Track 1')).toBeVisible();
    });

    test('should zoom timeline', async ({ page }) => {
        // The stage has its own zoom controls, labelled "(Stage)".
        const zoomIn = page.getByLabel('Zoom In', { exact: true });
        const zoomOut = page.getByLabel('Zoom Out', { exact: true });

        await expect(zoomIn).toBeVisible();
        await expect(zoomOut).toBeVisible();

        await zoomIn.click();
        await zoomOut.click();
        await expect(page.getByLabel('Zoom to Fit')).toBeVisible();
    });

    test('play toggles to pause and back', async ({ page }) => {
        await page.getByLabel('Play').click();
        await expect(page.getByLabel('Pause')).toBeVisible();
        await page.getByLabel('Pause').click();
        await expect(page.getByLabel('Play')).toBeVisible();
    });

    test('keyboard shortcut overlay lists the bindings', async ({ page }) => {
        await page.getByRole('menuitem', { name: 'Help' }).click();
        await page.getByRole('menuitem', { name: /Keyboard Shortcuts/ }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Play / Pause');
        await expect(dialog).toContainText('Transport');

        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('media bin can be searched and filtered', async ({ page }) => {
        await expect(page.getByLabel('Search media')).toBeVisible();
        await expect(page.getByLabel('Sort media')).toBeVisible();
        await expect(page.getByText('No media yet.')).toBeVisible();

        await page.getByLabel('Search media').fill('nothing-matches');
        // With no media at all the empty state stays as it is.
        await expect(page.getByText('No media yet.')).toBeVisible();
    });

    test('panels collapse and reopen from the View menu', async ({ page }) => {
        await page.getByRole('menuitem', { name: 'View' }).click();
        await page.getByRole('menuitemcheckbox', { name: 'Media Bin' }).click();
        await expect(page.getByLabel('Show Media Bin')).toBeVisible();

        await page.getByLabel('Show Media Bin').click();
        await expect(page.getByLabel('Search media')).toBeVisible();
    });

});
