/* ============================================================
   js/hwpx.js — HWPX 조립 엔진
   
   역할: 관리자가 배포한 HWPX 템플릿 파일에 사용자 입력값을
         치환·삽입하여 완성된 HWPX 파일을 생성하고 다운로드.
   
   의존성: JSZip (전역 CDN 로드)
   
   처리 순서:
   1. HWPX(ZIP) 언팩
   2. 텍스트 치환 (T_, D_, N_, L_)
   3. 체크박스 처리 (C_)
   4. 이미지 삽입 (I_)
   5. 서명 삽입 (S_)
   6. 재압축 및 다운로드
   ============================================================ */

/* ── 공개 API ───────────────────────────────────────────── */

/**
 * 메인 함수: HWPX 생성 및 다운로드
 *
 * @param {Blob|ArrayBuffer} templateBlob - 서버에서 받은 HWPX 템플릿 파일
 * @param {Object}  formData  - { fieldKey: value }
 *                              이미지/서명은 dataURL string
 * @param {Array}   fields    - 양식 설정 JSON의 fields 배열
 * @param {string}  filename  - 저장될 파일명 (확장자 제외)
 * @returns {Promise<void>}
 */
export async function buildAndDownloadHwpx(templateBlob, formData, fields, filename) {
  try {
    // 1. ZIP 언팩
    const zip = await JSZip.loadAsync(templateBlob);

    // 2~5. 각 XML 파일에 치환 적용
    const imageInsertions = []; // { key, dataURL, aspectRatio } 순서 보존

    // 2. 텍스트 치환 (T_, D_, N_, L_, C_ 모두 포함)
    for (const [path, zipEntry] of Object.entries(zip.files)) {
      if (!path.endsWith('.xml') && !path.endsWith('.hpf')) continue;
      if (zipEntry.dir) continue;

      let xmlContent = await zipEntry.async('string');

      for (const field of fields) {
        const { key, type } = field;
        const placeholder = `{{${key}}}`;
        const value = formData[key];

        if (value === undefined || value === null || value === '') continue;

        switch (type) {
          case 'text':
          case 'number':
            xmlContent = replaceAll(xmlContent, placeholder, escapeXml(String(value)));
            break;

          case 'date':
            // "2026-03-16" → "2026년 03월 16일"
            xmlContent = replaceAll(xmlContent, placeholder, formatDate(value));
            break;

          case 'list':
            xmlContent = replaceAll(xmlContent, placeholder, escapeXml(String(value)));
            break;

          case 'checkbox':
            // C_ 처리: 플레이스홀더를 빈 문자열로 대체.
            // 실제 체크 기호는 인접 셀에 삽입 (아래 별도 처리).
            xmlContent = handleCheckbox(xmlContent, placeholder, value);
            break;

          case 'image':
            // 이미지는 BinData 삽입이 필요하므로 별도 처리
            // 일단 플레이스홀더를 임시 마커로 교체
            imageInsertions.push({ key, dataURL: value, type: 'image', field });
            break;

          case 'signature':
            imageInsertions.push({ key, dataURL: value, type: 'signature', field });
            break;
        }
      }

      zip.file(path, xmlContent);
    }

    // 3~5. 이미지/서명 삽입
    if (imageInsertions.length > 0) {
      await insertImages(zip, imageInsertions);
    }

    // 6. 재압축 및 다운로드
    const hwpxBlob = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/x-hwp+zip',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    downloadBlob(hwpxBlob, `${filename}.hwpx`);

  } catch (err) {
    console.error('[HWPX] 생성 오류:', err);
    throw new Error(`HWPX 생성 실패: ${err.message}`);
  }
}


/* ── 내부 헬퍼 함수들 ───────────────────────────────────── */

/**
 * 체크박스 처리
 * C_ 플레이스홀더가 있는 셀의 인접 셀에 체크 기호 삽입.
 * HWPX XML 구조에서 셀은 <hp:Tc>로 표현됨.
 * O → 바로 다음 셀(B열)에 ✔
 * X → 두 번째 다음 셀(C열)에 ✔
 * 미선택 → 공란 (플레이스홀더만 제거)
 *
 * 주의: 이 구현은 같은 행에 {{C_xxx}} O칸 X칸 순서로 셀이 있다고 가정.
 */
function handleCheckbox(xmlContent, placeholder, value) {
  // 플레이스홀더를 포함한 <hp:Tc>...</hp:Tc> 찾기
  const tcRegex = /(<hp:Tc\b[^>]*>)([\s\S]*?)(<\/hp:Tc>)/g;
  let cellIndex = 0;
  const cells = [];

  // 모든 셀을 추출
  let match;
  while ((match = tcRegex.exec(xmlContent)) !== null) {
    cells.push({
      full: match[0],
      open: match[1],
      inner: match[2],
      close: match[3],
      index: match.index
    });
  }

  // 플레이스홀더가 있는 셀 찾기
  const placeholderCellIdx = cells.findIndex(c => c.inner.includes(placeholder));
  if (placeholderCellIdx === -1) {
    // 테이블 외부에 있는 경우: 단순 텍스트로 대체
    const textVal = value === 'O' ? '○' : value === 'X' ? '×' : '';
    return replaceAll(xmlContent, placeholder, textVal);
  }

  // 플레이스홀더 제거 (셀 자체는 유지)
  const cleanedInner = cells[placeholderCellIdx].inner.replace(
    new RegExp(escapeRegex(placeholder), 'g'), ''
  );
  cells[placeholderCellIdx] = {
    ...cells[placeholderCellIdx],
    inner: cleanedInner
  };

  // 체크 기호 삽입
  const CHECK_MARK = '✔'; // U+2714
  if (value === 'O' && placeholderCellIdx + 1 < cells.length) {
    cells[placeholderCellIdx + 1].inner = insertTextIntoCell(
      cells[placeholderCellIdx + 1].inner, CHECK_MARK
    );
  } else if (value === 'X' && placeholderCellIdx + 2 < cells.length) {
    cells[placeholderCellIdx + 2].inner = insertTextIntoCell(
      cells[placeholderCellIdx + 2].inner, CHECK_MARK
    );
  }

  // 변경된 셀을 원본 XML에 반영 (역순으로 교체하여 인덱스 유지)
  let result = xmlContent;
  for (let i = cells.length - 1; i >= 0; i--) {
    const original = cells[i].full;
    const replaced = cells[i].open + cells[i].inner + cells[i].close;
    if (original !== replaced) {
      result = result.slice(0, cells[i].index) +
               replaced +
               result.slice(cells[i].index + original.length);
    }
  }

  return result;
}

/**
 * HWPX 셀 XML 내에 텍스트 삽입.
 * 기존 텍스트 런(<hp:t>) 내용을 교체하거나 새 런을 추가.
 */
function insertTextIntoCell(cellInner, text) {
  // 기존 hp:t 태그 내용을 교체
  if (/<hp:t[^>]*>/.test(cellInner)) {
    return cellInner.replace(/(<hp:t[^>]*>)[^<]*(<\/hp:t>)/, `$1${text}$2`);
  }
  // hp:t 없으면 최소 런 구조 추가
  return cellInner + `<hp:Run><hp:t>${text}</hp:t></hp:Run>`;
}

/**
 * 이미지/서명을 BinData에 삽입하고 XML 참조 추가.
 * 플레이스홀더 텍스트가 있는 위치에 HWPX 그림 XML을 삽입.
 */
async function insertImages(zip, insertions) {
  for (let i = 0; i < insertions.length; i++) {
    const { key, dataURL, type, field } = insertions[i];
    if (!dataURL || !dataURL.startsWith('data:')) continue;

    // dataURL → Uint8Array
    const [meta, base64Data] = dataURL.split(',');
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';

    const byteString = atob(base64Data);
    const bytes = new Uint8Array(byteString.length);
    for (let j = 0; j < byteString.length; j++) {
      bytes[j] = byteString.charCodeAt(j);
    }

    // BinData에 저장
    const binFileName = type === 'signature'
      ? `BinData/sign_${i}.${ext}`
      : `BinData/image_${i}.${ext}`;
    zip.file(binFileName, bytes);

    // section XML에서 플레이스홀더를 HWPX 그림 XML로 교체
    const placeholder = `{{${key}}}`;
    const { widthEmu, heightEmu } = getImageSize(field);
    const picXml = buildHwpxPictureXml(binFileName, widthEmu, heightEmu, i);

    for (const [path, zipEntry] of Object.entries(zip.files)) {
      if (!path.toLowerCase().includes('section') || !path.endsWith('.xml')) continue;
      if (zipEntry.dir) continue;

      let xmlContent = await zipEntry.async('string');
      if (!xmlContent.includes(placeholder)) continue;

      // 플레이스홀더를 포함한 단락을 그림 단락으로 교체
      xmlContent = replaceParagraphWithImage(xmlContent, placeholder, picXml);
      zip.file(path, xmlContent);
    }
  }
}

/**
 * HWPX 그림 XML 생성 (단순화된 버전)
 * 실제 HWPX의 그림 삽입 XML 구조를 생성.
 * 이 XML은 실제 HWP 개발자 문서 기반으로 작성됨.
 */
function buildHwpxPictureXml(binPath, widthEmu, heightEmu, idx) {
  const picId = 100 + idx;
  return `<hp:Para>
  <hp:Run>
    <hp:Picture id="${picId}" Desc="" Size="Crop" HorzAlign="Center" VertAlign="Top"
      TreatAsChar="1" WindingType="0">
      <hp:sz width="${widthEmu}" height="${heightEmu}"/>
      <hp:PictureInfo BrightType="0" Bright="0" Contrast="0" Effect="RealPic"/>
      <hp:PictureContents>
        <hp:Img href="${binPath}"/>
      </hp:PictureContents>
    </hp:Picture>
  </hp:Run>
</hp:Para>`;
}

/**
 * 플레이스홀더가 포함된 단락 전체를 그림 단락으로 교체
 */
function replaceParagraphWithImage(xmlContent, placeholder, picXml) {
  // <hp:Para>...</hp:Para> 내에 플레이스홀더가 있는 경우 해당 Para 교체
  const paraRegex = /<hp:Para\b[^>]*>[\s\S]*?<\/hp:Para>/g;
  return xmlContent.replace(paraRegex, (match) => {
    if (match.includes(placeholder)) {
      return picXml;
    }
    return match;
  });
}

/**
 * 비율 설정에 따라 이미지 크기를 EMU로 변환
 * EMU (English Metric Unit): 1cm = 360000 EMU
 */
function getImageSize(field) {
  // 기본: 가로 12cm
  const baseWidth = 12 * 360000;
  const ratio = field.aspect_ratio || '4:3';
  const [w, h] = ratio.split(':').map(Number);
  return {
    widthEmu:  baseWidth,
    heightEmu: Math.round(baseWidth * h / w)
  };
}


/* ── 유틸리티 ───────────────────────────────────────────── */

/** XML 특수문자 이스케이프 */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 정규식 특수문자 이스케이프 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 문자열 전체 치환 */
function replaceAll(str, search, replacement) {
  return str.split(search).join(replacement);
}

/** 날짜 포맷: "2026-03-16" → "2026년 03월 16일" */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${y}년 ${m}월 ${d}일`;
}

/** Blob 다운로드 트리거 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Web Share API로 파일 공유 (모바일 OS 공유 시트)
 * 미지원 시 downloadBlob()으로 폴백
 */
export async function shareOrDownload(blob, filename) {
  if (navigator.canShare && navigator.canShare({ files: [new File([blob], filename)] })) {
    try {
      await navigator.share({
        files: [new File([blob], filename, { type: 'application/x-hwp+zip' })],
        title: '점검 보고서'
      });
      return true;
    } catch (err) {
      if (err.name !== 'AbortError') {
        // 공유 실패 시 다운로드로 폴백
        downloadBlob(blob, filename);
      }
      return false;
    }
  }
  // Web Share API 미지원 환경: 직접 다운로드
  downloadBlob(blob, filename);
  return false;
}


/* ── 이미지 처리 (Canvas API) ───────────────────────────── */

/**
 * 이미지 크롭 및 리사이징
 * @param {HTMLCanvasElement} sourceCanvas - 크롭 UI 캔버스
 * @param {Object} cropBox - { x, y, width, height } 크롭 영역 (캔버스 좌표)
 * @param {string} aspectRatio - "4:3" | "16:9" | "1:1"
 * @param {string} outputFormat - 'image/jpeg' | 'image/png'
 * @param {number} quality - JPEG 품질 0~1
 * @returns {Promise<string>} dataURL
 */
export function cropAndResize(sourceCanvas, cropBox, aspectRatio, outputFormat = 'image/jpeg', quality = 0.85) {
  const [rw, rh] = aspectRatio.split(':').map(Number);

  // 긴 축 1000px 이내로 리사이징
  const MAX_LONG = 1000;
  let outW = cropBox.width;
  let outH = cropBox.height;
  if (outW > outH) {
    if (outW > MAX_LONG) { outH = Math.round(outH * MAX_LONG / outW); outW = MAX_LONG; }
  } else {
    if (outH > MAX_LONG) { outW = Math.round(outW * MAX_LONG / outH); outH = MAX_LONG; }
  }

  const canvas = document.createElement('canvas');
  canvas.width  = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  if (outputFormat === 'image/png') {
    ctx.clearRect(0, 0, outW, outH); // 투명 배경
  } else {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, outW, outH);
  }

  ctx.drawImage(
    sourceCanvas,
    cropBox.x, cropBox.y, cropBox.width, cropBox.height,
    0, 0, outW, outH
  );

  return canvas.toDataURL(outputFormat, quality);
}
