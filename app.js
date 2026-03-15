/* ============================================================
   js/app.js — 메인 앱 (라우터 + 상태 + 전체 화면 렌더링)
   
   화면 흐름:
   home → form-select → form-fill → (crop-image) → (sign) → (save)
   home → admin-login → admin-dashboard → admin-form-edit
   ============================================================ */

import { initDB, saveDraft, loadDraft, clearDraft, listDrafts } from './storage.js';
import { buildAndDownloadHwpx, shareOrDownload, cropAndResize, downloadBlob } from './hwpx.js';

/* ── SUPABASE 설정 ──────────────────────────────────────── */
// TODO: 실제 배포 시 아래 값을 Supabase 프로젝트 설정으로 교체
// import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'
// const supabase = createClient('YOUR_SUPABASE_URL', 'YOUR_SUPABASE_ANON_KEY');
const USE_MOCK = true; // false로 바꾸면 Supabase 연동 모드

/* ── 목 데이터 (Supabase 대체용) ─────────────────────────── */
const MOCK_DEPARTMENTS = [
  { id: 'dept-1', name: '학교지원과' },
  { id: 'dept-2', name: '평생교육과' },
  { id: 'dept-3', name: '진로직업과' }
];

const MOCK_FORMS = [
  {
    id: 'form-001',
    department_id: 'dept-1',
    title: '학원 현장 점검 보고서',
    version: 3,
    updated_at: '2026-03-10',
    fields: [
      { key: 'T_기관명',     type: 'text',      label: '기관(학원)명',      required: true },
      { key: 'T_점검자',     type: 'text',      label: '점검자 성명',        required: true },
      { key: 'D_점검일자',   type: 'date',      label: '점검 일자',          required: true },
      { key: 'L_학교급',     type: 'list',      label: '학교급',
        options: ['초등학교', '중학교', '고등학교', '유치원', '특수학교'], required: true },
      { key: 'N_수강생수',   type: 'number',    label: '수강생 수 (명)',      required: false },
      { key: 'C_자가진단',   type: 'checkbox',  label: '자가진단 설문 실시 여부', required: false },
      { key: 'C_위생점검',   type: 'checkbox',  label: '위생 점검 실시 여부',    required: false },
      { key: 'I_외부전경',   type: 'image',     label: '외부 전경 사진',
        aspect_ratio: '4:3', required: true },
      { key: 'I_내부현황',   type: 'image',     label: '내부 현황 사진',
        aspect_ratio: '4:3', required: false },
      { key: 'S_점검자서명', type: 'signature', label: '점검자 서명',         required: true },
      { key: 'T_특이사항',   type: 'text',      label: '특이사항 (없으면 공란)', required: false }
    ]
  },
  {
    id: 'form-002',
    department_id: 'dept-1',
    title: '시설 안전 점검 보고서',
    version: 1,
    updated_at: '2026-02-20',
    fields: [
      { key: 'T_시설명',     type: 'text',      label: '시설명',             required: true },
      { key: 'D_점검일자',   type: 'date',      label: '점검 일자',          required: true },
      { key: 'C_소화기',     type: 'checkbox',  label: '소화기 점검 여부',   required: true },
      { key: 'C_비상구',     type: 'checkbox',  label: '비상구 점검 여부',   required: true },
      { key: 'I_점검현장',   type: 'image',     label: '점검 현장 사진',
        aspect_ratio: '16:9', required: true },
      { key: 'S_점검자서명', type: 'signature', label: '점검자 서명',        required: true }
    ]
  }
];

/* ── 앱 상태 ──────────────────────────────────────────────── */
const STATE = {
  page: 'home',               // 현재 화면
  departments: [],
  forms: [],
  currentForm: null,          // 선택된 양식 config
  formData: {},               // 입력된 데이터 { fieldKey: value }
  templateBlob: null,         // HWPX 템플릿 Blob (저장 시 다운로드용)
  cropTarget: null,           // 크롭 중인 필드 key
  cropImage: null,            // 크롭할 원본 Image 객체
  adminUser: null,
  adminForms: [...MOCK_FORMS]
};

/* ── 라우터 ───────────────────────────────────────────────── */
function navigate(page, params = {}) {
  Object.assign(STATE, params);
  STATE.page = page;
  render();
}

function render() {
  const app = document.getElementById('app');
  switch (STATE.page) {
    case 'home':            app.innerHTML = renderHome();          bindHomeEvents();   break;
    case 'form-select':     app.innerHTML = renderFormSelect();    bindFormSelectEvents(); break;
    case 'form-fill':       app.innerHTML = renderFormFill();      bindFormFillEvents(); break;
    case 'crop-image':      renderCropScreen();                    break;
    case 'sign':            renderSignScreen();                    break;
    case 'admin-login':     app.innerHTML = renderAdminLogin();    bindAdminLoginEvents(); break;
    case 'admin-dashboard': app.innerHTML = renderAdminDashboard(); bindAdminDashboardEvents(); break;
    default:                app.innerHTML = `<div class="loading-screen"><p>알 수 없는 화면</p></div>`;
  }
}

/* ══════════════════════════════════════════════════════════
   화면 1. 홈
   ══════════════════════════════════════════════════════════ */
function renderHome() {
  return `
    <div class="home-screen">
      <div>
        <h1 class="home-title">현장 점검 보고서</h1>
        <p class="home-subtitle">작성한 보고서는 기기에만 저장됩니다.</p>
      </div>
      <div class="home-cards">
        <div class="home-card primary" id="btn-form-select">
          <div class="home-card-title">양식 선택</div>
          <div class="home-card-desc">점검 양식을 선택하고 보고서를 작성합니다</div>
        </div>
        <div class="home-card" id="btn-open-folder">
          <div class="home-card-title">저장 폴더 열기</div>
          <div class="home-card-desc">완성된 보고서 파일을 확인합니다</div>
        </div>
        <div class="home-card" id="btn-help">
          <div class="home-card-title">도움말</div>
          <div class="home-card-desc">앱 사용 방법을 확인합니다</div>
        </div>
      </div>
      <div style="margin-top:auto; padding-top:24px; text-align:center">
        <button class="btn-text" id="btn-admin-link" style="color:#AAAAAA; font-size:12px">
          관리자 메뉴
        </button>
      </div>
    </div>`;
}

async function bindHomeEvents() {
  document.getElementById('btn-form-select').onclick = async () => {
    await loadFormsData();
    // 임시저장 데이터 확인
    const drafts = await listDrafts();
    if (drafts.length > 0) {
      const draft = drafts[0];
      const form = STATE.forms.find(f => f.id === draft.formId);
      if (form) {
        showModal({
          title: '이어서 작성하시겠습니까?',
          body: `'${form.title}' 작성 중인 내용이 있습니다.`,
          confirmText: '이어서 작성',
          cancelText: '처음부터',
          onConfirm: () => {
            STATE.currentForm = form;
            STATE.formData = draft.data || {};
            navigate('form-fill');
          },
          onCancel: async () => {
            await clearDraft(draft.formId);
            navigate('form-select');
          }
        });
        return;
      }
    }
    navigate('form-select');
  };

  document.getElementById('btn-open-folder').onclick = () => {
    // 모바일 파일 앱으로 이동 (Android Intent / iOS 딥링크)
    // Android: files:///storage/emulated/0/Download
    // iOS: shareddocuments:// (제한적 지원)
    try {
      window.open('files:///storage/emulated/0/Download', '_system');
    } catch {
      showSnackbar('기기의 파일 앱에서 다운로드 폴더를 확인하세요.');
    }
  };

  document.getElementById('btn-help').onclick = () => {
    showModal({
      title: '사용 방법',
      body: `1. [양식 선택]으로 점검 양식을 선택합니다.\n2. 현장에서 내용을 입력하고 사진을 촬영합니다.\n3. [양식 저장] 또는 [양식 전송]으로 보고서를 완성합니다.\n\n※ 작성 중 내용은 자동 임시저장됩니다.`,
      confirmText: '확인',
      cancelText: null
    });
  };

  document.getElementById('btn-admin-link').onclick = () => {
    navigate('admin-login');
  };
}

/* ══════════════════════════════════════════════════════════
   화면 2. 양식 선택
   ══════════════════════════════════════════════════════════ */
function renderFormSelect() {
  const deptOptions = STATE.departments
    .map(d => `<option value="${d.id}">${d.name}</option>`)
    .join('');

  return `
    <div class="screen">
      <div class="header">
        <button class="header-back" id="back-home">← 홈</button>
        <div class="header-title">양식 선택</div>
      </div>
      <div class="content">
        <div class="form-group">
          <label class="form-label required">부서 선택</label>
          <select class="form-input" id="dept-select">
            <option value="">— 부서를 선택하세요 —</option>
            ${deptOptions}
          </select>
        </div>
        <div id="form-list"></div>
      </div>
    </div>`;
}

function bindFormSelectEvents() {
  document.getElementById('back-home').onclick = () => navigate('home');

  document.getElementById('dept-select').onchange = (e) => {
    const deptId = e.target.value;
    const list = document.getElementById('form-list');
    if (!deptId) { list.innerHTML = ''; return; }

    const filtered = STATE.forms.filter(f => f.department_id === deptId);
    if (filtered.length === 0) {
      list.innerHTML = '<p style="color:#AAAAAA; font-size:13px; padding:16px 0">배포된 양식이 없습니다.</p>';
      return;
    }

    list.innerHTML = filtered.map(f => `
      <div class="card">
        <div class="card-title">${f.title}</div>
        <div class="card-meta">v${f.version} · ${f.updated_at}</div>
        <div class="card-footer">
          <button class="btn btn-primary" style="flex:0 0 auto; width:80px"
            data-form-id="${f.id}">작성</button>
        </div>
      </div>
    `).join('');

    // 양식 선택 이벤트
    list.querySelectorAll('[data-form-id]').forEach(btn => {
      btn.onclick = async () => {
        const formId = btn.dataset.formId;
        const form = STATE.forms.find(f => f.id === formId);
        STATE.currentForm = form;
        STATE.formData = {};
        // TODO: HWPX 템플릿은 저장 시점에 서버에서 fetch
        // STATE.templateBlob = await fetchTemplate(form.id);
        navigate('form-fill');
      };
    });
  };
}

/* ══════════════════════════════════════════════════════════
   화면 3. 양식 작성
   ══════════════════════════════════════════════════════════ */
function renderFormFill() {
  const form = STATE.currentForm;
  if (!form) return renderHome();

  const fieldsHtml = form.fields.map(field => renderField(field)).join('');

  return `
    <div class="screen">
      <div class="header">
        <button class="header-back" id="back-form-select">← 양식 선택</button>
        <div class="header-title">${form.title}</div>
      </div>
      <div class="content" id="form-content">
        ${fieldsHtml}
        <div style="height:8px"></div>
      </div>
      <div class="footer-actions">
        <button class="btn btn-secondary" id="btn-save">양식 저장</button>
        <button class="btn btn-primary" id="btn-share">양식 전송</button>
      </div>
    </div>`;
}

function renderField(field) {
  const { key, type, label, required, options, aspect_ratio } = field;
  const val = STATE.formData[key];
  const reqAttr = required ? 'required' : '';
  const labelHtml = `<label class="form-label ${required ? 'required' : ''}">${label}</label>`;

  switch (type) {
    case 'text':
      return `<div class="form-group" data-key="${key}">
        ${labelHtml}
        <input type="text" class="form-input field-input" data-key="${key}"
          value="${escHtml(val || '')}" placeholder="${label} 입력" ${reqAttr}>
        <span class="form-error-text">필수 입력 항목입니다.</span>
      </div>`;

    case 'number':
      return `<div class="form-group" data-key="${key}">
        ${labelHtml}
        <input type="number" inputmode="numeric" class="form-input field-input" data-key="${key}"
          value="${escHtml(val || '')}" placeholder="숫자 입력" ${reqAttr}>
        <span class="form-error-text">필수 입력 항목입니다.</span>
      </div>`;

    case 'date':
      return `<div class="form-group" data-key="${key}">
        ${labelHtml}
        <input type="date" class="form-input field-input" data-key="${key}"
          value="${val || ''}" ${reqAttr}>
        <span class="form-error-text">날짜를 선택하세요.</span>
      </div>`;

    case 'list': {
      const optionsHtml = options.map(o =>
        `<option value="${escHtml(o)}" ${val === o ? 'selected' : ''}>${escHtml(o)}</option>`
      ).join('');
      return `<div class="form-group" data-key="${key}">
        ${labelHtml}
        <select class="form-input field-input" data-key="${key}" ${reqAttr}>
          <option value="">— 선택 —</option>
          ${optionsHtml}
        </select>
        <span class="form-error-text">항목을 선택하세요.</span>
      </div>`;
    }

    case 'checkbox': {
      const isO = val === 'O';
      const isX = val === 'X';
      return `<div class="form-group" data-key="${key}">
        ${labelHtml}
        <div class="radio-group">
          <div class="radio-option choice-o">
            <input type="radio" name="${key}" id="${key}_O" value="O" ${isO ? 'checked' : ''}>
            <label for="${key}_O">O (예)</label>
          </div>
          <div class="radio-option choice-x">
            <input type="radio" name="${key}" id="${key}_X" value="X" ${isX ? 'checked' : ''}>
            <label for="${key}_X">X (아니오)</label>
          </div>
        </div>
        <span class="form-error-text">선택하세요.</span>
      </div>`;
    }

    case 'image': {
      const ratioClass = aspect_ratio === '16:9' ? 'ratio-16-9' : aspect_ratio === '1:1' ? 'ratio-1-1' : '';
      const hasImg = val && val.startsWith('data:');
      return `<div class="form-group" data-key="${key}">
        ${labelHtml}
        <div class="image-card ${ratioClass} ${hasImg ? 'has-image' : ''}" id="img-card-${key}" data-key="${key}">
          ${hasImg
            ? `<img src="${val}" alt="${label}">`
            : `<span style="font-size:20px; color:#AAAAAA">+</span><span>사진 추가</span>`}
        </div>
        ${hasImg ? `<div class="image-card-actions">
          <button class="btn btn-secondary" style="font-size:12px; padding:6px 12px"
            id="img-change-${key}" data-key="${key}">사진 교체</button>
        </div>` : ''}
        <span class="form-error-text">사진을 촬영하거나 선택하세요.</span>
      </div>`;
    }

    case 'signature': {
      const hasSig = val && val.startsWith('data:');
      return `<div class="form-group" data-key="${key}">
        ${labelHtml}
        <div class="signature-card ${hasSig ? 'has-signature' : ''}" id="sig-card-${key}" data-key="${key}">
          ${hasSig
            ? `<img src="${val}" alt="서명"><button class="btn-text" style="font-size:12px"
                id="sig-clear-${key}" data-key="${key}">다시 서명</button>`
            : `<span style="color:#AAAAAA">서명하려면 여기를 누르세요</span>`}
        </div>
        <span class="form-error-text">서명이 필요합니다.</span>
      </div>`;
    }

    default:
      return '';
  }
}

function bindFormFillEvents() {
  const form = STATE.currentForm;

  document.getElementById('back-form-select').onclick = () => {
    showModal({
      title: '작성을 중단하시겠습니까?',
      body: '입력한 내용은 자동 저장되어 이어서 작성할 수 있습니다.',
      confirmText: '나가기',
      cancelText: '계속 작성',
      onConfirm: () => navigate('form-select')
    });
  };

  // 텍스트/숫자/날짜/목록 입력값 실시간 저장
  document.querySelectorAll('.field-input').forEach(el => {
    el.addEventListener('change', async (e) => {
      const key = e.target.dataset.key;
      STATE.formData[key] = e.target.value;
      await saveDraft(form.id, form.version, STATE.formData);
    });
    el.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      STATE.formData[key] = e.target.value;
    });
  });

  // 체크박스 라디오 변경
  form.fields.filter(f => f.type === 'checkbox').forEach(field => {
    document.querySelectorAll(`input[name="${field.key}"]`).forEach(radio => {
      radio.addEventListener('change', async (e) => {
        STATE.formData[field.key] = e.target.value;
        await saveDraft(form.id, form.version, STATE.formData);
      });
    });
  });

  // 이미지 카드 클릭
  document.querySelectorAll('.image-card').forEach(card => {
    card.onclick = (e) => {
      if (e.target.tagName === 'IMG') return; // 이미지 자체 클릭 무시
      showImageSourceSheet(card.dataset.key);
    };
  });
  document.querySelectorAll('[id^="img-change-"]').forEach(btn => {
    btn.onclick = () => showImageSourceSheet(btn.dataset.key);
  });

  // 서명 카드 클릭
  document.querySelectorAll('.signature-card').forEach(card => {
    card.onclick = (e) => {
      if (e.target.id && e.target.id.startsWith('sig-clear-')) return;
      showSignScreen(card.dataset.key);
    };
  });
  document.querySelectorAll('[id^="sig-clear-"]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const key = btn.dataset.key;
      delete STATE.formData[key];
      saveDraft(form.id, form.version, STATE.formData);
      navigate('form-fill');
    };
  });

  // 양식 저장
  document.getElementById('btn-save').onclick = () => generateReport(false);
  document.getElementById('btn-share').onclick = () => generateReport(true);
}

/* ══════════════════════════════════════════════════════════
   보고서 생성
   ══════════════════════════════════════════════════════════ */
async function generateReport(share = false) {
  const form = STATE.currentForm;

  // 필수 항목 검증
  let isValid = true;
  form.fields.forEach(field => {
    if (!field.required) return;
    const val = STATE.formData[field.key];
    const group = document.querySelector(`.form-group[data-key="${field.key}"]`);
    if (!group) return;
    const empty = !val || val === '';
    group.classList.toggle('has-error', empty);
    if (empty) isValid = false;
  });

  if (!isValid) {
    // 첫 번째 오류 항목으로 스크롤
    const firstError = document.querySelector('.form-group.has-error');
    if (firstError) firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showSnackbar('필수 입력 항목을 모두 채워주세요.');
    return;
  }

  // 파일명 생성 (양식제목_날짜_기관명)
  const dateStr = (STATE.formData['D_점검일자'] || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const orgName = STATE.formData['T_기관명'] || STATE.formData['T_시설명'] || '점검';
  const filename = `${form.title}_${dateStr}_${orgName}`;

  // ── HWPX 생성 ──────────────────────────────────────────
  // TODO: 실제 HWPX 템플릿을 Supabase Storage에서 fetch
  // const templateBlob = await fetchHwpxTemplate(form.id);
  
  // 프로토타입: 템플릿 없이 텍스트 파일 다운로드
  if (!STATE.templateBlob) {
    // 프로토타입 모드: 수집된 데이터를 텍스트로 출력
    const txtContent = buildTextReport(form, STATE.formData, filename);
    const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });

    showSnackbar('⚠ 프로토타입 모드: HWPX 대신 텍스트 파일로 저장됩니다.');
    
    if (share) {
      await shareOrDownload(blob, filename + '.txt');
    } else {
      downloadBlob(blob, filename + '.txt');
    }

    await clearDraft(form.id);
    showModal({
      title: '보고서가 완성되었습니다',
      body: `'${filename}.txt' 파일이 저장되었습니다.\n\n실제 HWPX 출력은 관리자가 양식 파일을 서버에 등록한 후 사용할 수 있습니다.`,
      confirmText: '홈으로',
      cancelText: null,
      onConfirm: () => navigate('home')
    });
    return;
  }

  // 실제 HWPX 조립
  try {
    showSnackbar('보고서를 생성 중입니다...');
    if (share) {
      const { blob } = await buildHwpxBlob(STATE.templateBlob, STATE.formData, form.fields);
      await shareOrDownload(blob, filename + '.hwpx');
    } else {
      await buildAndDownloadHwpx(STATE.templateBlob, STATE.formData, form.fields, filename);
    }
    await clearDraft(form.id);
    showModal({
      title: '보고서가 완성되었습니다',
      body: `'${filename}.hwpx' 파일이 저장되었습니다.`,
      confirmText: '홈으로',
      cancelText: null,
      onConfirm: () => navigate('home')
    });
  } catch (err) {
    showSnackbar('오류: ' + err.message);
  }
}

/** 프로토타입용 텍스트 보고서 생성 */
function buildTextReport(form, formData, filename) {
  const lines = [
    `========================================`,
    `  ${form.title}`,
    `  [프로토타입 출력 - 실제 배포 시 HWPX 생성]`,
    `========================================`,
    ``
  ];
  form.fields.forEach(field => {
    const val = formData[field.key];
    let displayVal = val;
    if (field.type === 'image' && val) displayVal = '[사진 첨부됨]';
    if (field.type === 'signature' && val) displayVal = '[서명 첨부됨]';
    if (field.type === 'date' && val) displayVal = val.replace(/-/g, '.');
    lines.push(`${field.label}: ${displayVal || '(미입력)'}`);
  });
  lines.push('');
  lines.push(`생성일시: ${new Date().toLocaleString('ko-KR')}`);
  return lines.join('\n');
}

/* ══════════════════════════════════════════════════════════
   화면 3-1. 이미지 소스 선택 시트
   ══════════════════════════════════════════════════════════ */
function showImageSourceSheet(fieldKey) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-sheet">
      <div class="modal-title">사진 선택</div>
      <button class="source-sheet-btn" id="ss-camera">촬영</button>
      <button class="source-sheet-btn" id="ss-gallery">갤러리에서 선택</button>
      <button class="source-sheet-btn btn-text" id="ss-cancel" style="color:#AAAAAA">취소</button>
    </div>`;
  document.body.appendChild(overlay);

  const field = STATE.currentForm.fields.find(f => f.key === fieldKey);

  overlay.querySelector('#ss-cancel').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.querySelector('#ss-camera').onclick = () => {
    overlay.remove();
    const input = document.getElementById('image-input');
    input.onchange = (e) => handleImageSelected(e, field);
    input.click();
  };

  overlay.querySelector('#ss-gallery').onclick = () => {
    overlay.remove();
    const input = document.getElementById('gallery-input');
    input.onchange = (e) => handleImageSelected(e, field);
    input.click();
  };
}

function handleImageSelected(event, field) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = ''; // 같은 파일 재선택 가능하도록 초기화

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      STATE.cropImage = img;
      STATE.cropTarget = field.key;
      STATE.page = 'crop-image';
      renderCropScreen();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ══════════════════════════════════════════════════════════
   화면 3-1. 크롭 UI
   ══════════════════════════════════════════════════════════ */
function renderCropScreen() {
  // 기존 크롭 화면 제거
  const existing = document.getElementById('crop-screen');
  if (existing) existing.remove();

  const field = STATE.currentForm.fields.find(f => f.key === STATE.cropTarget);
  const [rw, rh] = (field?.aspect_ratio || '4:3').split(':').map(Number);

  const screen = document.createElement('div');
  screen.className = 'crop-screen';
  screen.id = 'crop-screen';
  screen.innerHTML = `
    <div style="padding:12px 16px; color:#fff; font-size:13px; flex-shrink:0">
      ${field?.label || '사진 조정'} — 비율 ${field?.aspect_ratio || '4:3'}
    </div>
    <div class="crop-viewport" id="crop-viewport">
      <canvas id="crop-canvas"></canvas>
      <div class="crop-overlay">
        <div class="crop-guide" id="crop-guide"></div>
      </div>
    </div>
    <div class="crop-footer">
      <button class="btn btn-secondary" id="crop-cancel">다시 선택</button>
      <button class="btn btn-primary" id="crop-confirm">사진 사용</button>
    </div>`;
  document.body.appendChild(screen);

  // 캔버스에 이미지 그리기
  const canvas = document.getElementById('crop-canvas');
  const ctx = canvas.getContext('2d');
  const img = STATE.cropImage;
  const viewport = document.getElementById('crop-viewport');

  const vpW = viewport.clientWidth;
  const vpH = viewport.clientHeight;

  // 이미지를 뷰포트에 맞게 스케일링
  const scale = Math.min(vpW / img.width, vpH / img.height, 1);
  canvas.width  = img.width;
  canvas.height = img.height;
  canvas.style.width  = `${img.width  * scale}px`;
  canvas.style.height = `${img.height * scale}px`;
  ctx.drawImage(img, 0, 0);

  // 크롭 가이드 초기 위치 (중앙)
  const guideEl = document.getElementById('crop-guide');
  const displayW = img.width  * scale;
  const displayH = img.height * scale;

  // 비율에 맞는 최대 크롭 박스 계산
  let guideW, guideH;
  if (displayW / displayH > rw / rh) {
    guideH = displayH * 0.9;
    guideW = guideH * rw / rh;
  } else {
    guideW = displayW * 0.9;
    guideH = guideW * rh / rw;
  }

  const canvasRect = () => canvas.getBoundingClientRect();
  const viewportRect = () => viewport.getBoundingClientRect();

  let guideLeft = (vpW - guideW) / 2;
  let guideTop  = (vpH - guideH) / 2;

  function updateGuide() {
    guideEl.style.left   = `${guideLeft}px`;
    guideEl.style.top    = `${guideTop}px`;
    guideEl.style.width  = `${guideW}px`;
    guideEl.style.height = `${guideH}px`;
  }
  updateGuide();

  // 드래그로 가이드 이동
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

  function onStart(clientX, clientY) {
    dragging = true;
    startX = clientX; startY = clientY;
    startLeft = guideLeft; startTop = guideTop;
  }
  function onMove(clientX, clientY) {
    if (!dragging) return;
    const vr = viewportRect();
    guideLeft = Math.max(0, Math.min(vpW - guideW, startLeft + (clientX - startX)));
    guideTop  = Math.max(0, Math.min(vpH - guideH, startTop  + (clientY - startY)));
    updateGuide();
  }
  function onEnd() { dragging = false; }

  guideEl.addEventListener('mousedown', e => onStart(e.clientX, e.clientY));
  document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
  document.addEventListener('mouseup', onEnd);
  guideEl.addEventListener('touchstart', e => onStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  document.addEventListener('touchmove', e => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  document.addEventListener('touchend', onEnd);

  // 취소
  document.getElementById('crop-cancel').onclick = () => {
    screen.remove();
    // 다시 이미지 소스 선택으로
    showImageSourceSheet(STATE.cropTarget);
  };

  // 확인: 크롭 적용
  document.getElementById('crop-confirm').onclick = async () => {
    const vr = viewportRect();
    const cr = canvasRect();

    // 가이드 좌표 → 캔버스 원본 좌표 변환
    const dispScale = img.width * scale / img.width; // = scale
    const cropX = (guideLeft - (cr.left - vr.left)) / scale;
    const cropY = (guideTop  - (cr.top  - vr.top )) / scale;
    const cropW = guideW / scale;
    const cropH = guideH / scale;

    // Canvas API로 크롭 및 리사이징
    const croppedDataURL = cropAndResize(
      canvas,
      { x: Math.max(0, cropX), y: Math.max(0, cropY), width: cropW, height: cropH },
      field?.aspect_ratio || '4:3',
      'image/jpeg',
      0.85
    );

    STATE.formData[STATE.cropTarget] = croppedDataURL;
    const form = STATE.currentForm;
    await saveDraft(form.id, form.version, STATE.formData);

    screen.remove();
    navigate('form-fill');
  };
}

/* ══════════════════════════════════════════════════════════
   화면 3-2. 서명 UI
   ══════════════════════════════════════════════════════════ */
function showSignScreen(fieldKey) {
  const existing = document.getElementById('sign-screen');
  if (existing) existing.remove();

  const screen = document.createElement('div');
  screen.className = 'signature-screen';
  screen.id = 'sign-screen';

  // 서명 영역을 90도 회전: CSS transform 사용
  // 실제 화면은 세로 모드 유지, 콘텐츠만 90도 회전하여 가로 서명 공간 확보
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const canvasW = vh - 120; // 회전 후 가로 길이 = 화면 높이 - 여백
  const canvasH = vw * 0.5; // 회전 후 세로 길이 = 화면 너비의 절반

  screen.innerHTML = `
    <div class="signature-header" style="
      flex-shrink:0; padding:12px 16px;
      display:flex; align-items:center; justify-content:space-between;
      border-bottom:1px solid #E8E8E8">
      <span style="font-size:15px; font-weight:700">서명</span>
      <button class="btn-text" id="sig-close">취소</button>
    </div>
    <div class="signature-inner" style="
      width:${vw}px; height:${vh - 52}px;
      transform: rotate(90deg);
      transform-origin: ${vw/2}px ${(vh-52)/2}px;">
      <p class="signature-label">아래 영역에 서명해주세요</p>
      <canvas id="signature-canvas" width="${canvasW}" height="${canvasH}"></canvas>
      <div class="signature-actions">
        <button class="btn btn-secondary" id="sig-clear" style="flex:0 0 auto; padding:8px 20px">초기화</button>
        <button class="btn btn-primary" id="sig-confirm" style="flex:0 0 auto; padding:8px 24px">서명 확정</button>
      </div>
    </div>`;
  document.body.appendChild(screen);

  const canvas = document.getElementById('signature-canvas');
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let drawing = false;
  let lastX = 0, lastY = 0;

  function getCanvasPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    // CSS rotate(90deg) 적용 상태이므로 좌표 변환 필요
    // 회전된 캔버스의 실제 터치 좌표를 원래 캔버스 좌표로 변환
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    // 90도 회전 역변환: (x, y) → (y, w-x) where w = rect.width
    return {
      x: relY * (canvas.width  / rect.height),
      y: (rect.width - relX) * (canvas.height / rect.width)
    };
  }

  canvas.addEventListener('mousedown', e => {
    drawing = true;
    const pos = getCanvasPos(e.clientX, e.clientY);
    lastX = pos.x; lastY = pos.y;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 1, 0, Math.PI * 2);
    ctx.fill();
  });
  canvas.addEventListener('mousemove', e => {
    if (!drawing) return;
    const pos = getCanvasPos(e.clientX, e.clientY);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastX = pos.x; lastY = pos.y;
  });
  canvas.addEventListener('mouseup', () => drawing = false);

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    drawing = true;
    const pos = getCanvasPos(e.touches[0].clientX, e.touches[0].clientY);
    lastX = pos.x; lastY = pos.y;
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!drawing) return;
    const pos = getCanvasPos(e.touches[0].clientX, e.touches[0].clientY);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastX = pos.x; lastY = pos.y;
  }, { passive: false });
  canvas.addEventListener('touchend', () => drawing = false);

  document.getElementById('sig-close').onclick = () => screen.remove();

  document.getElementById('sig-clear').onclick = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  document.getElementById('sig-confirm').onclick = async () => {
    // 서명이 있는지 확인
    const pixelData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const hasContent = pixelData.some((_, i) => i % 4 === 3 && pixelData[i] > 0);
    if (!hasContent) {
      showSnackbar('서명을 먼저 입력해주세요.');
      return;
    }

    // 캔버스를 역방향 90도 회전하여 바로 선 서명 이미지 획득
    const rotated = document.createElement('canvas');
    rotated.width  = canvas.height;
    rotated.height = canvas.width;
    const rCtx = rotated.getContext('2d');
    rCtx.translate(rotated.width / 2, rotated.height / 2);
    rCtx.rotate(-Math.PI / 2); // -90도 (원래대로 복원)
    rCtx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);

    const dataURL = rotated.toDataURL('image/png'); // 투명 배경 PNG

    STATE.formData[fieldKey] = dataURL;
    const form = STATE.currentForm;
    await saveDraft(form.id, form.version, STATE.formData);

    screen.remove();
    navigate('form-fill');
  };
}

/* ══════════════════════════════════════════════════════════
   관리자 화면 (기본 구조)
   ══════════════════════════════════════════════════════════ */
function renderAdminLogin() {
  return `
    <div class="admin-login">
      <h1>관리자</h1>
      <p>양식을 등록하고 배포합니다</p>
      <div class="form-group" style="width:100%">
        <label class="form-label required">이메일</label>
        <input type="email" class="form-input" id="admin-email" placeholder="admin@example.com">
      </div>
      <div class="form-group" style="width:100%">
        <label class="form-label required">비밀번호</label>
        <input type="password" class="form-input" id="admin-pw" placeholder="비밀번호">
      </div>
      <button class="btn btn-primary" id="btn-admin-login" style="width:100%">로그인</button>
      <button class="btn-text" id="btn-admin-back" style="margin-top:8px; color:#AAAAAA">← 사용자 홈으로</button>
    </div>`;
}

function bindAdminLoginEvents() {
  document.getElementById('btn-admin-back').onclick = () => navigate('home');
  document.getElementById('btn-admin-login').onclick = () => {
    const email = document.getElementById('admin-email').value;
    const pw    = document.getElementById('admin-pw').value;

    // TODO: 실제 Supabase Auth 연동
    // const { data, error } = await supabase.auth.signInWithPassword({ email, password: pw });
    if (email === 'admin@test.com' && pw === 'test1234') {
      STATE.adminUser = { email, name: '관리자', dept: '학교지원과' };
      navigate('admin-dashboard');
    } else {
      showSnackbar('이메일 또는 비밀번호가 올바르지 않습니다.');
    }
  };
}

function renderAdminDashboard() {
  const formRows = STATE.adminForms.map(f => `
    <div class="list-item">
      <div>
        <div class="list-item-title">${f.title}</div>
        <div class="list-item-meta">v${f.version} · ${f.updated_at}</div>
      </div>
      <button class="btn btn-secondary" style="width:60px; padding:6px 8px; font-size:12px"
        data-form-id="${f.id}">수정</button>
      <button class="btn btn-danger" style="width:60px; padding:6px 8px; font-size:12px"
        data-del-id="${f.id}">삭제</button>
    </div>`).join('');

  return `
    <div class="admin-screen">
      <div class="header">
        <div class="header-title">양식 관리</div>
        <button class="btn-text" id="admin-logout">로그아웃</button>
      </div>
      <div class="content">
        <div style="display:flex; gap:8px; margin-bottom:16px">
          <button class="btn btn-primary" id="btn-new-form">양식 신규 등록</button>
          <button class="btn btn-secondary" id="btn-sample-dl">샘플 양식 다운로드</button>
        </div>
        <div class="section-divider">내가 관리하는 양식</div>
        ${formRows || '<p style="color:#AAAAAA; font-size:13px">등록된 양식이 없습니다.</p>'}
      </div>
    </div>`;
}

function bindAdminDashboardEvents() {
  document.getElementById('admin-logout').onclick = () => {
    STATE.adminUser = null;
    navigate('home');
  };

  document.getElementById('btn-new-form').onclick = () => {
    showSnackbar('양식 등록 기능은 다음 버전에서 구현 예정입니다.');
  };

  document.getElementById('btn-sample-dl').onclick = () => {
    showSnackbar('샘플 양식 다운로드는 다음 버전에서 구현 예정입니다.');
  };

  document.querySelectorAll('[data-del-id]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.delId;
      const form = STATE.adminForms.find(f => f.id === id);
      showSnackbar(`'${form.title}'이(가) 휴지통으로 이동되었습니다.`, {
        actionText: '실행취소',
        onAction: () => {} // TODO: 실제 삭제 취소 구현
      });
    };
  });
}

/* ══════════════════════════════════════════════════════════
   공통 UI 컴포넌트
   ══════════════════════════════════════════════════════════ */

/** 모달 다이얼로그 */
function showModal({ title, body, confirmText = '확인', cancelText = '취소', onConfirm = null, onCancel = null }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay center';
  overlay.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-title">${title}</div>
      <div class="modal-body">${body.replace(/\n/g, '<br>')}</div>
      <div class="modal-actions">
        ${cancelText ? `<button class="btn btn-secondary" id="modal-cancel">${cancelText}</button>` : ''}
        ${confirmText ? `<button class="btn btn-primary" id="modal-confirm">${confirmText}</button>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  if (cancelText) {
    overlay.querySelector('#modal-cancel').onclick = () => { close(); onCancel?.(); };
  }
  if (confirmText) {
    overlay.querySelector('#modal-confirm').onclick = () => { close(); onConfirm?.(); };
  }
}

/** 스낵바 알림 */
let _snackTimer = null;
function showSnackbar(msg, { actionText = null, onAction = null } = {}) {
  const existing = document.querySelector('.snackbar');
  if (existing) existing.remove();
  if (_snackTimer) clearTimeout(_snackTimer);

  const snack = document.createElement('div');
  snack.className = 'snackbar';
  snack.innerHTML = `
    <span>${msg}</span>
    ${actionText ? `<button class="btn-text" id="snack-action">${actionText}</button>` : ''}`;
  document.body.appendChild(snack);

  if (actionText) {
    snack.querySelector('#snack-action').onclick = () => { snack.remove(); onAction?.(); };
  }

  _snackTimer = setTimeout(() => snack.remove(), 3500);
}

/** HTML 이스케이프 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════════
   데이터 로딩
   ══════════════════════════════════════════════════════════ */
async function loadFormsData() {
  if (STATE.departments.length > 0) return; // 이미 로드됨

  if (USE_MOCK) {
    STATE.departments = MOCK_DEPARTMENTS;
    STATE.forms = MOCK_FORMS;
    return;
  }

  // TODO: Supabase에서 실제 데이터 로드
  // const { data: depts } = await supabase.from('departments').select('*');
  // const { data: forms } = await supabase.from('forms').select('*').eq('is_published', true);
  // STATE.departments = depts || [];
  // STATE.forms = forms || [];
}

/* ══════════════════════════════════════════════════════════
   앱 초기화
   ══════════════════════════════════════════════════════════ */
async function init() {
  try {
    await initDB();
    
    // Service Worker 등록
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(console.warn);
    }

    // 오늘 날짜를 기본값으로 설정 (날짜 필드)
    const today = new Date().toISOString().slice(0, 10);
    STATE._today = today;

    navigate('home');
  } catch (err) {
    console.error('앱 초기화 실패:', err);
    document.getElementById('app').innerHTML =
      `<div class="loading-screen"><p>앱을 시작할 수 없습니다.<br>${err.message}</p></div>`;
  }
}

init();
