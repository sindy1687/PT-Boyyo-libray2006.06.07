// 圖書館管理系統核心功能
class LibrarySystem {
    constructor() {
        this.books = [];
        this.borrowedBooks = [];
        this.users = [];
        this.currentUser = null;
        this.adminUsername = 'sindy16872000';
        this.bookIdPattern = /^[ABC]\d+$/;
        this.defaultGoogleWebAppUrl = 'https://script.google.com/macros/s/AKfycbxYZodHltoNvStyYHg3iHwflZ2W6g3vPNKftIOo3e8A22-jNL_-j_GmBbxzZwLt9Ot_/exec';
        this.autoSyncTimer = null;
        this.autoSyncLastRunAt = 0;
        this.autoSyncCooldownUntil = 0;
        this.autoSyncMinIntervalMs = 30000;
        this.autoSyncDebounceMs = 1500;
        this.pushNowInFlight = false;
        this.currentBookType = 'series'; // 預設顯示系列書
        
        // API 節流與重試機制
        this.lastApiRequestTime = 0;
        this.apiRequestDelay = 3000; // 增加到 3 秒間隔，避免 429 錯誤
        this.apiRetryConfig = {
            maxRetries: 3, // 減少重試次數，避免過度重試
            baseDelay: 5000, // 增加基礎延遲到 5 秒
            maxDelay: 30000 // 增加最大延遲到 30 秒
        };
        this.apiRequestQueue = [];
        this.apiRequestInProgress = false;
        
        // 搜尋狀態控制
        this.searchState = {
            isRunning: false,
            isPaused: false,
            shouldStop: false,
            currentIndex: 0,
            totalBooks: 0,
            successCount: 0,
            failCount: 0,
            searchQueue: []
        };
        
        this.settings = {
            loanDays: 14,
            guestBorrow: false,
            defaultCopies: 1,
            defaultYear: 2024,
            autoUpdateInterval: 300000,
            googleWebAppUrl: '',
            userLoanSettings: [],
            subAdmins: [
                { username: 'boyo1314', createdAt: new Date().toISOString() }
            ] // 副管理者列表
            ,
            seriesList: [] // 可在設定中維護的系列名稱清單（預設空）
        };
        this.updateTimer = null;
        this.lastUpdateTime = null;
        
        // 快取系統狀態
        this.cacheVersion = null;
        this.lastCacheDownloadDate = null;
        
        this.init();
    }

    // ==================== 快取系統函數 ====================
    
    /**
     * 初始化快取系統 - 從 localStorage 讀取快取狀態
     */
    initCacheSystem() {
        this.cacheVersion = localStorage.getItem('lib_cache_version') || null;
        this.lastCacheDownloadDate = localStorage.getItem('lib_cache_download_date') || null;
    }

    /**
     * 取得書單快取鍵名
     */
    getBookListCacheKey() {
        return 'lib_books_cache_v1';
    }

    /**
     * 取得書單版本鍵名
     */
    getBookListVersionKey() {
        return 'lib_books_version';
    }

    /**
     * 取得上次下載日期鍵名
     */
    getLastDownloadDateKey() {
        return 'lib_cache_download_date';
    }

    /**
     * 檢查是否應該從雲端更新書單
     * 邏輯：
     * 1. 如果今天還沒下載過，需要下載
     * 2. 如果版本信息不同，需要下載
     * 3. 否則使用快取
     */
    async checkShouldUpdateBookList() {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD 格式
        const lastDownloadDate = localStorage.getItem(this.getLastDownloadDateKey());
        
        // 今天第一次進入網站，需要下載
        if (lastDownloadDate !== today) {
            console.log(`[快取] 今天第一次進入，需要下載。上次下載日期: ${lastDownloadDate}, 今天: ${today}`);
            return true;
        }
        
        // 今天已下載過，檢查版本是否有更新
        const localVersion = localStorage.getItem('lib_cache_version');
        
        // 嘗試從雲端取得版本信息
        try {
            const url = this.getGoogleWebAppUrl();
            if (!url) {
                console.log('[快取] 未設定 Google Sheets URL，使用本地快取');
                return false;
            }

            // 嘗試獲取版本信息（需要 Google Sheets 應用程式支持 getVersion 操作）
            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify({ action: 'getVersion' })
            });

            const result = await response.json().catch(() => null);
            
            // 如果響應中有版本信息，比較版本
            if (result && result.data && result.data.version) {
                const remoteVersion = result.data.version;
                
                if (remoteVersion && remoteVersion !== localVersion) {
                    console.log(`[快取] 版本有更新。本地: ${localVersion}, 雲端: ${remoteVersion}`);
                    return true;
                }
                
                console.log(`[快取] 版本未變更，使用本地快取。版本: ${localVersion}`);
                return false;
            } else {
                // 如果無法獲取版本信息，但已有本地快取和版本記錄，則使用快取
                if (localVersion) {
                    console.log('[快取] 無法獲取遠端版本，但已有本地快取，繼續使用');
                    return false;
                }
                
                // 如果沒有本地版本記錄，需要下載
                console.log('[快取] 沒有本地版本記錄，需要下載');
                return true;
            }
        } catch (error) {
            console.log('[快取] 版本檢查失敗，使用本地快取:', error.message);
            
            // 如果檢查失敗但有本地快取，使用快取
            if (localVersion) {
                console.log('[快取] 使用本地快取版本:', localVersion);
                return false;
            }
            
            // 如果沒有本地快取，需要嘗試下載
            return false;
        }
    }

    /**
     * 保存書單到快取
     */
    saveBookListCache(books, borrowedBooks) {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD 格式
        localStorage.setItem(this.getBookListCacheKey(), JSON.stringify(books));
        localStorage.setItem(this.getLastDownloadDateKey(), today);
        console.log(`[快取] 已保存書單快取，日期: ${today}, 書籍數: ${books.length}`);
    }

    /**
     * 從快取加載書單
     */
    loadBookListCache() {
        try {
            const cachedBooks = localStorage.getItem(this.getBookListCacheKey());
            if (!cachedBooks) {
                console.log('[快取] 未找到快取的書單');
                return null;
            }
            
            const books = JSON.parse(cachedBooks);
            const downloadDate = localStorage.getItem(this.getLastDownloadDateKey());
            console.log(`[快取] 成功加載快取書單，書籍數: ${books.length}, 快取日期: ${downloadDate}`);
            return books;
        } catch (error) {
            console.error('[快取] 加載快取失敗:', error);
            return null;
        }
    }

    /**
     * 更新書單版本時間戳 - 管理員新增/修改/刪除書籍後調用
     * @param {string} timestamp - 版本時間戳（ISO 格式），若不提供則使用當前時間
     */
    updateBookListVersion(timestamp = null) {
        const version = timestamp || new Date().toISOString();
        localStorage.setItem('lib_cache_version', version);
        this.cacheVersion = version;
        console.log(`[快取] 已更新書單版本: ${version}`);
    }

    /**
     * 清除書單快取 - 強制重新下載
     */
    clearBookListCache() {
        localStorage.removeItem(this.getBookListCacheKey());
        localStorage.removeItem(this.getLastDownloadDateKey());
        localStorage.removeItem('lib_cache_version');
        this.cacheVersion = null;
        this.lastCacheDownloadDate = null;
        console.log('[快取] 已清除書單快取');
    }

    /**
     * 取得快取狀態信息
     */
    getCacheStatus() {
        const downloadDate = localStorage.getItem(this.getLastDownloadDateKey());
        const version = localStorage.getItem('lib_cache_version');
        const today = new Date().toISOString().split('T')[0];
        const isCacheValid = downloadDate === today;
        
        return {
            downloadDate,
            version,
            isCacheValid,
            today
        };
    }

    escapeHtml(value) {
        const str = String(value ?? '');
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    getLoanDaysForUser(username) {
        const userId = String(username || '').trim();
        if (!userId) return this.settings.loanDays;

        const list = Array.isArray(this.settings?.userLoanSettings)
            ? this.settings.userLoanSettings
            : [];

        const rule = list.find(r => String(r?.username || '').trim() === userId);
        const days = parseInt(rule?.days, 10);
        if (Number.isFinite(days) && days >= 1 && days <= 365) return days;
        return this.settings.loanDays;
    }

    normalizeUserLoanSettings() {
        if (!Array.isArray(this.settings.userLoanSettings)) {
            this.settings.userLoanSettings = [];
        }

        const normalized = [];
        const seen = new Set();
        this.settings.userLoanSettings.forEach(item => {
            if (!item || typeof item !== 'object') return;
            const username = String(item.username || '').trim();
            if (!username) return;
            if (seen.has(username)) return;
            const days = parseInt(item.days, 10);
            if (!Number.isFinite(days) || days < 1 || days > 365) return;
            seen.add(username);
            normalized.push({
                username,
                days,
                reason: String(item.reason || '').trim(),
                updatedAt: item.updatedAt || new Date().toISOString()
            });
        });

        normalized.sort((a, b) => a.username.localeCompare(b.username, 'zh-Hant'));
        this.settings.userLoanSettings = normalized;
    }

    // 從書名判斷系列名稱
    // 自動推斷套書名稱（從書名中提取共同開頭）
    autoInferSeriesName(book) {
        const title = book.title || book.name || book['書名'] || '';

        if (!title) return null;

        // 嘗試提取共同開頭（例如「小天使1 我們一起做成有之類」→「小天使」）
        // 先匹配「名稱+數字」的格式
        const match = title.match(/^([^\d\s]+)\s*\d+/);
        if (match && match[1] && match[1].length >= 3) {
            return match[1];
        }

        // 如果沒有匹配到，嘗試移除數字和標記
        let seriesName = title
            .replace(/[0-9０-９]+/g, '') // 移除所有數字
            .replace(/[第][一二三四五六七八九十百千0-9０-９]*[集冊卷本部季屆]/g, '') // 移除「第X集/冊/卷/本/部/季/屆」或「第卷」
            .replace(/[集冊卷本部季屆]/g, '') // 移除單獨的「集/冊/卷/本/部/季/屆」
            .replace(/[上下中左右]/g, '') // 移除「上下中左右」
            .replace(/[（(].*?[）)]/g, '') // 移除括號內的內容
            .replace(/【.*?】/g, '') // 移除【】內的內容
            .replace(/[IVX]+/g, '') // 移除羅馬數字
            .replace(/首部曲|二部曲|三部曲|四部曲|終部曲/g, '') // 移除部曲
            .replace(/[：:－\-].*$/g, '') // 移除冒號後的內容
            .replace(/\s+/g, '') // 移除所有空格
            .trim();

        // 如果移除後的結果太短或為空，返回 null
        if (!seriesName || seriesName.length < 3) {
            return null;
        }

        return seriesName;
    }

    getSeriesName(book) {
        const title = book.title || book.name || book['書名'] || '';

        // 常見套書名稱改由設定 `this.settings.seriesList` 提供（預設空）
        const commonSeriesNames = Array.isArray(this.settings.seriesList) ? this.settings.seriesList : [];
        for (const seriesName of commonSeriesNames) {
            if (seriesName && title.includes(seriesName)) {
                return seriesName;
            }
        }

        // 如果沒有匹配到常見套書名稱，使用原本的規則
        return title
            .replace(/[0-9０-９]+/g, '') // 移除所有數字
            .replace(/[第][一二三四五六七八九十百千0-9０-９]+[集冊卷本部季屆]/g, '') // 移除「第X集/冊/卷/本/部/季/屆」
            .replace(/[上下中左右]/g, '') // 移除「上下中左右」
            .replace(/[（(].*?[）)]/g, '') // 移除括號內的內容
            .replace(/【.*?】/g, '') // 移除【】內的內容
            .replace(/[IVX]+/g, '') // 移除羅馬數字
            .replace(/首部曲|二部曲|三部曲|四部曲|終部曲/g, '') // 移除部曲
            .replace(/[：:－\-].*$/g, '') // 移除冒號後的內容
            .replace(/\s+/g, '') // 移除所有空格
            .trim() || '其他書籍';
    }

    normalizeSeriesName(name) {
        return String(name || '')
            .trim()
            .replace(/[\u3000\s]+/g, ' ')
            .replace(/[：:]/g, ' ')
            .replace(/[-–—_]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    getDisplaySeriesName(book) {
        const manualSeries = book.series && String(book.series).trim();
        if (manualSeries) {
            return this.normalizeSeriesName(manualSeries);
        }

        const inferred = this.autoInferSeriesName(book) || this.getSeriesName(book);
        return this.normalizeSeriesName(inferred) || '單本書';
    }

    // 偵測相似套書格式
    findSimilarSeriesBook(title) {
        const currentSeriesName = this.getSeriesName({ title });

        // 在現有書籍中尋找相同套書名稱的書
        for (const book of this.books) {
            const bookSeriesName = this.getSeriesName(book);
            if (bookSeriesName === currentSeriesName && bookSeriesName !== '其他書籍') {
                return {
                    similarBook: book,
                    seriesName: bookSeriesName
                };
            }
        }

        return null;
    }

    // 將書籍按系列分組
    groupBooksBySeries(books) {
        const groups = {};

        books.forEach(book => {
            const seriesName = this.getDisplaySeriesName(book);
            if (!groups[seriesName]) {
                groups[seriesName] = [];
            }
            groups[seriesName].push(book);
        });

        const finalGroups = {};
        Object.keys(groups).forEach(seriesName => {
            const booksInGroup = groups[seriesName];
            const isSingleBookGroup = booksInGroup.length < 2;

            if (seriesName === '單本書' || isSingleBookGroup) {
                if (!finalGroups['單本書']) {
                    finalGroups['單本書'] = [];
                }
                finalGroups['單本書'].push(...booksInGroup);
            } else {
                finalGroups[seriesName] = booksInGroup;
            }
        });

        return finalGroups;
    }

    // 直接輸入書碼借閱
    borrowByBookCode() {
        const input = document.getElementById('borrow-by-code-input');
        const raw = (input?.value || '').trim();
        const code = raw.toUpperCase();

        if (!this.currentUser) {
            this.showToast('請先登入', 'error');
            return;
        }

        if (!code) {
            this.showToast('請輸入書碼', 'error');
            return;
        }

        if (!this.bookIdPattern.test(code)) {
            this.showToast('書碼格式錯誤：請用 A/B/C + 數字（例：C0001）', 'error');
            return;
        }

        const book = this.books.find(b => String(b.id || '').toUpperCase() === code);
        if (!book) {
            this.showToast(`找不到書碼：${code}`, 'error');
            return;
        }

        // 交給既有借閱流程處理（多書碼/多冊/庫存檢查等）
        this.borrowBook(book.id);

        if (input) input.value = '';
    }

    // 初始化系統
    init() {
        this.loadData();
        this.initCacheSystem(); // 初始化快取系統
        this.setupEventListeners();
        this.syncBorrowedPanelForViewport();
        this.syncAppHeaderHeight();
        
        // 優先從 Google Sheets 載入最新資料
        this.autoLoadFromGoogleSheets();
        
        // 自動從 Google Sheets 載入線上資料（若已設定同步網址）
        this.startAutoPull();
        this.renderBooks();
        this.renderBorrowedBooks();
        this.updateStats();
        this.updateUserDisplay();
        this.updateAdminControls();
        this.startAutoUpdate();
        // 每次進入網頁時觸發同步（管理者同步全部；一般使用者同步借閱記錄）
        try {
            this.triggerSyncForAction('enter');
        } catch (e) {
            console.error('enter sync failed:', e);
        }
    }

    isAdminUser() {
        return !!(this.currentUser && this.currentUser.username === this.adminUsername);
    }

    isSubAdminUser() {
        return !!(this.currentUser && this.currentUser.role === 'subadmin');
    }

    hasAdminAccess() {
        return this.isAdminUser() || this.isSubAdminUser();
    }

    requireAdmin(actionName) {
        if (this.hasAdminAccess()) return true;
        this.showToast(`${actionName}：僅限管理者帳號`, 'error');
        return false;
    }

    requireSuperAdmin(actionName) {
        if (this.isAdminUser()) return true;
        this.showToast(`${actionName}：僅限主要管理者帳號 ${this.adminUsername}`, 'error');
        return false;
    }

    generateNextBookId(prefix) {
        const p = String(prefix || '').toUpperCase().trim();
        if (!/^[ABC]$/.test(p)) return null;

        let maxNum = 0;
        let maxWidth = 4;

        (this.books || []).forEach(b => {
            const ids = [];
            if (b && b.id) ids.push(String(b.id));
            if (b && Array.isArray(b.bookIds)) ids.push(...b.bookIds.map(String));

            ids.forEach(rawId => {
                const id = String(rawId || '').toUpperCase().trim();
                const m = id.match(/^([ABC])(\d+)$/);
                if (!m) return;
                if (m[1] !== p) return;
                const numStr = m[2];
                const num = parseInt(numStr, 10);
                if (Number.isFinite(num)) {
                    if (num > maxNum) maxNum = num;
                    if (numStr.length > maxWidth) maxWidth = numStr.length;
                }
            });
        });

        const nextNum = maxNum + 1;
        const padded = String(nextNum).padStart(maxWidth, '0');
        return `${p}${padded}`;
    }

    async duplicateBookAsNewCopy(bookId) {
        if (!this.requireAdmin('新增複本')) return;

        const clickedId = String(bookId || '').trim();
        if (!clickedId) return;

        // 可能是合併卡片（用主書碼點進來），先找出同書名的所有候選
        const found = this.books.find(b => b.id === clickedId);
        let candidates = [];
        if (found) {
            const normalizedTitle = this.normalizeTitle(found.title);
            candidates = this.books.filter(b => this.normalizeTitle(b.title) === normalizedTitle);
        } else {
            // 若主書碼找不到（理論上不太會），嘗試從合併資訊回推
            const mergedBooks = this.mergeBooksByTitle(this.books);
            const merged = mergedBooks.find(mb => Array.isArray(mb.bookIds) && mb.bookIds.includes(clickedId));
            candidates = merged?.mergedBooks || [];
        }

        let baseBook = found;
        if (Array.isArray(candidates) && candidates.length > 1) {
            const chosen = await this.showSelectionModal({
                title: '選擇要複製的書碼',
                message: '此書名有多個書碼，請選擇要作為樣板的書碼（會複製作者/年份/封面等資料）',
                options: candidates.map(b => ({
                    value: b.id,
                    title: `書碼：${b.id}`,
                    subtitle: `${b.author ? `作者：${b.author}｜` : ''}${b.year ? `${b.year}年` : ''}`,
                    imageUrl: b.coverUrl || ''
                }))
            });
            if (!chosen) return;
            baseBook = this.books.find(b => b.id === chosen) || candidates.find(b => b.id === chosen) || found;
        }

        if (!baseBook) {
            this.showToast('找不到要複製的書籍', 'error');
            return;
        }

        const prefixMatch = String(baseBook.id || '').toUpperCase().match(/^([ABC])(\d+)$/);
        const prefix = prefixMatch ? prefixMatch[1] : null;
        const newId = this.generateNextBookId(prefix);
        if (!newId) {
            this.showToast('無法產生新書碼', 'error');
            return;
        }

        if (this.books.find(b => String(b.id || '').toUpperCase() === newId)) {
            this.showToast(`書碼已存在：${newId}`, 'error');
            return;
        }

        const now = Date.now();
        const newBook = {
            id: newId,
            bookIds: [newId],
            title: baseBook.title,
            author: baseBook.author || '',
            coverUrl: baseBook.coverUrl || '',
            genre: baseBook.genre || this.getGenreFromId(newId),
            year: Number(baseBook.year) || this.settings.defaultYear,
            copies: 1,
            availableCopies: 1,
            isNew: true,
            addedAt: now,
            createdAt: new Date().toISOString()
        };

        this.books.push(newBook);
        this.saveData();
        this.triggerSyncForAction('addBook');
        this.renderBooks();
        this.updateStats();
        this.showToast(`已新增複本：${newId}`, 'success');
    }

    updateAdminControls() {
        const isAdmin = this.isAdminUser();
        const hasAdminAccess = this.hasAdminAccess();
        const ids = [
            'google-sync-btn',
            'google-load-btn',
            'google-push-btn',
            'google-pull-btn',
            'settings-btn',
            'import-btn',
            'add-book-btn',
            'fetch-all-covers-btn',
            'reload-csv-btn',
            'toggle-auto-update-btn',
            'reset-btn'
        ];

        ids.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            // reset-btn 只有主要管理者可以看
            if (id === 'reset-btn') {
                el.style.display = isAdmin ? '' : 'none';
                el.disabled = !isAdmin;
            } else {
                // 其他按鈕主要管理者和副管理者都可以看
                el.style.display = hasAdminAccess ? '' : 'none';
                el.disabled = !hasAdminAccess;
            }
            el.title = '';
            el.style.opacity = '';
            el.style.cursor = '';
        });

        const fileInput = document.getElementById('file-input');
        if (fileInput) {
            fileInput.style.display = hasAdminAccess ? '' : 'none';
            fileInput.disabled = !hasAdminAccess;
        }

        const adminFab = document.getElementById('admin-fab');
        if (adminFab) {
            adminFab.style.display = hasAdminAccess ? '' : 'none';
            adminFab.disabled = !hasAdminAccess;
        }

        // 隱藏副管理者管理標籤（只有主要管理者可以看到）
        const subAdminTab = document.querySelector('.tab-btn[onclick*="sub-admin"]');
        if (subAdminTab) {
            subAdminTab.style.display = isAdmin ? '' : 'none';
        }

        this.renderAdminActionsSheet();
    }

    async pushToGoogleSheetsNow() {
        // 管理員可以執行完整上傳，一般使用者只能上傳借閱記錄
        const url = this.getGoogleWebAppUrl();
        if (!url) return;
        if (this.pushNowInFlight) return;

        this.pushNowInFlight = true;
        try {
            if (this.isAdminUser()) {
                // 管理員：上傳完整資料（書籍 + 借閱記錄）
                await this.pushToGoogleSheets({ silent: true });
            } else {
                // 一般使用者：只上傳借閱記錄
                await this.pushBorrowedBooksToGoogleSheets({ silent: true });
            }
        } catch (e) {
            console.error('pushToGoogleSheetsNow error:', e);
        } finally {
            this.pushNowInFlight = false;
        }
    }

    getGoogleWebAppUrl() {
        const url = (this.settings?.googleWebAppUrl || '').trim();
        return url || null;
    }

    startAutoPull() {
        const url = this.getGoogleWebAppUrl();
        if (!url) return;

        // 避免阻塞初始化，延後到下一輪事件迴圈
        setTimeout(() => {
            this.pullFromGoogleSheets({ silent: true, protectEmpty: true, closeModal: false });
        }, 0);
    }

    startAutoSync() {
        // 不用登入也能自動上傳，但必須先由管理者設定好 Web App URL
        // 這裡只做啟動，不做提示，避免干擾使用者
        this.scheduleAutoSync();
    }

    scheduleAutoSync() {
        if (this.autoSyncTimer) {
            clearTimeout(this.autoSyncTimer);
        }

        this.autoSyncTimer = setTimeout(() => {
            this.autoSyncTimer = null;
            this.autoPushToGoogleSheets();
        }, this.autoSyncDebounceMs);
    }

    // 根據動作類型決定是否要觸發同步（僅在會變更館藏資料的動作才同步）
    triggerSyncForAction(action) {
        const allowedActions = [
            'addBook',
            'editBook',
            'deleteBook',
            'importBooks',
            'bulkImport',
            'saveSettings',
            'enter',
            'borrow',
            'return'
        ];

        try {
            if (!allowedActions.includes(action)) {
                // 非同步範圍的動作，跳過自動上傳
                return;
            }

            // 若允許，排程並立刻嘗試上傳（靜默模式）
            this.scheduleAutoSync();
            this.pushToGoogleSheetsNow();
        } catch (e) {
            console.error('triggerSyncForAction error:', e);
        }
    }

    async autoPushToGoogleSheets() {
        // 管理員可以執行完整自動上傳，一般使用者只能自動上傳借閱記錄
        const url = this.getGoogleWebAppUrl();
        if (!url) return;

        const now = Date.now();
        if (now < this.autoSyncCooldownUntil) return;
        if (now - this.autoSyncLastRunAt < this.autoSyncMinIntervalMs) return;
        this.autoSyncLastRunAt = now;

        try {
            if (this.isAdminUser()) {
                // 管理員：上傳完整資料
                await this.pushToGoogleSheets({ silent: true });
            } else {
                // 一般使用者：只上傳借閱記錄
                await this.pushBorrowedBooksToGoogleSheets({ silent: true });
            }
        } catch (e) {
            // 失敗後退避，避免一直打
            this.autoSyncCooldownUntil = Date.now() + 60000;
            console.error('autoPushToGoogleSheets error:', e);
        }
    }

    // 設定事件監聽器
    setupEventListeners() {
        // 搜尋和篩選（元素可能不存在，需防呆）
        const mainSearchInput = document.getElementById('search-input');
        if (mainSearchInput) {
            mainSearchInput.addEventListener('input', () => this.renderBooks());
        }
        document.getElementById('genre-filter').addEventListener('change', () => this.renderBooks());
        document.getElementById('sort-by').addEventListener('change', () => this.renderBooks());
        document.getElementById('sort-order').addEventListener('change', () => this.renderBooks());
        const mainSearchBtn = document.getElementById('search-btn');
        if (mainSearchBtn) {
            mainSearchBtn.addEventListener('click', () => this.renderBooks());
        }

        // 新增館藏：書碼首字母自動同步類別
        const bookPrefixSelect = document.getElementById('book-prefix');
        const bookIdInput = document.getElementById('book-id');
        if (bookIdInput && bookPrefixSelect) {
            bookIdInput.addEventListener('input', () => {
                const raw = String(bookIdInput.value || '');
                const trimmed = raw.trim();
                if (!trimmed) return;

                const first = trimmed.charAt(0).toUpperCase();
                if (/^[ABC]$/.test(first)) {
                    bookPrefixSelect.value = first;
                    if (trimmed.charAt(0) !== first) {
                        const pos = bookIdInput.selectionStart;
                        bookIdInput.value = first + trimmed.slice(1);
                        if (typeof pos === 'number') {
                            bookIdInput.setSelectionRange(pos, pos);
                        }
                    }
                }
            });

            bookPrefixSelect.addEventListener('change', () => {
                const prefix = String(bookPrefixSelect.value || '').toUpperCase();
                const suggested = this.generateNextBookId(prefix);
                if (suggested) {
                    bookIdInput.value = suggested;
                }
            });
        }

        // 直接輸入書碼借閱
        const borrowByCodeInput = document.getElementById('borrow-by-code-input');
        const borrowByCodeBtn = document.getElementById('borrow-by-code-btn');
        if (borrowByCodeBtn) {
            borrowByCodeBtn.addEventListener('click', () => this.borrowByBookCode());
        }
        if (borrowByCodeInput) {
            borrowByCodeInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.borrowByBookCode();
                }
            });
        }

        // 管理功能
        document.getElementById('boyou-books-btn').addEventListener('click', () => this.goToBoyouBooks());
        document.getElementById('import-btn').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) settingsBtn.addEventListener('click', () => this.showSettingsModal());
        document.getElementById('google-sync-btn').addEventListener('click', () => this.showGoogleSyncModal());
        document.getElementById('google-load-btn').addEventListener('click', () => this.loadFromGoogleSheets());
        document.getElementById('refresh-booklist-btn').addEventListener('click', () => this.refreshBookList());
        document.getElementById('file-input').addEventListener('change', (e) => this.importBooks(e));
        document.getElementById('add-book-btn').addEventListener('click', () => this.showAddBookModal());
        document.getElementById('fetch-all-covers-btn').addEventListener('click', () => this.showFetchCoversModal());
        document.getElementById('reload-csv-btn').addEventListener('click', () => this.reloadCSV());
        document.getElementById('toggle-auto-update-btn').addEventListener('click', () => this.toggleAutoUpdate());
        document.getElementById('reset-btn').addEventListener('click', () => this.resetData());
        document.getElementById('location-map-btn').addEventListener('click', () => this.showLocationMap());

        // 登入/登出
        document.getElementById('login-btn').addEventListener('click', () => this.showLoginModal());
        document.getElementById('logout-btn').addEventListener('click', () => this.logout());

        // 模態框
        this.setupModalListeners();

        // 表單提交
        document.getElementById('login-form').addEventListener('submit', (e) => this.handleLogin(e));
        document.getElementById('add-book-form').addEventListener('submit', (e) => this.handleAddBook(e));
        const settingsForm = document.getElementById('settings-form');
        if (settingsForm) settingsForm.addEventListener('submit', (e) => this.handleSaveSettings(e));

        // 使用者借閱時間設定
        const userLoanForm = document.getElementById('user-loan-form');
        if (userLoanForm) {
            userLoanForm.addEventListener('submit', (e) => this.handleSaveUserLoanSetting(e));
        }
        const userLoanSearch = document.getElementById('user-loan-search');
        if (userLoanSearch) {
            userLoanSearch.addEventListener('input', () => this.renderUserLoanSettingsList());
        }
        const deleteUserLoanBtn = document.getElementById('delete-user-loan-btn');
        if (deleteUserLoanBtn) {
            deleteUserLoanBtn.addEventListener('click', () => this.handleDeleteUserLoanSetting());
        }

        // 副管理者管理
        const subAdminForm = document.getElementById('sub-admin-form');
        if (subAdminForm) {
            subAdminForm.addEventListener('submit', (e) => this.handleAddSubAdmin(e));
        }
        const editBookForm = document.getElementById('edit-book-form');
        if (editBookForm) {
            editBookForm.addEventListener('submit', (e) => this.handleEditBook(e));
        }

        const fetchCoversForm = document.getElementById('fetch-covers-form');
        if (fetchCoversForm) {
            fetchCoversForm.addEventListener('submit', (e) => this.handleFetchCovers(e));
        }

        // 搜尋範圍選擇變更
        const fetchRange = document.getElementById('fetch-range');
        if (fetchRange) {
            fetchRange.addEventListener('change', (e) => this.toggleFetchOptions(e.target.value));
        }

        // 進度控制按鈕
        const pauseBtn = document.getElementById('pause-search-btn');
        const resumeBtn = document.getElementById('resume-search-btn');
        const stopBtn = document.getElementById('stop-search-btn');
        
        if (pauseBtn) pauseBtn.addEventListener('click', () => this.pauseSearch());
        if (resumeBtn) resumeBtn.addEventListener('click', () => this.resumeSearch());
        if (stopBtn) stopBtn.addEventListener('click', () => this.stopSearch());

        const autoFillAddBtn = document.getElementById('auto-fill-add-book-btn');
        if (autoFillAddBtn) {
            autoFillAddBtn.addEventListener('click', () => this.autoFillBookInfo({
                titleInputId: 'book-title',
                authorInputId: 'book-author',
                yearInputId: 'book-year',
                coverInputId: 'book-cover-url'
            }));
        }

        const autoFillEditBtn = document.getElementById('auto-fill-edit-book-btn');
        if (autoFillEditBtn) {
            autoFillEditBtn.addEventListener('click', () => this.autoFillBookInfo({
                titleInputId: 'edit-book-title',
                authorInputId: 'edit-book-author',
                yearInputId: 'edit-book-year',
                coverInputId: 'edit-book-cover-url'
            }));
        }

        // 視圖切換
        document.getElementById('grid-view').addEventListener('click', () => this.setView('grid'));
        document.getElementById('list-view').addEventListener('click', () => this.setView('list'));

        // 匯出借閱清單
        const exportBorrowedBtn = document.getElementById('export-borrowed-btn');
        if (exportBorrowedBtn) {
            exportBorrowedBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.exportBorrowedToExcel();
            });
        }

        // 借閱記錄搜尋和篩選事件監聽器
        const borrowedSearchInput = document.getElementById('borrowed-search-input');
        if (borrowedSearchInput) {
            borrowedSearchInput.addEventListener('input', () => this.searchBorrowedBooks());
            borrowedSearchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.searchBorrowedBooks();
                }
            });
        }

        const borrowedFilterStatus = document.getElementById('borrowed-filter-status');
        if (borrowedFilterStatus) {
            borrowedFilterStatus.addEventListener('change', () => this.searchBorrowedBooks());
        }

        const borrowedSort = document.getElementById('borrowed-sort');
        if (borrowedSort) {
            borrowedSort.addEventListener('change', () => this.searchBorrowedBooks());
        }

        const borrowedHeader = document.querySelector('.borrowed-header');
        if (borrowedHeader) {
            borrowedHeader.addEventListener('click', () => this.toggleBorrowedPanel());
            borrowedHeader.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.toggleBorrowedPanel();
                }
            });
        }

        const borrowedToggleBtn = document.getElementById('borrowed-toggle-btn');
        if (borrowedToggleBtn) {
            borrowedToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleBorrowedPanel();
            });
        }

        // 借閱紀錄：返回首頁按鈕
        const borrowedBackHomeBtn = document.getElementById('borrowed-back-home-btn');
        if (borrowedBackHomeBtn) {
            borrowedBackHomeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // 關閉借閱紀錄面板
                const panel = document.querySelector('.borrowed-section');
                if (panel) {
                    panel.classList.remove('open');
                    panel.classList.add('minimized');
                    this.updateBorrowedToggleIcon();
                }
                // 回到頁面頂部
                try {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                } catch (_) {
                    window.scrollTo(0, 0);
                }
            });
        }

        const borrowedFab = document.getElementById('borrowed-fab');
        if (borrowedFab) {
            borrowedFab.addEventListener('click', () => {
                const panel = document.querySelector('.borrowed-section');
                if (panel) {
                    // 直接展開並捲動到可見區域
                    panel.classList.add('open');
                    panel.classList.remove('minimized');
                    try {
                        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    } catch (_) {
                        panel.scrollIntoView(true);
                    }
                    this.updateBorrowedToggleIcon();
                }

                // 未登入時，引導登入以顯示借閱紀錄
                if (!this.currentUser) {
                    this.showToast('請先登入以查看借閱紀錄', 'info');
                    this.showLoginModal();
                    return;
                }

                // 確保內容為最新
                this.renderBorrowedBooks();
            });
        }

        // Google Sheets 同步
        const googlePullBtn = document.getElementById('google-pull-btn');
        const googlePushBtn = document.getElementById('google-push-btn');
        if (googlePullBtn) googlePullBtn.addEventListener('click', () => this.pullFromGoogleSheets());
        if (googlePushBtn) googlePushBtn.addEventListener('click', () => this.pushToGoogleSheets());

        this.setupAdminActionsSheetListeners();

        window.addEventListener('resize', () => {
            this.syncBorrowedPanelForViewport();
            this.syncAppHeaderHeight();
        });
    }

    syncAppHeaderHeight() {
        const header = document.querySelector('.header');
        if (!header) return;

        const setHeight = () => {
            const h = header.offsetHeight || 0;
            document.documentElement.style.setProperty('--app-header-height', `${h}px`);
        };

        requestAnimationFrame(setHeight);
        setTimeout(setHeight, 150);
    }

    setupAdminActionsSheetListeners() {
        const adminFab = document.getElementById('admin-fab');
        const modal = document.getElementById('admin-actions-modal');
        const closeBtn = document.getElementById('admin-actions-close');

        if (adminFab) {
            adminFab.addEventListener('click', () => {
                if (!this.isAdminUser()) return;
                if (modal) modal.style.display = 'block';
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                if (modal) modal.style.display = 'none';
            });
        }
    }

    renderAdminActionsSheet() {
        const listEl = document.getElementById('admin-actions-list');
        if (!listEl) return;

        if (!this.hasAdminAccess()) {
            listEl.innerHTML = '';
            return;
        }

        const isAdmin = this.isAdminUser();
        const items = [
            { id: 'settings-btn', label: '系統設定', icon: 'fas fa-cog' },
            { id: 'google-sync-btn', label: 'Google Sheets 同步', icon: 'fas fa-cloud-upload-alt' },
            { id: 'google-load-btn', label: '從 Google Sheets 載入', icon: 'fas fa-cloud-download-alt' },
            { id: 'import-btn', label: '匯入 Excel 書單', icon: 'fas fa-file-import' },
            { id: 'add-book-btn', label: '新增館藏', icon: 'fas fa-plus' },
            { id: 'fetch-all-covers-btn', label: '一鍵搜尋封面', icon: 'fas fa-images' },
            { id: 'reload-csv-btn', label: '重新載入資料', icon: 'fas fa-sync' },
            { id: 'toggle-auto-update-btn', label: '自動更新', icon: 'fas fa-sync-alt' }
        ];

        // 只有主要管理者可以看到重置資料按鈕
        if (isAdmin) {
            items.push({ id: 'reset-btn', label: '重置資料', icon: 'fas fa-trash' });
        }

        listEl.innerHTML = items
            .map(item => {
                return `
<button class="actionsheet-item" type="button" data-target-id="${item.id}">
  <span class="actionsheet-item-left">
    <span class="actionsheet-item-icon"><i class="${item.icon}"></i></span>
    <span class="actionsheet-item-text">${item.label}</span>
  </span>
  <span class="actionsheet-item-right"><i class="fas fa-chevron-right"></i></span>
</button>`;
            })
            .join('');

        listEl.querySelectorAll('[data-target-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.getAttribute('data-target-id');
                const target = targetId ? document.getElementById(targetId) : null;
                const modal = document.getElementById('admin-actions-modal');
                if (modal) modal.style.display = 'none';
                if (target) target.click();
            });
        });
    }

    syncBorrowedPanelForViewport() {
        const panel = document.querySelector('.borrowed-section');
        if (!panel) return;

        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
            if (!panel.classList.contains('open') && !panel.classList.contains('minimized')) {
                panel.classList.add('minimized');
            }
        } else {
            if (!panel.classList.contains('open') && !panel.classList.contains('minimized')) {
                panel.classList.add('open');
            }
        }

        this.updateBorrowedToggleIcon();
    }

    toggleBorrowedPanel() {
        const panel = document.querySelector('.borrowed-section');
        if (!panel) return;

        const willOpen = !panel.classList.contains('open');
        if (willOpen) {
            panel.classList.add('open');
            panel.classList.remove('minimized');
            // 展開時自動捲動到可見區域，讓使用者直觀看到內容
            try {
                panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (_) {
                // 某些舊版瀏覽器不支援 smooth，忽略即可
                panel.scrollIntoView(true);
            }
        } else {
            panel.classList.remove('open');
            panel.classList.add('minimized');
        }

        this.updateBorrowedToggleIcon();
    }

    updateBorrowedToggleIcon() {
        const icon = document.querySelector('#borrowed-toggle-btn i');
        const toggleBtn = document.getElementById('borrowed-toggle-btn');
        const fabBtn = document.getElementById('borrowed-fab');
        if (!icon) {
            // 即使找不到 icon，也同步更新無障礙屬性
        }

        const panel = document.querySelector('.borrowed-section');
        if (!panel) return;

        const isOpen = panel.classList.contains('open');
        if (icon) icon.className = isOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(isOpen));
        if (fabBtn) fabBtn.setAttribute('aria-pressed', String(isOpen));
    }

    // 設定模態框事件
    setupModalListeners() {
        const modals = document.querySelectorAll('.modal');
        const closes = document.querySelectorAll('.close');

        closes.forEach(close => {
            close.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                modal.style.display = 'none';
            });
        });

        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.style.display = 'none';
            }
        });
    }

    // 顯示位置圖
    showLocationMap() {
        const modal = document.getElementById('location-map-modal');
        if (modal) {
            modal.style.display = 'block';
        }
    }

    // 載入資料
    loadData() {
        this.books = JSON.parse(localStorage.getItem('lib_books_v1') || '[]');
        this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
        this.users = JSON.parse(localStorage.getItem('lib_users_v1') || '[]');
        this.currentUser = JSON.parse(localStorage.getItem('lib_active_user_v1') || 'null');

        const storedSettings = JSON.parse(localStorage.getItem('lib_settings_v1') || 'null');
        if (storedSettings && typeof storedSettings === 'object') {
            this.settings = { ...this.settings, ...storedSettings };
        }

        if (!this.settings.googleWebAppUrl) {
            this.settings.googleWebAppUrl = this.defaultGoogleWebAppUrl;
        }

        // 確保 subAdmins 存在
        if (!this.settings.subAdmins || !Array.isArray(this.settings.subAdmins)) {
            this.settings.subAdmins = [];
        }

        // 檢查 boyo1314 是否在副管理者列表中
        if (!this.settings.subAdmins.find(sa => sa.username === 'boyo1314')) {
            this.settings.subAdmins.push({
                username: 'boyo1314',
                createdAt: new Date().toISOString()
            });
        }

        localStorage.setItem('lib_settings_v1', JSON.stringify(this.settings));

        // 去重：根據書籍 ID 移除重複項
        const bookMap = new Map();
        this.books.forEach(book => {
            if (book.id && !bookMap.has(book.id)) {
                bookMap.set(book.id, book);
            }
        });
        this.books = Array.from(bookMap.values());

        // 為舊書補上 createdAt 欄位
        this.books = this.books.map((book, index) => ({
            ...book,
            createdAt: book.createdAt || new Date(Number(book.addedAt) || Date.now() - index).toISOString()
        }));

        this.saveData();
    }

    updateBorrowedToggleIcon() {
        const icon = document.querySelector('#borrowed-toggle-btn i');
        if (!icon) return;

        const panel = document.querySelector('.borrowed-section');
        if (!panel) return;

        const isOpen = panel.classList.contains('open');
        icon.className = isOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
    }

    // 設定模態框事件
    setupModalListeners() {
        const modals = document.querySelectorAll('.modal');
        const closes = document.querySelectorAll('.close');

        closes.forEach(close => {
            close.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                modal.style.display = 'none';
            });
        });

        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.style.display = 'none';
            }
        });
    }

    // 顯示位置圖
    showLocationMap() {
        const modal = document.getElementById('location-map-modal');
        if (modal) {
            modal.style.display = 'block';
        }
    }

    // 直接從 Google Sheets 載入書籍
    async loadFromGoogleSheets() {
        if (!this.requireAdmin('從 Google Sheets 載入')) return;

        const url = this.getGoogleWebAppUrl();
        if (!url) {
            this.showToast('請先在系統設定中設定 Google Sheets 同步網址', 'error');
            this.showGoogleSyncModal();
            return;
        }

        const confirmed = confirm('確定要從 Google Sheets 載入書籍資料嗎？\n這會覆蓋目前本機的所有書籍資料。');
        if (!confirmed) return;

        try {
            this.showToast('正在從 Google Sheets 載入書籍資料...', 'info');
            this.showLoadingIndicator(true);

            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify({ action: 'pull' })
            });

            const result = await response.json().catch(() => null);
            if (!response.ok || !result || !result.ok) {
                throw new Error('Google Sheets 請求失敗');
            }

            const data = result.data || {};
            if (!Array.isArray(data.books)) {
                throw new Error('資料格式不正確');
            }

            if (data.books.length === 0) {
                const ok = confirm('Google Sheets 中沒有書籍資料。確定要清空本機館藏嗎？');
                if (!ok) {
                    this.showLoadingIndicator(false);
                    return;
                }
            }

            // 載入書籍資料（Google Sheet 越下面越新，所以反轉讓最新的在最上面）
            let newBooks = [...data.books].reverse();

            // 去重：根據書籍 ID 移除重複項
            const bookMap = new Map();
            newBooks.forEach(book => {
                if (book.id && !bookMap.has(book.id)) {
                    bookMap.set(book.id, book);
                }
            });
            this.books = Array.from(bookMap.values());
            this.setBorrowedBooksFromRemote(Array.isArray(data.borrowedBooks) ? data.borrowedBooks : []);

            // 處理博幼藏書資料
            if (data.boyouBooks && typeof data.boyouBooks === 'object') {
                localStorage.setItem('lib_boyou_books_v1', JSON.stringify(data.boyouBooks));
            }

            // 儲存到本地
            this.saveData();
            
            // 重新渲染介面
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();

            this.showLoadingIndicator(false);
            this.showToast(`成功載入 ${this.books.length} 本書籍資料`, 'success');

        } catch (error) {
            console.error('從 Google Sheets 載入失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('載入失敗，請檢查網路連線或 Google Sheets 設定', 'error');
        }
    }

    showGoogleSyncModal() {
        if (!this.requireAdmin('Google Sheets 同步')) return;
        const modal = document.getElementById('google-sync-modal');
        const urlInput = document.getElementById('google-webapp-url');
        if (urlInput) {
            urlInput.value = this.settings.googleWebAppUrl || '';
        }
        if (modal) {
            modal.style.display = 'block';
        }
    }

    showSettingsModal() {
        if (!this.requireAdmin('系統設定')) return;

        const modal = document.getElementById('settings-modal');
        const loanDays = document.getElementById('loan-days');
        const guestBorrow = document.getElementById('guest-borrow');
        const defaultCopies = document.getElementById('default-copies');
        const defaultYear = document.getElementById('default-year');

        if (loanDays) loanDays.value = String(this.settings.loanDays ?? 14);
        if (guestBorrow) guestBorrow.checked = !!this.settings.guestBorrow;
        if (defaultCopies) defaultCopies.value = String(this.settings.defaultCopies ?? 1);
        if (defaultYear) defaultYear.value = String(this.settings.defaultYear ?? 2024);

        this.normalizeUserLoanSettings();
        this.renderUserLoanSettingsList();

        if (modal) modal.style.display = 'block';
    }

    handleSaveSettings(e) {
        e.preventDefault();
        if (!this.requireAdmin('儲存設定')) return;

        let loanDays = parseInt(document.getElementById('loan-days')?.value, 10);
        if (!Number.isFinite(loanDays) || loanDays < 1) loanDays = 14;
        const guestBorrow = !!document.getElementById('guest-borrow')?.checked;
        const defaultCopies = parseInt(document.getElementById('default-copies')?.value) || 1;
        const defaultYear = parseInt(document.getElementById('default-year')?.value) || 2024;

        this.settings.loanDays = loanDays;
        this.settings.guestBorrow = guestBorrow;
        this.settings.defaultCopies = defaultCopies;
        this.settings.defaultYear = defaultYear;

        this.saveData();
        this.renderBooks();

        const modal = document.getElementById('settings-modal');
        if (modal) modal.style.display = 'none';
        this.showToast('設定已儲存', 'success');
    }

    getGoogleWebAppUrlFromUI() {
        const urlInput = document.getElementById('google-webapp-url');
        const url = urlInput ? urlInput.value.trim() : '';
        if (!url) {
            this.showToast('請先填入 Apps Script Web App URL', 'error');
            return null;
        }
        this.settings.googleWebAppUrl = url;
        this.saveData();
        return url;
    }

    async pushBorrowedBooksToGoogleSheets(options = {}) {
        const { silent = false } = options;
        
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            if (!silent) this.showToast('請先由管理者設定 Google Sheets 同步網址', 'error');
            return;
        }

        try {
            if (!silent) this.showToast('正在上傳借閱記錄到 Google Sheets...', 'info');
            
            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify({
                    action: 'pushBorrowedBooks',
                    payload: {
                        borrowedBooks: this.borrowedBooks,
                        userId: this.currentUser?.username || 'anonymous'
                    }
                })
            });

            const result = await response.json().catch(() => null);
            if (!response.ok) {
                if (!silent) this.showToast('上傳借閱記錄失敗', 'error');
                return;
            }

            if (result && result.ok) {
                if (!silent) this.showToast('借閱記錄上傳完成', 'success');
            } else {
                if (!silent) this.showToast('上傳完成，但回應格式不符', 'warning');
            }
        } catch (error) {
            console.error('pushBorrowedBooksToGoogleSheets error:', error);
            if (!silent) this.showToast('上傳失敗，請檢查網路連線', 'error');
            throw error;
        }
    }

    async pushToGoogleSheets(options = {}) {
        const { silent = false } = options;
        
        // 檢查管理員權限（非靜默操作需要權限）
        if (!silent && !this.requireAdmin('上傳到 Google Sheets')) return;
        
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            if (!silent) this.showToast('請先由管理者設定 Google Sheets 同步網址', 'error');
            return;
        }

        try {
            if (!silent) this.showToast('正在上傳到 Google Sheets...', 'info');
            const boyouBooks = JSON.parse(localStorage.getItem('lib_boyou_books_v1') || 'null') || {};

            // 去重：根據書籍 ID 移除重複項
            const bookMap = new Map();
            (Array.isArray(this.books) ? this.books : []).forEach(book => {
                if (book.id && !bookMap.has(book.id)) {
                    bookMap.set(book.id, book);
                }
            });
            const deduplicatedBooks = Array.from(bookMap.values());

            // 確保每本書都有 series 與 createdAt 欄位
            const normalizedBooks = deduplicatedBooks.map(b => ({
                ...b,
                series: b.series || '',
                createdAt: b.createdAt || b.addedAt || ''
            }));

            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify({
                    action: 'push',
                    payload: {
                        books: normalizedBooks,
                        borrowedBooks: this.borrowedBooks,
                        boyouBooks
                    }
                })
            });

            const result = await response.json().catch(() => null);
            if (!response.ok) {
                if (!silent) this.showToast('上傳失敗，請檢查 Web App 權限/網址', 'error');
                return;
            }

            if (result && result.ok) {
                // 上傳成功後，更新版本信息
                this.updateBookListVersion();
                
                if (!silent) this.showToast('上傳完成', 'success');
            } else {
                if (!silent) this.showToast('上傳完成，但回應格式不符', 'warning');
            }
        } catch (error) {
            console.error('pushToGoogleSheets error:', error);
            if (!silent) this.showToast('上傳失敗，請檢查網路或 CORS 設定', 'error');
            throw error;
        }
    }

    async pullFromGoogleSheets(options = {}) {
        const { silent = false, protectEmpty = false, closeModal = true } = options;
        const url = silent ? this.getGoogleWebAppUrl() : this.getGoogleWebAppUrlFromUI();
        if (!url) return;

        try {
            if (!silent) this.showToast('正在從 Google Sheets 下載...', 'info');
            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify({ action: 'pull' })
            });

            const result = await response.json().catch(() => null);
            if (!response.ok || !result || !result.ok) {
                if (!silent) this.showToast('下載失敗，請檢查 Web App 權限/網址', 'error');
                return;
            }

            const data = result.data || {};
            if (!Array.isArray(data.books) || !Array.isArray(data.borrowedBooks)) {
                if (!silent) this.showToast('下載失敗：資料格式不正確', 'error');
                return;
            }

            if (protectEmpty && data.books.length === 0 && Array.isArray(this.books) && this.books.length > 0) {
                // 自動載入模式：線上空資料時不覆蓋本機，避免把館藏清空
                return;
            }

            if (data.books.length === 0 && Array.isArray(this.books) && this.books.length > 0) {
                const ok = confirm('線上 Books 資料是空的，下載會清空目前館藏。確定要覆蓋嗎？');
                if (!ok) {
                    if (!silent) this.showToast('已取消下載覆蓋', 'info');
                    return;
                }
            }

            // Google Sheet 越下面越新，所以反轉讓最新的在最上面
            let newBooks = [...data.books].reverse();

            // 去重：根據書籍 ID 移除重複項
            const bookMap = new Map();
            newBooks.forEach(book => {
                if (book.id && !bookMap.has(book.id)) {
                    bookMap.set(book.id, book);
                }
            });
            this.books = Array.from(bookMap.values());

            // 如果遠端沒有借閱資料但本機已有資料，保留本機借閱資料
            if (Array.isArray(data.borrowedBooks) && data.borrowedBooks.length === 0) {
                if (Array.isArray(this.borrowedBooks) && this.borrowedBooks.length > 0) {
                    console.log('[pullFromGoogleSheets] 收到空的遠端借閱清單，保留本機借閱資料');
                } else {
                    this.borrowedBooks = [];
                }
            } else {
                this.borrowedBooks = data.borrowedBooks;
            }

            if (data.boyouBooks && typeof data.boyouBooks === 'object') {
                localStorage.setItem('lib_boyou_books_v1', JSON.stringify(data.boyouBooks));
            }
            this.saveData();
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();
            if (!silent) this.showToast('下載完成並已同步到本機', 'success');

            if (closeModal) {
                const modal = document.getElementById('google-sync-modal');
                if (modal) modal.style.display = 'none';
            }
        } catch (error) {
            console.error('pullFromGoogleSheets error:', error);
            if (!silent) this.showToast('下載失敗，請檢查網路或 CORS 設定', 'error');
        }
    }

    async autoLoadFromGoogleSheets() {
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            console.log('未設定 Google Sheets URL，跳過自動載入');
            // 嘗試載入本地 CSV 檔案作為備案
            await this.autoLoadCSV();
            return;
        }

        try {
            // 記錄載入前本機是否已有書籍，用來判斷是否為首次匯入
            const hadLocalBooks = Array.isArray(this.books) && this.books.length > 0;
            // 檢查是否應該從雲端更新書單
            console.log('正在檢查書單是否需要更新...');
            const shouldUpdate = await this.checkShouldUpdateBookList();
            
            if (!shouldUpdate) {
                // 不需要更新，嘗試從快取加載
                console.log('[快取策略] 不需要更新，嘗試從快取加載');
                const cachedBooks = this.loadBookListCache();
                if (cachedBooks && cachedBooks.length > 0) {
                    this.books = cachedBooks;
                    // 從本地 localStorage 加載借閱資料（不變）
                    this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                    this.lastUpdateTime = new Date();
                    this.updateLastUpdateDisplay();
                    console.log(`[快取策略] 成功加載快取書籍 ${this.books.length} 本`);
                    this.showToast(`已加載快取書籍 ${this.books.length} 本`, 'info');
                    return;
                } else {
                    // 快取不存在，需要下載
                    console.log('[快取策略] 快取不存在，需要從雲端下載');
                }
            }
            
            // 需要從雲端更新書單
            console.log('[快取策略] 開始從 Google Sheets 下載書單');
            this.showToast('正在同步書單...', 'info');
            
            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify({ action: 'pull' })
            });

            const result = await response.json().catch(() => null);
            if (!response.ok || !result || !result.ok) {
                console.log('Google Sheets 載入失敗:', result?.error || '未知錯誤');
                
                // 如果雲端失敗，嘗試從快取加載
                console.log('[快取策略] 雲端加載失敗，嘗試從快取加載');
                const cachedBooks = this.loadBookListCache();
                if (cachedBooks && cachedBooks.length > 0) {
                    this.books = cachedBooks;
                    this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                    this.lastUpdateTime = new Date();
                    this.updateLastUpdateDisplay();
                    this.showToast(`雲端同步失敗，已加載快取書籍 ${this.books.length} 本`, 'warning');
                    return;
                }
                
                this.showToast('Google Sheets 載入失敗，嘗試載入本地 CSV 檔案...', 'warning');
                // 當 Google Sheets 失敗時，自動載入本地 CSV 檔案
                await this.autoLoadCSV();
                return;
            }

            const data = result.data || {};
            if (!Array.isArray(data.books)) {
                console.log('Google Sheets 資料格式不正確');
                
                // 如果雲端格式錯誤，嘗試從快取加載
                console.log('[快取策略] 雲端資料格式不正確，嘗試從快取加載');
                const cachedBooks = this.loadBookListCache();
                if (cachedBooks && cachedBooks.length > 0) {
                    this.books = cachedBooks;
                    this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                    this.lastUpdateTime = new Date();
                    this.updateLastUpdateDisplay();
                    this.showToast(`雲端資料格式錯誤，已加載快取書籍 ${this.books.length} 本`, 'warning');
                    return;
                }
                
                this.showToast('Google Sheets 資料格式錯誤，嘗試載入本地 CSV 檔案...', 'warning');
                // 當資料格式錯誤時，自動載入本地 CSV 檔案
                await this.autoLoadCSV();
                return;
            }

            // 處理書籍資料（Google Sheet 越下面越新，所以反轉讓最新的在最上面）
            let newBooks = [...(data.books || [])].reverse();

            // 去重：根據書籍 ID 移除重複項
            const bookMap = new Map();
            newBooks.forEach(book => {
                if (book.id && !bookMap.has(book.id)) {
                    bookMap.set(book.id, book);
                }
            });
            this.books = Array.from(bookMap.values());

            // 如果遠端沒有借閱資料但本機已有資料，保留本機借閱資料
            if (Array.isArray(data.borrowedBooks) && data.borrowedBooks.length === 0) {
                if (Array.isArray(this.borrowedBooks) && this.borrowedBooks.length > 0) {
                    console.log('[autoLoadFromGoogleSheets] 收到空的遠端借閱清單，保留本機借閱資料');
                } else {
                    this.borrowedBooks = [];
                }
            } else {
                this.borrowedBooks = data.borrowedBooks || [];
            }

            // 處理博幼藏書
            const boyouBooks = data.boyouBooks || {};
            localStorage.setItem('lib_boyou_books_v1', JSON.stringify(boyouBooks));

            // 保存快取
            this.saveBookListCache(this.books, this.borrowedBooks);
            
            // 更新版本信息
            const remoteVersion = data.version || new Date().toISOString();
            this.updateBookListVersion(remoteVersion);

            this.saveData();
            this.lastUpdateTime = new Date();
            this.updateLastUpdateDisplay();
            
            // 若原本本機沒有書籍、此次從雲端成功載入書籍，視為首次匯入，才觸發同步
            if (!hadLocalBooks && Array.isArray(this.books) && this.books.length > 0) {
                try {
                    localStorage.setItem('lib_initial_import_done', '1');
                    // 使用 action 'addBook' 作為變更類別觸發同步
                    this.triggerSyncForAction('addBook');
                } catch (e) {
                    console.error('首次匯入後觸發同步失敗:', e);
                }
            }

            if (this.books.length > 0) {
                console.log(`成功從 Google Sheets 載入 ${this.books.length} 本書籍`);
                this.showToast(`已從 Google Sheets 載入 ${this.books.length} 本書籍`, 'success');
            } else {
                console.log('Google Sheets 中沒有書籍資料，嘗試載入本地 CSV 檔案...');
                this.showToast('Google Sheets 中沒有書籍資料，嘗試載入本地 CSV 檔案...', 'warning');
                // 當線上沒有資料時，也嘗試載入本地 CSV 檔案
                await this.autoLoadCSV();
            }

        } catch (error) {
            console.error('自動從 Google Sheets 載入失敗:', error);
            
            // 如果出錯，嘗試從快取加載
            console.log('[快取策略] 自動載入失敗，嘗試從快取加載');
            const cachedBooks = this.loadBookListCache();
            if (cachedBooks && cachedBooks.length > 0) {
                this.books = cachedBooks;
                this.borrowedBooks = JSON.parse(localStorage.getItem('lib_borrowed_v1') || '[]');
                this.lastUpdateTime = new Date();
                this.updateLastUpdateDisplay();
                this.showToast(`同步失敗，已加載快取書籍 ${this.books.length} 本`, 'warning');
                return;
            }
            
            this.showToast('Google Sheets 載入失敗，嘗試載入本地 CSV 檔案...', 'warning');
            // 當發生錯誤時，自動載入本地 CSV 檔案
            await this.autoLoadCSV();
        }
    }

    // 自動載入 CSV 檔案
    async autoLoadCSV() {
        console.log('開始載入本地 CSV 檔案');
        try {
            // 顯示載入中狀態
            this.showLoadingIndicator(true);
            
            // 載入本地 CSV 檔案
            const response = await fetch('113博幼館藏.csv');
            if (!response.ok) {
                console.log('本地 CSV 檔案載入失敗');
                this.showLoadingIndicator(false);
                return;
            }

            const csvText = await response.text();
            const csvData = this.parseCSV(csvText);
            
            if (csvData.length > 0) {
                this.processCSVData(csvData);
                this.lastUpdateTime = new Date();
                this.updateLastUpdateDisplay();
                this.showToast(`已載入本地 CSV 資料 (${csvData.length} 筆)`, 'success');
            }
            
            this.showLoadingIndicator(false);
        } catch (error) {
            console.log('載入失敗:', error);
            this.showLoadingIndicator(false);
        }
    }

    /**
     * 重新整理書單 - 提供給普通用戶的快捷按鈕
     * 清除快取，強制從雲端重新下載最新書單
     * 不需要管理員權限
     */
    async refreshBookList() {
        try {
            this.showToast('正在重新整理書單...', 'info');
            this.showLoadingIndicator(true);
            
            console.log('[使用者操作] 重新整理書單 - 清除快取');
            // 清除快取，強制重新下載
            this.clearBookListCache();
            
            // 從雲端重新載入書單
            await this.autoLoadFromGoogleSheets();
            
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();
            this.showLoadingIndicator(false);
            
            this.showToast('書單已重新整理', 'success');
        } catch (error) {
            console.error('重新整理書單失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('重新整理失敗，請檢查網路連線', 'error');
        }
    }

    // 解析 CSV 文字
    parseCSV(csvText) {
        console.log('開始解析 CSV 文字，長度:', csvText.length);
        const lines = csvText.split('\n');
        console.log('CSV 行數:', lines.length);
        const data = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            // 跳過標題行和空行
            if (i < 4) {
                console.log(`跳過第${i}行 (標題行):`, line);
                continue;
            }
            
            const columns = line.split(',');
            if (columns.length >= 2 && columns[0]) {
                console.log(`處理第${i}行:`, columns[0], columns[1]);
                data.push(columns);
            } else {
                console.log(`跳過第${i}行 (格式不符):`, line);
            }
        }
        
        console.log('CSV 解析完成，共', data.length, '筆有效資料');
        return data;
    }

    // 處理 CSV 資料
    processCSVData(csvData) {
        console.log('開始處理 CSV 資料，共', csvData.length, '筆');
        console.log('處理前書籍數量:', this.books.length);
        
        // 清空現有書籍資料，避免累積
        this.books = [];
        
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        const bookMap = new Map(); // 用於合併相同書名的書籍

        for (let i = 0; i < csvData.length; i++) {
            const row = csvData[i];
            if (!row || row.length === 0 || !row[0]) continue;

            const id = row[0].toString().trim();
            let title = row[1] ? row[1].toString().trim() : '';

            // 驗證書碼格式
            if (!/^[ABC]\d+$/.test(id)) {
                errors.push(`第${i+5}行：書碼格式錯誤 (${id})`);
                errorCount++;
                continue;
            }

            // 如果書名為空，跳過此記錄
            if (!title) {
                console.log(`跳過第${i+5}行：書名為空 (${id})`);
                continue;
            }

            // 檢查重複書碼（在當前處理的資料中）
            if (bookMap.has(title) && bookMap.get(title).bookIds.includes(id)) {
                errors.push(`第${i+5}行：書碼重複 (${id})`);
                errorCount++;
                continue;
            }

            const genre = this.getGenreFromId(id);
            const year = this.settings.defaultYear;
            const copies = 1; // 預設冊數為 1

            // 檢查是否已存在相同書名的書籍
            if (bookMap.has(title)) {
                const existingBook = bookMap.get(title);
                existingBook.copies += copies;
                existingBook.availableCopies += copies;
                existingBook.bookIds.push(id); // 記錄所有書碼
            } else {
                const newBook = {
                    id, // 主要書碼
                    bookIds: [id], // 所有書碼列表
                    title,
                    genre,
                    year,
                    copies,
                    availableCopies: copies
                };
                bookMap.set(title, newBook);
            }
            successCount++;
        }

        // 將合併後的書籍添加到陣列中
        for (const book of bookMap.values()) {
            this.books.push(book);
        }

        console.log('處理完成，共載入', this.books.length, '本書籍');
        console.log('書籍列表:', this.books);

        this.saveData();

        if (successCount > 0) {
            console.log(`成功載入 ${successCount} 本書籍`);
        }
        if (errorCount > 0) {
            console.log(`有 ${errorCount} 筆資料載入失敗`);
            console.log('載入錯誤:', errors);
        }
    }

    // 儲存資料
    saveData() {
        localStorage.setItem('lib_books_v1', JSON.stringify(this.books));
        localStorage.setItem('lib_borrowed_v1', JSON.stringify(this.borrowedBooks));
        localStorage.setItem('lib_users_v1', JSON.stringify(this.users));
        localStorage.setItem('lib_active_user_v1', JSON.stringify(this.currentUser));
        localStorage.setItem('lib_settings_v1', JSON.stringify(this.settings));
        
        // 自動上傳到 Google Sheets
        this.autoSyncToGoogleSheets();
    }

    // 安全地從遠端資料設定借閱清單：避免遠端空陣列覆蓋本機已有資料
    setBorrowedBooksFromRemote(remoteBorrowed) {
        try {
            if (!Array.isArray(remoteBorrowed)) return;

            // 如果遠端沒有任何紀錄但本機已有資料，保留本機資料
            if (remoteBorrowed.length === 0) {
                if (Array.isArray(this.borrowedBooks) && this.borrowedBooks.length > 0) {
                    console.log('[borrow] 收到空的遠端借閱清單，保留本機借閱資料');
                    return;
                }
                this.borrowedBooks = [];
                return;
            }

            // 若遠端有資料，合併遠端與本機，避免重複（以 id 為準）
            const map = new Map();
            (Array.isArray(this.borrowedBooks) ? this.borrowedBooks : []).forEach(b => {
                if (b && b.id) map.set(b.id, b);
            });
            remoteBorrowed.forEach(rb => {
                if (rb && rb.id) map.set(rb.id, rb);
            });
            this.borrowedBooks = Array.from(map.values());
        } catch (e) {
            console.error('setBorrowedBooksFromRemote error:', e);
        }
    }

    // 自動同步到 Google Sheets
    async autoSyncToGoogleSheets() {
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            // 如果沒有設定 Google Sheets，靜默跳過
            return;
        }

        try {
            // 防止頻繁上傳，設定一個短暫的延遲
            if (this.autoSyncTimeout) {
                clearTimeout(this.autoSyncTimeout);
            }

            this.autoSyncTimeout = setTimeout(async () => {
                const boyouBooks = JSON.parse(localStorage.getItem('lib_boyou_books_v1') || 'null') || {};
                const response = await fetch(url, {
                    method: 'POST',
                    body: JSON.stringify({
                        action: 'push',
                        payload: {
                            books: this.books,
                            borrowedBooks: this.borrowedBooks,
                            boyouBooks
                        }
                    })
                });

                const result = await response.json().catch(() => null);
                if (response.ok && result && result.ok) {
                    console.log('自動同步到 Google Sheets 成功');
                    // 可以選擇性地顯示一個小圖標或訊息
                    this.showSyncIndicator('已同步', 'success');
                } else {
                    console.log('自動同步到 Google Sheets 失敗');
                }
            }, 1000); // 延遲1秒上傳，避免頻繁請求

        } catch (error) {
            console.error('自動同步到 Google Sheets 失敗:', error);
            // 靜默失敗，不影響本地操作
        }
    }

    // 顯示同步指示器
    showSyncIndicator(message, type = 'info') {
        // 創建或更新同步指示器
        let indicator = document.getElementById('sync-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'sync-indicator';
            indicator.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 8px 16px;
                border-radius: 20px;
                font-size: 0.8rem;
                font-weight: 600;
                z-index: 10000;
                transition: all 0.3s ease;
                pointer-events: none;
            `;
            document.body.appendChild(indicator);
        }

        // 設置樣式和訊息
        if (type === 'success') {
            indicator.style.backgroundColor = '#48bb78';
            indicator.style.color = 'white';
        } else {
            indicator.style.backgroundColor = '#667eea';
            indicator.style.color = 'white';
        }
        
        indicator.textContent = message;
        indicator.style.opacity = '1';

        // 3秒後淡出
        setTimeout(() => {
            indicator.style.opacity = '0';
            setTimeout(() => {
                if (indicator.parentNode) {
                    indicator.parentNode.removeChild(indicator);
                }
            }, 300);
        }, 3000);
    }

    // 顯示登入模態框
    showLoginModal() {
        document.getElementById('login-modal').style.display = 'block';
    }

    showSelectionModal({ title, message, options }) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal';
            overlay.style.display = 'block';
            overlay.style.zIndex = '10001';

            const content = document.createElement('div');
            content.className = 'modal-content selection-modal-content';

            const closeBtn = document.createElement('span');
            closeBtn.className = 'close';
            closeBtn.innerHTML = '&times;';

            const h2 = document.createElement('h2');
            h2.textContent = title || '請選擇';
            h2.className = 'selection-modal-title';

            const p = document.createElement('p');
            p.textContent = message || '';
            p.className = 'selection-modal-message';

            const list = document.createElement('div');
            list.className = 'selection-modal-options';

            const safeOptions = Array.isArray(options) ? options : [];
            safeOptions.forEach((opt) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'selection-modal-option';
                btn.dataset.value = opt.value;

                const img = document.createElement('img');
                img.className = 'selection-option-image';
                img.src = opt.image || '';
                img.alt = opt.title || '';
                img.loading = 'lazy';
                // 如果沒有圖片，顯示預設圖標
                if (!opt.image) {
                    img.style.display = 'none';
                }

                const text = document.createElement('div');
                text.className = 'selection-option-text';
                text.innerHTML = `
                    <div class="selection-option-title">${opt.title || ''}</div>
                    <div class="selection-option-code">${opt.code || ''}</div>
                    <div class="selection-option-stock">可借 ${opt.available || 0} / ${opt.total || 1}</div>
                `;

                btn.appendChild(img);
                btn.appendChild(text);

                btn.addEventListener('click', () => {
                    cleanup();
                    resolve(opt.value);
                });
                list.appendChild(btn);
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn btn-outline selection-modal-cancel';
            cancelBtn.textContent = '取消';
            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve(null);
            });

            const cleanup = () => {
                document.removeEventListener('keydown', onKeyDown);
                overlay.removeEventListener('click', onOverlayClick);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            };

            const onOverlayClick = (e) => {
                if (e.target === overlay) {
                    cleanup();
                    resolve(null);
                }
            };

            const onKeyDown = (e) => {
                if (e.key === 'Escape') {
                    cleanup();
                    resolve(null);
                }
            };

            closeBtn.addEventListener('click', () => {
                cleanup();
                resolve(null);
            });

            overlay.addEventListener('click', onOverlayClick);
            document.addEventListener('keydown', onKeyDown);

            content.appendChild(closeBtn);
            content.appendChild(h2);
            if (p.textContent) content.appendChild(p);
            content.appendChild(list);
            content.appendChild(cancelBtn);
            overlay.appendChild(content);
            document.body.appendChild(overlay);
        });
    }

    // 處理登入
    handleLogin(e) {
        e.preventDefault();
        const usernameEl = document.getElementById('username');
        const roleEl = document.getElementById('user-role');

        if (!usernameEl) {
            this.showToast('登入表單缺少使用者名稱欄位（#username）', 'error');
            return;
        }

        const username = usernameEl.value;
        const role = roleEl ? roleEl.value : 'student';

        if (!username.trim()) {
            this.showToast('請輸入使用者名稱', 'error');
            return;
        }

        // 檢查是否為副管理者
        const subAdmin = this.settings.subAdmins?.find(sa => sa.username === username);
        if (subAdmin) {
            this.currentUser = { username, role: 'subadmin' };
        } else if (username === this.adminUsername) {
            this.currentUser = { username, role: 'admin' };
        } else {
            this.currentUser = { username, role };
        }

        this.saveData();
        this.updateUserDisplay();
        this.updateAdminControls();
        if (!this.hasAdminAccess()) {
            this.stopAutoUpdate();
        } else {
            this.startAutoUpdate();
        }
        this.renderBooks();
        this.renderBorrowedBooks();

        document.getElementById('login-modal').style.display = 'none';
        document.getElementById('login-form').reset();
        this.showToast(`歡迎 ${username}！`, 'success');
    }

    // 登出
    logout() {
        this.currentUser = null;
        this.saveData();
        this.updateUserDisplay();
        this.updateAdminControls();
        this.stopAutoUpdate();
        this.renderBooks();
        this.renderBorrowedBooks();
        this.showToast('已登出', 'success');
    }

    // 更新使用者顯示
    updateUserDisplay() {
        const currentUserSpan = document.getElementById('current-user');
        const loginBtn = document.getElementById('login-btn');
        const logoutBtn = document.getElementById('logout-btn');

        if (this.currentUser) {
            currentUserSpan.textContent = this.currentUser.username;
            loginBtn.style.display = 'none';
            logoutBtn.style.display = 'inline-flex';
        } else {
            currentUserSpan.textContent = '訪客';
            loginBtn.style.display = 'inline-flex';
            logoutBtn.style.display = 'none';
        }
    }

    // 取得角色名稱
    getRoleName(role) {
        const roleNames = {
            'guest': '訪客',
            'student': '學生',
            'staff': '老師/館員'
        };
        return roleNames[role] || '未知';
    }

    // 顯示新增書籍模態框
    showAddBookModal() {
        if (!this.requireAdmin('新增館藏')) return;
        document.getElementById('add-book-modal').style.display = 'block';
        
        // 設定預設值
        document.getElementById('book-year').value = this.settings.defaultYear;
        document.getElementById('book-copies').value = this.settings.defaultCopies;
        
        // 清空表單
        document.getElementById('add-book-form').reset();
        
        // 重新設定預設值（因為reset會清空）
        document.getElementById('book-year').value = this.settings.defaultYear;
        document.getElementById('book-copies').value = this.settings.defaultCopies;
        const authorInput = document.getElementById('book-author');
        if (authorInput) authorInput.value = '';

        // 預填下一個書碼（仍可手動修改）
        const suggestedId = this.suggestNextBookId();
        const bookIdInput = document.getElementById('book-id');
        const bookPrefixSelect = document.getElementById('book-prefix');

        if (bookPrefixSelect) {
            const m = String(suggestedId || '').toUpperCase().match(/^([ABC])/);
            bookPrefixSelect.value = m ? m[1] : 'C';
        }
        if (bookIdInput && suggestedId) {
            bookIdInput.value = suggestedId;
        }

        if (suggestedId) {
            this.showToast(`已預填書碼 ${suggestedId}，可從此號開始編輯（可自行修改）`, 'info');
        }
        
        // 聚焦到書碼輸入框
        setTimeout(() => {
            document.getElementById('book-id').focus();
            if (document.getElementById('book-id')?.value) {
                document.getElementById('book-id').select();
            }
        }, 100);
        
        // 添加實時驗證
        this.setupAddBookValidation();
    }

    suggestNextBookId() {
        const genreFilter = document.getElementById('genre-filter')?.value;
        const prefixMap = { '繪本': 'A', '橋梁書': 'B', '文字書': 'C' };
        const prefix = prefixMap[genreFilter] || 'C';
        return this.generateNextBookId(prefix);
    }

    generateNextBookId(prefix) {
        const used = new Set();
        const existingNumbers = [];

        // 收集所有已使用的編號
        this.books.forEach(book => {
            if (book?.id) {
                const idStr = String(book.id).toUpperCase();
                if (idStr.startsWith(prefix)) {
                    const numPart = idStr.substring(prefix.length);
                    const num = parseInt(numPart, 10);
                    if (!isNaN(num)) {
                        used.add(idStr);
                        existingNumbers.push(num);
                    }
                }
            }
            if (Array.isArray(book?.bookIds)) {
                book.bookIds.forEach(id => {
                    if (id) {
                        const idStr = String(id).toUpperCase();
                        if (idStr.startsWith(prefix)) {
                            const numPart = idStr.substring(prefix.length);
                            const num = parseInt(numPart, 10);
                            if (!isNaN(num)) {
                                used.add(idStr);
                                existingNumbers.push(num);
                            }
                        }
                    }
                });
            }
        });

        // 如果沒有任何書籍，從 C0001 開始
        if (existingNumbers.length === 0) {
            return `${prefix}0001`;
        }

        // 找出最大編號
        const maxNumber = Math.max(...existingNumbers);
        
        // 生成所有可能的編號（從1到最大編號+1）
        for (let i = 1; i <= maxNumber + 1; i++) {
            const candidate = `${prefix}${String(i).padStart(4, '0')}`;
            if (!used.has(candidate)) {
                return candidate;
            }
        }

        // 如果都找不到，返回最大編號+1
        return `${prefix}${String(maxNumber + 1).padStart(4, '0')}`;
    }

    hasBookId(id) {
        const target = String(id || '').trim().toUpperCase();
        if (!target) return false;

        return this.books.some(book => {
            if (!book) return false;
            if (String(book.id || '').toUpperCase() === target) return true;
            if (Array.isArray(book.bookIds) && book.bookIds.some(x => String(x || '').toUpperCase() === target)) return true;
            return false;
        });
    }

    // 根據書名查找相同書籍
    findBookByTitle(title) {
        if (!title || typeof title !== 'string') return null;
        
        const normalizedTitle = title.trim().toLowerCase();
        
        // 尋找第一個匹配的書籍（忽略大小寫和前後空白）
        return this.books.find(book => {
            if (!book || !book.title) return false;
            return book.title.trim().toLowerCase() === normalizedTitle;
        });
    }

    // 測試書籍編號生成邏輯
    testBookIdGeneration() {
        console.log('=== 測試書籍編號生成邏輯 ===');
        
        // 測試 C 前綴
        const cResult = this.generateNextBookId('C');
        console.log(`C 前綴測試結果: ${cResult}`);
        
        // 測試 A 前綴
        const aResult = this.generateNextBookId('A');
        console.log(`A 前綴測試結果: ${aResult}`);
        
        // 測試 B 前綴
        const bResult = this.generateNextBookId('B');
        console.log(`B 前綴測試結果: ${bResult}`);
        
        // 測試不存在的 D 前綴
        const dResult = this.generateNextBookId('D');
        console.log(`D 前綴測試結果: ${dResult}`);
        
        // 顯示結果給用戶
        const results = `
            測試結果：
            C 前綴: ${cResult}
            A 前綴: ${aResult}
            B 前綴: ${bResult}
            D 前綴: ${dResult}
        `;
        
        this.showToast(results, 'info', 5000);
        
        return { cResult, aResult, bResult, dResult };
    }

    // 處理新增書籍
    handleAddBook(e) {
        e.preventDefault();

        try {
            const idEl = document.getElementById('book-id');
            const titleEl = document.getElementById('book-title');
            const authorEl = document.getElementById('book-author');
            const coverEl = document.getElementById('book-cover-url');
            const yearEl = document.getElementById('book-year');
            const copiesEl = document.getElementById('book-copies');

            if (!idEl || !titleEl || !yearEl || !copiesEl) {
                this.showToast('新增失敗：表單欄位不存在，請重新整理頁面', 'error');
                return;
            }

            const id = idEl.value.trim().toUpperCase();
            const title = titleEl.value.trim();
            const author = (authorEl?.value || '').trim();
            const coverUrl = (coverEl?.value || '').trim();
            const year = parseInt(yearEl.value) || this.settings.defaultYear;
            const copies = parseInt(copiesEl.value) || this.settings.defaultCopies;

            // 驗證書碼格式（支援全形和半形字符）
            if (!/^[ABC]\d+$/.test(id)) {
                this.showToast('書碼格式錯誤：請用 A/B/C + 數字（例：C0001）', 'error');
                return;
            }

            // 檢查重複書碼
            if (this.hasBookId(id)) {
                this.showToast('書碼已存在', 'error');
                return;
            }

            if (!title) {
                this.showToast('請輸入書名', 'error');
                return;
            }

            // 檢查是否有相同書名的書籍，如果有則自動套用資料
            const existingBook = this.findBookByTitle(title);
            if (existingBook) {
                // 自動套用重複書籍的資料
                if (!author && existingBook.author) {
                    author = existingBook.author;
                    if (authorEl) authorEl.value = author;
                }
                if (!coverUrl && existingBook.coverUrl) {
                    coverUrl = existingBook.coverUrl;
                    if (coverEl) coverEl.value = coverUrl;
                }
                if (year === this.settings.defaultYear && existingBook.year) {
                    year = existingBook.year;
                    if (yearEl) yearEl.value = year;
                }

                this.showToast(`偵測到相同書名，已自動套用書籍資料`, 'info');
            }

            // 讀取使用者輸入的系列書名稱
            const seriesEl = document.getElementById('book-series');
            const seriesName = (seriesEl?.value || '').trim();

            const genre = this.getGenreFromId(id);
            const newBook = {
                id,
                title,
                author,
                coverUrl,
                genre,
                year,
                copies,
                availableCopies: copies,
                isNew: true,
                addedAt: Date.now(),
                createdAt: new Date().toISOString()
            };

            // 如果使用者輸入了系列書名稱，就保存到書籍對象
            if (seriesName) {
                newBook.series = seriesName;
            }

            this.books.push(newBook);
            this.saveData();
            // 新增館藏後也自動同步到 Google Sheets
            this.triggerSyncForAction('addBook');
            
            // 更新書單版本，讓快取失效
            this.updateBookListVersion();
            
            this.renderBooks();
            this.updateStats();

            const modal = document.getElementById('add-book-modal');
            if (modal) modal.style.display = 'none';
            const form = document.getElementById('add-book-form');
            if (form) form.reset();

            this.showToast('書籍新增成功！', 'success');
        } catch (err) {
            console.error('handleAddBook error:', err);
            this.showToast(`新增失敗：${err?.message || err}`, 'error');
        }
    }

    // 設定新增書籍表單的實時驗證
    setupAddBookValidation() {
        const bookIdInput = document.getElementById('book-id');
        const bookTitleInput = document.getElementById('book-title');
        const bookPrefixSelect = document.getElementById('book-prefix');

        if (!bookIdInput || !bookTitleInput) return;

        if (bookPrefixSelect && !bookPrefixSelect.dataset.bound) {
            bookPrefixSelect.dataset.bound = '1';
            bookPrefixSelect.addEventListener('change', (e) => {
                const prefix = String(e.target.value || '').toUpperCase();
                if (!/^[ABC]$/.test(prefix)) return;
                const generated = this.generateNextBookId(prefix);
                if (bookIdInput) bookIdInput.value = generated;
                if (bookIdInput) bookIdInput.dispatchEvent(new Event('input'));
            });
        }
        
        // 書碼格式驗證
        if (!bookIdInput.dataset.bound) {
            bookIdInput.dataset.bound = '1';
            bookIdInput.addEventListener('input', (e) => {
            const value = e.target.value.trim();
            const upper = value.toUpperCase();

            if (/^[ABC]$/.test(upper)) {
                const generated = this.generateNextBookId(upper);
                e.target.value = generated;
            }

            if (bookPrefixSelect) {
                const m = String(e.target.value || '').toUpperCase().match(/^([ABC])/);
                if (m) bookPrefixSelect.value = m[1];
            }

            const currentValue = e.target.value.trim().toUpperCase();
            const isValid = /^[ABC]\d+$/.test(currentValue);
            
            if (currentValue && !isValid) {
                e.target.style.borderColor = '#f56565';
                this.showFieldError('book-id', '書碼格式：A/B/C + 數字');
            } else {
                e.target.style.borderColor = '#e2e8f0';
                this.hideFieldError('book-id');
            }

            if (/^[ABC]\d+$/.test(currentValue) && this.hasBookId(currentValue)) {
                e.target.style.borderColor = '#f56565';
                this.showFieldError('book-id', '書碼已存在');
            }
            });
        }
        
        // 書名驗證與重複檢查
        if (!bookTitleInput.dataset.bound) {
            bookTitleInput.dataset.bound = '1';
            bookTitleInput.addEventListener('input', (e) => {
            const value = e.target.value.trim();
            
            if (value.length === 0) {
                e.target.style.borderColor = '#f56565';
                this.showFieldError('book-title', '請輸入書名');
            } else {
                e.target.style.borderColor = '#e2e8f0';
                this.hideFieldError('book-title');
                
                // 檢查是否有相同書名的書籍
                const existingBook = this.findBookByTitle(value);
                if (existingBook) {
                    // 顯示找到相同書籍的提示
                    this.showFieldError('book-title', `找到相同書名，將自動套用作者、出版年份和封面資料`);
                    
                    // 自動填入作者（如果作者欄位為空）
                    const authorEl = document.getElementById('book-author');
                    if (authorEl && (!authorEl.value.trim() || authorEl.value.trim() === '')) {
                        authorEl.value = existingBook.author || '';
                    }
                    
                    // 自動填入出版年份（如果年份欄位為預設值）
                    const yearEl = document.getElementById('book-year');
                    if (yearEl && (!yearEl.value || parseInt(yearEl.value) === this.settings.defaultYear)) {
                        yearEl.value = existingBook.year || this.settings.defaultYear;
                    }
                    
                    // 自動填入封面網址（如果封面欄位為空）
                    const coverEl = document.getElementById('book-cover-url');
                    if (coverEl && (!coverEl.value.trim() || coverEl.value.trim() === '')) {
                        coverEl.value = existingBook.coverUrl || '';
                    }
                } else {
                    // 清除重複書籍提示
                    const errorDiv = bookTitleInput.parentNode.querySelector('.field-error');
                    if (errorDiv && errorDiv.textContent.includes('找到相同書名')) {
                        this.hideFieldError('book-title');
                    }
                }
            }
            });
        }
    }

    // 顯示欄位錯誤提示
    showFieldError(fieldId, message) {
        const field = document.getElementById(fieldId);
        let errorDiv = field.parentNode.querySelector('.field-error');
        
        if (!errorDiv) {
            errorDiv = document.createElement('div');
            errorDiv.className = 'field-error';
            field.parentNode.appendChild(errorDiv);
        }
        
        errorDiv.textContent = message;
        errorDiv.style.color = '#f56565';
        errorDiv.style.fontSize = '0.8rem';
        errorDiv.style.marginTop = '5px';
    }

    // 隱藏欄位錯誤提示
    hideFieldError(fieldId) {
        const field = document.getElementById(fieldId);
        const errorDiv = field.parentNode.querySelector('.field-error');
        
        if (errorDiv) {
            errorDiv.remove();
        }
    }

    // 從書碼取得類別
    getGenreFromId(id) {
        const firstChar = id.charAt(0).toUpperCase();
        const genreMap = {
            'A': '繪本',
            'B': '橋梁書',
            'C': '文字書'
        };
        return genreMap[firstChar] || '未知';
    }

    // 智能書名排序：讓相似書名聚集在一起
    smartTitleSort(titleA, titleB, sortOrder) {
        // 提取書名的主要部分（去除數字、括號等）
        const cleanTitleA = this.cleanTitle(titleA);
        const cleanTitleB = this.cleanTitle(titleB);
        
        // 先按清理後的書名排序
        const cleanCompare = cleanTitleA.localeCompare(cleanTitleB, 'zh-TW');
        
        if (cleanCompare !== 0) {
            return sortOrder === 'asc' ? cleanCompare : -cleanCompare;
        }
        
        // 如果清理後的書名相同，則按完整書名排序
        const fullCompare = titleA.localeCompare(titleB, 'zh-TW');
        return sortOrder === 'asc' ? fullCompare : -fullCompare;
    }

    // 清理書名：移除數字、括號等，保留主要書名
    cleanTitle(title) {
        // 移除常見的後綴模式
        return title
            .replace(/[（(].*?[）)]/g, '') // 移除括號內容
            .replace(/\d+.*$/g, '') // 移除末尾的數字
            .replace(/[第].*?[卷冊部集]/g, '') // 移除第X卷/冊/部/集
            .replace(/[上下中].*$/g, '') // 移除上/下/中
            .replace(/[全].*$/g, '') // 移除全
            .replace(/[一二三四五六七八九十百千萬]+/g, '') // 移除中文數字
            .replace(/[IVXLC]+/g, '') // 移除羅馬數字
            .trim();
    }

    getSeriesKey(title) {
        const s = String(title || '')
            .replace(/[（(【\[].*?[）)】\]]/g, ' ')
            .replace(/第\s*[0-9０-９一二三四五六七八九十百千萬IVXLCivxlc]+\s*[卷冊部集篇回話章]/g, ' ')
            .replace(/\b(?:vol|volume)\.?\s*[0-9０-９]+\b/gi, ' ')
            .replace(/[0-9０-９]+\s*[卷冊部集篇回話章]/g, ' ')
            .replace(/\b[IVXLC]+\b/gi, ' ')
            .replace(/\b[0-9０-９]+\b/g, ' ')
            .replace(/[一二三四五六七八九十百千萬]+/g, ' ')
            .replace(/\b(上|中|下|前|後|續|終|全)\b/g, ' ')
            .replace(/[：:，,。．·・\-—_~～]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return s;
    }

    // 排序書籍，讓同系列書籍排在一起
    sortBooksWithSeries(books, sortOrder = 'asc') {
        // 為每本書添加清理後的書名和系列標記
        const booksWithSeriesInfo = books.map(book => ({
            ...book,
            cleanTitle: this.cleanTitle(book.title),
            seriesKey: this.getSeriesKey(book.title),
            hasSeriesMarkers: /[（(].*?[）)]|\d+.*$|[第].*?[卷冊部集]|[上下中].*$|[全].*$/.test(book.title)
        }));
        
        // 按系列分組
        const seriesMap = new Map();
        const standaloneBooks = [];
        
        booksWithSeriesInfo.forEach(book => {
            const key = (book.seriesKey || '').trim();
            const groupKey = key.length >= 2 ? key : '';

            if (groupKey) {
                if (!seriesMap.has(groupKey)) {
                    seriesMap.set(groupKey, []);
                }
                seriesMap.get(groupKey).push(book);
            } else {
                standaloneBooks.push(book);
            }
        });
        
        const sortedBooks = [];
        
        // 處理系列書籍（至少2本才算系列）
        seriesMap.forEach((seriesBooks, seriesName) => {
            if (seriesBooks.length >= 2) {
                // 系列內書籍排序：嘗試把系列「第一本」放在最前面
                // 1) 若書名含數字（例如卷/冊/號），依數字升冪排序（1、2、3...），
                // 2) 否則若有 createdAt（或 addedAt）欄位，依時間升冪排序（較早的在前），
                // 3) 最後退回到書名排序
                seriesBooks.sort((a, b) => {
                    // 嘗試從書名擷取數字索引
                    const extractIndex = (title) => {
                        if (!title) return NaN;
                        const m = String(title).match(/(\d{1,4})/);
                        if (m) return parseInt(m[1], 10);
                        return NaN;
                    };

                    const aIdx = extractIndex(a.title);
                    const bIdx = extractIndex(b.title);
                    if (!Number.isNaN(aIdx) && !Number.isNaN(bIdx)) {
                        if (aIdx !== bIdx) return aIdx - bIdx; // 升冪，第一冊 (1) 在前
                    }

                    // 若無明確數字索引，使用 createdAt/addedAt 升冪（較早的視為第一本）
                    const aTime = new Date(a.createdAt || a.addedAt || 0).getTime();
                    const bTime = new Date(b.createdAt || b.addedAt || 0).getTime();
                    if (aTime && bTime && aTime !== bTime) {
                        return aTime - bTime; // 較早的在前
                    }

                    // 最後依書名排序
                    return this.smartTitleSort(a.title, b.title, sortOrder);
                });
                sortedBooks.push(...seriesBooks);
            } else {
                // 單本書籍加入獨立書籍
                standaloneBooks.push(...seriesBooks);
            }
        });

        // 獨立書籍排序：優先考慮新書，然後按書名排序
        standaloneBooks.sort((a, b) => {
            // 優先處理新書：最近新增的書籍放在最前面
            const aAddedAt = Number(a.addedAt) || 0;
            const bAddedAt = Number(b.addedAt) || 0;
            const aIsNew = !!a.isNew && aAddedAt > 0;
            const bIsNew = !!b.isNew && bAddedAt > 0;
            
            // 如果其中一本是新書，按 addedAt 降序排列（最新的在前）
            if (aIsNew || bIsNew) {
                if (aIsNew && !bIsNew) return -1; // a 是新書，排在前面
                if (!aIsNew && bIsNew) return 1;  // b 是新書，排在前面
                // 兩本都是新書，按 addedAt 降序排列
                return bAddedAt - aAddedAt;
            }
            
            // 如果都不是新書，或者 addedAt 相同，則按書名排序
            return this.smartTitleSort(a.title, b.title, sortOrder);
        });
        
        sortedBooks.push(...standaloneBooks);
        
        return sortedBooks;
    }

    // 匯入書籍
    importBooks(event) {
        if (!this.requireAdmin('匯入 Excel 書單')) return;
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

                this.processImportData(jsonData);
            } catch (error) {
                this.showToast('檔案格式錯誤', 'error');
                console.error('Import error:', error);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    // 處理匯入資料
    processImportData(data) {
        let successCount = 0;
        let errorCount = 0;
        const errors = [];

        // 跳過標題行，從第二行開始處理
        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            if (!row || row.length === 0 || !row[0]) continue;

            const id = row[0].toString().trim();
            const title = row[1] ? row[1].toString().trim() : '';
            const copies = row[2] ? parseInt(row[2]) : this.settings.defaultCopies;

            // 驗證書碼格式
            if (!/^[ABC]\d+$/.test(id)) {
                errors.push(`第${i+1}行：書碼格式錯誤 (${id})`);
                errorCount++;
                continue;
            }

            // 檢查重複書碼
            if (this.books.find(book => book.id === id)) {
                errors.push(`第${i+1}行：書碼重複 (${id})`);
                errorCount++;
                continue;
            }

            if (!title) {
                errors.push(`第${i+1}行：缺少書名`);
                errorCount++;
                continue;
            }

            const genre = this.getGenreFromId(id);
            const year = this.settings.defaultYear;

            const newBook = {
                id,
                title,
                genre,
                year,
                copies: copies || this.settings.defaultCopies,
                availableCopies: copies || this.settings.defaultCopies,
                createdAt: new Date().toISOString()
            };

            this.books.push(newBook);
            successCount++;
        }

        this.saveData();
        this.renderBooks();
        this.updateStats();

        if (successCount > 0) {
            this.showToast(`成功匯入 ${successCount} 本書籍`, 'success');
        }
        if (errorCount > 0) {
            this.showToast(`有 ${errorCount} 筆資料匯入失敗`, 'warning');
            console.log('Import errors:', errors);
        }
    }

    // 借閱書籍
    async borrowBook(bookId) {
        console.log('借閱按鈕被點擊，書碼:', bookId);
        console.log('當前使用者:', this.currentUser);
        
        if (!this.currentUser) {
            this.showToast('請先登入', 'error');
            return;
        }

        const clickedBook = this.books.find(b => b.id === bookId);
        if (!clickedBook) {
            this.showToast('書籍不存在', 'error');
            return;
        }

        // 若同書名存在多筆（合併顯示/多個書碼），讓使用者選擇要借哪個書碼
        const normalizedTitle = this.normalizeTitle(clickedBook.title);
        const sameTitleBooks = this.books.filter(b => this.normalizeTitle(b.title) === normalizedTitle);

        let selectedBook = clickedBook;
        if (sameTitleBooks.length > 1) {
            const availableCandidates = sameTitleBooks
                .map(b => ({
                    book: b,
                    available: Number(b.availableCopies) || 0,
                    total: Number(b.copies) || 1
                }))
                .filter(x => x.available > 0);

            if (availableCandidates.length === 0) {
                this.showToast('此書籍已全部借出', 'error');
                return;
            }

            const choice = await this.showSelectionModal({
                title: '選擇要借閱的書碼',
                message: '此書名有多個書碼，請點選要借閱的號碼',
                options: availableCandidates.map(x => ({
                    value: x.book.id,
                    image: x.book.coverUrl || '',
                    title: x.book.title,
                    code: x.book.id,
                    available: x.available,
                    total: x.total
                }))
            });

            if (!choice) return;
            const picked = availableCandidates.find(x => x.book.id === choice);
            if (!picked) {
                this.showToast('選擇的借閱號碼無效', 'error');
                return;
            }
            selectedBook = picked.book;
        }

        const book = selectedBook;

        if (book.availableCopies <= 0) {
            this.showToast('此書籍已全部借出', 'error');
            return;
        }

        // 允許同一使用者借多本（若館藏有多本），但最多不超過該書總冊數
        const userBorrowedCount = this.borrowedBooks.filter(
            b => b.bookId === book.id && b.userId === this.currentUser.username && !b.returnedAt
        ).length;

        if (userBorrowedCount >= (book.copies || 1)) {
            this.showToast('您已借滿此書所有冊數', 'error');
            return;
        }

        // 若此書碼有多冊，讓借閱人選擇要借第幾冊
        let copyNo = null;
        const totalCopies = Number(book.copies) || 1;
        if (totalCopies > 1) {
            const usedCopyNos = new Set(
                this.borrowedBooks
                    .filter(b => b.bookId === book.id && !b.returnedAt && Number.isFinite(Number(b.copyNo)))
                    .map(b => Number(b.copyNo))
            );

            const availableCopyNos = [];
            for (let i = 1; i <= totalCopies; i++) {
                if (!usedCopyNos.has(i)) availableCopyNos.push(i);
            }

            if (availableCopyNos.length === 0) {
                this.showToast('此書籍已全部借出', 'error');
                return;
            }

            if (availableCopyNos.length === 1) {
                copyNo = availableCopyNos[0];
            } else {
                const chosen = await this.showSelectionModal({
                    title: '選擇要借閱的冊號',
                    message: '此書有多冊，請點選要借閱的冊號',
                    options: availableCopyNos.map(n => ({
                        value: n,
                        image: book.coverUrl || '',
                        title: book.title,
                        code: `${book.id} - 第 ${n} 冊`,
                        available: 1,
                        total: totalCopies
                    }))
                });

                if (chosen === null) return;
                if (!availableCopyNos.includes(Number(chosen))) {
                    this.showToast('選擇的冊號無效', 'error');
                    return;
                }
                copyNo = Number(chosen);
            }
        }

        const borrowDate = new Date();
        const loanDays = this.getLoanDaysForUser(this.currentUser.username);
        const dueDate = new Date(borrowDate.getTime() + loanDays * 24 * 60 * 60 * 1000);

        const borrowRecord = {
            id: Date.now().toString(),
            bookId: book.id,
            bookTitle: book.title,
            userId: this.currentUser.username,
            borrowDate: borrowDate.toISOString(),
            dueDate: dueDate.toISOString(),
            loanDays,
            copyNo,
            returnedAt: null
        };

        this.borrowedBooks.push(borrowRecord);
        book.availableCopies--;

        this.saveData();
        // 借閱不觸發館藏同步（僅保留本機變更）
        this.triggerSyncForAction('borrow');
        this.renderBooks();
        this.renderBorrowedBooks();
        this.updateStats();
        this.showToast('借閱成功！', 'success');
    }

    // 歸還書籍
    returnBook(borrowId) {
        const borrowRecord = this.borrowedBooks.find(b => b.id === borrowId);
        if (!borrowRecord) {
            this.showToast('借閱記錄不存在', 'error');
            return;
        }

        if (borrowRecord.returnedAt) {
            this.showToast('此書籍已歸還', 'error');
            return;
        }

        borrowRecord.returnedAt = new Date().toISOString();
        
        const book = this.books.find(b => b.id === borrowRecord.bookId);
        if (book) {
            book.availableCopies++;
        }

        this.saveData();
        // 歸還不觸發館藏同步
        this.triggerSyncForAction('return');
        this.renderBooks();
        this.renderBorrowedBooks();
        this.updateStats();
        this.showToast('歸還成功！', 'success');
    }

    // 判斷封面網址是否允許（避免熱鏈被擋的網域導致錯誤）
    isAllowedCoverUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const u = new URL(url);
            const blockedHosts = new Set([
                'tse1.mm.bing.net',
                'tse2.mm.bing.net',
                'tse3.mm.bing.net',
                'tse4.mm.bing.net',
                'tse1.explicit.bing.net',
                'tshop.r10s.com',
                'system.chc.edu.tw'
            ]);
            return !blockedHosts.has(u.hostname);
        } catch (_) {
            return false;
        }
    }

    // 渲染書籍列表
    renderBooks() {
        console.log('開始渲染書籍，當前書籍數量:', this.books.length);
        const container = document.getElementById('books-container');
        const rawSearchTerm = document.getElementById('search-input')?.value || '';
        const normalizedSearchTerm = (rawSearchTerm || '').trim();
        const searchTerm = normalizedSearchTerm.toLowerCase();
        const genreFilter = document.getElementById('genre-filter').value;
        const sortBy = document.getElementById('sort-by').value;
        const sortOrder = document.getElementById('sort-order').value;

        // 重置虛擬滾動狀態
        this.virtualScrollState = {
            loadedCount: 0,
            batchSize: 50,
            isLoading: false
        };

        // 書碼精準搜尋：支援多個書碼（逗號/空白分隔）
        const codeTokens = (normalizedSearchTerm || '')
            .toUpperCase()
            .split(/[\s,，]+/)
            .map(s => s.trim())
            .filter(Boolean);
        const isCodeSearch = codeTokens.length > 0 && codeTokens.every(t => /^[ABC]\d+$/.test(t));

        let filteredBooks = this.books.filter(book => {
            let matchesSearch;

            if (!searchTerm) {
                matchesSearch = true;
            } else if (isCodeSearch) {
                const mainId = String(book.id || '').toUpperCase();
                const allIds = Array.isArray(book.bookIds)
                    ? book.bookIds.map(id => String(id || '').toUpperCase())
                    : [];
                matchesSearch = codeTokens.some(code => code === mainId || allIds.includes(code));
            } else {
                matchesSearch =
                    String(book.title || '').toLowerCase().includes(searchTerm) ||
                    String(book.author || '').toLowerCase().includes(searchTerm) ||
                    String(book.id || '').toLowerCase().includes(searchTerm) ||
                    (book.bookIds && book.bookIds.some(id => String(id || '').toLowerCase().includes(searchTerm))) ||
                    String(book.year ?? '').toLowerCase().includes(searchTerm) ||
                    String(book.genre || '').toLowerCase().includes(searchTerm);
            }
            
            const matchesGenre = !genreFilter || this.matchesBookGenre(book, genreFilter);
            
            return matchesSearch && matchesGenre;
        });

        // 注意：排序要在「合併」後再套用，避免合併後順序被打亂

        if (filteredBooks.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-book-open"></i>
                    <h3>沒有找到書籍</h3>
                    <p>請嘗試調整搜尋條件或新增書籍</p>
                    <div class="empty-state-actions">
                        <button class="btn btn-primary" onclick="library.searchBookInfo('${searchTerm}')">
                            <i class="fas fa-search"></i> 搜尋書籍資訊
                        </button>
                        ${this.isAdminUser() ? `
                        <button class="btn btn-info" onclick="library.showAddBookModal()">
                            <i class="fas fa-plus"></i> 新增書籍
                        </button>` : ''}
                    </div>
                </div>
            `;
            return;
        }

        const isGridView = document.getElementById('grid-view').classList.contains('active');
        container.className = isGridView ? 'books-grid' : 'books-list';
        
        // 合併相同書名的書籍
        const mergedBooks = this.mergeBooksByTitle(filteredBooks);

        // 合併後排序
        mergedBooks.sort((a, b) => {
            // 優先按 createdAt 降序排列（最新的在前）
            const timeA = new Date(a.createdAt || a.addedAt || 0).getTime();
            const timeB = new Date(b.createdAt || b.addedAt || 0).getTime();
            if (timeA !== timeB) {
                return timeB - timeA;
            }

            // 如果 createdAt 相同，則按原來的排序邏輯
            if (sortBy === 'code') {
                const aCode = String(a.id || '').toUpperCase();
                const bCode = String(b.id || '').toUpperCase();
                const aMatch = aCode.match(/^([ABC])(\d+)$/);
                const bMatch = bCode.match(/^([ABC])(\d+)$/);

                if (aMatch && bMatch) {
                    const [, aLetter, aNumStr] = aMatch;
                    const [, bLetter, bNumStr] = bMatch;

                    if (aLetter !== bLetter) {
                        return sortOrder === 'asc'
                            ? aLetter.localeCompare(bLetter)
                            : bLetter.localeCompare(aLetter);
                    }

                    const aNum = parseInt(aNumStr, 10);
                    const bNum = parseInt(bNumStr, 10);
                    if (!isNaN(aNum) && !isNaN(bNum)) {
                        return sortOrder === 'asc' ? aNum - bNum : bNum - aNum;
                    }
                    return sortOrder === 'asc'
                        ? aNumStr.localeCompare(bNumStr)
                        : bNumStr.localeCompare(aNumStr);
                }

                return sortOrder === 'asc'
                    ? aCode.localeCompare(bCode)
                    : bCode.localeCompare(aCode);
            }

            // 其他排序方式：首先按類別分組
            const genreOrder = ['繪本', '橋梁書', '文字書'];
            const aGenreIndex = genreOrder.indexOf(a.genre);
            const bGenreIndex = genreOrder.indexOf(b.genre);
            if (aGenreIndex !== bGenreIndex) {
                return aGenreIndex - bGenreIndex;
            }

            // 然後按主要排序條件排序
            let aVal = a[sortBy];
            let bVal = b[sortBy];
            if (sortBy === 'year') {
                aVal = parseInt(aVal);
                bVal = parseInt(bVal);
            } else if (sortBy === 'title') {
                return this.smartTitleSort(a.title, b.title, sortOrder);
            } else {
                aVal = aVal.toString().toLowerCase();
                bVal = bVal.toString().toLowerCase();
            }

            if (sortOrder === 'asc') {
                return aVal > bVal ? 1 : -1;
            }
            return aVal < bVal ? 1 : -1;
        });

        // 所有排序方式都做系列分組，讓同一系列的書整理在一起
        const sortedBooks = this.sortBooksWithSeries(mergedBooks, sortOrder);

        // 按系列分組顯示
        const groupedBooks = this.groupBooksBySeries(sortedBooks);
        const seriesNames = Object.keys(groupedBooks);

        // 分成系列書和單本書兩個區塊
        // 邏輯：
        // 1. 如果書籍有顯式 series 屬性，顯示為系列書
        // 2. 如果書籍沒有 series 屬性，顯示為單本書
        const seriesBooks = [];
        const standaloneBooks = [];

        seriesNames.forEach(seriesName => {
            const seriesBooksList = groupedBooks[seriesName];

            // 如果系列名稱是「單本書」，則全部歸類為單本書
            if (seriesName === '單本書') {
                standaloneBooks.push(...seriesBooksList);
            } else {
                // 有 series 屬性的書歸類為系列書
                seriesBooks.push({ seriesName, books: seriesBooksList });
            }
        });

        // 生成 HTML
        let html = '';

        // 根據當前分頁顯示對應內容
        if (this.currentBookType === 'series') {
            // 系列書區塊
            if (seriesBooks.length > 0) {
                html += seriesBooks.map(({ seriesName, books: seriesBooksList }, index) => {
                    const totalBooks = seriesBooksList.length;
                    const latestBook = seriesBooksList[0]; // 已經按系列順序，第一本為系列第一本
                    const seriesId = `series-${index}`; // 使用索引避免特殊字符問題

                    const originalIndex = this.books.findIndex(b => b.id === latestBook.id);
                    const isLegacy = originalIndex >= 0 && originalIndex < 1493;

                    return `
                        <div class="series-section">
                            <div class="series-header" onclick="library.toggleSeries('${seriesId}')">
                                <h3 class="series-title">
                                    <i class="fas fa-chevron-down series-toggle-icon" id="${seriesId}-icon"></i>
                                    ${this.escapeHtml(seriesName)}
                                    <span class="series-count">（${totalBooks} 本）</span>
                                </h3>
                            </div>
                            <div class="series-actions">
                                <button class="btn btn-outline btn-sm series-expand-btn" onclick="library.toggleSeries('${seriesId}')">
                                    展開全部 ${totalBooks} 本
                                </button>
                            </div>
                            <div class="series-books books-grid" id="${seriesId}">
                                ${this.createBookCard(latestBook, isLegacy)}
                                <div class="series-more-books" id="${seriesId}-more" style="display: none;">
                                    ${seriesBooksList.slice(1).map(book => {
                                        const idx = this.books.findIndex(b => b.id === book.id);
                                        const legacy = idx >= 0 && idx < 1493;
                                        return this.createBookCard(book, legacy);
                                    }).join('')}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                html += '<div class="empty-state"><i class="fas fa-layer-group"></i><h3>沒有系列書</h3><p>目前沒有符合條件的系列書籍</p></div>';
            }
        } else {
            // 單本書區塊
            if (standaloneBooks.length > 0) {
                const gridClass = isGridView ? 'books-grid' : 'books-list';
                html += `<div class="${gridClass}" id="standalone-books-grid">`;
                // 只渲染前 batchSize 本書
                const booksToRender = standaloneBooks.slice(0, this.virtualScrollState.batchSize);
                this.virtualScrollState.loadedCount = booksToRender.length;
                html += booksToRender.map(book => {
                    const originalIndex = this.books.findIndex(b => b.id === book.id);
                    const isLegacy = originalIndex >= 0 && originalIndex < 1493;
                    return this.createBookCard(book, isLegacy);
                }).join('');
                html += '</div>';

                // 如果還有更多書籍，顯示「加載更多」按鈕
                if (standaloneBooks.length > this.virtualScrollState.loadedCount) {
                    html += `
                        <div class="load-more-container" style="text-align: center; padding: 20px;">
                            <button class="btn btn-primary" id="load-more-btn" onclick="library.loadMoreBooks()">
                                <i class="fas fa-plus"></i> 加載更多（還有 ${standaloneBooks.length - this.virtualScrollState.loadedCount} 本）
                            </button>
                        </div>
                    `;
                }
            } else {
                html += '<div class="empty-state"><i class="fas fa-book"></i><h3>沒有單本書</h3><p>目前沒有符合條件的單本書籍</p></div>';
            }
        }

        container.innerHTML = html;
    }

    // 加載更多書籍
    loadMoreBooks() {
        if (this.virtualScrollState.isLoading) return;
        this.virtualScrollState.isLoading = true;

        const container = document.getElementById('standalone-books-grid');
        const loadMoreBtn = document.getElementById('load-more-btn');

        if (!container || !loadMoreBtn) {
            this.virtualScrollState.isLoading = false;
            return;
        }

        // 獲取當前的篩選條件
        const rawSearchTerm = document.getElementById('search-input')?.value || '';
        const normalizedSearchTerm = (rawSearchTerm || '').trim();
        const searchTerm = normalizedSearchTerm.toLowerCase();
        const genreFilter = document.getElementById('genre-filter').value;
        const sortBy = document.getElementById('sort-by').value;
        const sortOrder = document.getElementById('sort-order').value;

        // 書碼精準搜尋
        const codeTokens = (normalizedSearchTerm || '')
            .toUpperCase()
            .split(/[\s,，]+/)
            .map(s => s.trim())
            .filter(Boolean);
        const isCodeSearch = codeTokens.length > 0 && codeTokens.every(t => /^[ABC]\d+$/.test(t));

        let filteredBooks = this.books.filter(book => {
            let matchesSearch;

            if (!searchTerm) {
                matchesSearch = true;
            } else if (isCodeSearch) {
                const mainId = String(book.id || '').toUpperCase();
                const allIds = Array.isArray(book.bookIds)
                    ? book.bookIds.map(id => String(id || '').toUpperCase())
                    : [];
                matchesSearch = codeTokens.some(code => code === mainId || allIds.includes(code));
            } else {
                matchesSearch =
                    String(book.title || '').toLowerCase().includes(searchTerm) ||
                    String(book.author || '').toLowerCase().includes(searchTerm) ||
                    String(book.id || '').toLowerCase().includes(searchTerm) ||
                    (book.bookIds && book.bookIds.some(id => String(id || '').toLowerCase().includes(searchTerm))) ||
                    String(book.year ?? '').toLowerCase().includes(searchTerm) ||
                    String(book.genre || '').toLowerCase().includes(searchTerm);
            }

            const matchesGenre = !genreFilter || this.matchesBookGenre(book, genreFilter);

            return matchesSearch && matchesGenre;
        });

        // 合併相同書名的書籍
        const mergedBooks = this.mergeBooksByTitle(filteredBooks);

        // 合併後排序
        mergedBooks.sort((a, b) => {
            const timeA = new Date(a.createdAt || a.addedAt || 0).getTime();
            const timeB = new Date(b.createdAt || b.addedAt || 0).getTime();
            if (timeA !== timeB) {
                return timeB - timeA;
            }

            if (sortBy === 'code') {
                const aCode = String(a.id || '').toUpperCase();
                const bCode = String(b.id || '').toUpperCase();
                const aMatch = aCode.match(/^([ABC])(\d+)$/);
                const bMatch = bCode.match(/^([ABC])(\d+)$/);

                if (aMatch && bMatch) {
                    const [, aLetter, aNumStr] = aMatch;
                    const [, bLetter, bNumStr] = bMatch;

                    if (aLetter !== bLetter) {
                        return sortOrder === 'asc'
                            ? aLetter.localeCompare(bLetter)
                            : bLetter.localeCompare(aLetter);
                    }

                    const aNum = parseInt(aNumStr, 10);
                    const bNum = parseInt(bNumStr, 10);
                    if (!isNaN(aNum) && !isNaN(bNum)) {
                        return sortOrder === 'asc' ? aNum - bNum : bNum - aNum;
                    }
                    return sortOrder === 'asc'
                        ? aNumStr.localeCompare(bNumStr)
                        : bNumStr.localeCompare(aNumStr);
                }

                return sortOrder === 'asc'
                    ? aCode.localeCompare(bCode)
                    : bCode.localeCompare(aCode);
            }

            const genreOrder = ['繪本', '橋梁書', '文字書'];
            const aGenreIndex = genreOrder.indexOf(a.genre);
            const bGenreIndex = genreOrder.indexOf(b.genre);
            if (aGenreIndex !== bGenreIndex) {
                return aGenreIndex - bGenreIndex;
            }

            let aVal = a[sortBy];
            let bVal = b[sortBy];
            if (sortBy === 'year') {
                aVal = parseInt(aVal);
                bVal = parseInt(bVal);
            } else if (sortBy === 'title') {
                return this.smartTitleSort(a.title, b.title, sortOrder);
            } else {
                aVal = aVal.toString().toLowerCase();
                bVal = bVal.toString().toLowerCase();
            }

            if (sortOrder === 'asc') {
                return aVal > bVal ? 1 : -1;
            }
            return aVal < bVal ? 1 : -1;
        });

        // 按系列分組顯示
        const sortedBooks = this.sortBooksWithSeries(mergedBooks, sortOrder);
        const groupedBooks = this.groupBooksBySeries(sortedBooks);
        const seriesNames = Object.keys(groupedBooks);

        // 分成系列書和單本書兩個區塊
        const seriesBooks = [];
        const standaloneBooks = [];

        seriesNames.forEach(seriesName => {
            const seriesBooksList = groupedBooks[seriesName];

            if (seriesName === '單本書') {
                standaloneBooks.push(...seriesBooksList);
            } else {
                seriesBooks.push({ seriesName, books: seriesBooksList });
            }
        });

        // 加載下一批書籍
        const nextBatch = standaloneBooks.slice(
            this.virtualScrollState.loadedCount,
            this.virtualScrollState.loadedCount + this.virtualScrollState.batchSize
        );

        if (nextBatch.length === 0) {
            loadMoreBtn.remove();
            this.virtualScrollState.isLoading = false;
            return;
        }

        // 追加新書籍到容器
        const newBooksHtml = nextBatch.map(book => {
            const originalIndex = this.books.findIndex(b => b.id === book.id);
            const isLegacy = originalIndex >= 0 && originalIndex < 1493;
            return this.createBookCard(book, isLegacy);
        }).join('');

        container.insertAdjacentHTML('beforeend', newBooksHtml);

        // 更新已加載數量
        this.virtualScrollState.loadedCount += nextBatch.length;

        // 更新或移除按鈕
        if (standaloneBooks.length > this.virtualScrollState.loadedCount) {
            loadMoreBtn.innerHTML = `<i class="fas fa-plus"></i> 加載更多（還有 ${standaloneBooks.length - this.virtualScrollState.loadedCount} 本）`;
        } else {
            loadMoreBtn.remove();
        }

        this.virtualScrollState.isLoading = false;
    }

    // 切換系列展開/收合
    toggleSeries(seriesId) {
        const moreBooks = document.getElementById(`${seriesId}-more`);
        const icon = document.getElementById(`${seriesId}-icon`);
        const btn = document.querySelector(`.series-expand-btn`);

        if (moreBooks.style.display === 'none') {
            moreBooks.style.display = 'flex';
            icon.className = 'fas fa-chevron-down series-toggle-icon';
            btn.textContent = `收起`;
        } else {
            moreBooks.style.display = 'none';
            icon.className = 'fas fa-chevron-right series-toggle-icon';
            btn.textContent = `展開全部`;
        }
    }

    // 切換書籍類型分頁（系列書/單本書）
    switchBookType(type) {
        this.currentBookType = type;

        // 更新按鈕狀態
        document.getElementById('tab-series').classList.toggle('active', type === 'series');
        document.getElementById('tab-standalone').classList.toggle('active', type === 'standalone');

        // 重新渲染書籍列表
        this.renderBooks();
    }

    // 合併相同書名的書籍
    mergeBooksByTitle(books) {
        const titleMap = new Map();
        
        books.forEach(book => {
            const normalizedTitle = this.normalizeTitle(book.title);
            
            if (!titleMap.has(normalizedTitle)) {
                // 創建合併後的書籍對象
                const mergedBook = {
                    ...book,
                    bookIds: [book.id],
                    mergedBooks: [book],
                    totalCopies: book.copies || 1,
                    totalAvailableCopies: book.availableCopies || 0,
                    // 新書標記：合併卡片沿用最新 addedAt
                    isNew: !!book.isNew,
                    addedAt: book.addedAt || null
                };
                titleMap.set(normalizedTitle, mergedBook);
            } else {
                // 合併到現有的書籍
                const existingBook = titleMap.get(normalizedTitle);
                existingBook.bookIds.push(book.id);
                existingBook.mergedBooks.push(book);
                existingBook.totalCopies += (book.copies || 1);
                existingBook.totalAvailableCopies += (book.availableCopies || 0);

                // 新書標記：只要其中一本是新書就標記；addedAt 取最新
                if (book.isNew) existingBook.isNew = true;
                const existingAddedAt = existingBook.addedAt || 0;
                const nextAddedAt = book.addedAt || 0;
                if (nextAddedAt > existingAddedAt) existingBook.addedAt = nextAddedAt;
                
                // 更新主要資訊（使用第一本書的資訊）
                if (!existingBook.author && book.author) {
                    existingBook.author = book.author;
                }
                if (!existingBook.coverUrl && book.coverUrl) {
                    existingBook.coverUrl = book.coverUrl;
                }
                if (!existingBook.year && book.year) {
                    existingBook.year = book.year;
                }
            }
        });
        
        return Array.from(titleMap.values());
    }

    // 標準化書名（用於比較）
    normalizeTitle(title) {
        if (!title) return '';
        return title
            .toLowerCase()
            .trim()
            .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, '') // 保留中文、英文、數字和空格
            .replace(/\s+/g, ' ') // 合併多個空格
            .trim();
    }

    // 根據書編號自動分類匹配
    matchesBookGenre(book, genreFilter) {
        // 以主書碼 book.id 的前綴為準，避免合併書卡因含其他前綴而被放行
        const mainCode = String(book.id || '').toUpperCase();
        const mainMatch = mainCode.match(/^([ABC])(\d+)$/);
        if (mainMatch) {
            const prefix = mainMatch[1];
            switch (prefix) {
                case 'A':
                    return genreFilter === '繪本';
                case 'B':
                    return genreFilter === '橋梁書';
                case 'C':
                    return genreFilter === '文字書';
                default:
                    return false;
            }
        }

        // 主書碼不合法時，才回退檢查 bookIds（例如舊資料/合併資料）
        const allCodes = Array.isArray(book.bookIds)
            ? book.bookIds.map(v => String(v || '').toUpperCase()).filter(Boolean)
            : [];

        const prefixes = allCodes
            .map(code => code.match(/^([ABC])(\d+)$/))
            .filter(Boolean)
            .map(m => m[1]);

        if (prefixes.length > 0) {
            return prefixes.some(prefix => {
                switch (prefix) {
                    case 'A':
                        return genreFilter === '繪本';
                    case 'B':
                        return genreFilter === '橋梁書';
                    case 'C':
                        return genreFilter === '文字書';
                    default:
                        return false;
                }
            });
        }

        // 如果書碼格式都不正確，最後才使用原有類別判斷
        return book.genre === genreFilter;
    }

    // 判斷是否為國小四年級適合的書籍
    isElementaryGrade4Book(book, genreFilter) {
        // 如果已設定類別，直接檢查
        if (book.genre) {
            return book.genre === genreFilter;
        }

        // 根據書名和作者判斷是否適合國小四年級
        const title = String(book.title || '').toLowerCase();
        const author = String(book.author || '').toLowerCase();
        const year = parseInt(book.year) || 0;
        
        // 適合國小四年級的類別
        const suitableGenres = ['橋梁書', '童話', '冒險', '科普', '傳記', '歷史', '文學'];
        
        // 檢查是否在適合的類別中
        if (suitableGenres.includes(genreFilter)) {
            return true;
        }
        
        // 根據書名關鍵字判斷
        const grade4Keywords = [
            '小學', '國小', '四年級', '童話', '故事', '冒險', 
            '科學', '自然', '歷史', '地理', '傳記', '神話',
            '寓言', '成語', '古詩', '經典', '名著', '兒童'
        ];
        
        const hasGrade4Keyword = grade4Keywords.some(keyword => 
            title.includes(keyword) || author.includes(keyword)
        );
        
        if (hasGrade4Keyword) {
            return true;
        }
        
        // 根據出版年份判斷（較新的書籍通常更適合）
        if (year >= 2000 && suitableGenres.includes(genreFilter)) {
            return true;
        }
        
        return false;
    }

    // 從編輯模態框搜尋書籍資訊
    searchBookInfoFromEdit() {
        const titleInput = document.getElementById('edit-book-title');
        const searchTerm = titleInput.value.trim();
        
        if (!searchTerm) {
            this.showToast('請先輸入書名再進行搜尋', 'warning');
            titleInput.focus();
            return;
        }

        // 直接顯示多選搜尋選項
        this.showMultiSearchOptions(searchTerm);
    }

    // 建立書籍卡片
    createBookCard(book) {
        // 判斷是否為合併書籍
        const isMerged = book.mergedBooks && book.mergedBooks.length > 1;

        // 新增書籍記號（7天內視為新書）
        const addedAt = Number(book.addedAt) || 0;
        const isNew = !!book.isNew && addedAt > 0 && (Date.now() - addedAt) <= 7 * 24 * 60 * 60 * 1000;
        
        // 計算可借閱數量（使用合併後的數量）
        const availableCopies = isMerged ? book.totalAvailableCopies : (book.availableCopies || 0);
        const totalCopies = isMerged ? book.totalCopies : (book.copies || 1);
        
        const canBorrow = !!this.currentUser && availableCopies > 0;

        // 計算用戶已借閱數量（需要檢查所有合併的書籍）
        let userBorrowedCount = 0;
        if (this.currentUser) {
            if (isMerged) {
                userBorrowedCount = book.mergedBooks.reduce((count, mergedBook) => {
                    return count + this.borrowedBooks.filter(
                        b => b.bookId === mergedBook.id && b.userId === this.currentUser.username && !b.returnedAt
                    ).length;
                }, 0);
            } else {
                userBorrowedCount = this.borrowedBooks.filter(
                    b => b.bookId === book.id && b.userId === this.currentUser.username && !b.returnedAt
                ).length;
            }
        }

        // 顯示書碼資訊
        const bookIdsDisplay = isMerged 
            ? `${book.id} 等${book.bookIds.length}本` 
            : book.id;

        const canManageBooks = this.isAdminUser();

        return `
            <div class="book-card genre-${book.genre} ${availableCopies === 0 ? 'borrowed' : ''} ${isMerged ? 'merged' : ''}">
                <div class="book-cover">
                    ${this.isAllowedCoverUrl(book.coverUrl) ? 
                        `<img src="${book.coverUrl}" alt="${book.title}" class="book-cover-img" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                        <div class="book-cover-placeholder" style="display: none;">
                            <i class="fas fa-book"></i>
                        </div>` : 
                        `<div class="book-cover-placeholder" style="display: flex;">
                            <i class="fas fa-book"></i>
                        </div>`
                    }
                    ${isMerged ? '<div class="merged-badge">合併</div>' : ''}
                    ${isNew ? '<div class="new-badge">新</div>' : ''}
                </div>
                <div class="book-content">
                    <div class="book-header">
                        <span class="book-id">${bookIdsDisplay}</span>
                        <span class="book-genre">${book.genre}</span>
                    </div>
                    <div class="book-title">${book.title}</div>
                    ${book.author ? `<div class="book-info-item"><i class=\"fas fa-pen-nib\"></i><span>${book.author}</span></div>` : ''}
                    <div class="book-info">
                        <div class="book-info-item">
                            <i class="fas fa-calendar"></i>
                            <span>${book.year}年</span>
                        </div>
                        <div class="book-info-item">
                            <i class="fas fa-copy"></i>
                            <span>可借 ${availableCopies}/${totalCopies} 本</span>
                        </div>
                        ${isMerged ? `
                        <div class="book-info-item">
                            <i class="fas fa-layer-group"></i>
                            <span>包含 ${book.mergedBooks.length} 本書</span>
                        </div>` : ''}
                        ${isMerged ? `
                        <div class="book-info-item">
                            <i class="fas fa-list"></i>
                            <span>書碼：${book.bookIds.join(', ')}</span>
                        </div>` : ''}
                    </div>
                    <div class="book-actions">
                        ${canBorrow ?
                            `<button class="btn btn-primary btn-small" onclick="library.borrowBook('${book.id}')">
                                <i class="fas fa-book-reader"></i> ${userBorrowedCount > 0 ? '再借' : '借閱'}
                            </button>` :
                            `<button class="btn btn-outline btn-small" disabled>
                                <i class="fas fa-ban"></i> 已借出
                            </button>`
                        }
                        ${canManageBooks ? `
                            <button class="btn btn-success btn-small" onclick="library.duplicateBookAsNewCopy('${book.id}')">
                                <i class="fas fa-plus"></i> 複製新增
                            </button>
                            <button class="btn btn-info btn-small" onclick="library.showEditBookModal('${book.id}')">
                                <i class="fas fa-pen"></i> 編輯
                            </button>
                            <button class="btn btn-warning btn-small" onclick="library.deleteBook('${book.id}')">
                                <i class="fas fa-trash"></i> 刪除
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    showEditBookModal(bookId) {
        if (!this.requireAdmin('編輯書籍')) return;

        // 查找書籍（包括合併書籍中的個別書籍）
        let targetBook = this.books.find(b => b.id === bookId);
        let allRelatedBooks = [];

        if (targetBook) {
            // 如果是普通書籍，查找所有相同書名的書籍
            const sameTitleBooks = this.books.filter(b => 
                this.normalizeTitle(b.title) === this.normalizeTitle(targetBook.title)
            );
            allRelatedBooks = sameTitleBooks;
        } else {
            // 如果直接找不到，可能在合併書籍中，查找所有相關書籍
            const mergedBooks = this.mergeBooksByTitle(this.books);
            const mergedBook = mergedBooks.find(mb => 
                mb.bookIds && mb.bookIds.includes(bookId)
            );
            
            if (mergedBook) {
                allRelatedBooks = mergedBook.mergedBooks || [];
                targetBook = allRelatedBooks.find(b => b.id === bookId);
            }
        }

        if (!targetBook || allRelatedBooks.length === 0) {
            this.showToast('書籍不存在', 'error');
            return;
        }

        // 如果有多本相同書名的書籍，顯示選擇畫面
        if (allRelatedBooks.length > 1) {
            this.showBookSelectionModal(allRelatedBooks, targetBook.id);
        } else {
            // 只有一本書，直接顯示編輯畫面
            this.openEditBookModal(targetBook);
        }
    }

    // 顯示書籍選擇模態框
    showBookSelectionModal(books, selectedBookId) {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'block';
        
        const booksList = books.map(book => `
            <div class="book-selection-item ${book.id === selectedBookId ? 'selected' : ''}" 
                 onclick="library.selectBookForEdit('${book.id}')">
                <div class="book-selection-info">
                    <div class="book-selection-id">書碼：${book.id}</div>
                    <div class="book-selection-details">
                        <div class="book-selection-author">作者：${book.author || '未知'}</div>
                        <div class="book-selection-year">出版年份：${book.year || '未知'}</div>
                        <div class="book-selection-copies">冊數：${book.copies || 1}</div>
                        <div class="book-selection-available">可借：${book.availableCopies || 0}</div>
                    </div>
                </div>
                <div class="book-selection-cover">
                    ${this.isAllowedCoverUrl(book.coverUrl) ? 
                        `<img src="${book.coverUrl}" alt="${book.title}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'">` : 
                        '<div class="no-cover">無封面</div>'
                    }
                </div>
                ${book.id === selectedBookId ? 
                    '<div class="book-selection-badge">目前選擇</div>' : 
                    '<div class="book-selection-select-btn">選擇</div>'
                }
            </div>
        `).join('');
        
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3>選擇要編輯的書籍</h3>
                    <span class="close" onclick="this.closest('.modal').remove()">&times;</span>
                </div>
                <div class="modal-body">
                    <p class="selection-hint">找到多本相同書名的書籍，請選擇要編輯的具體書籍：</p>
                    <div class="book-selection-list">
                        ${booksList}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 取消
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
    }

    // 選擇書籍進行編輯
    selectBookForEdit(bookId) {
        const book = this.books.find(b => b.id === bookId);
        if (!book) {
            this.showToast('書籍不存在', 'error');
            return;
        }
        
        // 關閉選擇模態框
        document.querySelector('.modal').remove();
        
        // 開啟編輯模態框
        this.openEditBookModal(book);
    }

    // 開啟編輯書籍模態框
    openEditBookModal(book) {
        const modal = document.getElementById('edit-book-modal');
        const originalIdInput = document.getElementById('edit-book-original-id');
        const idInput = document.getElementById('edit-book-id');
        const titleInput = document.getElementById('edit-book-title');
        const authorInput = document.getElementById('edit-book-author');
        const coverInput = document.getElementById('edit-book-cover-url');
        const yearInput = document.getElementById('edit-book-year');
        const copiesInput = document.getElementById('edit-book-copies');
        const seriesInput = document.getElementById('edit-book-series');

        // 清除之前的錯誤提示
        const errorDiv = document.getElementById('edit-book-id-error');
        if (errorDiv) {
            errorDiv.style.display = 'none';
            errorDiv.textContent = '';
        }
        
        // 確保書碼輸入框可編輯
        if (idInput) {
            idInput.classList.remove('error');
            idInput.disabled = false;
            idInput.readOnly = false;
            idInput.removeAttribute('disabled');
            idInput.removeAttribute('readonly');
        }

        if (originalIdInput) originalIdInput.value = book.id;
        if (idInput) idInput.value = book.id;
        if (titleInput) titleInput.value = book.title || '';
        if (authorInput) authorInput.value = book.author || '';
        if (coverInput) coverInput.value = book.coverUrl || '';
        if (yearInput) yearInput.value = book.year || this.settings.defaultYear;
        if (copiesInput) copiesInput.value = book.copies || 1;
        
        // 加載系列書名稱
        if (seriesInput) {
            seriesInput.value = book.series || '';
        }

        if (modal) modal.style.display = 'block';

        // 確保書碼輸入框可編輯（延遲確保屬性設置生效）
        setTimeout(() => {
            if (idInput) {
                idInput.disabled = false;
                idInput.readOnly = false;
                idInput.removeAttribute('disabled');
                idInput.removeAttribute('readonly');
                idInput.focus();
            }
        }, 100);

        // 自動搜尋書籍資料
        this.autoSearchBookInfo(book.title);
    }

    // 自動搜尋書籍資料（編輯時使用）
    async autoSearchBookInfo(bookTitle) {
        if (!bookTitle || bookTitle.trim() === '') return;

        try {
            // 使用 Google Books API 搜尋
            const query = encodeURIComponent(bookTitle.trim());
            const apiUrl = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1&langRestrict=zh`;

            const response = await fetch(apiUrl);
            if (!response.ok) return;

            const data = await response.json();
            
            if (!data.items || data.items.length === 0) return;

            const book = data.items[0];
            const info = book.volumeInfo;

            // 檢查是否需要更新現有資料
            const authorInput = document.getElementById('edit-book-author');
            const coverInput = document.getElementById('edit-book-cover-url');
            const yearInput = document.getElementById('edit-book-year');

            let hasUpdates = false;
            let updateMessage = '找到書籍資訊：';

            // 更新作者（如果目前為空）
            if (authorInput && (!authorInput.value || authorInput.value.trim() === '') && info.authors) {
                authorInput.value = info.authors.join(', ');
                hasUpdates = true;
                updateMessage += ' 作者已更新';
            }

            // 更新封面（如果目前為空）
            if (coverInput && (!coverInput.value || coverInput.value.trim() === '') && info.imageLinks) {
                const coverUrl = info.imageLinks.extraLarge || 
                                info.imageLinks.large || 
                                info.imageLinks.medium || 
                                info.imageLinks.thumbnail || 
                                info.imageLinks.smallThumbnail;
                if (coverUrl) {
                    coverInput.value = coverUrl;
                    hasUpdates = true;
                    updateMessage += ' 封面已更新';
                }
            }

            // 更新年份（如果目前為預設值且找到更準確的年份）
            if (yearInput && info.publishedDate) {
                const publishedYear = info.publishedDate.substring(0, 4);
                const currentYear = yearInput.value;
                const defaultYear = this.settings.defaultYear;
                
                if (currentYear == defaultYear && publishedYear !== currentYear) {
                    yearInput.value = publishedYear;
                    hasUpdates = true;
                    updateMessage += ' 年份已更新';
                }
            }

            // 顯示更新結果
            if (hasUpdates) {
                this.showToast(updateMessage, 'success');
            }

        } catch (error) {
            console.error('自動搜尋書籍資訊失敗:', error);
            // 靜默失敗，不影響編輯功能
        }
    }

    // 搜尋借閱記錄
    searchBorrowedBooks() {
        if (!this.currentUser) {
            this.renderBorrowedBooks();
            return;
        }

        const searchTerm = (document.getElementById('borrowed-search-input')?.value || '').trim().toLowerCase();
        const statusFilter = document.getElementById('borrowed-filter-status')?.value || 'all';
        const sortBy = document.getElementById('borrowed-sort')?.value || 'date-desc';

        // 根據用戶權限獲取基礎數據
        let filteredBooks;
        if (this.hasAdminAccess()) {
            // 管理者（主要管理者和副管理者）可以看到所有未歸還的記錄進行搜尋
            filteredBooks = this.borrowedBooks.filter(b => !b.returnedAt);
        } else {
            // 一般用戶只能看到自己的未歸還記錄
            filteredBooks = this.borrowedBooks.filter(
                b => b.userId === this.currentUser.username && !b.returnedAt
            );
        }

        // 搜尋過濾
        if (searchTerm) {
            filteredBooks = filteredBooks.filter(record => {
                const book = this.books.find(b => b.id === record.bookId);
                const bookTitle = book ? book.title.toLowerCase() : '';
                const userId = record.userId ? record.userId.toLowerCase() : '';
                const bookId = record.bookId ? record.bookId.toLowerCase() : '';

                return bookTitle.includes(searchTerm) ||
                       userId.includes(searchTerm) ||
                       bookId.includes(searchTerm);
            });
        }

        // 狀態過濾
        const now = new Date();
        filteredBooks = filteredBooks.filter(record => {
            const isReturned = record.returnedAt;
            const isOverdue = !isReturned && record.dueDate && new Date(record.dueDate) < now;

            switch (statusFilter) {
                case 'borrowed':
                    return !isReturned;
                case 'returned':
                    return isReturned;
                case 'overdue':
                    return isOverdue;
                default:
                    return true;
            }
        });

        // 排序
        filteredBooks.sort((a, b) => {
            switch (sortBy) {
                case 'date-asc':
                    return new Date(a.borrowDate) - new Date(b.borrowDate);
                case 'date-desc':
                    return new Date(b.borrowDate) - new Date(a.borrowDate);
                case 'title':
                    const bookA = this.books.find(b => b.id === a.bookId);
                    const bookB = this.books.find(b => b.id === b.bookId);
                    return (bookA?.title || '').localeCompare(bookB?.title || '');
                case 'borrower':
                    return (a.userId || '').localeCompare(b.userId || '');
                case 'bookId':
                    return a.bookId.localeCompare(b.bookId);
                default:
                    return 0;
            }
        });

        this.renderBorrowedBooks(filteredBooks);
        this.updateBorrowedStatsSummary(filteredBooks);
    }
    
    // 清除借閱記錄搜尋
    clearBorrowedSearch() {
        const searchInput = document.getElementById('borrowed-search-input');
        const statusFilter = document.getElementById('borrowed-filter-status');
        const sortSelect = document.getElementById('borrowed-sort');
        
        if (searchInput) searchInput.value = '';
        if (statusFilter) statusFilter.value = 'all';
        if (sortSelect) sortSelect.value = 'date-desc';
        
        this.renderBorrowedBooks();
        this.updateBorrowedStatsSummary();
    }
    
    // 顯示逾期書籍
    showOverdueBooks() {
        if (!this.currentUser) {
            this.showToast('請先登入', 'error');
            return;
        }

        const now = new Date();
        let overdueBooks;
        
        if (this.currentUser.username === 'sindy16872000') {
            // 管理員可以看到所有逾期書籍
            overdueBooks = this.borrowedBooks.filter(record => {
                return !record.returnedAt && record.dueDate && new Date(record.dueDate) < now;
            });
        } else {
            // 一般用戶只能看到自己的逾期書籍
            overdueBooks = this.borrowedBooks.filter(record => {
                return !record.returnedAt && 
                       record.dueDate && 
                       new Date(record.dueDate) < now &&
                       record.userId === this.currentUser.username;
            });
        }
        
        if (overdueBooks.length === 0) {
            this.showToast('目前沒有逾期書籍', 'success');
            return;
        }
        
        // 設定篩選條件為逾期
        document.getElementById('borrowed-filter-status').value = 'overdue';
        this.searchBorrowedBooks();
        
        this.showToast(`找到 ${overdueBooks.length} 本逾期書籍`, 'warning');
    }
    
    // 顯示借閱統計
    showBorrowingStats() {
        const totalBorrowed = this.borrowedBooks.length;
        const currentlyBorrowed = this.borrowedBooks.filter(b => !b.returnedAt).length;
        const returnedBooks = this.borrowedBooks.filter(b => b.returnedAt).length;
        
        const now = new Date();
        const overdueBooks = this.borrowedBooks.filter(b => {
            return !b.returnedAt && b.dueDate && new Date(b.dueDate) < now;
        });
        
        // 計算最熱門的書籍
        const bookCounts = {};
        this.borrowedBooks.forEach(record => {
            bookCounts[record.bookId] = (bookCounts[record.bookId] || 0) + 1;
        });
        
        const topBooks = Object.entries(bookCounts)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 5)
            .map(([bookId, count]) => {
                const book = this.books.find(b => b.id === bookId);
                return { book: book?.title || bookId, count };
            });
        
        // 計算最活躍的借閱者
        const borrowerCounts = {};
        this.borrowedBooks.forEach(record => {
            if (record.userId) {
                borrowerCounts[record.userId] = (borrowerCounts[record.userId] || 0) + 1;
            }
        });
        
        const topBorrowers = Object.entries(borrowerCounts)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 5)
            .map(([name, count]) => ({ name, count }));
        
        const statsHtml = `
            <div class="borrowing-stats">
                <h3><i class="fas fa-chart-bar"></i> 借閱統計</h3>
                
                <div class="stats-grid">
                    <div class="stat-card">
                        <h4>總體統計</h4>
                        <p>總借閱次數: <strong>${totalBorrowed}</strong></p>
                        <p>目前借出: <strong>${currentlyBorrowed}</strong></p>
                        <p>已歸還: <strong>${returnedBooks}</strong></p>
                        <p>逾期未還: <strong style="color: #dc3545;">${overdueBooks.length}</strong></p>
                    </div>
                    
                    <div class="stat-card">
                        <h4>熱門書籍 TOP 5</h4>
                        ${topBooks.map((item, index) => 
                            `<p>${index + 1}. ${item.book} (${item.count} 次)</p>`
                        ).join('')}
                    </div>
                    
                    <div class="stat-card">
                        <h4>活躍借閱者 TOP 5</h4>
                        ${topBorrowers.map((item, index) => 
                            `<p>${index + 1}. ${item.name} (${item.count} 次)</p>`
                        ).join('')}
                    </div>
                </div>
            </div>
        `;
        
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 800px;">
                <span class="close">&times;</span>
                ${statsHtml}
            </div>
        `;
        
        document.body.appendChild(modal);
        modal.style.display = 'block';
        
        // 設置關閉事件
        modal.querySelector('.close').onclick = () => modal.remove();
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }
    
    // 更新借閱統計摘要
    updateBorrowedStatsSummary(filteredBooks = null) {
        let booksToCount = filteredBooks;
        
        // 如果沒有傳入過濾後的書籍，根據用戶權限決定統計範圍
        if (!booksToCount) {
            if (!this.currentUser) {
                // 未登入用戶，顯示 0
                booksToCount = [];
            } else if (this.currentUser.username === 'sindy16872000') {
                // 管理員可以看到所有未歸還的記錄
                booksToCount = this.borrowedBooks.filter(b => !b.returnedAt);
            } else {
                // 一般用戶只能看到自己的未歸還記錄
                booksToCount = this.borrowedBooks.filter(
                    b => b.userId === this.currentUser.username && !b.returnedAt
                );
            }
        }
        
        const now = new Date();
        
        const totalCount = booksToCount.length;
        const overdueCount = booksToCount.filter(record => {
            return !record.returnedAt && record.dueDate && new Date(record.dueDate) < now;
        }).length;
        
        const totalElement = document.getElementById('borrowed-count-summary');
        const overdueElement = document.getElementById('overdue-count-summary');
        
        if (totalElement) {
            totalElement.textContent = `總計: ${totalCount} 本`;
        }
        if (overdueElement) {
            overdueElement.textContent = `逾期: ${overdueCount} 本`;
            overdueElement.style.color = overdueCount > 0 ? '#dc3545' : '#28a745';
        }
    }

    // 檢查書碼重複（編輯時即時驗證）
    checkBookCodeDuplicate(newId) {
        const originalId = (document.getElementById('edit-book-original-id')?.value || '').trim();
        const errorDiv = document.getElementById('edit-book-id-error');
        const inputField = document.getElementById('edit-book-id');
        
        if (!newId || !errorDiv || !inputField) return;

        const trimmed = String(newId || '').trim();
        const upper = trimmed.toUpperCase();

        // 若只輸入 A/B/C，自動補上下一個可用號碼
        if (/^[ABC]$/.test(upper)) {
            const generated = this.generateNextBookId(upper);
            inputField.value = generated;
            newId = generated;
        }
        
        // 清除之前的錯誤狀態
        errorDiv.style.display = 'none';
        inputField.classList.remove('error');
        
        // 如果書碼沒有改變，不檢查
        if (newId === originalId) return;
        
        // 檢查書碼格式
        if (!this.bookIdPattern.test(newId)) {
            errorDiv.textContent = '書碼格式錯誤：請用 A/B/C + 數字（例：C0001）';
            errorDiv.style.display = 'block';
            inputField.classList.add('error');
            return;
        }
        
        // 檢查是否重複
        const existingBook = this.books.find(b => b.id === newId);
        if (existingBook) {
            errorDiv.textContent = `書碼 "${newId}" 已存在（書名：${existingBook.title}）`;
            errorDiv.style.display = 'block';
            inputField.classList.add('error');
        } else {
            // 書碼可用，顯示成功提示（可選）
            errorDiv.textContent = '書碼可用';
            errorDiv.style.display = 'block';
            errorDiv.style.color = '#28a745';
            inputField.classList.remove('error');
        }
    }

    handleEditBook(e) {
        e.preventDefault();
        if (!this.requireAdmin('編輯書籍')) return;

        const originalId = (document.getElementById('edit-book-original-id')?.value || '').trim();
        const editIdInput = document.getElementById('edit-book-id');
        const newId = (editIdInput?.value || '').trim().toUpperCase();
        const title = (document.getElementById('edit-book-title')?.value || '').trim();
        const author = (document.getElementById('edit-book-author')?.value || '').trim();
        const coverUrl = (document.getElementById('edit-book-cover-url')?.value || '').trim();
        const year = parseInt(document.getElementById('edit-book-year')?.value) || this.settings.defaultYear;
        const newCopies = parseInt(document.getElementById('edit-book-copies')?.value) || 1;

        if (editIdInput && editIdInput.value !== newId) {
            editIdInput.value = newId;
        }

        if (!originalId || !newId) {
            this.showToast('編輯失敗：缺少書碼', 'error');
            return;
        }
        if (!title) {
            this.showToast('請輸入書名', 'error');
            return;
        }

        // 驗證新書碼格式
        if (!this.bookIdPattern.test(newId)) {
            this.showToast('書碼格式錯誤：請用 A/B/C + 數字（例：C0001）', 'error');
            return;
        }

        // 如果書碼有變更，檢查新書碼是否已存在
        if (newId !== originalId) {
            const existingBook = this.books.find(b => b.id === newId);
            if (existingBook) {
                this.showToast('新書碼已存在', 'error');
                return;
            }
        }

        const book = this.books.find(b => b.id === originalId);
        if (!book) {
            this.showToast('書籍不存在', 'error');
            return;
        }

        const borrowedCount = this.borrowedBooks.filter(b => b.bookId === originalId && !b.returnedAt).length;
        if (newCopies < borrowedCount) {
            this.showToast(`冊數不得小於已借出數量 (${borrowedCount})`, 'error');
            return;
        }

        // 更新書籍資訊
        const oldId = book.id;
        book.id = newId;
        book.title = title;
        book.author = author;
        book.coverUrl = coverUrl;
        book.genre = this.getGenreFromId(newId);
        book.year = year;
        book.copies = newCopies;
        book.availableCopies = newCopies - borrowedCount;

        // 讀取使用者輸入的系列書名稱
        const seriesEl = document.getElementById('edit-book-series');
        const seriesName = (seriesEl?.value || '').trim();

        // 更新系列書名稱
        if (seriesName) {
            book.series = seriesName;

            // 如果這本書有多本（相同書名），自動套用套書名稱到其他相同書名的書籍
            const sameTitleBooks = this.books.filter(b => b.title === title && b.id !== originalId);
            if (sameTitleBooks.length > 0) {
                sameTitleBooks.forEach(sameBook => {
                    sameBook.series = seriesName;
                });
                this.showToast(`已自動套用套書名稱到 ${sameTitleBooks.length} 本相同書名的書籍`, 'info');
            }
        } else {
            // 如果使用者清空了系列書名稱，則移除此欄位
            delete book.series;

            // 如果這本書有多本（相同書名），自動清空其他相同書名的書籍的套書名稱
            const sameTitleBooks = this.books.filter(b => b.title === title && b.id !== originalId);
            if (sameTitleBooks.length > 0) {
                sameTitleBooks.forEach(sameBook => {
                    delete sameBook.series;
                });
                this.showToast(`已自動清空 ${sameTitleBooks.length} 本相同書名的書籍的套書名稱`, 'info');
            }
        }

        // 更新書碼列表
        if (Array.isArray(book.bookIds)) {
            const index = book.bookIds.indexOf(oldId);
            if (index > -1) {
                book.bookIds[index] = newId;
            }
            if (!book.bookIds.includes(newId)) {
                book.bookIds.unshift(newId);
            }
        } else {
            book.bookIds = [newId];
        }

        // 如果書碼有變更，更新所有相關借閱紀錄
        if (newId !== originalId) {
            this.borrowedBooks.forEach(borrowRecord => {
                if (borrowRecord.bookId === originalId) {
                    borrowRecord.bookId = newId;
                }
            });

            // 更新統計數據中的書碼
            if (this.stats && this.stats.categoryStats) {
                Object.keys(this.stats.categoryStats).forEach(category => {
                    const categoryStat = this.stats.categoryStats[category];
                    if (categoryStat.bookIds && categoryStat.bookIds.includes(originalId)) {
                        const index = categoryStat.bookIds.indexOf(originalId);
                        categoryStat.bookIds[index] = newId;
                    }
                });
            }
        }

        this.saveData();
        // 若書籍物件有 series 屬性（確實被設為套書），切換至「系列書」分頁
        try {
            if (book && book.series) {
                this.switchBookType('series');
            }
        } catch (e) {
            console.error('切換至系列分頁失敗:', e);
        }
        // 更新書單版本，讓快取失效
        this.updateBookListVersion();
        
        // 編輯書籍屬於動作變更，才觸發同步
        this.triggerSyncForAction('editBook');
        
        this.renderBooks();
        this.updateStats();

        const modal = document.getElementById('edit-book-modal');
        if (modal) modal.style.display = 'none';
        
        const message = newId !== originalId ? 
            `書籍已更新，書碼已從 ${originalId} 變更為 ${newId}` : 
            '書籍已更新';
        this.showToast(message, 'success');
    }

    async autoFillBookInfo({ titleInputId, authorInputId, yearInputId, coverInputId }) {
        const titleInput = document.getElementById(titleInputId);
        const authorInput = document.getElementById(authorInputId);
        const yearInput = document.getElementById(yearInputId);
        const coverInput = coverInputId ? document.getElementById(coverInputId) : null;

        const title = (titleInput?.value || '').trim();
        const author = (authorInput?.value || '').trim();

        if (!title && !author) {
            this.showToast('請先輸入書名或作者再搜尋', 'warning');
            return;
        }

        try {
            const q = [];
            if (title) q.push(`intitle:${title}`);
            if (author) q.push(`inauthor:${author}`);
            const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q.join('+'))}&maxResults=5`;

            // 使用 API 隊列機制
            const data = await this.enqueueApiRequest(async () => {
                return await this.fetchWithRetry(url);
            });
            
            const item = data?.items?.[0];
            const info = item?.volumeInfo;
            if (!info) {
                this.showToast('找不到符合的書籍資料', 'warning');
                return;
            }

            const foundTitle = (info.title || '').trim();
            const foundAuthors = Array.isArray(info.authors) ? info.authors.join('、') : '';
            const published = (info.publishedDate || '').trim();
            const year = published ? parseInt(published.slice(0, 4), 10) : NaN;
            const coverUrl = (info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '').trim();

            if (titleInput && foundTitle && !titleInput.value.trim()) titleInput.value = foundTitle;
            if (authorInput && foundAuthors) authorInput.value = foundAuthors;
            if (yearInput && Number.isFinite(year)) yearInput.value = String(year);
            if (coverInput && coverUrl) coverInput.value = coverUrl;

            this.showToast('已自動回填書籍資訊', 'success');
        } catch (error) {
            console.error('autoFillBookInfo error:', error);
            this.handleApiError(error, '自動填入書籍資訊失敗');
        }
    }

    // API 請求隊列處理
    async enqueueApiRequest(requestFn) {
        return new Promise((resolve, reject) => {
            this.apiRequestQueue.push({ requestFn, resolve, reject });
            this.processApiQueue();
        });
    }

    async processApiQueue() {
        if (this.apiRequestInProgress || this.apiRequestQueue.length === 0) return;
        
        this.apiRequestInProgress = true;
        
        while (this.apiRequestQueue.length > 0) {
            const { requestFn, resolve, reject } = this.apiRequestQueue.shift();
            
            // 確保請求間隔
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastApiRequestTime;
            if (timeSinceLastRequest < this.apiRequestDelay) {
                const waitTime = this.apiRequestDelay - timeSinceLastRequest;
                await new Promise(r => setTimeout(r, waitTime));
            }
            
            this.lastApiRequestTime = Date.now();
            
            try {
                const result = await requestFn();
                resolve(result);
            } catch (error) {
                reject(error);
            }
        }
        
        this.apiRequestInProgress = false;
    }

    // 帶重試與指數退避的 fetch
    async fetchWithRetry(url, options = {}) {
        let lastError;
        for (let attempt = 1; attempt <= this.apiRetryConfig.maxRetries; attempt++) {
            try {
                const res = await fetch(url, options);
                if (res.ok) return await res.json();
                if (res.status === 429) {
                    // 429: Too Many Requests，使用指數退避策略
                    const delay = Math.min(
                        this.apiRetryConfig.baseDelay * Math.pow(2, attempt - 1),
                        this.apiRetryConfig.maxDelay
                    );
                    console.warn(`API 429，等待 ${delay}ms 後重試 (${attempt}/${this.apiRetryConfig.maxRetries})`);
                    
                    // 在第一次 429 錯誤時顯示用戶提示
                    if (attempt === 1) {
                        this.showToast('API 請求過於頻繁，正在自動重試...', 'warning', 3000);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw new Error(`HTTP ${res.status}`);
            } catch (err) {
                lastError = err;
                if (attempt === this.apiRetryConfig.maxRetries) break;
                const delay = Math.min(
                    this.apiRetryConfig.baseDelay * Math.pow(2, attempt - 1),
                    this.apiRetryConfig.maxDelay
                );
                console.warn(`API 請求失敗，等待 ${delay}ms 後重試 (${attempt}/${this.apiRetryConfig.maxRetries})`, err.message);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }

    // 統一的 API 錯誤處理
    handleApiError(error, fallbackMessage = 'API 請求失敗') {
        if (error.message.includes('429')) {
            this.showToast('請求過於頻繁，系統將自動重試，請稍候...', 'warning', 8000);
        } else if (error.message.includes('499') || error.message.includes('antivirus')) {
            this.showToast('請求被防毒軟體阻擋，請暫時停用防毒或換網路後重試', 'error', 6000);
        } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            this.showToast('網路連線異常，請檢查網路狀態後重試', 'error', 6000);
        } else if (error.message.includes('timeout')) {
            this.showToast('請求超時，請稍後重試', 'error', 5000);
        } else {
            console.error('API 錯誤詳情:', error);
            this.showToast(fallbackMessage, 'error', 5000);
        }
    }

    deleteBook(bookId) {
        if (!this.requireAdmin('刪除書籍')) return;

        // 查找書籍（包括合併書籍中的個別書籍）
        let targetBook = this.books.find(b => b.id === bookId);
        let allRelatedBooks = [];

        if (targetBook) {
            // 如果是普通書籍，查找所有相同書名的書籍
            const sameTitleBooks = this.books.filter(b => 
                this.normalizeTitle(b.title) === this.normalizeTitle(targetBook.title)
            );
            allRelatedBooks = sameTitleBooks;
        } else {
            // 如果直接找不到，可能在合併書籍中，查找所有相關書籍
            const mergedBooks = this.mergeBooksByTitle(this.books);
            const mergedBook = mergedBooks.find(mb => 
                mb.bookIds && mb.bookIds.includes(bookId)
            );
            
            if (mergedBook) {
                allRelatedBooks = mergedBook.mergedBooks || [];
                targetBook = allRelatedBooks.find(b => b.id === bookId);
            }
        }

        if (!targetBook || allRelatedBooks.length === 0) {
            this.showToast('書籍不存在', 'error');
            return;
        }

        // 如果有多本相同書名的書籍，顯示選擇畫面
        if (allRelatedBooks.length > 1) {
            this.showDeleteSelectionModal(allRelatedBooks, targetBook.id);
        } else {
            // 只有一本書，直接刪除
            this.confirmDeleteBook(targetBook);
        }
    }

    // 顯示刪除書籍選擇模態框
    showDeleteSelectionModal(books, selectedBookId) {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'block';
        
        const booksList = books.map(book => {
            const borrowedCount = this.borrowedBooks.filter(b => b.bookId === book.id && !b.returnedAt).length;
            const canDelete = borrowedCount === 0;
            
            return `
                <div class="book-selection-item ${book.id === selectedBookId ? 'selected' : ''} ${!canDelete ? 'disabled' : ''}" 
                     onclick="${canDelete ? `library.selectBookForDelete('${book.id}')` : ''}">
                    <div class="book-selection-info">
                        <div class="book-selection-id">書碼：${book.id}</div>
                        <div class="book-selection-details">
                            <div class="book-selection-author">作者：${book.author || '未知'}</div>
                            <div class="book-selection-year">出版年份：${book.year || '未知'}</div>
                            <div class="book-selection-copies">冊數：${book.copies || 1}</div>
                            <div class="book-selection-available">可借：${book.availableCopies || 0}</div>
                        </div>
                        ${borrowedCount > 0 ? 
                            `<div class="book-selection-warning">
                                <i class="fas fa-exclamation-triangle"></i> 
                                有 ${borrowedCount} 本未歸還，無法刪除
                            </div>` : 
                            ''
                        }
                    </div>
                    <div class="book-selection-cover">
                        ${book.coverUrl ? 
                            `<img src="${book.coverUrl}" alt="${book.title}" onerror="this.style.display='none'">` : 
                            '<div class="no-cover">無封面</div>'
                        }
                    </div>
                    ${book.id === selectedBookId ? 
                        '<div class="book-selection-badge">目前選擇</div>' : 
                        (canDelete ? 
                            '<div class="book-selection-select-btn book-selection-delete-btn">刪除</div>' :
                            '<div class="book-selection-disabled-btn">無法刪除</div>'
                        )
                    }
                </div>
            `;
        }).join('');
        
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3><i class="fas fa-trash"></i> 選擇要刪除的書籍</h3>
                    <span class="close" onclick="this.closest('.modal').remove()">&times;</span>
                </div>
                <div class="modal-body">
                    <p class="selection-hint selection-hint-danger">
                        <i class="fas fa-exclamation-triangle"></i>
                        找到多本相同書名的書籍，請選擇要刪除的具體書籍：
                    </p>
                    <div class="book-selection-list">
                        ${booksList}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 取消
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
    }

    // 選擇書籍進行刪除
    selectBookForDelete(bookId) {
        const book = this.books.find(b => b.id === bookId);
        if (!book) {
            this.showToast('書籍不存在', 'error');
            return;
        }
        
        // 關閉選擇模態框
        document.querySelector('.modal').remove();
        
        // 確認刪除
        this.confirmDeleteBook(book);
    }

    // 確認刪除書籍
    confirmDeleteBook(book) {
        const borrowedCount = this.borrowedBooks.filter(b => b.bookId === book.id && !b.returnedAt).length;
        if (borrowedCount > 0) {
            this.showToast('此書籍仍有未歸還借閱，無法刪除', 'error');
            return;
        }

        if (!confirm(`確定要刪除「${book.title}」（書碼：${book.id}）嗎？\n\n此操作無法復原！`)) return;

        this.books = this.books.filter(b => b.id !== book.id);
        this.saveData();
        
        // 更新書單版本，讓快取失效
        this.updateBookListVersion();
        
        // 刪除書籍屬於動作變更，才觸發同步
        this.triggerSyncForAction('deleteBook');
        
        this.renderBooks();
        this.updateStats();
        this.showToast(`書籍「${book.title}」已刪除`, 'success');
    }

    // 渲染借閱記錄
    renderBorrowedBooks(borrowedBooksToRender = null) {
        const container = document.getElementById('borrowed-container');

        if (!this.currentUser) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-sign-in-alt"></i>
                    <h3>請先登入</h3>
                    <p>登入後即可查看借閱記錄</p>
                </div>
            `;
            this.updateBorrowedStatsSummary();
            return;
        }

        // 如果沒有傳入要渲染的書籍，使用預設邏輯
        let borrowedBooks = borrowedBooksToRender;
        if (!borrowedBooks) {
            // 根據使用者角色決定顯示範圍
            if (this.hasAdminAccess()) {
                // 管理者（主要管理者和副管理者）可以看到所有借閱記錄
                borrowedBooks = this.borrowedBooks.filter(b => !b.returnedAt);
            } else {
                // 其他使用者只能看到自己的借閱記錄
                borrowedBooks = this.borrowedBooks.filter(
                    b => b.userId === this.currentUser.username && !b.returnedAt
                );
            }
        }

        // 更新統計摘要
        this.updateBorrowedStatsSummary(borrowedBooks);

        // 如果已經在 searchBorrowedBooks 中排序過，就不要再排序
        if (!borrowedBooksToRender) {
            // 按借閱日期降序排列（最新的在最上面）
            borrowedBooks.sort((a, b) => {
                const dateA = new Date(a.borrowDate || 0).getTime();
                const dateB = new Date(b.borrowDate || 0).getTime();
                return dateB - dateA;
            });
        }

        if (borrowedBooks.length === 0) {
            const message = this.hasAdminAccess()
                ? '目前沒有借閱記錄'
                : '您目前沒有借閱記錄';
            const subMessage = this.hasAdminAccess()
                ? '所有書籍都已歸還'
                : '快去借閱您喜歡的書籍吧！';

            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-book"></i>
                    <h3>${message}</h3>
                    <p>${subMessage}</p>
                </div>
            `;
            return;
        }

        let headerHtml = '';
        if (this.hasAdminAccess()) {
            headerHtml = `
                <div style="margin-bottom: 16px; text-align: right;">
                    <button id="set-all-due-dates-btn" class="btn btn-warning btn-small">
                        <i class="fas fa-calendar-alt"></i> 設定全部還書時間
                    </button>
                </div>
            `;
        }

        container.innerHTML = headerHtml + borrowedBooks.map(record => this.createBorrowedItem(record)).join('');

        // 動態綁定按鈕事件（避免快取問題）
        const setBtn = document.getElementById('set-all-due-dates-btn');
        if (setBtn) {
            setBtn.addEventListener('click', () => this.setAllDueDates());
        }
    }

    // 建立借閱項目
    createBorrowedItem(record) {
        const borrowDate = new Date(record.borrowDate);
        const dueDate = new Date(record.dueDate);
        const now = new Date();
        const daysLeft = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));

        return `
            <div class="borrowed-item">
                <div class="borrowed-info">
                    <div class="borrowed-title">${record.bookTitle}</div>
                    <div class="borrowed-details">
                        <div><i class="fas fa-barcode"></i> 書碼：${record.bookId}${record.copyNo ? ` - 第 ${record.copyNo} 冊` : ''}</div>
                        <div><i class="fas fa-user"></i> 借閱者：${record.userId}</div>
                        <div><i class="fas fa-calendar-plus"></i> 借閱日期：${borrowDate.toLocaleDateString()}</div>
                        <div><i class="fas fa-calendar-check"></i> 應還日期：${dueDate.toLocaleDateString()}</div>
                        <div>
                            <i class="fas fa-clock"></i> 剩餘 ${daysLeft} 天
                        </div>
                    </div>
                </div>
                <div class="borrowed-actions">
                    ${this.currentUser.username === 'sindy16872000' ? `
                    <button class="btn btn-info btn-small" onclick="library.adjustDueDate('${record.id}')">
                        <i class="fas fa-calendar-alt"></i> 調整還書時間
                    </button>` : ''}
                    <button class="btn btn-success btn-small" onclick="library.returnBook('${record.id}')">
                        <i class="fas fa-undo"></i> 歸還
                    </button>
                </div>
            </div>
        `;
    }

    // 調整單筆借閱的還書時間（僅限 sindy16872000）
    adjustDueDate(borrowId) {
        if (this.currentUser.username !== 'sindy16872000') {
            this.showToast('無此權限', 'error');
            return;
        }

        const record = this.borrowedBooks.find(b => b.id === borrowId);
        if (!record || record.returnedAt) {
            this.showToast('借閱記錄不存在或已歸還', 'error');
            return;
        }

        const input = window.prompt(`請輸入要幾天後歸還（目前：${new Date(record.dueDate).toLocaleDateString('zh-TW')}）`, '7');
        if (input === null) return;

        const days = parseInt(String(input).trim(), 10);
        if (!Number.isFinite(days) || days < 0) {
            this.showToast('請輸入有效的天數（0 或正整數）', 'error');
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const newDate = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);

        record.dueDate = newDate.toISOString();

        this.saveData();
        this.renderBorrowedBooks();
        this.showToast(`已將「${record.bookTitle}」的還書時間設為 ${days} 天後（${newDate.toLocaleDateString('zh-TW')}）`, 'success');
    }

    // 批量設定所有借閱的還書時間（僅限 sindy16872000）
    setAllDueDates() {
        if (this.currentUser.username !== 'sindy16872000') {
            this.showToast('無此權限', 'error');
            return;
        }

        const input = window.prompt('請輸入要幾天後歸還（例如：7）', '7');
        if (input === null) return;

        const days = parseInt(String(input).trim(), 10);
        if (!Number.isFinite(days) || days < 0) {
            this.showToast('請輸入有效的天數（0 或正整數）', 'error');
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const newDate = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);

        const updated = this.borrowedBooks.filter(b => !b.returnedAt).map(b => {
            b.dueDate = newDate.toISOString();
            return b;
        });

        if (updated.length === 0) {
            this.showToast('沒有待更新的借閱記錄', 'info');
            return;
        }

        this.saveData();
        this.renderBorrowedBooks();
        this.showToast(`已將 ${updated.length} 筆借閱的還書時間設為 ${days} 天後（${newDate.toLocaleDateString('zh-TW')}）`, 'success');
    }

    // 切換設定標籤頁
    switchSettingsTab(tabName) {
        // 移除所有標籤的 active 狀態
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

        // 啟用選中的標籤
        const activeBtn = document.querySelector(`.tab-btn[onclick*="${tabName}"]`);
        const activeContent = document.getElementById(`${tabName}-settings`);
        if (activeBtn) activeBtn.classList.add('active');
        if (activeContent) activeContent.classList.add('active');

        // 如果切換到副管理者標籤，渲染副管理者列表
        if (tabName === 'sub-admin') {
            this.renderSubAdminList();
        }
    }

    // 顯示新增副管理者模態框
    showAddSubAdminModal() {
        if (!this.requireSuperAdmin('新增副管理者')) return;

        const modal = document.getElementById('sub-admin-modal');
        const form = document.getElementById('sub-admin-form');
        const usernameEl = document.getElementById('sub-admin-username');

        if (form) form.reset();
        if (usernameEl) usernameEl.value = '';

        if (modal) modal.style.display = 'block';
    }

    // 新增副管理者
    handleAddSubAdmin(e) {
        e.preventDefault();
        if (!this.requireSuperAdmin('新增副管理者')) return;

        const usernameEl = document.getElementById('sub-admin-username');
        const username = usernameEl?.value?.trim();

        if (!username) {
            this.showToast('請輸入副管理者名稱', 'error');
            return;
        }

        // 檢查是否已存在
        if (this.settings.subAdmins?.find(sa => sa.username === username)) {
            this.showToast('此副管理者已存在', 'error');
            return;
        }

        // 檢查是否與主要管理者相同
        if (username === this.adminUsername) {
            this.showToast('不能將主要管理者設為副管理者', 'error');
            return;
        }

        // 新增副管理者
        if (!this.settings.subAdmins) {
            this.settings.subAdmins = [];
        }
        this.settings.subAdmins.push({
            username: username,
            createdAt: new Date().toISOString()
        });

        this.saveData();
        this.renderSubAdminList();

        // 關閉模態框
        const modal = document.getElementById('sub-admin-modal');
        if (modal) modal.style.display = 'none';

        this.showToast(`副管理者 ${username} 新增成功`, 'success');
    }

    // 刪除副管理者
    deleteSubAdmin(username) {
        if (!this.requireSuperAdmin('刪除副管理者')) return;

        if (!confirm(`確定要刪除副管理者 ${username} 嗎？`)) {
            return;
        }

        this.settings.subAdmins = this.settings.subAdmins.filter(sa => sa.username !== username);
        this.saveData();
        this.renderSubAdminList();

        this.showToast(`副管理者 ${username} 已刪除`, 'success');
    }

    // 渲染副管理者列表
    renderSubAdminList() {
        const container = document.getElementById('sub-admin-list');
        if (!container) return;

        const subAdmins = this.settings.subAdmins || [];

        if (subAdmins.length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-user-shield"></i><h3>沒有副管理者</h3><p>目前沒有設定任何副管理者</p></div>';
            return;
        }

        let html = '<div class="sub-admin-list">';
        subAdmins.forEach((subAdmin, index) => {
            html += `
                <div class="sub-admin-item">
                    <div class="sub-admin-info">
                        <i class="fas fa-user-shield"></i>
                        <span class="sub-admin-name">${this.escapeHtml(subAdmin.username)}</span>
                        <span class="sub-admin-date">新增於 ${new Date(subAdmin.createdAt).toLocaleDateString('zh-TW')}</span>
                    </div>
                    <button class="btn btn-danger btn-sm" onclick="library.deleteSubAdmin('${this.escapeHtml(subAdmin.username)}')">
                        <i class="fas fa-trash"></i> 刪除
                    </button>
                </div>
            `;
        });
        html += '</div>';

        container.innerHTML = html;
    }

    // 顯示新增使用者借閱時間設定模態框
    showAddUserLoanModal() {
        if (!this.requireAdmin('使用者借閱時間設定')) return;
        this.normalizeUserLoanSettings();

        const modal = document.getElementById('user-loan-modal');
        const form = document.getElementById('user-loan-form');
        const editingIndex = document.getElementById('user-loan-editing-index');
        const username = document.getElementById('user-loan-username');
        const days = document.getElementById('user-loan-days');
        const reason = document.getElementById('user-loan-reason');
        const deleteBtn = document.getElementById('delete-user-loan-btn');

        if (form) form.reset();
        if (editingIndex) editingIndex.value = '';
        if (username) username.value = '';
        if (days) days.value = '';
        if (reason) reason.value = '';
        if (deleteBtn) deleteBtn.style.display = 'none';

        if (modal) modal.style.display = 'block';
        setTimeout(() => {
            if (username) username.focus();
        }, 0);
    }

    // 搜尋使用者借閱時間設定
    searchUserLoanSettings() {
        this.renderUserLoanSettingsList();
    }

    renderUserLoanSettingsList() {
        const container = document.getElementById('user-loan-list');
        if (!container) return;

        this.normalizeUserLoanSettings();

        const term = String(document.getElementById('user-loan-search')?.value || '').trim().toLowerCase();
        const list = this.settings.userLoanSettings;

        const filtered = term
            ? list.filter(x => String(x.username || '').toLowerCase().includes(term))
            : list;

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 12px;">
                    <i class="fas fa-user-clock"></i>
                    <h3>沒有設定</h3>
                    <p>可在此為特定使用者指定不同的借閱天數</p>
                </div>
            `;
            return;
        }

        container.innerHTML = filtered.map(item => {
            const idx = list.findIndex(x => x.username === item.username);
            const reason = item.reason ? `<div style="opacity: .85; margin-top: 4px;">原因：${this.escapeHtml(item.reason)}</div>` : '';
            return `
                <div class="borrowed-item" style="cursor: pointer;" onclick="library.openUserLoanSetting(${idx})">
                    <div class="borrowed-info">
                        <div class="borrowed-title">${this.escapeHtml(item.username)}</div>
                        <div class="borrowed-details">
                            <div><i class="fas fa-calendar-days"></i> 借閱天數：${item.days} 天</div>
                            ${reason}
                        </div>
                    </div>
                    <div class="borrowed-actions">
                        <button class="btn btn-info btn-small" onclick="event.stopPropagation(); library.openUserLoanSetting(${idx})">
                            <i class="fas fa-pen"></i> 編輯
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    openUserLoanSetting(index) {
        if (!this.requireAdmin('使用者借閱時間設定')) return;
        this.normalizeUserLoanSettings();

        const idx = Number(index);
        if (!Number.isFinite(idx) || idx < 0 || idx >= this.settings.userLoanSettings.length) {
            this.showToast('設定項目不存在', 'error');
            return;
        }

        const item = this.settings.userLoanSettings[idx];

        const modal = document.getElementById('user-loan-modal');
        const editingIndex = document.getElementById('user-loan-editing-index');
        const username = document.getElementById('user-loan-username');
        const days = document.getElementById('user-loan-days');
        const reason = document.getElementById('user-loan-reason');
        const deleteBtn = document.getElementById('delete-user-loan-btn');

        if (editingIndex) editingIndex.value = String(idx);
        if (username) username.value = item.username;
        if (days) days.value = String(item.days);
        if (reason) reason.value = item.reason || '';
        if (deleteBtn) deleteBtn.style.display = '';

        if (modal) modal.style.display = 'block';
        setTimeout(() => {
            if (days) days.focus();
        }, 0);
    }

    handleSaveUserLoanSetting(e) {
        e.preventDefault();
        if (!this.requireAdmin('使用者借閱時間設定')) return;

        this.normalizeUserLoanSettings();

        const editingIndexEl = document.getElementById('user-loan-editing-index');
        const usernameEl = document.getElementById('user-loan-username');
        const daysEl = document.getElementById('user-loan-days');
        const reasonEl = document.getElementById('user-loan-reason');

        const username = String(usernameEl?.value || '').trim();
        const days = parseInt(String(daysEl?.value || '').trim(), 10);
        const reason = String(reasonEl?.value || '').trim();

        if (!username) {
            this.showToast('請輸入使用者名稱', 'error');
            return;
        }
        if (!Number.isFinite(days) || days < 1 || days > 365) {
            this.showToast('借閱天數需為 1-365 的整數', 'error');
            return;
        }

        const nowIso = new Date().toISOString();
        const editingIndex = editingIndexEl && editingIndexEl.value !== ''
            ? parseInt(editingIndexEl.value, 10)
            : -1;

        const existingIndex = this.settings.userLoanSettings.findIndex(x => x.username === username);

        // 編輯模式：若改了 username，避免與其他項目衝突
        if (editingIndex >= 0 && editingIndex < this.settings.userLoanSettings.length) {
            if (existingIndex !== -1 && existingIndex !== editingIndex) {
                this.showToast('已有相同使用者名稱的設定，請先刪除或改名', 'error');
                return;
            }
            this.settings.userLoanSettings[editingIndex] = { username, days, reason, updatedAt: nowIso };
        } else {
            if (existingIndex !== -1) {
                this.settings.userLoanSettings[existingIndex] = { username, days, reason, updatedAt: nowIso };
            } else {
                this.settings.userLoanSettings.push({ username, days, reason, updatedAt: nowIso });
            }
        }

        this.normalizeUserLoanSettings();
        this.saveData();
        this.renderUserLoanSettingsList();

        const modal = document.getElementById('user-loan-modal');
        if (modal) modal.style.display = 'none';

        this.showToast('已儲存使用者借閱時間設定', 'success');
    }

    handleDeleteUserLoanSetting() {
        if (!this.requireAdmin('使用者借閱時間設定')) return;
        this.normalizeUserLoanSettings();

        const editingIndexEl = document.getElementById('user-loan-editing-index');
        const idx = parseInt(String(editingIndexEl?.value || ''), 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= this.settings.userLoanSettings.length) {
            this.showToast('刪除失敗：找不到設定項目', 'error');
            return;
        }

        const item = this.settings.userLoanSettings[idx];
        const ok = confirm(`確定要刪除「${item.username}」的借閱天數設定嗎？`);
        if (!ok) return;

        this.settings.userLoanSettings.splice(idx, 1);
        this.normalizeUserLoanSettings();
        this.saveData();
        this.renderUserLoanSettingsList();

        const modal = document.getElementById('user-loan-modal');
        if (modal) modal.style.display = 'none';
        this.showToast('已刪除設定', 'success');
    }

    // 更新統計資訊
    updateStats() {
        const totalBooks = this.books.reduce((sum, book) => sum + book.copies, 0);
        const uniqueTitles = new Set(
            this.books
                .map(book => (book?.title ?? '').trim().replace(/\s+/g, ' ').toLowerCase())
                .filter(Boolean)
        ).size;
        const availableBooks = this.books.reduce((sum, book) => sum + book.availableCopies, 0);
        const borrowedBooks = this.borrowedBooks.filter(b => !b.returnedAt).length;

        // 基本統計（所有用戶都看得到）
        document.getElementById('total-books').textContent = totalBooks;
        document.getElementById('unique-titles').textContent = uniqueTitles;
        document.getElementById('available-books').textContent = availableBooks;
        document.getElementById('borrowed-books').textContent = borrowedBooks;

        // 管理員專用詳細統計
        if (this.isAdminUser()) {
            // 按類別統計
            const statsByGenre = this.calculateStatsByGenre();
            
            // 更新或創建管理員統計區域
            this.updateAdminStats(statsByGenre);
        } else {
            // 非管理員隱藏詳細統計
            this.hideAdminStats();
        }
    }

    // 計算各類別書籍統計
    calculateStatsByGenre() {
        const stats = {
            '繪本': { total: 0, available: 0, borrowed: 0, titles: new Set() },
            '橋梁書': { total: 0, available: 0, borrowed: 0, titles: new Set() },
            '文字書': { total: 0, available: 0, borrowed: 0, titles: new Set() },
            '未知': { total: 0, available: 0, borrowed: 0, titles: new Set() }
        };

        this.books.forEach(book => {
            const genre = book.genre || '未知';
            if (!stats[genre]) {
                stats[genre] = { total: 0, available: 0, borrowed: 0, titles: new Set() };
            }

            stats[genre].total += book.copies || 1;
            stats[genre].available += book.availableCopies || 0;
            stats[genre].borrowed += (book.copies || 1) - (book.availableCopies || 0);
            stats[genre].titles.add(book.title);
        });

        // 將 Set 轉為數量
        Object.keys(stats).forEach(genre => {
            stats[genre].titleCount = stats[genre].titles.size;
            delete stats[genre].titles;
        });

        return stats;
    }

    // 更新管理員統計顯示
    updateAdminStats(statsByGenre) {
        let adminStatsDiv = document.getElementById('admin-stats');
        
        // 如果不存在，創建管理員統計區域
        if (!adminStatsDiv) {
            adminStatsDiv = document.createElement('div');
            adminStatsDiv.id = 'admin-stats';
            adminStatsDiv.className = 'admin-stats';
            
            // 插入到現有統計區域後面
            const statsContainer = document.querySelector('.stats');
            if (statsContainer) {
                statsContainer.parentNode.insertBefore(adminStatsDiv, statsContainer.nextSibling);
            }
        }

        // 生成統計內容
        const statsHtml = `
            <div class="admin-stats-header">
                <h4><i class="fas fa-chart-bar"></i> 管理員詳細統計</h4>
            </div>
            <div class="admin-stats-grid">
                ${Object.entries(statsByGenre).map(([genre, stats]) => `
                    <div class="admin-stat-card ${genre === '繪本' ? 'picture-book' : genre === '橋梁書' ? 'bridge-book' : genre === '文字書' ? 'chapter-book' : 'unknown-book'}">
                        <div class="admin-stat-title">${genre}</div>
                        <div class="admin-stat-numbers">
                            <div class="admin-stat-item">
                                <span class="admin-stat-label">總冊數</span>
                                <span class="admin-stat-value total">${stats.total}</span>
                            </div>
                            <div class="admin-stat-item">
                                <span class="admin-stat-label">可借</span>
                                <span class="admin-stat-value available">${stats.available}</span>
                            </div>
                            <div class="admin-stat-item">
                                <span class="admin-stat-label">已借</span>
                                <span class="admin-stat-value borrowed">${stats.borrowed}</span>
                            </div>
                            <div class="admin-stat-item">
                                <span class="admin-stat-label">書名數</span>
                                <span class="admin-stat-value titles">${stats.titleCount}</span>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        adminStatsDiv.innerHTML = statsHtml;
        adminStatsDiv.style.display = 'block';
    }

    // 隱藏管理員統計
    hideAdminStats() {
        const adminStatsDiv = document.getElementById('admin-stats');
        if (adminStatsDiv) {
            adminStatsDiv.style.display = 'none';
        }
    }

    // 設定視圖模式
    setView(view) {
        const gridBtn = document.getElementById('grid-view');
        const listBtn = document.getElementById('list-view');
        const container = document.getElementById('books-container');

        if (view === 'grid') {
            gridBtn.classList.add('active');
            listBtn.classList.remove('active');
            container.className = 'books-grid';
        } else {
            listBtn.classList.add('active');
            gridBtn.classList.remove('active');
            container.className = 'books-list';
        }
    }

    // 重置資料
    resetData() {
        if (!this.requireSuperAdmin('重置資料')) return;
        if (confirm('確定要重置所有資料嗎？此操作無法復原！')) {
            localStorage.removeItem('lib_books_v1');
            localStorage.removeItem('lib_borrowed_v1');
            localStorage.removeItem('lib_users_v1');
            localStorage.removeItem('lib_active_user_v1');
            localStorage.removeItem('lib_settings_v1');
            localStorage.removeItem('lib_csv_loaded_v1');
            
            this.books = [];
            this.borrowedBooks = [];
            this.users = [];
            this.currentUser = null;
            
            // 重新載入 Google Sheets（改以線上資料為主）
            this.pullFromGoogleSheets({ silent: false, protectEmpty: false, closeModal: false });
            
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();
            this.updateUserDisplay();
            
            this.showToast('資料已重置，將重新載入線上資料', 'success');
        }
    }
    
    // 重新載入 CSV 資料
    async reloadCSV() {
        if (!this.requireAdmin('重新載入 CSV')) return;
        
        // 嘗試從 Google Sheets 載入，失敗時自動載入本地 CSV
        this.showToast('正在嘗試從線上載入資料...', 'info');
        
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            console.log('未設定 Google Sheets URL，直接載入本地 CSV');
            await this.autoLoadCSV();
            return;
        }

        try {
            await this.pullFromGoogleSheets({ silent: false, protectEmpty: false, closeModal: false });
        } catch (error) {
            console.error('從 Google Sheets 載入失敗:', error);
            this.showToast('線上載入失敗，嘗試載入本地 CSV 檔案...', 'warning');
            await this.autoLoadCSV();
        }
    }

    // 匯出書籍資料到 CSV 檔案
    async exportToCSV() {
        if (!this.requireAdmin('匯出 CSV')) return;
        
        if (this.books.length === 0) {
            this.showToast('沒有書籍資料可以匯出', 'warning');
            return;
        }

        try {
            this.showToast('正在匯出 CSV 檔案...', 'info');
            this.showLoadingIndicator(true);

            // 建立 CSV 內容
            let csvContent = '博幼藏書,\n,\n欄1,欄2\n編號,書名\n';
            
            // 按書碼排序
            const sortedBooks = [...this.books].sort((a, b) => {
                if (a.id && b.id) {
                    return a.id.localeCompare(b.id);
                }
                return (a.title || '').localeCompare(b.title || '');
            });

            // 加入書籍資料
            sortedBooks.forEach(book => {
                const id = book.id || '';
                const title = book.title || '';
                csvContent += `${id},${title}\n`;
            });

            // 建立 Blob 物件
            const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
            
            // 建立下載連結
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', '113博幼館藏.csv');
            link.style.visibility = 'hidden';
            
            // 觸發下載
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            this.showLoadingIndicator(false);
            this.showToast(`成功匯出 ${this.books.length} 筆書籍資料到 CSV 檔案`, 'success');
            
            console.log(`CSV 匯出完成，共 ${this.books.length} 筆資料`);

        } catch (error) {
            console.error('匯出 CSV 失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('匯出 CSV 失敗', 'error');
        }
    }

    // 同步 Google Sheets 資料到本地 CSV
    async syncGoogleSheetsToCSV() {
        if (!this.requireAdmin('同步 Google Sheets 到 CSV')) return;
        
        const url = this.getGoogleWebAppUrl();
        if (!url) {
            this.showToast('請先設定 Google Sheets 同步網址', 'error');
            return;
        }

        try {
            this.showToast('正在從 Google Sheets 載入資料...', 'info');
            this.showLoadingIndicator(true);

            const response = await fetch(url, {
                method: 'POST',
                body: JSON.stringify({ action: 'pull' })
            });

            const result = await response.json().catch(() => null);
            if (!response.ok || !result || !result.ok) {
                throw new Error('Google Sheets 請求失敗');
            }

            const data = result.data || {};
            if (!Array.isArray(data.books)) {
                throw new Error('資料格式不正確');
            }

            if (data.books.length === 0) {
                this.showLoadingIndicator(false);
                this.showToast('Google Sheets 中沒有書籍資料', 'warning');
                return;
            }

            // 更新本地書籍資料
            this.books = data.books;
            this.borrowedBooks = data.borrowedBooks || [];
            
            // 處理博幼藏書資料
            if (data.boyouBooks && typeof data.boyouBooks === 'object') {
                localStorage.setItem('lib_boyou_books_v1', JSON.stringify(data.boyouBooks));
            }

            // 儲存到本地
            this.saveData();
            
            // 匯出為 CSV
            await this.exportToCSVData(data.books);
            
            // 重新渲染介面
            this.renderBooks();
            this.renderBorrowedBooks();
            this.updateStats();
            this.lastUpdateTime = new Date();
            this.updateLastUpdateDisplay();

            this.showLoadingIndicator(false);
            this.showToast(`成功同步 ${data.books.length} 本書籍到 CSV 檔案`, 'success');

        } catch (error) {
            console.error('同步 Google Sheets 到 CSV 失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('同步失敗，請檢查網路連線或 Google Sheets 設定', 'error');
        }
    }

    // 匯出書籍資料為 CSV (內部函數)
    async exportToCSVData(books) {
        try {
            // 建立 CSV 內容
            let csvContent = '博幼藏書,\n,\n欄1,欄2\n編號,書名\n';
            
            // 按書碼排序
            const sortedBooks = [...books].sort((a, b) => {
                if (a.id && b.id) {
                    return a.id.localeCompare(b.id);
                }
                return (a.title || '').localeCompare(b.title || '');
            });

            // 加入書籍資料
            sortedBooks.forEach(book => {
                const id = book.id || '';
                const title = book.title || '';
                csvContent += `${id},${title}\n`;
            });

            // 建立 Blob 物件
            const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
            
            // 建立下載連結
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', '113博幼館藏.csv');
            link.style.visibility = 'hidden';
            
            // 觸發下載
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            console.log(`CSV 匯出完成，共 ${books.length} 筆資料`);

        } catch (error) {
            console.error('匯出 CSV 資料失敗:', error);
            throw error;
        }
    }


    // 開始自動更新
    startAutoUpdate() {
        if (!this.isAdminUser()) {
            this.stopAutoUpdate();
            return;
        }
        // 清除現有的定時器
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }

        // 設定自動更新定時器
        this.updateTimer = setInterval(() => {
            this.autoUpdateBooks();
        }, this.settings.autoUpdateInterval);

        console.log(`自動更新已啟動，每 ${this.settings.autoUpdateInterval / 1000} 秒檢查一次`);
    }

    // 停止自動更新
    stopAutoUpdate() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
            console.log('自動更新已停止');
        }
    }

    // 自動更新書籍資料
    async autoUpdateBooks() {
        try {
            console.log('開始自動更新線上 Google Sheets 資料...');

            await this.pullFromGoogleSheets({ silent: true, protectEmpty: true, closeModal: false });
            this.lastUpdateTime = new Date();
            this.updateLastUpdateDisplay();
        } catch (error) {
            console.error('自動更新失敗:', error);
        }
    }

    // 更新最後更新時間顯示
    updateLastUpdateDisplay() {
        const lastUpdateElement = document.getElementById('last-update-time');
        if (lastUpdateElement && this.lastUpdateTime) {
            const timeString = this.lastUpdateTime.toLocaleString('zh-TW');
            lastUpdateElement.textContent = `最後更新：${timeString}`;
        }
    }

    // 切換自動更新狀態
    toggleAutoUpdate() {
        if (!this.requireAdmin('自動更新')) return;
        const button = document.getElementById('toggle-auto-update-btn');
        const statusElement = document.getElementById('auto-update-status');
        
        if (this.updateTimer) {
            // 停止自動更新
            this.stopAutoUpdate();
            button.innerHTML = '<i class="fas fa-play"></i> 啟動自動更新';
            button.className = 'btn btn-warning';
            statusElement.innerHTML = '<i class="fas fa-circle" style="color: #ff6b6b;"></i> 自動更新已停止';
            this.showToast('自動更新已停止', 'warning');
        } else {
            // 啟動自動更新
            this.startAutoUpdate();
            button.innerHTML = '<i class="fas fa-pause"></i> 停止自動更新';
            button.className = 'btn btn-success';
            statusElement.innerHTML = '<i class="fas fa-circle" style="color: #28a745;"></i> 自動更新已啟動';
            this.showToast('自動更新已啟動', 'success');
        }
    }

    // 顯示載入指示器
    showLoadingIndicator(show) {
        const statusElement = document.getElementById('auto-update-status');
        if (statusElement) {
            if (show) {
                statusElement.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在載入最新資料...';
                statusElement.style.color = '#007bff';
            } else {
                // 恢復正常狀態顯示
                if (this.updateTimer) {
                    statusElement.innerHTML = '<i class="fas fa-circle" style="color: #28a745;"></i> 自動更新已啟動';
                } else {
                    statusElement.innerHTML = '<i class="fas fa-circle" style="color: #ff6b6b;"></i> 自動更新已停止';
                }
            }
        }
    }

    // 跳轉到博幼藏書頁面
    goToBoyouBooks() {
        window.location.href = 'boyou-books.html';
    }

    // 顯示通知
    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        if (!toast) {
            console.log(`Toast (${type}): ${message}`);
            return;
        }
        toast.textContent = message;
        toast.className = `toast ${type}`;
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    // 匯出借閱清單為 Excel
    exportBorrowedToExcel() {
        if (!this.currentUser) {
            this.showToast('請先登入後再匯出', 'error');
            return;
        }

        // 依角色決定匯出內容（staff / 管理者 匯出全部未歸還，其餘僅匯出自己的未歸還）
        let records;
        const canExportAll = this.isAdminUser() || this.currentUser.role === 'staff';
        if (canExportAll) {
            records = this.borrowedBooks.filter(b => !b.returnedAt);
        } else {
            records = this.borrowedBooks.filter(b => b.userId === this.currentUser.username && !b.returnedAt);
        }

        if (!records || records.length === 0) {
            this.showToast('沒有可匯出的借閱記錄', 'warning');
            return;
        }

        // 老師/館員/管理者：單一檔案、每位借閱者一個工作表
        if (canExportAll) {
            const grouped = new Map();
            records.forEach(r => {
                if (!grouped.has(r.userId)) grouped.set(r.userId, []);
                grouped.get(r.userId).push(r);
            });

            const dateStr = new Date().toISOString().slice(0, 10);
            const header = ['借閱編號', '書碼', '書名', '借閱者', '借閱日期'];

            const wb = XLSX.utils.book_new();

            const sanitizeSheetName = (name) => {
                const invalid = /[\\\/:\*\?\[\]]/g; // Excel 禁止字元
                let safe = String(name).replace(invalid, ' ');
                if (!safe.trim()) safe = '借閱者';
                if (safe.length > 31) safe = safe.slice(0, 31);
                return safe;
            };

            grouped.forEach((userRecords, userId) => {
                const rows = userRecords.map(r => {
                    const borrowDate = new Date(r.borrowDate);
                    return [
                        r.id,
                        r.bookId,
                        r.bookTitle,
                        r.userId,
                        borrowDate.toLocaleDateString('zh-TW')
                    ];
                });

                const aoa = [header, ...rows];
                const ws = XLSX.utils.aoa_to_sheet(aoa);
                const colWidths = header.map((h, idx) => {
                    const maxLen = Math.max(
                        h.length,
                        ...rows.map(row => (row[idx] !== undefined && row[idx] !== null ? String(row[idx]).length : 0))
                    );
                    return { wch: Math.min(Math.max(maxLen + 2, 8), 40) };
                });
                ws['!cols'] = colWidths;

                const sheetName = sanitizeSheetName(userId);
                XLSX.utils.book_append_sheet(wb, ws, sheetName);
            });

            const filename = `借閱清單_全部_${dateStr}.xlsx`;
            XLSX.writeFile(wb, filename);
            this.showToast('已匯出單一檔案（多工作表）', 'success');
            return;
        }

        // 學生/訪客：只匯出自己的活頁簿
        const header = ['借閱編號', '書碼', '書名', '借閱者', '借閱日期'];
        const rows = records.map(r => {
            const borrowDate = new Date(r.borrowDate);
            return [
                r.id,
                r.bookId,
                r.bookTitle,
                r.userId,
                borrowDate.toLocaleDateString('zh-TW')
            ];
        });

        const aoa = [header, ...rows];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const colWidths = header.map((h, idx) => {
            const maxLen = Math.max(
                h.length,
                ...rows.map(row => (row[idx] !== undefined && row[idx] !== null ? String(row[idx]).length : 0))
            );
            return { wch: Math.min(Math.max(maxLen + 2, 8), 40) };
        });
        ws['!cols'] = colWidths;

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '借閱清單');
        const dateStr = new Date().toISOString().slice(0, 10);
        const filename = `借閱清單_${this.currentUser.username}_${dateStr}.xlsx`;
        XLSX.writeFile(wb, filename);
        this.showToast('已匯出借閱清單', 'success');
    }

    // 顯示搜尋封面模態框
    showFetchCoversModal() {
        if (!this.requireAdmin('一鍵搜尋封面')) return;
        
        const modal = document.getElementById('fetch-covers-modal');
        if (modal) {
            modal.style.display = 'block';
            // 重置表單
            document.getElementById('fetch-covers-form').reset();
            document.getElementById('range-options').style.display = 'none';
            document.getElementById('genre-options').style.display = 'none';
        }
    }

    // 處理搜尋封面表單提交
    async handleFetchCovers(e) {
        e.preventDefault();
        if (!this.requireAdmin('一鍵搜尋封面')) return;

        const rangeType = document.getElementById('fetch-range').value;
        const fetchCovers = document.getElementById('fetch-covers').checked;
        const fetchAuthors = document.getElementById('fetch-authors').checked;

        if (!fetchCovers && !fetchAuthors) {
            this.showToast('請至少選擇一種搜尋類型', 'error');
            return;
        }

        // 根據範圍類型篩選書籍
        let searchQueue = [];
        
        if (rangeType === 'all') {
            searchQueue = this.books.filter(book => 
                (fetchCovers && !book.coverUrl) || 
                (fetchAuthors && !book.author)
            );
        } else if (rangeType === 'range') {
            const startCode = document.getElementById('range-start').value.trim().toUpperCase();
            const endCode = document.getElementById('range-end').value.trim().toUpperCase();
            
            if (!startCode || !endCode) {
                this.showToast('請輸入起始和結束書碼', 'error');
                return;
            }

            searchQueue = this.books.filter(book => {
                const bookCode = book.id.toUpperCase();
                const inRange = bookCode >= startCode && bookCode <= endCode;
                const needsUpdate = (fetchCovers && !book.coverUrl) || (fetchAuthors && !book.author);
                return inRange && needsUpdate;
            });
        } else if (rangeType === 'genre') {
            const genre = document.getElementById('fetch-genre').value;
            searchQueue = this.books.filter(book => 
                book.genre === genre && 
                ((fetchCovers && !book.coverUrl) || (fetchAuthors && !book.author))
            );
        }

        if (searchQueue.length === 0) {
            this.showToast('在指定範圍內沒有需要更新的書籍', 'info');
            return;
        }

        // 關閉設定模態框，打開進度模態框
        document.getElementById('fetch-covers-modal').style.display = 'none';
        this.showSearchProgressModal();

        // 開始搜尋
        await this.startSearchProcess(searchQueue, fetchCovers, fetchAuthors);
    }

    // 切換搜尋選項顯示
    toggleFetchOptions(rangeType) {
        const rangeOptions = document.getElementById('range-options');
        const genreOptions = document.getElementById('genre-options');

        rangeOptions.style.display = rangeType === 'range' ? 'block' : 'none';
        genreOptions.style.display = rangeType === 'genre' ? 'block' : 'none';
    }

    // 顯示搜尋進度模態框
    showSearchProgressModal() {
        const modal = document.getElementById('search-progress-modal');
        if (modal) {
            modal.style.display = 'block';
            // 重置進度顯示
            this.updateProgressDisplay();
        }
    }

    // 開始搜尋處理
    async startSearchProcess(searchQueue, fetchCovers, fetchAuthors) {
        this.searchState = {
            isRunning: true,
            isPaused: false,
            shouldStop: false,
            currentIndex: 0,
            totalBooks: searchQueue.length,
            successCount: 0,
            failCount: 0,
            searchQueue: searchQueue,
            fetchCovers: fetchCovers,
            fetchAuthors: fetchAuthors
        };

        this.updateProgressDisplay();

        while (this.searchState.currentIndex < this.searchState.searchQueue.length && !this.searchState.shouldStop) {
            // 檢查是否暫停
            while (this.searchState.isPaused && !this.searchState.shouldStop) {
                await this.sleep(100);
            }

            if (this.searchState.shouldStop) break;

            const book = this.searchState.searchQueue[this.searchState.currentIndex];
            
            try {
                // 更新目前處理的書籍名稱
                document.getElementById('current-book-title').textContent = book.title;

                let success = false;

                // 搜尋封面
                if (this.searchState.fetchCovers && !book.coverUrl) {
                    const coverUrl = await this.searchBookCover(book.title, book.author);
                    if (coverUrl) {
                        book.coverUrl = coverUrl;
                        success = true;
                    }
                }

                // 搜尋作者
                if (this.searchState.fetchAuthors && !book.author) {
                    const author = await this.searchBookAuthor(book.title);
                    if (author) {
                        book.author = author;
                        success = true;
                    }
                }

                if (success) {
                    this.searchState.successCount++;
                } else {
                    this.searchState.failCount++;
                }

                this.searchState.currentIndex++;
                this.updateProgressDisplay();

                // 避免請求過於頻繁
                await this.sleep(1000);

            } catch (error) {
                console.error(`搜尋時發生錯誤 (${book.title}):`, error);
                this.searchState.failCount++;
                this.searchState.currentIndex++;
                this.updateProgressDisplay();
            }
        }

        // 搜尋完成
        this.finishSearchProcess();
    }

    // 更新進度顯示
    updateProgressDisplay() {
        const progress = (this.searchState.currentIndex / this.searchState.totalBooks) * 100;
        
        document.getElementById('progress-count').textContent = this.searchState.currentIndex;
        document.getElementById('progress-total').textContent = this.searchState.totalBooks;
        document.getElementById('success-count').textContent = this.searchState.successCount;
        document.getElementById('fail-count').textContent = this.searchState.failCount;
        document.getElementById('progress-fill').style.width = `${progress}%`;
    }

    // 暫停搜尋
    pauseSearch() {
        this.searchState.isPaused = true;
        document.getElementById('pause-search-btn').style.display = 'none';
        document.getElementById('resume-search-btn').style.display = 'inline-flex';
        this.showToast('搜尋已暫停', 'info');
    }

    // 繼續搜尋
    resumeSearch() {
        this.searchState.isPaused = false;
        document.getElementById('pause-search-btn').style.display = 'inline-flex';
        document.getElementById('resume-search-btn').style.display = 'none';
        this.showToast('搜尋已繼續', 'info');
    }

    // 停止搜尋
    stopSearch() {
        this.searchState.shouldStop = true;
        this.showToast('搜尋已停止', 'warning');
    }

    // 完成搜尋處理
    finishSearchProcess() {
        this.searchState.isRunning = false;
        
        // 儲存資料並更新顯示
        this.saveData();
        this.renderBooks();
        
        // 關閉進度模態框
        document.getElementById('search-progress-modal').style.display = 'none';
        
        // 顯示結果
        this.showToast(`搜尋完成！成功: ${this.searchState.successCount}, 失敗: ${this.searchState.failCount}`, 'success');
        
        // 搜尋完成不會觸發館藏同步（若需要可改為 'bulkImport'）
        this.triggerSyncForAction('search');
    }

    // 搜尋書籍作者
    async searchBookAuthor(title) {
        try {
            const query = encodeURIComponent(title);
            const apiUrl = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1&langRestrict=zh`;
            
            const response = await fetch(apiUrl);
            if (!response.ok) return null;
            
            const data = await response.json();
            
            if (data.items && data.items.length > 0) {
                const book = data.items[0];
                const authors = book.volumeInfo.authors;
                
                if (authors && authors.length > 0) {
                    return authors.join(', ');
                }
            }
            
            return null;
        } catch (error) {
            console.error('搜尋作者時發生錯誤:', error);
            return null;
        }
    }

    // 搜尋單本書籍封面
    async searchBookCover(title, author = '') {
        try {
            // 建構搜尋查詢
            let query = title;
            if (author) {
                query += ` ${author}`;
            }

            // 使用 Google Books API
            const apiUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1&langRestrict=zh`;
            
            const response = await fetch(apiUrl);
            if (!response.ok) return null;
            
            const data = await response.json();
            
            if (data.items && data.items.length > 0) {
                const book = data.items[0];
                const imageLinks = book.volumeInfo.imageLinks;
                
                if (imageLinks) {
                    // 優先使用大圖，如果沒有則使用中圖或縮圖
                    return imageLinks.extraLarge || 
                           imageLinks.large || 
                           imageLinks.medium || 
                           imageLinks.thumbnail || 
                           imageLinks.smallThumbnail;
                }
            }
            
            return null;
        } catch (error) {
            console.error('搜尋封面時發生錯誤:', error);
            return null;
        }
    }

    // 延遲函數
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 顯示載入指示器
    showLoadingIndicator(show) {
        let indicator = document.getElementById('loading-indicator');
        
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'loading-indicator';
            indicator.innerHTML = `
                <div class="loading-overlay">
                    <div class="loading-spinner">
                        <i class="fas fa-spinner fa-spin"></i>
                        <div class="loading-text">處理中...</div>
                    </div>
                </div>
            `;
            
            // 添加載入指示器的樣式
            const style = document.createElement('style');
            style.textContent = `
                .loading-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 9999;
                }
                
                .loading-spinner {
                    background: white;
                    padding: 30px;
                    border-radius: 12px;
                    text-align: center;
                    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
                }
                
                .loading-spinner i {
                    font-size: 2rem;
                    color: #667eea;
                    margin-bottom: 15px;
                }
                
                .loading-text {
                    font-size: 1.1rem;
                    color: #4a5568;
                    font-weight: 600;
                }
            `;
            
            document.head.appendChild(style);
            document.body.appendChild(indicator);
        }
        
        indicator.style.display = show ? 'flex' : 'none';
    }

    // 搜尋書籍資訊（當找不到書籍時使用）
    async searchBookInfo(searchTerm, preferredSource = null) {
        if (!searchTerm || searchTerm.trim() === '') {
            this.showToast('請輸入書名進行搜尋', 'error');
            return;
        }

        try {
            this.showToast('正在搜尋書籍資訊...', 'info');
            this.showLoadingIndicator(true);

            let results = [];

            // 如果指定了特定書庫，直接使用手動搜尋選項
            if (preferredSource === 'bookscom' || preferredSource === 'kingstone' || preferredSource === 'eslite') {
                this.showManualSearchOptions(searchTerm, []);
                return;
            }

            // 如果指定了多選搜尋，顯示多選介面
            if (preferredSource === 'multi') {
                this.showMultiSearchOptions(searchTerm);
                return;
            }

            // 先嘗試 Google Books API
            results = await this.searchFromGoogleBooks(searchTerm);
            
            // 如果 Google Books 沒有結果，直接提供書庫選擇
            if (results.length === 0) {
                this.showLoadingIndicator(false);
                this.showToast('Google Books 沒有找到資料，請選擇其他書庫', 'info');
                this.showManualSearchOptions(searchTerm, []);
                return;
            }
            
            // 如果 Google Books 結果不足，嘗試 Open Library
            if (results.length < 3) {
                this.showToast('正在擴大搜尋範圍...', 'info');
                
                // 嘗試 Open Library
                const openLibraryResults = await this.searchFromOpenLibrary(searchTerm);
                results = [...results, ...openLibraryResults];
                
                // 如果結果仍然不足，提供手動搜尋選項
                if (results.length < 8) {
                    this.showManualSearchOptions(searchTerm, results);
                    return;
                }
            }

            if (results.length === 0) {
                this.showLoadingIndicator(false);
                this.showToast('找不到相關書籍資訊', 'warning');
                return;
            }

            // 顯示搜尋結果
            this.showBookSearchResults(results, searchTerm);

        } catch (error) {
            console.error('搜尋書籍資訊失敗:', error);
            this.showLoadingIndicator(false);
            this.showToast('搜尋失敗，請檢查網路連線', 'error');
        }
    }

    // 從 Google Books API 搜尋
    async searchFromGoogleBooks(searchTerm) {
        try {
            const query = encodeURIComponent(searchTerm.trim());
            const apiUrl = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=5&langRestrict=zh`;

            // 使用 API 隊列機制
            const data = await this.enqueueApiRequest(async () => {
                return await this.fetchWithRetry(apiUrl);
            });
            
            if (!data.items || data.items.length === 0) return [];

            return data.items.map(book => ({
                source: 'Google Books',
                volumeInfo: book.volumeInfo,
                id: book.id
            }));

        } catch (error) {
            console.error('Google Books 搜尋失敗:', error);
            this.handleApiError(error, 'Google Books 搜尋失敗');
            return [];
        }
    }

    // 從 Open Library API 搜尋
    async searchFromOpenLibrary(searchTerm) {
        try {
            const query = encodeURIComponent(searchTerm.trim());
            const apiUrl = `https://openlibrary.org/search.json?q=${query}&limit=5&language=chi`;

            // 使用 API 隊列機制
            const data = await this.enqueueApiRequest(async () => {
                return await this.fetchWithRetry(apiUrl);
            });
            
            if (!data.docs || data.docs.length === 0) return [];

            return data.docs.map(book => ({
                source: 'Open Library',
                volumeInfo: {
                    title: book.title,
                    authors: book.author_name || [],
                    publisher: book.publisher ? [book.publisher] : [],
                    publishedDate: book.first_publish_year ? book.first_publish_year.toString() : '',
                    description: book.first_sentence ? book.first_sentence.join(' ') : '無簡介',
                    industryIdentifiers: book.isbn ? [
                        { type: 'ISBN_13', identifier: book.isbn[0] },
                        { type: 'ISBN_10', identifier: book.isbn[0] }
                    ] : [],
                    imageLinks: book.cover_i ? {
                        thumbnail: `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`,
                        smallThumbnail: `https://covers.openlibrary.org/b/id/${book.cover_i}-S.jpg`,
                        medium: `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`,
                        large: `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`
                    } : null
                },
                id: book.key.replace('/works/', '')
            }));

        } catch (error) {
            console.error('Open Library 搜尋失敗:', error);
            this.handleApiError(error, 'Open Library 搜尋失敗');
            return [];
        }
    }

    // 從博客來搜尋（使用代理方式）
    async searchFromBooksCom(searchTerm) {
        try {
            // 由於CORS限制，我們使用博客來的搜尋API代理
            const query = encodeURIComponent(searchTerm.trim());
            const apiUrl = `https://search.books.com.tw/search/query/key/${query}/cat/all`;

            // 使用CORS代理服務
            const proxyUrl = `https://cors-anywhere.herokuapp.com/${apiUrl}`;
            
            const response = await fetch(proxyUrl, {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            
            if (!response.ok) return [];

            const html = await response.text();
            
            // 解析HTML提取書籍資訊
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            const books = [];
            const bookElements = doc.querySelectorAll('.item');
            
            bookElements.forEach(element => {
                try {
                    const titleElement = element.querySelector('.title a');
                    const authorElement = element.querySelector('.author');
                    const imageElement = element.querySelector('img');
                    const publisherElement = element.querySelector('.publisher');
                    const yearElement = element.querySelector('.date');
                    
                    if (titleElement) {
                        const title = titleElement.textContent.trim();
                        const author = authorElement ? authorElement.textContent.trim() : '未知作者';
                        const coverUrl = imageElement ? imageElement.src || imageElement.getAttribute('data-src') : '';
                        const publisher = publisherElement ? publisherElement.textContent.trim() : '未知出版社';
                        const year = yearElement ? yearElement.textContent.trim().match(/\d{4}/)?.[0] || '未知年份' : '未知年份';
                        
                        books.push({
                            source: '博客來',
                            volumeInfo: {
                                title,
                                authors: [author],
                                publisher,
                                publishedDate: year,
                                description: '博客來書籍資料',
                                industryIdentifiers: [],
                                imageLinks: coverUrl ? {
                                    thumbnail: coverUrl,
                                    smallThumbnail: coverUrl
                                } : null
                            },
                            id: `bookscom_${books.length}`
                        });
                    }
                } catch (e) {
                    console.warn('解析博客來書籍資訊失敗:', e);
                }
            });
            
            return books.slice(0, 5); // 限制返回5本

        } catch (error) {
            console.error('博客來搜尋失敗:', error);
            return [];
        }
    }

    // 從金石堂搜尋（使用代理方式）
    async searchFromKingstone(searchTerm) {
        try {
            // 由於CORS限制，我們使用金石堂的搜尋API代理
            const query = encodeURIComponent(searchTerm.trim());
            const apiUrl = `https://www.kingstone.com.tw/search/search.aspx?searchkey=${query}`;

            // 使用CORS代理服務
            const proxyUrl = `https://cors-anywhere.herokuapp.com/${apiUrl}`;
            
            const response = await fetch(proxyUrl, {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            
            if (!response.ok) return [];

            const html = await response.text();
            
            // 解析HTML提取書籍資訊
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            const books = [];
            const bookElements = doc.querySelectorAll('.pdbookbox');
            
            bookElements.forEach(element => {
                try {
                    const titleElement = element.querySelector('.title a');
                    const authorElement = element.querySelector('.author');
                    const imageElement = element.querySelector('img');
                    const publisherElement = element.querySelector('.publish');
                    
                    if (titleElement) {
                        const title = titleElement.textContent.trim();
                        const author = authorElement ? authorElement.textContent.trim() : '未知作者';
                        const coverUrl = imageElement ? imageElement.src || imageElement.getAttribute('data-src') : '';
                        const publisher = publisherElement ? publisherElement.textContent.trim() : '未知出版社';
                        const year = '未知年份';
                        
                        books.push({
                            source: '金石堂',
                            volumeInfo: {
                                title,
                                authors: [author],
                                publisher,
                                publishedDate: year,
                                description: '金石堂書籍資料',
                                industryIdentifiers: [],
                                imageLinks: coverUrl ? {
                                    thumbnail: coverUrl,
                                    smallThumbnail: coverUrl
                                } : null
                            },
                            id: `kingstone_${books.length}`
                        });
                    }
                } catch (e) {
                    console.warn('解析金石堂書籍資訊失敗:', e);
                }
            });
            
            return books.slice(0, 5); // 限制返回5本

        } catch (error) {
            console.error('金石堂搜尋失敗:', error);
            return [];
        }
    }

    // 顯示手動搜尋選項
    showManualSearchOptions(searchTerm, currentResults) {
        this.showLoadingIndicator(false);
        
        // 處理特殊字符，避免JavaScript語法錯誤
        const safeSearchTerm = searchTerm.replace(/'/g, "\\'").replace(/"/g, '\\"');

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 600px;">
                <span class="close">&times;</span>
                <h2><i class="fas fa-search"></i> 選擇書庫搜尋</h2>
                <p>請選擇要搜尋的書庫，或使用自動搜尋：</p>
                
                <div class="search-source-buttons">
                    <button class="btn btn-primary" onclick="this.closest('.modal').remove(); library.searchBookInfo('${safeSearchTerm}', 'auto')">
                        <i class="fas fa-globe"></i> 自動搜尋
                    </button>
                    <button class="btn btn-info" onclick="this.closest('.modal').remove(); library.searchBookInfo('${safeSearchTerm}', 'multi')">
                        <i class="fas fa-check-square"></i> 多選搜尋
                    </button>
                    <button class="btn btn-success" onclick="this.closest('.modal').remove(); library.openBooksComSearch('${safeSearchTerm}')">
                        <i class="fas fa-book"></i> 博客來
                    </button>
                    <button class="btn btn-warning" onclick="this.closest('.modal').remove(); library.openKingstoneSearch('${safeSearchTerm}')">
                        <i class="fas fa-book-open"></i> 金石堂
                    </button>
                    <button class="btn btn-secondary" onclick="this.closest('.modal').remove(); library.openEsliteSearch('${safeSearchTerm}')">
                        <i class="fas fa-globe"></i> 誠品線上
                    </button>
                </div>
                
                <div class="search-source-info">
                    <h4><i class="fas fa-info-circle"></i> 書庫說明</h4>
                    <div class="source-grid">
                        <div class="source-item">
                            <strong>自動搜尋</strong>
                            <p>Google Books + Open Library，適合搜尋外文書籍</p>
                        </div>
                        <div class="source-item">
                            <strong>博客來</strong>
                            <p>台灣最大線上書店，中文書籍最齊全</p>
                        </div>
                        <div class="source-item">
                            <strong>金石堂</strong>
                            <p>知名連鎖書店，暢銷書豐富</p>
                        </div>
                        <div class="source-item">
                            <strong>誠品線上</strong>
                            <p>文化藝術書店，文學設計類豐富</p>
                        </div>
                    </div>
                </div>
                
                <div class="form-actions">
                    <button type="button" class="btn btn-outline" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 取消
                    </button>
                    <button type="button" class="btn btn-success" onclick="library.openBooksComSearch('${safeSearchTerm}')">
                        <i class="fas fa-external-link-alt"></i> 測試博客來
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.style.display = 'block';

        // 設置關閉事件
        modal.querySelector('.close').onclick = () => modal.remove();
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }

    // 開啟博客來搜尋
    openBooksComSearch(searchTerm) {
        const query = encodeURIComponent(searchTerm.trim());
        const url = `https://search.books.com.tw/search/query/key/${query}/cat/all`;
        window.open(url, '_blank');
        this.showToast('已開啟博客來搜尋頁面', 'info');
    }

    // 開啟金石堂搜尋
    openKingstoneSearch(searchTerm) {
        const query = encodeURIComponent(searchTerm.trim());
        const url = `https://www.kingstone.com.tw/search/search.aspx?searchkey=${query}`;
        window.open(url, '_blank');
        this.showToast('已開啟金石堂搜尋頁面', 'info');
    }

    // 開啟誠品搜尋
    openEsliteSearch(searchTerm) {
        const query = encodeURIComponent(searchTerm.trim());
        const url = `https://www.eslite.com/Search.aspx?keyword=${query}`;
        window.open(url, '_blank');
        this.showToast('已開啟誠品搜尋頁面', 'info');
    }

    // 顯示多選搜尋選項
    showMultiSearchOptions(searchTerm) {
        this.showLoadingIndicator(false);
        
        // 處理特殊字符，避免JavaScript語法錯誤
        const safeSearchTerm = searchTerm.replace(/'/g, "\\'").replace(/"/g, '\\"');

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 700px;">
                <span class="close">&times;</span>
                <h2><i class="fas fa-search"></i> 多選書庫搜尋</h2>
                <p>選擇要搜尋的書庫，可以同時開啟多個書庫：</p>
                
                <div class="multi-search-grid">
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="google-books" checked>
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>🌐 Google Books</strong>
                                <p>國際書籍資料庫，外文書籍豐富</p>
                            </div>
                        </label>
                    </div>
                    
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="open-library" checked>
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>📚 Open Library</strong>
                                <p>開放書籍資料庫，書籍數量龐大</p>
                            </div>
                        </label>
                    </div>
                    
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="books-com">
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>📖 博客來</strong>
                                <p>台灣最大線上書店，中文書籍最齊全</p>
                            </div>
                        </label>
                    </div>
                    
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="kingstone">
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>📕 金石堂</strong>
                                <p>知名連鎖書店，暢銷書豐富</p>
                            </div>
                        </label>
                    </div>
                    
                    <div class="search-source-item">
                        <label class="checkbox-container">
                            <input type="checkbox" id="eslite">
                            <span class="checkmark"></span>
                            <div class="source-info">
                                <strong>🎨 誠品線上</strong>
                                <p>文化藝術書店，文學設計類豐富</p>
                            </div>
                        </label>
                    </div>
                </div>
                
                <div class="search-actions">
                    <button class="btn btn-primary" onclick="library.executeMultiSearch('${safeSearchTerm}')">
                        <i class="fas fa-search"></i> 開始搜尋
                    </button>
                    <button class="btn btn-success" onclick="library.selectAllSources()">
                        <i class="fas fa-check-square"></i> 全選
                    </button>
                    <button class="btn btn-outline" onclick="library.deselectAllSources()">
                        <i class="fas fa-square"></i> 取消全選
                    </button>
                </div>
                
                <div class="form-actions">
                    <button type="button" class="btn btn-outline" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 取消
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.style.display = 'block';

        // 設置關閉事件
        modal.querySelector('.close').onclick = () => modal.remove();
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }

    // 執行多選搜尋
    async executeMultiSearch(searchTerm) {
        const sources = {
            'google-books': document.getElementById('google-books').checked,
            'open-library': document.getElementById('open-library').checked,
            'books-com': document.getElementById('books-com').checked,
            'kingstone': document.getElementById('kingstone').checked,
            'eslite': document.getElementById('eslite').checked
        };

        // 關閉多選介面
        document.querySelector('.modal').remove();

        // 開啟選中的書庫
        if (sources['books-com']) {
            this.openBooksComSearch(searchTerm);
        }
        if (sources['kingstone']) {
            this.openKingstoneSearch(searchTerm);
        }
        if (sources['eslite']) {
            this.openEsliteSearch(searchTerm);
        }

        // 對於API書庫，執行搜尋並顯示結果
        let apiResults = [];
        
        if (sources['google-books']) {
            this.showToast('正在搜尋 Google Books...', 'info');
            const googleResults = await this.searchFromGoogleBooks(searchTerm);
            apiResults = [...apiResults, ...googleResults];
        }
        
        if (sources['open-library']) {
            this.showToast('正在搜尋 Open Library...', 'info');
            const openLibraryResults = await this.searchFromOpenLibrary(searchTerm);
            apiResults = [...apiResults, ...openLibraryResults];
        }

        // 如果有API結果，顯示搜尋結果
        if (apiResults.length > 0) {
            this.showBookSearchResults(apiResults, searchTerm);
        } else if (!sources['books-com'] && !sources['kingstone'] && !sources['eslite']) {
            this.showToast('請至少選擇一個書庫', 'warning');
        } else {
            this.showToast('已開啟選中的書庫網站', 'info');
        }
    }

    // 全選所有書庫
    selectAllSources() {
        const checkboxes = document.querySelectorAll('.multi-search-grid input[type="checkbox"]');
        checkboxes.forEach(checkbox => checkbox.checked = true);
    }

    // 取消全選所有書庫
    deselectAllSources() {
        const checkboxes = document.querySelectorAll('.multi-search-grid input[type="checkbox"]');
        checkboxes.forEach(checkbox => checkbox.checked = false);
    }

    // 顯示書籍搜尋結果
    showBookSearchResults(books, searchTerm) {
        this.showLoadingIndicator(false);
        
        // 保存搜尋結果供其他函數使用
        this.searchResults = books;

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 800px;">
                <span class="close">&times;</span>
                <h2><i class="fas fa-search"></i> 書籍搜尋結果</h2>
                <div class="search-results">
                    ${books.map((book, index) => {
                        const info = book.volumeInfo;
                        const coverUrl = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '';
                        const authors = info.authors ? info.authors.join(', ') : '未知作者';
                        const publisher = info.publisher || '未知出版社';
                        const publishedDate = info.publishedDate ? info.publishedDate.substring(0, 4) : '未知年份';
                        const isbn = info.industryIdentifiers?.find(id => id.type === 'ISBN_13')?.identifier || 
                                     info.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier || '';
                        const description = info.description ? info.description.substring(0, 200) + '...' : '無簡介';

                        return `
                            <div class="search-result-item">
                                <div class="search-result-cover">
                                    ${coverUrl ? `<img src="${coverUrl}" alt="${info.title}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                                    <div class="search-result-cover-placeholder" style="display: none;">
                                        <i class="fas fa-book"></i>
                                    </div>` : `
                                    <div class="search-result-cover-placeholder">
                                        <i class="fas fa-book"></i>
                                    </div>`}
                                </div>
                                <div class="search-result-info">
                                    <div class="search-result-header">
                                        <h3 class="search-result-title">${info.title}</h3>
                                        <span class="search-result-source ${book.source === 'Google Books' ? 'google-books' : book.source === 'Open Library' ? 'open-library' : book.source === '博客來' ? 'books-com' : book.source === '金石堂' ? 'kingstone' : ''}">${book.source || '未知來源'}</span>
                                    </div>
                                    <div class="search-result-details">
                                        <p><strong>作者：</strong>${authors}</p>
                                        <p><strong>出版社：</strong>${publisher}</p>
                                        <p><strong>出版年份：</strong>${publishedDate}</p>
                                        ${isbn ? `<p><strong>ISBN：</strong>${isbn}</p>` : ''}
                                        <p><strong>簡介：</strong>${description}</p>
                                    </div>
                                    <div class="search-result-actions">
                                        <button class="btn btn-primary btn-sm" onclick="library.copyBookInfo(${index})">
                                            <i class="fas fa-copy"></i> 複製資訊
                                        </button>
                                        ${this.isAdminUser() ? `
                                        <button class="btn btn-success btn-sm" onclick="library.addBookFromSearch(${index})">
                                            <i class="fas fa-plus"></i> 新增到館藏
                                        </button>` : ''}
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-outline" onclick="this.closest('.modal').remove()">
                        <i class="fas fa-times"></i> 關閉
                    </button>
                </div>
            </div>
        `;

        // 儲存搜尋結果供後續使用
        this.searchResults = books;
        this.searchTerm = searchTerm;

        document.body.appendChild(modal);
        modal.style.display = 'block';

        // 設置關閉事件
        modal.querySelector('.close').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    // 複製書籍資訊
    copyBookInfo(index) {
        const book = this.searchResults[index];
        const info = book.volumeInfo;
        
        const authors = info.authors ? info.authors.join(', ') : '未知作者';
        const publisher = info.publisher || '未知出版社';
        const publishedDate = info.publishedDate ? info.publishedDate.substring(0, 4) : '未知年份';
        const isbn = info.industryIdentifiers?.find(id => id.type === 'ISBN_13')?.identifier || 
                     info.industryIdentifiers?.find(id => id.type === 'ISBN_10')?.identifier || '';
        const coverUrl = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '';

        // 檢查編輯模態框是否開啟
        const editModal = document.getElementById('edit-book-modal');
        const isEditModalOpen = editModal && editModal.style.display === 'block';

        if (isEditModalOpen) {
            // 如果編輯模態框開啟，直接填入表單
            this.fillEditFormWithBookInfo(info.title, authors, coverUrl, publishedDate);
            this.showToast('書籍資訊已填入編輯表單', 'success');
        } else {
            // 否則複製到剪貼簿
            const bookInfo = `書名：${info.title}
作者：${authors}
出版社：${publisher}
出版年份：${publishedDate}
${isbn ? `ISBN：${isbn}` : ''}
封面圖片：${coverUrl}`;

            // 複製到剪貼簿
            navigator.clipboard.writeText(bookInfo).then(() => {
                this.showToast('書籍資訊已複製到剪貼簿', 'success');
            }).catch(() => {
                // 如果剪貼簿 API 失敗，使用傳統方法
                const textArea = document.createElement('textarea');
                textArea.value = bookInfo;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                this.showToast('書籍資訊已複製到剪貼簿', 'success');
            });
        }
    }

    // 將書籍資訊填入編輯表單
    fillEditFormWithBookInfo(title, author, coverUrl, year) {
        const titleInput = document.getElementById('edit-book-title');
        const authorInput = document.getElementById('edit-book-author');
        const coverInput = document.getElementById('edit-book-cover-url');
        const yearInput = document.getElementById('edit-book-year');

        // 只填入空白的欄位
        if (titleInput && !titleInput.value.trim()) {
            titleInput.value = title;
        }
        if (authorInput && !authorInput.value.trim()) {
            authorInput.value = author;
        }
        if (coverInput && !coverInput.value.trim()) {
            coverInput.value = coverUrl;
        }
        if (yearInput && yearInput.value === this.settings.defaultYear) {
            yearInput.value = year;
        }
    }

    // 從搜尋結果新增書籍
    addBookFromSearch(index) {
        const book = this.searchResults[index];
        const info = book.volumeInfo;
        
        // 預填新增書籍表單
        const suggestedId = this.suggestNextBookId();
        const idEl = document.getElementById('book-id');
        if (idEl && !idEl.value.trim()) idEl.value = suggestedId;
        document.getElementById('book-title').value = info.title || '';
        document.getElementById('book-author').value = info.authors ? info.authors.join(', ') : '';
        document.getElementById('book-year').value = info.publishedDate ? info.publishedDate.substring(0, 4) : new Date().getFullYear();
        document.getElementById('book-cover-url').value = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '';
        
        // 關閉搜尋結果模態框
        document.querySelector('.modal').remove();
        
        // 顯示新增書籍模態框
        this.showAddBookModal();
        
        this.showToast('已將書籍資訊填入新增表單', 'success');
    }

}

// 初始化系統
const library = new LibrarySystem();

// 全域函數（供HTML調用）
window.library = library;
