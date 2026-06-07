// ============================================================
// doGet：支援 GET + ?payload=JSON 方式（手機 CORS 友善）
// 手機瀏覽器發出 GET 請求時不會觸發 CORS preflight，
// 因此可以繞過跨域限制，直接取得資料。
// 部署時請選擇：
//   執行身分 = 我（部署者）
//   存取對象 = 任何人（含未登入使用者）
// ============================================================
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const payloadStr = params.payload || '';
    const req = payloadStr ? JSON.parse(payloadStr) : {};
    return handleRequest_(req);
  } catch (err) {
    return json_({ ok: false, error: 'doGet error: ' + String(err && err.message ? err.message : err) });
  }
}

// ============================================================
// doPost：支援 POST + body JSON 方式（桌機 fallback 用）
// ============================================================
function doPost(e) {
  try {
    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    const req = bodyText ? JSON.parse(bodyText) : {};
    return handleRequest_(req);
  } catch (err) {
    return json_({ ok: false, error: 'doPost error: ' + String(err && err.message ? err.message : err) });
  }
}

// ============================================================
// 統一請求處理（doGet / doPost 共用）
// ============================================================
function handleRequest_(req) {
  try {
    const action = req.action;

    if (action === 'push') {
      const payload = req.payload || {};
      const books = Array.isArray(payload.books) ? payload.books : [];
      const borrowedBooks = Array.isArray(payload.borrowedBooks) ? payload.borrowedBooks : [];
      const boyouBooks = payload.boyouBooks && typeof payload.boyouBooks === 'object' ? payload.boyouBooks : {};

      writeBooks_(books);
      writeBorrowed_(borrowedBooks);
      writeBoyouBooks_(boyouBooks);

      return json_({ ok: true });
    }

    if (action === 'pushBorrowedBooks') {
      const payload = req.payload || {};
      const borrowedBooks = Array.isArray(payload.borrowedBooks) ? payload.borrowedBooks : [];
      const userId = payload.userId || 'anonymous';

      // 只更新借閱記錄，不更新書籍資料
      writeBorrowed_(borrowedBooks);

      // 記錄是哪個使用者更新的借閱記錄
      console.log('Borrowed books updated by user: ' + userId);

      return json_({ ok: true });
    }

    if (action === 'pull') {
      const data = {
        books: readBooks_(),
        borrowedBooks: readBorrowed_(),
        boyouBooks: readBoyouBooks_(),
      };
      return json_({ ok: true, data });
    }

    if (action === 'getVersion') {
      // 回傳版本資訊（以目前書籍資料列數為版本依據）
      const sh = getSheet_('Books');
      const lastRow = sh.getLastRow();
      const version = lastRow > 1
        ? String(lastRow) + '_' + new Date().toISOString().split('T')[0]
        : null;
      return json_({ ok: true, data: { version } });
    }

    return json_({ ok: false, error: 'Unknown action: ' + String(action) });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ============================================================
// 工具函數
// ============================================================

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

// ===== Books =====
function writeBooks_(books) {
  const sh = getSheet_('Books');
  sh.clearContents();

  const header = ['id', 'title', 'author', 'coverUrl', 'coverImage', 'genre', 'year', 'copies', 'availableCopies', 'series', 'createdAt', 'bookIds'];
  const rows = books.map(b => {
    const bookIds = Array.isArray(b.bookIds) ? b.bookIds.join(',') : '';
    const coverUrl = b.coverUrl || '';
    const coverImage = coverUrl ? '=IMAGE("' + coverUrl + '")' : '';
    const series = b.series || '';
    const createdAt = b.createdAt || b.addedAt || '';
    return [
      b.id || '',
      b.title || '',
      b.author || '',
      coverUrl,
      coverImage,
      b.genre || '',
      Number(b.year || 0),
      Number(b.copies || 0),
      Number(b.availableCopies || 0),
      series,
      createdAt,
      bookIds
    ];
  });

  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
}

function readBooks_() {
  const sh = getSheet_('Books');
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();

  // 如果只有標題行或沒有資料，返回空陣列
  if (lastRow <= 1) return [];

  // 明確指定讀取範圍，確保讀取所有資料
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();

  const header = values[0];
  const idx = indexMap_(header);

  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const id = row[idx.id] || '';
    const title = row[idx.title] || '';
    if (!id && !title) continue;

    const bookIdsCell = row[idx.bookIds] || '';
    const bookIds = String(bookIdsCell).trim()
      ? String(bookIdsCell).split(',').map(s => s.trim()).filter(Boolean)
      : undefined;

    const obj = {
      id: String(id),
      title: String(title),
      author: String(row[idx.author] || ''),
      coverUrl: String(row[idx.coverUrl] || ''),
      genre: String(row[idx.genre] || ''),
      year: Number(row[idx.year] || 0),
      copies: Number(row[idx.copies] || 0),
      availableCopies: Number(row[idx.availableCopies] || 0),
      series: String(row[idx.series] || ''),
      createdAt: String(row[idx.createdAt] || '')
    };
    if (bookIds) obj.bookIds = bookIds;

    out.push(obj);
  }
  return out;
}

// ===== Borrowed =====
function writeBorrowed_(borrowedBooks) {
  const sh = getSheet_('Borrowed');
  sh.clearContents();

  const header = ['id', 'bookId', 'bookTitle', 'userId', 'borrowDate', 'dueDate', 'returnedAt'];
  const rows = borrowedBooks.map(r => {
    return [
      r.id || '',
      r.bookId || '',
      r.bookTitle || '',
      r.userId || '',
      r.borrowDate || '',
      r.dueDate || '',
      r.returnedAt || ''
    ];
  });

  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
}

function readBorrowed_() {
  const sh = getSheet_('Borrowed');
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];

  const header = values[0];
  const idx = indexMap_(header);

  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const id = row[idx.id] || '';
    if (!id) continue;

    const returnedAtVal = row[idx.returnedAt];
    const returnedAt = String(returnedAtVal || '').trim() ? String(returnedAtVal) : null;

    out.push({
      id: String(id),
      bookId: String(row[idx.bookId] || ''),
      bookTitle: String(row[idx.bookTitle] || ''),
      userId: String(row[idx.userId] || ''),
      borrowDate: String(row[idx.borrowDate] || ''),
      dueDate: String(row[idx.dueDate] || ''),
      returnedAt: returnedAt
    });
  }
  return out;
}

// ===== BoyouBooks (整包 JSON，最完整) =====
function writeBoyouBooks_(boyouBooks) {
  const sh = getSheet_('BoyouBooks');
  sh.clearContents();

  sh.getRange(1, 1, 1, 2).setValues([['key', 'json']]);
  sh.getRange(2, 1, 1, 2).setValues([['boyouBooks', JSON.stringify(boyouBooks)]]);
}

function readBoyouBooks_() {
  const sh = getSheet_('BoyouBooks');
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return {};

  const jsonText = values[1][1];
  if (!jsonText) return {};

  try {
    return JSON.parse(String(jsonText));
  } catch (e) {
    return {};
  }
}

function indexMap_(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    map[String(h || '').trim()] = i;
  });

  return {
    id: map.id ?? 0,
    title: map.title ?? 1,
    author: map.author ?? 2,
    coverUrl: map.coverUrl ?? 3,
    coverImage: map.coverImage ?? 4,
    genre: map.genre ?? 5,
    year: map.year ?? 6,
    copies: map.copies ?? 7,
    availableCopies: map.availableCopies ?? 8,
    series: map.series ?? 9,
    createdAt: map.createdAt ?? 10,
    bookIds: map.bookIds ?? 11,

    bookId: map.bookId ?? 1,
    bookTitle: map.bookTitle ?? 2,
    userId: map.userId ?? 3,
    borrowDate: map.borrowDate ?? 4,
    dueDate: map.dueDate ?? 5,
    returnedAt: map.returnedAt ?? 6,
  };
}
