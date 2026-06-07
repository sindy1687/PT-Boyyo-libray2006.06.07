function doPost(e) {
  try {
    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    const req = bodyText ? JSON.parse(bodyText) : {};
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
      
      // 可以在這裡記錄是哪個使用者更新的借閱記錄
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

    if (action === 'searchBooks') {
      const keyword = req.keyword || '';
      const result = searchBooksFromBooksTW_(keyword);
      return json_({ ok: true, result });
    }

    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

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

// ===== 博客來搜尋 =====
function searchBooksFromBooksTW_(keyword) {
  if (!keyword) return null;
  const url = 'https://search.books.com.tw/search/query/key/' + encodeURIComponent(keyword) + '/adv_sort/1/';
  const options = {
    'headers': {
      'User-Agent': 'Mozilla/5.0 (compatible; BooksCrawler/1.0)'
    }
  };
  const response = UrlFetchApp.fetch(url, options);
  const html = response.getContentText();

  // 簡單解析（正則表達式）
  const titleMatch = html.match(/<h3[^>]*><a[^>]*>([^<]+)<\/a><\/h3>/);
  const authorMatch = html.match(/<div[^>]*class="author"[^>]*>([^<]+)<\/div>/);
  const publisherMatch = html.match(/<div[^>]*class="publisher"[^>]*>([^<]+)<\/div>/);
  const dateMatch = html.match(/<div[^>]*class="date"[^>]*>([^<]+)<\/div>/);
  const coverMatch = html.match(/<img[^>]*class="cover"[^>]*src="([^"]+)"/);

  if (!titleMatch) return null;

  return {
    title: titleMatch[1].trim(),
    author: authorMatch ? authorMatch[1].replace(/作者：/, '').trim() : '',
    publisher: publisherMatch ? publisherMatch[1].replace(/出版社：/, '').trim() : '',
    publishedDate: dateMatch ? dateMatch[1].trim() : '',
    coverUrl: coverMatch ? coverMatch[1].trim() : ''
  };
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
