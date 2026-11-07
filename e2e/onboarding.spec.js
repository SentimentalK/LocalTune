import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const OVERLAY = '[data-testid="onboarding"]';
const NEXT = '[data-testid="onboarding-next"]';
const SKIP = '[data-testid="onboarding-skip"]';
const CAPTION = '[data-testid="onboarding-caption"]';
const TIP = '[data-testid="onboarding-arrow-tip"]';
const MARKER = '[data-onboarding-target]';
const KEY = 'localtune:onboarded';

const STEPS = [
  { id: 'play', caption: '点这里播放' },
  { id: 'seek', caption: '拖唱臂跳转' },
  { id: 'tabs', caption: '在这里切换队列' },
  { id: 'search', caption: '搜歌名、歌手、专辑' },
];

const shots = '.scratch/conductor/az';

const stored = (page) => page.evaluate((key) => localStorage.getItem(key), KEY);

async function openGuide(page) {
  await page.goto('/?onboarding=force');
  await expect(page.locator(OVERLAY)).toBeVisible();
}

/** Walk one step: the caption, the single marked target and the arrow tip. */
async function expectStep(page, index) {
  const step = STEPS[index];
  await expect(page.locator(CAPTION)).toContainText(step.caption);
  const marked = page.locator(MARKER);
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveAttribute('data-onboarding-target', '');
  return { marked, step };
}

async function tipDistance(page, marked) {
  const targetBox = await marked.boundingBox();
  const tipBox = await page.locator(TIP).boundingBox();
  const dx = targetBox.x + targetBox.width / 2 - (tipBox.x + tipBox.width / 2);
  const dy = targetBox.y + targetBox.height / 2 - (tipBox.y + tipBox.height / 2);
  return Math.hypot(dx, dy);
}

/**
 * The first step can appear while the library panel is still animating open,
 * which slides the deck under the arrow. The guide follows the target, so the
 * assertion polls until the arrow lands; the returned value is the settled gap.
 */
async function settledDistance(page, marked) {
  await expect.poll(() => tipDistance(page, marked), { timeout: 5000 }).toBeLessThanOrEqual(24);
  return tipDistance(page, marked);
}

test.describe('first run', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('walks four steps, marks the guide done and stays closed after reload', async ({
    page,
  }) => {
    await openGuide(page);
    await expectStep(page, 0);

    for (let i = 0; i < 4; i += 1) await page.locator(NEXT).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect(await stored(page)).toBe('v1');

    await page.reload();
    await expect(page.locator('.wordmark')).toHaveText('localtune.');
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });
});

test.describe('anchor accuracy', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the phone arrow ends on every marked control', async ({ page }) => {
    await openGuide(page);
    let worst = 0;
    for (let i = 0; i < STEPS.length; i += 1) {
      const { marked } = await expectStep(page, i);
      worst = Math.max(worst, await settledDistance(page, marked));
      if (i < STEPS.length - 1) await page.locator(NEXT).click();
    }
    console.log(`anchor max 390x844: ${worst.toFixed(1)}px`);
  });
});

test.describe('anchor accuracy desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the desktop arrow ends on every marked control', async ({ page }) => {
    await openGuide(page);
    let worst = 0;
    for (let i = 0; i < STEPS.length; i += 1) {
      const { marked } = await expectStep(page, i);
      worst = Math.max(worst, await settledDistance(page, marked));
      if (i < STEPS.length - 1) await page.locator(NEXT).click();
    }
    console.log(`anchor max 1280x800: ${worst.toFixed(1)}px`);
  });
});

test.describe('skipping', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('skip ends the guide and counts as seen', async ({ page }) => {
    await openGuide(page);
    await page.locator(NEXT).click();
    await expect(page.locator(CAPTION)).toContainText('拖唱臂跳转');
    await page.locator(SKIP).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect(await stored(page)).toBe('v1');

    await page.reload();
    await expect(page.locator('.wordmark')).toHaveText('localtune.');
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });
});

test.describe('replay from About', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('about replays the guide from the first step', async ({ page }) => {
    await openGuide(page);
    for (let i = 0; i < 4; i += 1) await page.locator(NEXT).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);

    await page.locator('[data-testid="settings-open"]').click();
    await page.locator('[data-testid="onboarding-replay"]').click();

    await expect(page.locator(OVERLAY)).toBeVisible();
    await expect(page.locator(CAPTION)).toContainText('点这里播放');
    expect(await stored(page)).toBeNull();

    for (let i = 0; i < 4; i += 1) await page.locator(NEXT).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);
    expect(await stored(page)).toBe('v1');
  });
});

test.describe('reduced motion', () => {
  test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });

  test('the arrow is drawn at once and the tour still completes', async ({ page }) => {
    await openGuide(page);
    const arrow = page.locator('[data-testid="onboarding-arrow"]');
    await expect(arrow).toHaveCount(1);
    const style = await arrow.evaluate((node) => {
      const computed = getComputedStyle(node);
      return {
        animationName: computed.animationName,
        strokeDashoffset: computed.strokeDashoffset,
      };
    });
    expect(style.animationName).toBe('none');
    expect(style.strokeDashoffset).toBe('0px');

    for (let i = 0; i < 4; i += 1) await page.locator(NEXT).click();
    await expect(page.locator(OVERLAY)).toHaveCount(0);
  });
});

test.describe('screenshots', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('phone steps', async ({ page }) => {
    mkdirSync(shots, { recursive: true });
    await openGuide(page);
    for (let i = 0; i < STEPS.length; i += 1) {
      const { marked } = await expectStep(page, i);
      await settledDistance(page, marked);
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${shots}/onboarding-390-${i + 1}-${STEPS[i].id}.png` });
      if (i < STEPS.length - 1) await page.locator(NEXT).click();
    }
  });
});

test.describe('screenshots desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('desktop steps', async ({ page }) => {
    mkdirSync(shots, { recursive: true });
    await openGuide(page);
    for (let i = 0; i < STEPS.length; i += 1) {
      const { marked } = await expectStep(page, i);
      await settledDistance(page, marked);
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${shots}/onboarding-1280-${i + 1}-${STEPS[i].id}.png` });
      if (i < STEPS.length - 1) await page.locator(NEXT).click();
    }
  });
});
