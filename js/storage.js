/* ============================================================
   js/storage.js — IndexedDB 래퍼
   임시저장(draft), 양식 캐시(form config)를 로컬에 저장.
   모든 함수는 async/await 방식.
   ============================================================ */

const DB_NAME    = 'inspection-app';
const DB_VERSION = 1;

let _db = null;

/** DB 초기화 (앱 시작 시 1회 호출) */
export async function initDB() {
  if (_db) return _db;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // 양식 임시저장 스토어
      // key: formId, value: { formId, version, data: {fieldKey: value}, savedAt }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'formId' });
      }

      // 양식 설정 캐시 스토어
      // key: formId, value: { formId, version, config: {...}, cachedAt }
      if (!db.objectStoreNames.contains('formCache')) {
        db.createObjectStore('formCache', { keyPath: 'formId' });
      }
    };

    req.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    req.onerror = () => reject(req.error);
  });
}

/** 내부 헬퍼: 트랜잭션 래퍼 */
function tx(storeName, mode = 'readonly') {
  if (!_db) throw new Error('DB not initialized. Call initDB() first.');
  return _db.transaction(storeName, mode).objectStore(storeName);
}

/** IndexedDB get → Promise */
function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB put → Promise */
function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB delete → Promise */
function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* ── 임시저장 (Drafts) ──────────────────────────────────── */

/**
 * 양식 임시저장
 * @param {string} formId
 * @param {number} version
 * @param {Object} data  - { fieldKey: value, ... }
 *                         이미지는 Base64 dataURL로 저장
 */
export async function saveDraft(formId, version, data) {
  await dbPut('drafts', {
    formId,
    version,
    data,
    savedAt: new Date().toISOString()
  });
}

/**
 * 임시저장 불러오기
 * @returns {{ formId, version, data, savedAt } | null}
 */
export async function loadDraft(formId) {
  return await dbGet('drafts', formId);
}

/** 임시저장 삭제 (보고서 완료 후 호출) */
export async function clearDraft(formId) {
  await dbDelete('drafts', formId);
}

/** 임시저장된 양식 ID 목록 조회 (홈 화면 재접속 감지용) */
export async function listDrafts() {
  return new Promise((resolve, reject) => {
    const store = tx('drafts');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

/* ── 양식 설정 캐시 (Form Config Cache) ──────────────────── */

/**
 * 양식 설정 캐싱
 * @param {string} formId
 * @param {number} version
 * @param {Object} config - 양식 설정 JSON 전체
 */
export async function cacheFormConfig(formId, version, config) {
  await dbPut('formCache', {
    formId,
    version,
    config,
    cachedAt: new Date().toISOString()
  });
}

/**
 * 캐시된 양식 설정 조회
 * @returns {{ formId, version, config, cachedAt } | null}
 */
export async function getCachedForm(formId) {
  return await dbGet('formCache', formId);
}

/** 캐시 삭제 */
export async function clearFormCache(formId) {
  await dbDelete('formCache', formId);
}
