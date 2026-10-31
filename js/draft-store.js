/**
 * Draft Store
 * Keeps the current work (cards, images, passport) in IndexedDB so a reload or crash
 * does not lose an already paid-for translation. All calls fail soft.
 */

const DB_NAME = 'card-translator';
const STORE = 'drafts';
const DRAFT_KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB недоступен'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveDraft(draft) {
  try {
    await withStore('readwrite', store => store.put({ ...draft, savedAt: Date.now() }, DRAFT_KEY));
    return true;
  } catch (err) {
    console.warn('Draft save failed', err);
    return false;
  }
}

export async function loadDraft() {
  try {
    return (await withStore('readonly', store => store.get(DRAFT_KEY))) || null;
  } catch (err) {
    console.warn('Draft load failed', err);
    return null;
  }
}

export async function clearDraft() {
  try {
    await withStore('readwrite', store => store.delete(DRAFT_KEY));
  } catch (err) {
    console.warn('Draft clear failed', err);
  }
}
