/**
 * Brand table for the Android battery-optimisation steps shown in Settings.
 * Pure data: the UI renders one `<details>` per brand plus the generic stock
 * steps.
 */

export const BATTERY_BRANDS = ['samsung', 'xiaomi', 'huawei', 'stock'];

export const BATTERY_STEP_KEYS = {
  samsung: [
    'settings.background.samsung1',
    'settings.background.samsung2',
    'settings.background.samsung3',
  ],
  xiaomi: [
    'settings.background.xiaomi1',
    'settings.background.xiaomi2',
    'settings.background.xiaomi3',
  ],
  huawei: [
    'settings.background.huawei1',
    'settings.background.huawei2',
    'settings.background.huawei3',
  ],
  stock: [
    'settings.background.stock1',
    'settings.background.stock2',
    'settings.background.stock3',
  ],
};
