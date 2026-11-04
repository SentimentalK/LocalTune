/**
 * Default local-source strategy for this browser.
 *
 * Android Chrome cannot keep a File System Access grant across launches, so it
 * imports into OPFS instead. Browsers without `showDirectoryPicker` have no
 * reference mode at all. Pure function: no globals are read here.
 */
export function defaultLocalMode({ userAgent = '', hasPicker = false } = {}) {
  if (/Android/i.test(String(userAgent))) return 'import';
  return hasPicker ? 'reference' : 'import';
}
