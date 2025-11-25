import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
    await page.goto('/');

    // Expect a title "to contain" a substring.
    // Note: You might need to update this expectation based on your actual app title
    await expect(page).toHaveTitle(/Constellation Editor/);
});
