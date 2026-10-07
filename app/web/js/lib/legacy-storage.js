/**
 * The app was called ProjectOS: settings kept in this browser (accent, profile, dismissed
 * briefings, drafts…) were saved under "projectos:". Copied once to "flintbench:" so nothing is
 * lost with the new name. Imported first by main.js, before anything reads the storage.
 */
try {
  const OLD = 'projectos:';
  const legacy = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(OLD)) legacy.push(key);
  }
  for (const key of legacy) {
    const next = `flintbench:${key.slice(OLD.length)}`;
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch { /* storage unavailable */ }
