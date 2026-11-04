/**
 * Android battery-optimisation guidance. Chrome's UA string no longer carries
 * the device model on modern Android, so the model comes from UA-CH
 * (`navigator.userAgentData.getHighEntropyValues(['model'])`) and the UA string
 * is only a fallback. Pure module: callers pass the strings they already have.
 */

export const BATTERY_BRANDS = ['samsung', 'xiaomi', 'huawei', 'stock'];

/**
 * The `intent:` shortcut to the system battery settings only resolves on
 * Android 14+ AOSP (Android 12/13 do not declare BROWSABLE) and OEM behaviour
 * cannot be verified, so it is not offered as a button. Kept so a future
 * progressive enhancement can enable it without changing call sites.
 */
export const BATTERY_INTENT_URL = null;

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

function targetFromModel(model) {
  const text = String(model ?? '');
  if (!text) return null;
  if (/^SM-|SAMSUNG/i.test(text)) return 'samsung';
  if (/^(M\d{4}|2\d{3})|POCO|Redmi|^MI /i.test(text)) return 'xiaomi';
  if (/^(ELS|ANA|NOH|ALN)-|HUAWEI|HarmonyOS/i.test(text)) return 'huawei';
  return null;
}

function targetFromUserAgent(userAgent) {
  const text = String(userAgent ?? '');
  if (/SamsungBrowser|SM-[A-Z0-9]/i.test(text)) return 'samsung';
  if (/MIUI|MiuiBrowser|XiaoMi|Redmi|POCO|HyperOS/i.test(text)) return 'xiaomi';
  if (/HuaweiBrowser|HUAWEI|EMUI|HarmonyOS/i.test(text)) return 'huawei';
  return 'stock';
}

/**
 * Pick the settings guide for this device. The UA-CH model wins; when it is
 * missing or unrecognised the UA keywords decide, and everything else is stock.
 */
export function batteryTarget({ userAgent = '', model = '' } = {}) {
  return targetFromModel(model) ?? targetFromUserAgent(userAgent);
}
