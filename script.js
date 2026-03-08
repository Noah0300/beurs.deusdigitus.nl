const SESSION_STORAGE_KEY = 'userSession';
const USERS_STORAGE_KEY = 'appUsers';
const PRODUCTS_STORAGE_KEY = 'vinylProducts';
const BARCODE_METADATA_CACHE_KEY = 'barcodeMetadataCache';
const FAIRS_STORAGE_KEY = 'plannedFairs';
const TRANSACTIONS_STORAGE_KEY = 'salesTransactions';
const BERTUS_API_KEY_STORAGE = 'bertusApiKey';
const BERTUS_ACCOUNT_ID_STORAGE = 'bertusAccountId';
const LIVE_DATA_CLEANUP_KEY = 'liveDataCleanupV1';
let currentServerSession = null;
let sessionAddedProducts = [];
let importPreviewRows = [];
let cashierCart = [];
let cashierVideoStream = null;
let cashierScannerActive = false;
let cashierScannerMode = '';
let cashierHtml5Qr = null;
let cashierPrecisionMode = false;
let cashierConnectivityTimer = null;
let sharedDataSyncTimer = null;

const CAMERA_CONSTRAINTS_NORMAL = {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 }
};

const CAMERA_CONSTRAINTS_PRECISION = {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 }
};

const SEARCH_SORT_STATE = {
    key: 'artist',
    direction: 'asc'
};

function usePrettyRoutes() {
    const host = String(window.location.hostname || '').toLowerCase();
    if (host.endsWith('github.io') || host === 'localhost' || host === '127.0.0.1') {
        return false;
    }
    return true;
}

function routePath(name) {
    const pretty = {
        login: './',
        dashboard: './dashboard',
        cashier: './cashier'
    };
    const fallback = {
        login: './index.html',
        dashboard: './dashboard.html',
        cashier: './cashier.html'
    };
    return usePrettyRoutes() ? pretty[name] : fallback[name];
}

function goToRoute(name) {
    window.location.href = routePath(name);
}

async function apiRequest(path, options = {}) {
    const response = await fetch(path, {
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        ...options
    });

    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }
    return { response, data };
}

async function syncProductsFromServer() {
    const { response, data } = await apiRequest('./api/products', { method: 'GET', cache: 'no-store' });
    if (!response.ok || !data || !Array.isArray(data.products)) return false;
    localStorage.setItem(PRODUCTS_STORAGE_KEY, JSON.stringify(data.products));
    return true;
}

function setStoredTransactionsLocal(transactions) {
    localStorage.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify(transactions));
}

async function syncTransactionsFromServer() {
    const { response, data } = await apiRequest('./api/transactions', { method: 'GET', cache: 'no-store' });
    if (!response.ok || !data || !Array.isArray(data.transactions)) return false;
    setStoredTransactionsLocal(data.transactions);
    return true;
}

async function persistTransactions(transactions) {
    setStoredTransactionsLocal(transactions);
    const { response } = await apiRequest('./api/transactions', {
        method: 'PUT',
        body: JSON.stringify({ transactions })
    });
    return response.ok;
}

function setStoredFairsLocal(fairs) {
    localStorage.setItem(FAIRS_STORAGE_KEY, JSON.stringify(fairs));
}

async function syncFairsFromServer() {
    const { response, data } = await apiRequest('./api/fairs', { method: 'GET', cache: 'no-store' });
    if (!response.ok || !data || !Array.isArray(data.fairs)) return false;
    setStoredFairsLocal(data.fairs);
    return true;
}

async function persistFairs(fairs) {
    setStoredFairsLocal(fairs);
    const { response } = await apiRequest('./api/fairs', {
        method: 'PUT',
        body: JSON.stringify({ fairs })
    });
    return response.ok;
}

async function persistProducts(products, showSyncError = false) {
    localStorage.setItem(PRODUCTS_STORAGE_KEY, JSON.stringify(products));
    const { response, data } = await apiRequest('./api/products', {
        method: 'PUT',
        body: JSON.stringify({ products })
    });
    if (!response.ok && showSyncError) {
        const message = data && data.message ? data.message : 'Voorraad kon niet met server synchroniseren.';
        showCashierMessage(message, 'error');
    }
    return response.ok;
}

function cleanupLiveDataOnce() {
    try {
        if (localStorage.getItem(LIVE_DATA_CLEANUP_KEY) === 'done') return;
        const keysToClear = [
            SESSION_STORAGE_KEY,
            USERS_STORAGE_KEY,
            PRODUCTS_STORAGE_KEY,
            BARCODE_METADATA_CACHE_KEY,
            FAIRS_STORAGE_KEY,
            TRANSACTIONS_STORAGE_KEY,
            BERTUS_API_KEY_STORAGE,
            BERTUS_ACCOUNT_ID_STORAGE
        ];
        keysToClear.forEach((key) => localStorage.removeItem(key));
        localStorage.setItem(LIVE_DATA_CLEANUP_KEY, 'done');
    } catch {
        // ignore storage cleanup errors in restricted/private modes
    }
}

// ==================== LOGIN PAGE ====================

cleanupLiveDataOnce();

if (document.getElementById('loginForm')) {
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');

    loginForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const { response, data } = await apiRequest('./api/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });

        if (!response.ok || !data || !data.user) {
            errorMessage.textContent = data && data.message ? data.message : 'Gebruikersnaam of wachtwoord is onjuist.';
            errorMessage.classList.add('show');
            document.getElementById('password').value = '';
            setTimeout(() => {
                errorMessage.classList.remove('show');
            }, 5000);
            return;
        }

        currentServerSession = data.user;
        goToRoute(data.user.role === 'admin' ? 'dashboard' : 'cashier');
    });
}

// ==================== DASHBOARD PAGE ====================

const isDashboardPage = !!document.querySelector('.section-nav');
const isCashierPage = !!document.getElementById('cashierApp');

registerOfflineSupport();

if (isDashboardPage) {
    initializeAppForRole('admin');
}

if (isCashierPage) {
    initializeAppForRole('cashier');
}

function registerOfflineSupport() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((error) => {
            console.warn('Service worker registration failed:', error);
        });
    });
}

async function checkAuthentication(requiredRole = null) {
    const { response, data } = await apiRequest('./api/me', { method: 'GET', cache: 'no-store' });
    if (!response.ok || !data || !data.user) {
        goToRoute('login');
        return null;
    }

    const session = data.user;
    currentServerSession = session;
    if (requiredRole && session.role !== requiredRole) {
        goToRoute(session.role === 'admin' ? 'dashboard' : 'cashier');
        return null;
    }

    const displayName = session.username.charAt(0).toUpperCase() + session.username.slice(1);
    const userNameElement = document.getElementById('userName');
    if (userNameElement) userNameElement.textContent = displayName;
    const dashboardUserNameElement = document.getElementById('dashboardUserName');
    if (dashboardUserNameElement) dashboardUserNameElement.textContent = displayName;
    const sessionUserElement = document.getElementById('sessionUser');
    if (sessionUserElement) sessionUserElement.textContent = displayName;

    const loginTime = session.loginTime ? new Date(session.loginTime) : new Date();
    const sessionTimeElement = document.getElementById('sessionTime');
    if (sessionTimeElement) updateSessionTime(loginTime);
    return session;
}

async function initializeAppForRole(requiredRole) {
    const session = await checkAuthentication(requiredRole);
    if (!session) return;
    await syncProductsFromServer();
    await syncFairsFromServer();
    await syncTransactionsFromServer();

    if (requiredRole === 'admin') {
        initializeTopNavigation();
        initializeDashboard();
        initializeTransactionsPage();
        initializeAssignTransactionsPage();
        initializePastFairsPage();
        initializeUserManagement();
        initializeProductForm();
        initializeFairPlanner();
        initializeProductSearch();
        initializeImportTab();
        renderDashboardAgenda();
    }

    if (requiredRole === 'cashier') {
        initializeCashierPage();
        initializeCashierConnectivity();
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);
    startSharedDataSync(requiredRole);
}

function startSharedDataSync(role) {
    if (sharedDataSyncTimer) {
        clearInterval(sharedDataSyncTimer);
    }
    sharedDataSyncTimer = setInterval(async () => {
        await syncProductsFromServer();
        await syncFairsFromServer();
        await syncTransactionsFromServer();

        if (role === 'admin') {
            renderDashboardAgenda();
            renderDashboardOverview();
            renderPlannedFairsTable();
            renderTransactionsTable();
            renderAssignTransactionsTable();
            renderPastFairsPage();
            const searchInput = document.getElementById('productSearchInput');
            if (searchInput) renderSearchResults(searchInput.value);
        } else if (role === 'cashier') {
            renderCashierCart();
        }
    }, 10000);
}

function updateSessionTime(loginTime) {
    const loginTimeElement = document.getElementById('sessionTime');

    function updateDisplay() {
        const now = new Date();
        const diff = now - loginTime;
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        let timeString = '';
        if (hours > 0) {
            timeString = `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            timeString = `${minutes}m ${seconds}s`;
        } else {
            timeString = `${seconds}s`;
        }

        loginTimeElement.textContent = timeString;
    }

    updateDisplay();
    setInterval(updateDisplay, 1000);
}

function initializeDashboard() {
    renderDashboardAgenda();
    renderDashboardOverview();
}

function initializeTransactionsPage() {
    const tableBody = document.getElementById('transactionsTableBody');

    if (tableBody) {
        tableBody.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (!target.classList.contains('cancel-transaction-btn')) return;

            const transactionId = target.getAttribute('data-transaction-id') || '';
            if (!transactionId) return;
            void cancelTransaction(transactionId);
        });
    }
    renderTransactionsTable();
}

function initializeAssignTransactionsPage() {
    const tableBody = document.getElementById('assignTransactionsTableBody');
    const assignBtn = document.getElementById('assignSelectedTransactionsBtn');
    const selectAllCheckbox = document.getElementById('assignTransactionSelectAll');

    if (assignBtn) {
        assignBtn.addEventListener('click', () => {
            void assignSelectedTransactionsToFair();
        });
    }

    if (selectAllCheckbox && tableBody) {
        selectAllCheckbox.addEventListener('change', () => {
            const checked = selectAllCheckbox.checked;
            const rowCheckboxes = tableBody.querySelectorAll('.assign-transaction-checkbox');
            rowCheckboxes.forEach((checkbox) => {
                if (checkbox instanceof HTMLInputElement) checkbox.checked = checked;
            });
        });

        tableBody.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (!target.classList.contains('assign-transaction-checkbox')) return;
            syncAssignTransactionSelectAllState();
        });
    }

    populateAssignTransactionFairSelect();
    renderAssignTransactionsTable();
    updateAssignTransactionsTabVisibility();
}

function initializePastFairsPage() {
    renderPastFairsPage();
}

function initializeUserManagement() {
    const section = document.getElementById('userManagementSection');
    const form = document.getElementById('userManagementForm');
    const usersTableBody = document.getElementById('usersTableBody');
    const createUserBtn = document.getElementById('createUserBtn');
    if (!section || !form || !usersTableBody || !createUserBtn) return;

    const isMainAdmin = Boolean(currentServerSession && currentServerSession.isMainAdmin);
    if (!isMainAdmin) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    renderUsersTable();

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const usernameInput = document.getElementById('newUserNameInput');
        const passwordInput = document.getElementById('newUserPasswordInput');
        const roleInput = document.getElementById('newUserRoleInput');
        if (!(usernameInput instanceof HTMLInputElement) || !(passwordInput instanceof HTMLInputElement) || !(roleInput instanceof HTMLSelectElement)) {
            return;
        }

        const username = String(usernameInput.value || '').trim().toLowerCase();
        const password = String(passwordInput.value || '').trim();
        const role = roleInput.value === 'admin' ? 'admin' : 'cashier';

        if (!username || username.length < 3) {
            showUserManagementMessage('Gebruikersnaam moet minimaal 3 tekens zijn.', 'error');
            return;
        }
        if (!/^[a-z0-9._-]+$/.test(username)) {
            showUserManagementMessage('Gebruik alleen letters, cijfers, punt, streepje of underscore.', 'error');
            return;
        }
        if (!password || password.length < 6) {
            showUserManagementMessage('Wachtwoord moet minimaal 6 tekens zijn.', 'error');
            return;
        }

        const { response, data } = await apiRequest('./api/users', {
            method: 'POST',
            body: JSON.stringify({ username, password, role })
        });
        if (!response.ok) {
            showUserManagementMessage(data && data.message ? data.message : 'Gebruiker aanmaken mislukt.', 'error');
            return;
        }

        renderUsersTable();
        showUserManagementMessage('Gebruiker aangemaakt.', 'success');

        usernameInput.value = '';
        passwordInput.value = '';
        roleInput.value = 'cashier';
    });

    usersTableBody.addEventListener('click', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.classList.contains('delete-user-btn')) return;

        const username = target.getAttribute('data-username') || '';
        if (!username) return;

        const confirmed = window.confirm(`Gebruiker "${username}" verwijderen?`);
        if (!confirmed) return;

        const { response, data } = await apiRequest(`./api/users/${encodeURIComponent(username)}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            showUserManagementMessage(data && data.message ? data.message : 'Gebruiker verwijderen mislukt.', 'error');
            return;
        }

        renderUsersTable();
        showUserManagementMessage('Gebruiker verwijderd.', 'success');
    });
}

async function renderUsersTable() {
    const usersTableBody = document.getElementById('usersTableBody');
    if (!usersTableBody) return;

    const { response, data } = await apiRequest('./api/users', { method: 'GET', cache: 'no-store' });
    if (!response.ok || !data || !Array.isArray(data.users)) {
        usersTableBody.innerHTML = '<tr><td colspan="4" class="empty-row">Accounts konden niet worden geladen.</td></tr>';
        return;
    }

    const users = data.users.slice().sort((a, b) => a.username.localeCompare(b.username, 'nl'));
    if (users.length === 0) {
        usersTableBody.innerHTML = '<tr><td colspan="4" class="empty-row">Nog geen accounts gevonden.</td></tr>';
        return;
    }

    usersTableBody.innerHTML = users.map((user) => `
        <tr>
            <td>${escapeHtml(user.username)}</td>
            <td>${escapeHtml(user.role)}</td>
            <td>${user.isMainAdmin ? 'Hoofd-admin' : 'Standaard'}</td>
            <td>
                ${user.isMainAdmin
                    ? '<span class="empty-row">Niet verwijderbaar</span>'
                    : `<button type="button" class="danger-btn delete-user-btn" data-username="${escapeHtml(user.username)}">Verwijder</button>`}
            </td>
        </tr>
    `).join('');
}

function showUserManagementMessage(message, type) {
    const messageElement = document.getElementById('userManagementMessage');
    if (!messageElement) return;

    messageElement.textContent = message;
    messageElement.className = 'form-message show';
    if (type === 'error') messageElement.classList.add('error');
    if (type === 'success') messageElement.classList.add('success');
    if (type === 'info') messageElement.classList.add('info');
}

function initializeTopNavigation() {
    const navButtons = document.querySelectorAll('.section-nav-btn');
    if (navButtons.length === 0) return;

    navButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const targetPage = button.getAttribute('data-page-target');
            if (!targetPage) return;
            showDashboardPage(targetPage);
        });
    });
}

function showDashboardPage(pageId) {
    const pages = document.querySelectorAll('.dashboard-page');
    const navButtons = document.querySelectorAll('.section-nav-btn');

    pages.forEach((page) => {
        page.classList.toggle('active', page.id === pageId);
    });

    navButtons.forEach((button) => {
        const target = button.getAttribute('data-page-target');
        button.classList.toggle('active', target === pageId);
    });

    if (pageId === 'pageAddStock') {
        const barcodeInput = document.getElementById('barcodeInput');
        if (barcodeInput) barcodeInput.focus();
    }

    if (pageId === 'pageUpdateStock') {
        renderPlannedFairsTable();
        const fairNameInput = document.getElementById('fairNameInput');
        if (fairNameInput) fairNameInput.focus();
    }

    if (pageId === 'pageSearchManage') {
        const searchInput = document.getElementById('productSearchInput');
        renderSearchResults(searchInput ? searchInput.value : '');
        if (searchInput) searchInput.focus();
    }

    if (pageId === 'pageTransactions') {
        renderTransactionsTable();
    }

    if (pageId === 'pageAssignTransactions') {
        populateAssignTransactionFairSelect();
        renderAssignTransactionsTable();
    }

    if (pageId === 'pagePastFairs') {
        renderPastFairsPage();
    }

    if (pageId === 'pageImport') {
        const importFileInput = document.getElementById('importFileInput');
        if (importFileInput) importFileInput.focus();
    }

    if (pageId === 'pageDashboard') {
        renderDashboardAgenda();
        renderDashboardOverview();
        renderUsersTable();
    }
}

function initializeCashierPage() {
    const barcodeInput = document.getElementById('cashierBarcodeInput');
    const addBtn = document.getElementById('cashierAddBtn');
    const checkoutBtn = document.getElementById('checkoutBtn');
    const cartTableBody = document.getElementById('cashierCartTableBody');
    const cameraScanBtn = document.getElementById('cameraScanBtn');
    const stopCameraScanBtn = document.getElementById('stopCameraScanBtn');
    const togglePrecisionModeBtn = document.getElementById('togglePrecisionModeBtn');
    if (!barcodeInput || !addBtn || !checkoutBtn || !cartTableBody) return;

    barcodeInput.focus();
    renderCashierCart();

    addBtn.addEventListener('click', () => {
        addBarcodeToCart(barcodeInput.value);
        barcodeInput.value = '';
        barcodeInput.focus();
    });

    barcodeInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        addBarcodeToCart(barcodeInput.value);
        barcodeInput.value = '';
    });

    cartTableBody.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const barcode = target.getAttribute('data-barcode') || '';
        if (!barcode) return;

        if (target.classList.contains('cashier-inc-btn')) {
            changeCartQuantity(barcode, 1);
            return;
        }
        if (target.classList.contains('cashier-dec-btn')) {
            changeCartQuantity(barcode, -1);
            return;
        }
        if (target.classList.contains('cashier-remove-btn')) {
            removeFromCart(barcode);
        }
    });

    checkoutBtn.addEventListener('click', () => {
        processCheckout();
    });

    if (cameraScanBtn) {
        cameraScanBtn.addEventListener('click', async () => {
            await startCameraBarcodeScan();
        });
    }

    if (togglePrecisionModeBtn) {
        togglePrecisionModeBtn.addEventListener('click', () => {
            cashierPrecisionMode = !cashierPrecisionMode;
            togglePrecisionModeBtn.textContent = cashierPrecisionMode ? 'Slow precision: AAN' : 'Slow precision: UIT';
            togglePrecisionModeBtn.classList.toggle('active', cashierPrecisionMode);
            showCashierMessage(
                cashierPrecisionMode
                    ? 'Slow precision staat aan. Beter voor kleine barcodes, iets trager.'
                    : 'Slow precision staat uit. Sneller voor normale/grote barcodes.',
                'info'
            );
        });
    }

    if (stopCameraScanBtn) {
        stopCameraScanBtn.addEventListener('click', () => {
            stopCameraBarcodeScan();
        });
    }
}

function initializeCashierConnectivity() {
    updateCashierConnectionStatus('online', 'Cache en verbinding worden gecontroleerd...');

    const onOnline = () => {
        probeCashierConnectivity();
    };
    const onOffline = () => {
        updateCashierConnectionStatus('offline', 'Offline lokale modus actief. Kassa blijft lokaal werken.');
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    if (cashierConnectivityTimer) {
        clearInterval(cashierConnectivityTimer);
    }
    cashierConnectivityTimer = setInterval(() => {
        probeCashierConnectivity();
    }, 20000);

    probeCashierConnectivity();
}

async function probeCashierConnectivity() {
    if (!navigator.onLine) {
        updateCashierConnectionStatus('offline', 'Offline lokale modus actief. Kassa blijft lokaal werken.');
        return;
    }

    const start = performance.now();
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        await fetch(`./?connectivity=${Date.now()}`, {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal
        });
        clearTimeout(timeout);

        const durationMs = Math.round(performance.now() - start);
        const hasSwCache = Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);

        if (durationMs > 1600) {
            updateCashierConnectionStatus(
                'unstable',
                `Instabiele verbinding (${durationMs} ms). Lokale modus actief${hasSwCache ? ' + cache actief' : ''}.`
            );
            return;
        }

        updateCashierConnectionStatus(
            'online',
            `Online (${durationMs} ms)${hasSwCache ? ' • cache actief' : ' • cache start bij volgende herlaad'}.`
        );
    } catch {
        const hasSwCache = Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
        updateCashierConnectionStatus(
            'unstable',
            `Verbinding hapert. Lokale modus actief${hasSwCache ? ' + cache actief' : ''}.`
        );
    }
}

function updateCashierConnectionStatus(state, detail) {
    const wrap = document.getElementById('cashierConnectionStatus');
    const badge = document.getElementById('cashierConnectionBadge');
    const detailEl = document.getElementById('cashierConnectionDetail');
    if (!wrap || !badge || !detailEl) return;

    wrap.classList.remove('connection-online', 'connection-offline', 'connection-unstable');

    if (state === 'offline') {
        wrap.classList.add('connection-offline');
        badge.textContent = 'Offline';
    } else if (state === 'unstable') {
        wrap.classList.add('connection-unstable');
        badge.textContent = 'Instabiel';
    } else {
        wrap.classList.add('connection-online');
        badge.textContent = 'Online';
    }

    detailEl.textContent = detail;
}

function addBarcodeToCart(rawBarcode) {
    const barcode = sanitizeBarcode(rawBarcode);
    if (!barcode) {
        showCashierMessage('Scan of vul een barcode in.', 'error');
        return;
    }

    const candidates = getBarcodeCandidates(barcode);
    const products = getStoredProducts();
    const product = products.find((item) => candidates.includes(String(item.barcode || '')));
    if (!product) {
        showCashierMessage('Product niet gevonden in voorraad.', 'error');
        return;
    }

    const availableStock = Number.isFinite(product.stock) ? product.stock : 0;
    const currentQty = getCartQuantityForBarcode(product.barcode);
    if (availableStock <= currentQty) {
        showCashierMessage('Onvoldoende voorraad voor dit product.', 'error');
        return;
    }

    const existingIndex = cashierCart.findIndex((item) => item.barcode === product.barcode);
    if (existingIndex >= 0) {
        cashierCart[existingIndex].quantity += 1;
    } else {
        cashierCart.push({
            barcode: product.barcode,
            artist: product.artist,
            album: product.album,
            salePrice: Number.isFinite(product.salePrice) ? product.salePrice : 0,
            quantity: 1
        });
    }

    renderCashierCart();
    showCashierMessage('Product toegevoegd aan winkelmandje.', 'success');
}

function getCartQuantityForBarcode(barcode) {
    const item = cashierCart.find((entry) => entry.barcode === barcode);
    return item ? item.quantity : 0;
}

function changeCartQuantity(barcode, delta) {
    const index = cashierCart.findIndex((item) => item.barcode === barcode);
    if (index < 0) return;

    const products = getStoredProducts();
    const stockItem = products.find((item) => item.barcode === barcode);
    const maxStock = stockItem && Number.isFinite(stockItem.stock) ? stockItem.stock : 0;
    const nextQty = cashierCart[index].quantity + delta;

    if (nextQty <= 0) {
        cashierCart.splice(index, 1);
        renderCashierCart();
        return;
    }
    if (nextQty > maxStock) {
        showCashierMessage('Onvoldoende voorraad voor deze hoeveelheid.', 'error');
        return;
    }

    cashierCart[index].quantity = nextQty;
    renderCashierCart();
}

function removeFromCart(barcode) {
    cashierCart = cashierCart.filter((item) => item.barcode !== barcode);
    renderCashierCart();
}

function renderCashierCart() {
    const tableBody = document.getElementById('cashierCartTableBody');
    const totalElement = document.getElementById('cashierTotalAmount');
    if (!tableBody || !totalElement) return;

    if (cashierCart.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="7" class="empty-row">Winkelmandje is leeg.</td></tr>';
        totalElement.textContent = 'EUR 0,00';
        return;
    }

    let total = 0;
    tableBody.innerHTML = cashierCart.map((item) => {
        const subtotal = (Number(item.salePrice) || 0) * item.quantity;
        total += subtotal;
        return `
            <tr>
                <td>${escapeHtml(item.barcode)}</td>
                <td>${escapeHtml(item.artist || '')}</td>
                <td>${escapeHtml(item.album || '')}</td>
                <td>
                    <div class="stock-update-controls">
                        <button type="button" class="neutral-btn cashier-dec-btn" data-barcode="${escapeHtml(item.barcode)}">-</button>
                        <span>${item.quantity}</span>
                        <button type="button" class="neutral-btn cashier-inc-btn" data-barcode="${escapeHtml(item.barcode)}">+</button>
                    </div>
                </td>
                <td>EUR ${formatCurrency(item.salePrice)}</td>
                <td>EUR ${formatCurrency(subtotal)}</td>
                <td><button type="button" class="danger-btn cashier-remove-btn" data-barcode="${escapeHtml(item.barcode)}">Verwijder</button></td>
            </tr>
        `;
    }).join('');

    totalElement.textContent = `EUR ${formatCurrency(total)}`;
}

async function processCheckout() {
    if (cashierCart.length === 0) {
        showCashierMessage('Winkelmandje is leeg.', 'error');
        return;
    }

    const products = getStoredProducts();
    for (let i = 0; i < cashierCart.length; i += 1) {
        const cartItem = cashierCart[i];
        const index = products.findIndex((item) => item.barcode === cartItem.barcode);
        if (index < 0) {
            showCashierMessage(`Product ${cartItem.barcode} niet meer beschikbaar.`, 'error');
            return;
        }

        const available = Number.isFinite(products[index].stock) ? products[index].stock : 0;
        if (available < cartItem.quantity) {
            showCashierMessage(`Onvoldoende voorraad voor ${cartItem.artist} - ${cartItem.album}.`, 'error');
            return;
        }
    }

    const now = new Date().toISOString();
    let totalAmount = 0;
    let totalItems = 0;

    const soldItems = cashierCart.map((cartItem) => {
        const unitPrice = Number.isFinite(cartItem.salePrice) ? cartItem.salePrice : 0;
        const qty = Number.isFinite(cartItem.quantity) ? cartItem.quantity : 0;
        totalAmount += unitPrice * qty;
        totalItems += qty;
        return {
            barcode: cartItem.barcode,
            artist: cartItem.artist || '',
            album: cartItem.album || '',
            quantity: qty,
            salePrice: roundCurrency(unitPrice),
            subtotal: roundCurrency(unitPrice * qty)
        };
    });

    cashierCart.forEach((cartItem) => {
        const index = products.findIndex((item) => item.barcode === cartItem.barcode);
        products[index].stock -= cartItem.quantity;
        products[index].updatedAt = now;
    });

    await persistProducts(products, true);
    await appendTransaction({
        id: generateId(),
        createdAt: now,
        cashier: getCurrentUserName(),
        totalItems,
        totalAmount: roundCurrency(totalAmount),
        items: soldItems,
        canceled: false,
        canceledAt: null
    });
    cashierCart = [];
    renderCashierCart();
    showCashierMessage('Afrekenen voltooid. Voorraad is bijgewerkt.', 'success');
}

async function startCameraBarcodeScan() {
    if (cashierScannerActive) return;
    if (!window.isSecureContext) {
        showCashierMessage('Camera werkt op iPhone Safari alleen via HTTPS.', 'error');
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showCashierMessage('Camera API niet beschikbaar. Controleer Safari-toestemming en herlaad.', 'error');
        return;
    }

    const scannerWrap = document.getElementById('cashierScannerWrap');
    const video = document.getElementById('cashierVideo');
    const qrReader = document.getElementById('cashierQrReader');
    if (!(scannerWrap instanceof HTMLElement) || !(video instanceof HTMLVideoElement) || !(qrReader instanceof HTMLElement)) return;

    scannerWrap.classList.remove('hidden');

    if (typeof window.BarcodeDetector !== 'undefined') {
        await startBarcodeDetectorScan(video, qrReader);
        return;
    }

    if (typeof window.Html5Qrcode !== 'undefined') {
        await startHtml5QrScan(video, qrReader);
        return;
    }

    showCashierMessage('Barcode-scanner niet ondersteund in deze browser. Gebruik handmatige scan.', 'error');
}

async function startBarcodeDetectorScan(video, qrReader) {
    try {
        const detector = new window.BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39']
        });

        video.classList.remove('hidden');
        qrReader.classList.add('hidden');

        cashierVideoStream = await getCameraStreamWithFallback(cashierPrecisionMode);

        video.srcObject = cashierVideoStream;
        cashierScannerActive = true;
        cashierScannerMode = 'barcode-detector';

        const scanLoop = async () => {
            if (!cashierScannerActive || cashierScannerMode !== 'barcode-detector') return;
            try {
                let barcodes = await detector.detect(video);
                if (cashierPrecisionMode && (!barcodes || barcodes.length === 0) && video.videoWidth > 0 && video.videoHeight > 0) {
                    const upscaledCanvas = getUpscaledScanCanvas(video);
                    if (upscaledCanvas) {
                        barcodes = await detector.detect(upscaledCanvas);
                    }
                }
                if (Array.isArray(barcodes) && barcodes.length > 0) {
                    const rawValue = barcodes[0].rawValue || '';
                    if (rawValue) {
                        addBarcodeToCart(rawValue);
                        stopCameraBarcodeScan();
                        return;
                    }
                }
            } catch {
                // Ignore detect frame errors.
            }
            requestAnimationFrame(scanLoop);
        };

        requestAnimationFrame(scanLoop);
        showCashierMessage('Camera scanner gestart. Richt op barcode.', 'info');
    } catch (error) {
        console.error('BarcodeDetector scan error:', error);
        showCashierMessage('Camera kon niet gestart worden.', 'error');
        stopCameraBarcodeScan();
    }
}

async function startHtml5QrScan(video, qrReader) {
    try {
        video.classList.add('hidden');
        qrReader.classList.remove('hidden');
        qrReader.innerHTML = '';
        cashierHtml5Qr = new window.Html5Qrcode('cashierQrReader');

        const config = {
            fps: cashierPrecisionMode ? 8 : 15,
            disableFlip: true,
            qrbox: (viewfinderWidth, viewfinderHeight) => ({
                width: Math.max(280, Math.floor(viewfinderWidth * (cashierPrecisionMode ? 0.98 : 0.92))),
                height: Math.max(120, Math.floor(viewfinderHeight * (cashierPrecisionMode ? 0.38 : 0.30)))
            }),
            videoConstraints: cashierPrecisionMode ? CAMERA_CONSTRAINTS_PRECISION : CAMERA_CONSTRAINTS_NORMAL,
            formatsToSupport: [
                window.Html5QrcodeSupportedFormats.EAN_13,
                window.Html5QrcodeSupportedFormats.EAN_8,
                window.Html5QrcodeSupportedFormats.UPC_A,
                window.Html5QrcodeSupportedFormats.UPC_E,
                window.Html5QrcodeSupportedFormats.CODE_128,
                window.Html5QrcodeSupportedFormats.CODE_39
            ]
        };

        cashierScannerActive = true;
        cashierScannerMode = 'html5-qrcode';

        const onSuccess = (decodedText) => {
            if (!cashierScannerActive) return;
            if (decodedText) {
                addBarcodeToCart(decodedText);
                stopCameraBarcodeScan();
            }
        };

        const onError = () => {
            // Ignore frame decode misses.
        };

        try {
            await cashierHtml5Qr.start({ facingMode: { exact: 'environment' } }, config, onSuccess, onError);
        } catch {
            await cashierHtml5Qr.start({ facingMode: 'environment' }, config, onSuccess, onError);
        }

        showCashierMessage(
            cashierPrecisionMode
                ? 'Slow precision scanner gestart. Houd barcode dichtbij en stabiel.'
                : 'Camera scanner gestart. Richt op barcode.',
            'info'
        );
    } catch (error) {
        console.error('html5-qrcode scan error:', error);
        showCashierMessage('Camera kon niet gestart worden.', 'error');
        stopCameraBarcodeScan();
    }
}

async function getCameraStreamWithFallback(precisionMode) {
    const candidates = precisionMode
        ? [CAMERA_CONSTRAINTS_PRECISION, CAMERA_CONSTRAINTS_NORMAL, { facingMode: 'environment' }, true]
        : [CAMERA_CONSTRAINTS_NORMAL, { facingMode: 'environment' }, CAMERA_CONSTRAINTS_PRECISION, true];

    for (let i = 0; i < candidates.length; i += 1) {
        try {
            const videoConstraint = candidates[i];
            return await navigator.mediaDevices.getUserMedia({
                video: videoConstraint,
                audio: false
            });
        } catch {
            // Try next constraints profile.
        }
    }

    throw new Error('Geen werkende camera constraints gevonden');
}

function getUpscaledScanCanvas(video) {
    try {
        const baseWidth = video.videoWidth;
        const baseHeight = video.videoHeight;
        if (!baseWidth || !baseHeight) return null;

        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = baseWidth * scale;
        canvas.height = baseHeight * scale;
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return null;

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas;
    } catch {
        return null;
    }
}

function stopCameraBarcodeScan() {
    const scannerWrap = document.getElementById('cashierScannerWrap');
    const video = document.getElementById('cashierVideo');
    const qrReader = document.getElementById('cashierQrReader');
    cashierScannerActive = false;
    cashierScannerMode = '';

    if (cashierVideoStream) {
        cashierVideoStream.getTracks().forEach((track) => track.stop());
        cashierVideoStream = null;
    }
    if (video && video.srcObject) {
        video.srcObject = null;
    }
    if (video) {
        video.classList.remove('hidden');
    }

    if (cashierHtml5Qr) {
        try {
            if (cashierHtml5Qr.isScanning) {
                cashierHtml5Qr.stop();
            }
            cashierHtml5Qr.clear();
        } catch {
            // Ignore scanner cleanup errors.
        }
        cashierHtml5Qr = null;
    }
    if (qrReader) {
        qrReader.innerHTML = '';
        qrReader.classList.add('hidden');
    }
    if (scannerWrap) {
        scannerWrap.classList.add('hidden');
    }
}

function initializeProductForm() {
    const productForm = document.getElementById('productForm');
    if (!productForm) return;

    const barcodeInput = document.getElementById('barcodeInput');
    const artistInput = document.getElementById('artistInput');
    const albumInput = document.getElementById('albumInput');
    const purchasePriceInput = document.getElementById('purchasePriceInput');
    const salePriceInput = document.getElementById('salePriceInput');
    const stockInput = document.getElementById('stockInput');
    const lookupBarcodeBtn = document.getElementById('lookupBarcodeBtn');
    const saveProductBtn = document.getElementById('saveProductBtn');
    const toggleManualMetadataBtn = document.getElementById('toggleManualMetadataBtn');
    const productsTableBody = document.getElementById('productsTableBody');
    const commitAddedProductsBtn = document.getElementById('commitAddedProductsBtn');

    renderProductsTable();
    renderSearchResults();
    barcodeInput.focus();

    lookupBarcodeBtn.addEventListener('click', async () => {
        await handleBarcodeLookup();
    });

    barcodeInput.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            await handleBarcodeLookup();
        }
    });

    barcodeInput.addEventListener('input', () => {
        if (artistInput.value || albumInput.value) {
            artistInput.value = '';
            albumInput.value = '';
            saveProductBtn.disabled = true;
        }
        setMetadataInputsManualMode(false);
    });

    if (toggleManualMetadataBtn) {
        toggleManualMetadataBtn.addEventListener('click', () => {
            const isManual = artistInput.readOnly;
            setMetadataInputsManualMode(isManual);
            if (isManual) {
                saveProductBtn.disabled = false;
                showProductFormMessage('Handmatige modus actief. Pas artiest/album aan en sla op.', 'info');
                artistInput.focus();
            } else {
                showProductFormMessage('Handmatige modus uitgeschakeld.', 'info');
            }
        });
    }

    productForm.addEventListener('submit', (event) => {
        event.preventDefault();

        const barcode = sanitizeBarcode(barcodeInput.value);
        const artist = artistInput.value.trim();
        const album = albumInput.value.trim();
        const purchasePrice = Number.parseFloat(purchasePriceInput.value);
        const salePrice = Number.parseFloat(salePriceInput.value);
        const stock = Number.parseInt(stockInput.value, 10);

        if (!barcode || !artist || !album) {
            showProductFormMessage('Scan eerst een geldige barcode om artiest en album op te halen.', 'error');
            return;
        }
        if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
            showProductFormMessage('Vul een geldige inkoopprijs in.', 'error');
            return;
        }
        if (!Number.isFinite(salePrice) || salePrice < 0) {
            showProductFormMessage('Vul een geldige verkoopprijs in.', 'error');
            return;
        }
        if (!Number.isInteger(stock) || stock < 0) {
            showProductFormMessage('Vul een geldig aantal in (0 of hoger).', 'error');
            return;
        }

        upsertSessionProduct({
            barcode,
            artist,
            album,
            purchasePrice: roundCurrency(purchasePrice),
            salePrice: roundCurrency(salePrice),
            stock,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });

        setCachedMetadata(barcode, { artist, album });

        renderProductsTable();
        showProductFormMessage('Product toegevoegd aan sessie. Klik op "Voer door" om voorraad bij te werken.', 'success');
        resetProductForm({ barcodeInput, artistInput, albumInput, purchasePriceInput, salePriceInput, stockInput, saveProductBtn });
    });

    if (productsTableBody) {
        productsTableBody.addEventListener('input', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (!target.classList.contains('session-stock-input')) return;

            const barcode = target.getAttribute('data-barcode') || '';
            const amount = Number.parseInt(target.value, 10);
            if (!barcode || !Number.isInteger(amount) || amount < 0) return;

            const item = sessionAddedProducts.find((p) => p.barcode === barcode);
            if (!item) return;

            item.stock = amount;
            item.updatedAt = new Date().toISOString();
        });

        productsTableBody.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (!target.classList.contains('remove-session-btn')) return;

            const barcode = target.getAttribute('data-barcode') || '';
            if (!barcode) return;

            sessionAddedProducts = sessionAddedProducts.filter((item) => item.barcode !== barcode);
            renderProductsTable();
            showProductFormMessage('Product verwijderd uit deze sessie.', 'info');
        });
    }

    if (commitAddedProductsBtn) {
        commitAddedProductsBtn.addEventListener('click', async () => {
            if (sessionAddedProducts.length === 0) {
                showProductFormMessage('Er zijn geen sessieproducten om door te voeren.', 'error');
                return;
            }

            const storedProducts = getStoredProducts();
            const now = new Date().toISOString();

            sessionAddedProducts.forEach((sessionProduct) => {
                const existingIndex = storedProducts.findIndex((p) => p.barcode === sessionProduct.barcode);
                if (existingIndex >= 0) {
                    const existing = storedProducts[existingIndex];
                    const existingStock = Number.isFinite(existing.stock) ? existing.stock : 0;
                    const incomingStock = Number.isFinite(sessionProduct.stock) ? sessionProduct.stock : 0;
                    const existingPurchasePrice = Number.isFinite(existing.purchasePrice) ? existing.purchasePrice : 0;
                    const incomingPurchasePrice = Number.isFinite(sessionProduct.purchasePrice) ? sessionProduct.purchasePrice : 0;
                    const totalStock = existingStock + incomingStock;
                    const weightedPurchasePrice = totalStock > 0
                        ? roundCurrency(((existingStock * existingPurchasePrice) + (incomingStock * incomingPurchasePrice)) / totalStock)
                        : existingPurchasePrice;
                    storedProducts[existingIndex] = {
                        ...existing,
                        artist: sessionProduct.artist,
                        album: sessionProduct.album,
                        purchasePrice: weightedPurchasePrice,
                        salePrice: sessionProduct.salePrice,
                        stock: totalStock,
                        updatedAt: now
                    };
                } else {
                    storedProducts.push({
                        ...sessionProduct,
                        createdAt: now,
                        updatedAt: now
                    });
                }
            });

            await persistProducts(storedProducts);
            sessionAddedProducts = [];
            renderProductsTable();
            renderSearchResults();
            showProductFormMessage('Toegevoegde sessieproducten zijn doorgevoerd naar de voorraad.', 'success');
            resetProductForm({ barcodeInput, artistInput, albumInput, purchasePriceInput, salePriceInput, stockInput, saveProductBtn });
        });
    }

    async function handleBarcodeLookup() {
        const barcode = sanitizeBarcode(barcodeInput.value);
        if (barcode.length < 8) {
            showProductFormMessage('Barcode lijkt te kort. Scan een volledige EAN/UPC-code.', 'error');
            return;
        }

        const existingProduct = getStoredProductByBarcode(barcode);
        if (existingProduct && Number.isFinite(existingProduct.salePrice)) {
            salePriceInput.value = formatNumberForInput(existingProduct.salePrice);
        }

        showProductFormMessage('Barcode wordt opgezocht...', 'info');
        lookupBarcodeBtn.disabled = true;
        saveProductBtn.disabled = true;

        try {
            const metadata = await fetchReleaseByBarcode(barcode);
            if (!metadata) {
                artistInput.value = '';
                albumInput.value = '';
                setMetadataInputsManualMode(true);
                saveProductBtn.disabled = false;
                showProductFormMessage('Geen match gevonden. Vul artiest en album handmatig in.', 'info');
                artistInput.focus();
                return;
            }

            setMetadataInputsManualMode(false);
            artistInput.value = metadata.artist;
            albumInput.value = metadata.album;
            saveProductBtn.disabled = false;
            showProductFormMessage('Artiest en album automatisch gekoppeld.', 'success');
            purchasePriceInput.focus();
        } catch (error) {
            artistInput.value = '';
            albumInput.value = '';
            setMetadataInputsManualMode(true);
            saveProductBtn.disabled = false;
            showProductFormMessage('Zoeken mislukt. Vul artiest en album handmatig in.', 'error');
            console.error('Barcode lookup error:', error);
        } finally {
            lookupBarcodeBtn.disabled = false;
        }
    }
}

async function saveStockValue(barcode, rawValue, currentQuery) {
    const newStock = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(newStock) || newStock < 0) {
        showSearchMessage('Vul een geldige voorraad in (0 of hoger).', 'error');
        return;
    }

    const products = getStoredProducts();
    const productIndex = products.findIndex((product) => product.barcode === barcode);
    if (productIndex < 0) {
        showSearchMessage('Product niet gevonden.', 'error');
        return;
    }

    products[productIndex].stock = newStock;
    products[productIndex].updatedAt = new Date().toISOString();
    await persistProducts(products);
    renderSearchResults(currentQuery);
    showSearchMessage('Voorraad opgeslagen.', 'success');
}

async function saveSalePriceValue(barcode, rawValue, currentQuery) {
    const newSalePrice = Number.parseFloat(rawValue);
    if (!Number.isFinite(newSalePrice) || newSalePrice < 0) {
        showSearchMessage('Vul een geldige verkoopprijs in (0 of hoger).', 'error');
        return;
    }

    const products = getStoredProducts();
    const productIndex = products.findIndex((product) => product.barcode === barcode);
    if (productIndex < 0) {
        showSearchMessage('Product niet gevonden.', 'error');
        return;
    }

    products[productIndex].salePrice = roundCurrency(newSalePrice);
    products[productIndex].updatedAt = new Date().toISOString();
    await persistProducts(products);
    renderSearchResults(currentQuery);
}

function openStockEditor(barcode) {
    const display = document.querySelector(`.stock-display-btn[data-barcode="${cssEscape(barcode)}"]`);
    const editor = document.querySelector(`.stock-edit-group[data-barcode="${cssEscape(barcode)}"]`);
    const input = document.querySelector(`.stock-edit-input[data-barcode="${cssEscape(barcode)}"]`);
    if (!(display instanceof HTMLElement) || !(editor instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return;

    display.classList.add('hidden');
    editor.classList.remove('hidden');
    input.focus();
    input.select();
}

function closeStockEditor(barcode) {
    const display = document.querySelector(`.stock-display-btn[data-barcode="${cssEscape(barcode)}"]`);
    const editor = document.querySelector(`.stock-edit-group[data-barcode="${cssEscape(barcode)}"]`);
    if (!(display instanceof HTMLElement) || !(editor instanceof HTMLElement)) return;

    display.classList.remove('hidden');
    editor.classList.add('hidden');
}

function initializeProductSearch() {
    const searchInput = document.getElementById('productSearchInput');
    const searchResultsTableBody = document.getElementById('searchResultsTableBody');
    if (!searchInput || !searchResultsTableBody) return;

    const sortButtons = document.querySelectorAll('.sort-btn');
    searchInput.addEventListener('input', () => {
        renderSearchResults(searchInput.value);
    });

    sortButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const sortKey = button.getAttribute('data-sort-key');
            if (!sortKey) return;
            setSearchSort(sortKey);
            renderSearchResults(searchInput.value);
        });
    });

    searchResultsTableBody.addEventListener('click', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const barcode = target.getAttribute('data-barcode') || '';
        if (!barcode) return;

        if (target.classList.contains('stock-display-btn')) {
            openStockEditor(barcode);
            return;
        }

        if (target.classList.contains('stock-save-btn')) {
            const input = document.querySelector(`.stock-edit-input[data-barcode="${cssEscape(barcode)}"]`);
            if (!(input instanceof HTMLInputElement)) return;
            await saveStockValue(barcode, input.value, searchInput.value);
            closeStockEditor(barcode);
            return;
        }

        if (target.classList.contains('delete-product-btn')) {
            const products = getStoredProducts();
            const product = products.find((item) => item.barcode === barcode);
            if (!product) {
                showSearchMessage('Product niet gevonden.', 'error');
                return;
            }

            const confirmed = window.confirm(`Weet je zeker dat je "${product.artist} - ${product.album}" wilt verwijderen?`);
            if (!confirmed) return;

            const updatedProducts = products.filter((item) => item.barcode !== barcode);
            await persistProducts(updatedProducts);
            renderSearchResults(searchInput.value);
            showSearchMessage('Product verwijderd uit de voorraad.', 'success');
        }
    });

    searchResultsTableBody.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (!target.classList.contains('sale-price-input')) return;

        const barcode = target.getAttribute('data-barcode') || '';
        if (!barcode) return;
        void saveSalePriceValue(barcode, target.value, searchInput.value);
    });

    searchResultsTableBody.addEventListener('keydown', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;

        if (event.key === 'Enter' && target.classList.contains('stock-edit-input')) {
            event.preventDefault();
            const barcode = target.getAttribute('data-barcode') || '';
            if (!barcode) return;
            void saveStockValue(barcode, target.value, searchInput.value);
            closeStockEditor(barcode);
            return;
        }

        if (event.key === 'Escape' && target.classList.contains('stock-edit-input')) {
            event.preventDefault();
            const barcode = target.getAttribute('data-barcode') || '';
            if (!barcode) return;
            closeStockEditor(barcode);
            return;
        }

        if (event.key === 'Enter' && target.classList.contains('sale-price-input')) {
            event.preventDefault();
            target.blur();
        }
    });

    renderSearchResults();
    updateSortButtons();
}

function initializeImportTab() {
    const importFileInput = document.getElementById('importFileInput');
    const loadImportFileBtn = document.getElementById('loadImportFileBtn');
    const importRowsBtn = document.getElementById('importRowsBtn');
    const previewTableBody = document.getElementById('importPreviewTableBody');
    if (!importFileInput || !loadImportFileBtn || !importRowsBtn || !previewTableBody) return;

    loadImportFileBtn.addEventListener('click', async () => {
        const file = importFileInput.files && importFileInput.files[0];
        if (!file) {
            showImportMessage('Selecteer eerst een CSV of XLSX bestand.', 'error');
            return;
        }

        try {
            showImportMessage('Bestand wordt ingelezen...', 'info');
            const rawRows = await readImportFile(file);
            importPreviewRows = normalizeImportedRows(rawRows);
            await enrichMissingMetadata(importPreviewRows);
            renderImportPreviewTable();
            showImportMessage(`${importPreviewRows.length} regel(s) geladen. Controleer en pas aan waar nodig.`, 'success');
        } catch (error) {
            console.error('Import parse error:', error);
            importPreviewRows = [];
            renderImportPreviewTable();
            showImportMessage('Bestand kon niet worden ingelezen. Controleer formaat en kolomnamen.', 'error');
        }
    });

    previewTableBody.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        const rowIndex = Number.parseInt(target.getAttribute('data-row-index') || '', 10);
        const field = target.getAttribute('data-field') || '';
        if (!Number.isInteger(rowIndex) || rowIndex < 0 || !field || !importPreviewRows[rowIndex]) return;

        importPreviewRows[rowIndex][field] = target.value;
    });

    importRowsBtn.addEventListener('click', async () => {
        if (importPreviewRows.length === 0) {
            showImportMessage('Er is geen importpreview om door te voeren.', 'error');
            return;
        }

        const validationErrors = validateImportRows(importPreviewRows);
        if (validationErrors.length > 0) {
            showImportMessage(validationErrors[0], 'error');
            return;
        }

        const storedProducts = getStoredProducts();
        const now = new Date().toISOString();

        importPreviewRows.forEach((row) => {
            const barcode = sanitizeBarcode(row.barcode);
            const incomingStock = Number.parseInt(row.stock, 10);
            const incomingPurchasePrice = roundCurrency(Number.parseFloat(row.purchasePrice));
            const incomingSalePrice = roundCurrency(Number.parseFloat(row.salePrice));
            const incomingArtist = String(row.artist || '').trim();
            const incomingAlbum = String(row.album || '').trim();

            const existingIndex = storedProducts.findIndex((p) => String(p.barcode || '') === barcode);
            if (existingIndex >= 0) {
                const existing = storedProducts[existingIndex];
                const existingStock = Number.isFinite(existing.stock) ? existing.stock : 0;
                const existingPurchasePrice = Number.isFinite(existing.purchasePrice) ? existing.purchasePrice : 0;
                const totalStock = existingStock + incomingStock;
                const weightedPurchasePrice = totalStock > 0
                    ? roundCurrency(((existingStock * existingPurchasePrice) + (incomingStock * incomingPurchasePrice)) / totalStock)
                    : existingPurchasePrice;

                storedProducts[existingIndex] = {
                    ...existing,
                    barcode,
                    artist: incomingArtist || existing.artist,
                    album: incomingAlbum || existing.album,
                    stock: totalStock,
                    purchasePrice: weightedPurchasePrice,
                    salePrice: incomingSalePrice,
                    updatedAt: now
                };
            } else {
                storedProducts.push({
                    barcode,
                    artist: incomingArtist,
                    album: incomingAlbum,
                    stock: incomingStock,
                    purchasePrice: incomingPurchasePrice,
                    salePrice: incomingSalePrice,
                    createdAt: now,
                    updatedAt: now
                });
            }
        });

        await persistProducts(storedProducts);
        importPreviewRows = [];
        renderImportPreviewTable();
        renderSearchResults();
        showImportMessage('Import succesvol doorgevoerd naar voorraad.', 'success');
    });

    renderImportPreviewTable();
}

function initializeFairPlanner() {
    const fairPlannerForm = document.getElementById('fairPlannerForm');
    const plannedFairsTableBody = document.getElementById('plannedFairsTableBody');
    if (!fairPlannerForm || !plannedFairsTableBody) return;

    const fairNameInput = document.getElementById('fairNameInput');
    const fairCityInput = document.getElementById('fairCityInput');
    const fairDateInput = document.getElementById('fairDateInput');
    const fairStartTimeInput = document.getElementById('fairStartTimeInput');
    const fairEndTimeInput = document.getElementById('fairEndTimeInput');
    const fairNotesInput = document.getElementById('fairNotesInput');

    fairPlannerForm.addEventListener('submit', (event) => {
        event.preventDefault();

        const name = String(fairNameInput.value || '').trim();
        const city = String(fairCityInput.value || '').trim();
        const date = String(fairDateInput.value || '').trim();
        const startTime = String(fairStartTimeInput.value || '').trim();
        const endTime = String(fairEndTimeInput.value || '').trim();
        const notes = String(fairNotesInput.value || '').trim();

        if (!name || !city || !date) {
            showFairPlannerMessage('Vul beursnaam, locatie en datum in.', 'error');
            return;
        }

        if (startTime && endTime && startTime > endTime) {
            showFairPlannerMessage('Eindtijd moet na starttijd liggen.', 'error');
            return;
        }

        const fairs = getStoredFairs();
        fairs.push({
            id: generateId(),
            name,
            city,
            date,
            startTime,
            endTime,
            notes,
            createdAt: new Date().toISOString()
        });
        saveStoredFairs(fairs);

        renderPlannedFairsTable();
        renderDashboardAgenda();
        populateAssignTransactionFairSelect();
        updateAssignTransactionsTabVisibility();
        showFairPlannerMessage('Beurs toegevoegd aan de agenda.', 'success');

        fairNameInput.value = '';
        fairCityInput.value = '';
        fairDateInput.value = '';
        fairStartTimeInput.value = '';
        fairEndTimeInput.value = '';
        fairNotesInput.value = '';
        fairNameInput.focus();
    });

    plannedFairsTableBody.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.classList.contains('remove-fair-btn')) return;

        const fairId = target.getAttribute('data-fair-id') || '';
        if (!fairId) return;

        const fairs = getStoredFairs();
        const fair = fairs.find((item) => item.id === fairId);
        if (!fair) return;

        const confirmed = window.confirm(`Verwijder beurs "${fair.name}" op ${formatDateDisplay(fair.date)}?`);
        if (!confirmed) return;

        const updatedFairs = fairs.filter((item) => item.id !== fairId);
        saveStoredFairs(updatedFairs);
        unlinkFairFromTransactions(fairId);
        renderPlannedFairsTable();
        renderDashboardAgenda();
        populateAssignTransactionFairSelect();
        updateAssignTransactionsTabVisibility();
        renderTransactionsTable();
        renderAssignTransactionsTable();
        renderPastFairsPage();
        showFairPlannerMessage('Beurs verwijderd uit de agenda.', 'success');
    });

    renderPlannedFairsTable();
    renderDashboardAgenda();
}

function getStoredFairs() {
    const raw = localStorage.getItem(FAIRS_STORAGE_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function getStoredTransactions() {
    const raw = localStorage.getItem(TRANSACTIONS_STORAGE_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveStoredTransactions(transactions) {
    setStoredTransactionsLocal(transactions);
    void persistTransactions(transactions);
}

async function appendTransaction(transaction) {
    const transactions = getStoredTransactions();
    transactions.push(transaction);
    await persistTransactions(transactions);
    updateAssignTransactionsTabVisibility();
    renderAssignTransactionsTable();
}

async function cancelTransaction(transactionId) {
    const transactions = getStoredTransactions();
    const transactionIndex = transactions.findIndex((transaction) => transaction.id === transactionId);
    if (transactionIndex < 0) {
        showTransactionsMessage('Transactie niet gevonden.', 'error');
        return;
    }

    const transaction = transactions[transactionIndex];
    if (transaction.canceled) {
        showTransactionsMessage('Transactie is al geannuleerd.', 'error');
        return;
    }

    const confirmed = window.confirm('Transactie annuleren en voorraad terugboeken?');
    if (!confirmed) return;

    const products = getStoredProducts();
    const now = new Date().toISOString();

    (transaction.items || []).forEach((item) => {
        const barcode = String(item.barcode || '');
        const quantity = Number.isFinite(item.quantity) ? item.quantity : 0;
        if (!barcode || quantity <= 0) return;

        const index = products.findIndex((product) => String(product.barcode || '') === barcode);
        if (index >= 0) {
            const currentStock = Number.isFinite(products[index].stock) ? products[index].stock : 0;
            products[index].stock = currentStock + quantity;
            products[index].updatedAt = now;
        }
    });

    transactions[transactionIndex] = {
        ...transaction,
        canceled: true,
        canceledAt: now
    };

    await persistProducts(products);
    await persistTransactions(transactions);
    renderTransactionsTable();
    renderAssignTransactionsTable();
    updateAssignTransactionsTabVisibility();
    renderDashboardOverview();
    renderPastFairsPage();
    showTransactionsMessage('Transactie geannuleerd en voorraad hersteld.', 'success');
}

function renderTransactionsTable() {
    const tableBody = document.getElementById('transactionsTableBody');
    if (!tableBody) return;
    const fairs = getStoredFairs().slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    const fairMap = new Map(fairs.map((fair) => [fair.id, `${formatDateDisplay(fair.date)} - ${fair.name || ''}`]));

    const transactions = getStoredTransactions()
        .slice()
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    if (transactions.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="7" class="empty-row">Nog geen transacties.</td></tr>';
        return;
    }

    tableBody.innerHTML = transactions.map((transaction) => `
        <tr>
            <td>${escapeHtml(formatDateTimeDisplay(transaction.createdAt))}</td>
            <td>${escapeHtml(transaction.cashier || '')}</td>
            <td>${Number.isFinite(transaction.totalItems) ? transaction.totalItems : 0}</td>
            <td>EUR ${formatCurrency(transaction.totalAmount)}</td>
            <td>${escapeHtml(formatTransactionFairNames(transaction, fairMap))}</td>
            <td>${transaction.canceled ? 'Geannuleerd' : 'Actief'}</td>
            <td>
                ${transaction.canceled
                    ? '<span class="empty-row">-</span>'
                    : `<button type="button" class="danger-btn cancel-transaction-btn" data-transaction-id="${escapeHtml(transaction.id)}">X</button>`}
            </td>
        </tr>
    `).join('');
}

function showTransactionsMessage(message, type) {
    const messageElement = document.getElementById('transactionsMessage');
    if (!messageElement) return;

    messageElement.textContent = message;
    messageElement.className = 'form-message show';
    if (type === 'error') messageElement.classList.add('error');
    if (type === 'success') messageElement.classList.add('success');
    if (type === 'info') messageElement.classList.add('info');
}

function formatTransactionFairNames(transaction, fairMap) {
    const fairIds = Array.isArray(transaction.fairIds) ? transaction.fairIds : [];
    if (fairIds.length === 0) return '-';
    const labels = fairIds
        .map((id) => fairMap.get(id))
        .filter((label) => typeof label === 'string' && label.length > 0);
    return labels.length > 0 ? labels.join(', ') : '-';
}

function populateAssignTransactionFairSelect() {
    const fairSelect = document.getElementById('assignTransactionFairSelect');
    if (!(fairSelect instanceof HTMLSelectElement)) return;

    const fairs = getStoredFairs()
        .slice()
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    const options = ['<option value="">Selecteer beurs...</option>']
        .concat(fairs.map((fair) => `<option value="${escapeHtml(fair.id)}">${escapeHtml(formatDateDisplay(fair.date))} - ${escapeHtml(fair.name || '')}</option>`));

    fairSelect.innerHTML = options.join('');
}

function getUnassignedTransactions() {
    return getStoredTransactions()
        .filter((transaction) => {
            if (transaction.canceled) return false;
            const fairIds = Array.isArray(transaction.fairIds) ? transaction.fairIds : [];
            return fairIds.length === 0;
        })
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function renderAssignTransactionsTable() {
    const tableBody = document.getElementById('assignTransactionsTableBody');
    if (!tableBody) return;

    const transactions = getUnassignedTransactions();
    if (transactions.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="6" class="empty-row">Geen open transacties om toe te wijzen.</td></tr>';
        syncAssignTransactionSelectAllState();
        return;
    }

    tableBody.innerHTML = transactions.map((transaction) => `
        <tr>
            <td><input type="checkbox" class="assign-transaction-checkbox" data-transaction-id="${escapeHtml(transaction.id)}" aria-label="Selecteer transactie"></td>
            <td>${escapeHtml(formatDateTimeDisplay(transaction.createdAt))}</td>
            <td>${escapeHtml(transaction.cashier || '')}</td>
            <td>${Number.isFinite(transaction.totalItems) ? transaction.totalItems : 0}</td>
            <td>EUR ${formatCurrency(transaction.totalAmount)}</td>
            <td>${transaction.canceled ? 'Geannuleerd' : 'Actief'}</td>
        </tr>
    `).join('');
    syncAssignTransactionSelectAllState();
}

function getSelectedTransactionIdsForAssignment() {
    const tableBody = document.getElementById('assignTransactionsTableBody');
    if (!tableBody) return [];
    const selected = tableBody.querySelectorAll('.assign-transaction-checkbox:checked');
    return Array.from(selected).map((checkbox) => {
        if (!(checkbox instanceof HTMLInputElement)) return '';
        return checkbox.getAttribute('data-transaction-id') || '';
    }).filter(Boolean);
}

async function assignSelectedTransactionsToFair() {
    const fairSelect = document.getElementById('assignTransactionFairSelect');
    if (!(fairSelect instanceof HTMLSelectElement)) return;

    const fairId = String(fairSelect.value || '').trim();
    if (!fairId) {
        showAssignTransactionsMessage('Kies eerst een beurs.', 'error');
        return;
    }

    const selectedIds = getSelectedTransactionIdsForAssignment();
    if (selectedIds.length === 0) {
        showAssignTransactionsMessage('Selecteer minimaal 1 transactie.', 'error');
        return;
    }

    const transactions = getStoredTransactions();
    let updatedCount = 0;
    const updatedTransactions = transactions.map((transaction) => {
        if (!selectedIds.includes(transaction.id)) return transaction;
        updatedCount += 1;
        return { ...transaction, fairIds: [fairId] };
    });

    await persistTransactions(updatedTransactions);
    renderTransactionsTable();
    renderAssignTransactionsTable();
    renderPastFairsPage();
    updateAssignTransactionsTabVisibility();
    showAssignTransactionsMessage(`${updatedCount} transactie${updatedCount === 1 ? '' : 's'} toegewezen aan beurs.`, 'success');
}

function syncAssignTransactionSelectAllState() {
    const tableBody = document.getElementById('assignTransactionsTableBody');
    const selectAllCheckbox = document.getElementById('assignTransactionSelectAll');
    if (!tableBody || !(selectAllCheckbox instanceof HTMLInputElement)) return;

    const checkboxes = Array.from(tableBody.querySelectorAll('.assign-transaction-checkbox')).filter((item) => item instanceof HTMLInputElement);
    if (checkboxes.length === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
        return;
    }

    const checkedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
    selectAllCheckbox.checked = checkedCount === checkboxes.length;
    selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}

function showAssignTransactionsMessage(message, type) {
    const messageElement = document.getElementById('assignTransactionsMessage');
    if (!messageElement) return;

    messageElement.textContent = message;
    messageElement.className = 'form-message show';
    if (type === 'error') messageElement.classList.add('error');
    if (type === 'success') messageElement.classList.add('success');
    if (type === 'info') messageElement.classList.add('info');
}

function updateAssignTransactionsTabVisibility() {
    const navButton = document.getElementById('assignTransactionsNavBtn');
    const page = document.getElementById('pageAssignTransactions');
    if (!navButton || !page) return;

    const hasUnassigned = getUnassignedTransactions().length > 0;
    navButton.classList.toggle('hidden', !hasUnassigned);
    page.classList.toggle('hidden', !hasUnassigned);

    if (!hasUnassigned && page.classList.contains('active')) {
        showDashboardPage('pageTransactions');
    }
}

function renderPastFairsPage() {
    const container = document.getElementById('pastFairsList');
    if (!container) return;

    const fairs = getStoredFairs().slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    if (fairs.length === 0) {
        container.innerHTML = '<div class="empty-row">Nog geen beurzen beschikbaar.</div>';
        return;
    }

    const transactions = getStoredTransactions();
    container.innerHTML = fairs.map((fair) => {
        const linkedTransactions = transactions.filter((transaction) => {
            const fairIds = Array.isArray(transaction.fairIds) ? transaction.fairIds : [];
            return fairIds.includes(fair.id);
        });
        const activeTransactions = linkedTransactions.filter((transaction) => !transaction.canceled);
        const canceledTransactions = linkedTransactions.length - activeTransactions.length;
        const itemsSold = activeTransactions.reduce((sum, transaction) => sum + (Number.isFinite(transaction.totalItems) ? transaction.totalItems : 0), 0);
        const turnover = activeTransactions.reduce((sum, transaction) => sum + (Number.isFinite(transaction.totalAmount) ? transaction.totalAmount : 0), 0);
        const topRecords = buildTopRecordsForTransactions(activeTransactions);

        const topListHtml = topRecords.length === 0
            ? '<p class="empty-row">Nog geen gekoppelde verkoopregels.</p>'
            : topRecords.slice(0, 5).map((item) => `<p>${escapeHtml(item.label)} • ${item.quantity}x • EUR ${formatCurrency(item.revenue)}</p>`).join('');

        return `
            <article class="agenda-item">
                <div class="agenda-item-date">${escapeHtml(formatDateDisplay(fair.date))}</div>
                <div class="agenda-item-content">
                    <h4>${escapeHtml(fair.name || '')}</h4>
                    <p>${escapeHtml(fair.city || '')} • ${escapeHtml(formatTimeRange(fair.startTime, fair.endTime))}</p>
                    <p>Transacties: ${activeTransactions.length} actief (${canceledTransactions} geannuleerd)</p>
                    <p>Verkochte items: ${itemsSold} • Omzet: EUR ${formatCurrency(turnover)}</p>
                    <p><strong>Top platen:</strong></p>
                    ${topListHtml}
                </div>
            </article>
        `;
    }).join('');
}

function buildTopRecordsForTransactions(transactions) {
    const recordMap = new Map();

    transactions.forEach((transaction) => {
        const items = Array.isArray(transaction.items) ? transaction.items : [];
        items.forEach((item) => {
            const key = `${item.barcode || ''}`;
            const label = `${item.artist || '-'} - ${item.album || '-'} (${item.barcode || '-'})`;
            const current = recordMap.get(key) || { label, quantity: 0, revenue: 0 };
            const qty = Number.isFinite(item.quantity) ? item.quantity : 0;
            const revenue = Number.isFinite(item.subtotal) ? item.subtotal : 0;
            current.quantity += qty;
            current.revenue += revenue;
            recordMap.set(key, current);
        });
    });

    return Array.from(recordMap.values()).sort((a, b) => {
        if (b.quantity !== a.quantity) return b.quantity - a.quantity;
        return b.revenue - a.revenue;
    });
}

function saveStoredFairs(fairs) {
    setStoredFairsLocal(fairs);
    void persistFairs(fairs);
}

function unlinkFairFromTransactions(fairId) {
    const transactions = getStoredTransactions();
    const updatedTransactions = transactions.map((transaction) => {
        const fairIds = Array.isArray(transaction.fairIds) ? transaction.fairIds.filter((id) => id !== fairId) : [];
        return { ...transaction, fairIds };
    });
    saveStoredTransactions(updatedTransactions);
}

function renderPlannedFairsTable() {
    const tableBody = document.getElementById('plannedFairsTableBody');
    if (!tableBody) return;

    const fairs = getStoredFairs().sort((a, b) => {
        const dateA = `${a.date || ''} ${a.startTime || '00:00'}`;
        const dateB = `${b.date || ''} ${b.startTime || '00:00'}`;
        return dateA.localeCompare(dateB);
    });

    if (fairs.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="6" class="empty-row">Nog geen beurzen gepland.</td></tr>';
        return;
    }

    const rows = fairs.map((fair) => `
        <tr>
            <td>${escapeHtml(formatDateDisplay(fair.date))}</td>
            <td>${escapeHtml(fair.name || '')}</td>
            <td>${escapeHtml(fair.city || '')}</td>
            <td>${escapeHtml(formatTimeRange(fair.startTime, fair.endTime))}</td>
            <td>${escapeHtml(fair.notes || '-')}</td>
            <td><button type="button" class="danger-btn remove-fair-btn" data-fair-id="${escapeHtml(fair.id)}">Verwijder</button></td>
        </tr>
    `).join('');

    tableBody.innerHTML = rows;
}

function renderDashboardAgenda() {
    const agendaSummary = document.getElementById('dashboardAgendaSummary');
    const agendaList = document.getElementById('dashboardAgendaList');
    if (!agendaSummary || !agendaList) return;

    const today = getTodayDateString();
    const fairs = getStoredFairs()
        .filter((fair) => String(fair.date || '') >= today)
        .sort((a, b) => {
            const dateA = `${a.date || ''} ${a.startTime || '00:00'}`;
            const dateB = `${b.date || ''} ${b.startTime || '00:00'}`;
            return dateA.localeCompare(dateB);
        });

    if (fairs.length === 0) {
        agendaSummary.textContent = 'Nog geen beurzen ingepland.';
        agendaList.innerHTML = '<div class="empty-row">Plan je eerste beurs via "Beurzen plannen".</div>';
        renderDashboardOverview();
        return;
    }

    agendaSummary.textContent = `${fairs.length} komende beurs${fairs.length === 1 ? '' : 'en'}`;
    const maxItems = fairs.slice(0, 8);
    agendaList.innerHTML = maxItems.map((fair) => `
        <article class="agenda-item">
            <div class="agenda-item-date">${escapeHtml(formatDateDisplay(fair.date))}</div>
            <div class="agenda-item-content">
                <h4>${escapeHtml(fair.name || '')}</h4>
                <p>${escapeHtml(fair.city || '')} • ${escapeHtml(formatTimeRange(fair.startTime, fair.endTime))}</p>
                ${fair.notes ? `<p class="agenda-note">${escapeHtml(fair.notes)}</p>` : ''}
            </div>
        </article>
    `).join('');

    renderDashboardOverview();
}

function renderDashboardOverview() {
    const totalProductsEl = document.getElementById('overviewTotalProducts');
    const totalStockEl = document.getElementById('overviewTotalStock');
    const inventoryValueEl = document.getElementById('overviewInventoryValue');
    const upcomingFairsEl = document.getElementById('overviewUpcomingFairs');
    if (!totalProductsEl || !totalStockEl || !inventoryValueEl || !upcomingFairsEl) return;

    const products = getStoredProducts();
    const fairs = getStoredFairs();
    const today = getTodayDateString();

    const totalProducts = products.length;
    const totalStock = products.reduce((sum, product) => {
        const stock = Number.isFinite(product.stock) ? product.stock : 0;
        return sum + stock;
    }, 0);
    const inventoryValue = products.reduce((sum, product) => {
        const stock = Number.isFinite(product.stock) ? product.stock : 0;
        const purchasePrice = Number.isFinite(product.purchasePrice) ? product.purchasePrice : 0;
        return sum + (stock * purchasePrice);
    }, 0);
    const upcomingFairs = fairs.filter((fair) => String(fair.date || '') >= today).length;

    totalProductsEl.textContent = String(totalProducts);
    totalStockEl.textContent = String(totalStock);
    inventoryValueEl.textContent = `EUR ${formatCurrency(inventoryValue)}`;
    upcomingFairsEl.textContent = String(upcomingFairs);
}

function formatDateDisplay(dateString) {
    if (!dateString) return '-';
    const date = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTimeDisplay(isoString) {
    if (!isoString) return '-';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return String(isoString);
    return date.toLocaleString('nl-NL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatTimeRange(startTime, endTime) {
    if (startTime && endTime) return `${startTime} - ${endTime}`;
    if (startTime) return `vanaf ${startTime}`;
    if (endTime) return `tot ${endTime}`;
    return 'Tijd n.t.b.';
}

function generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readImportFile(file) {
    const extension = (file.name.split('.').pop() || '').toLowerCase();

    if (extension === 'csv') {
        const text = await file.text();
        return parseCsvRows(text);
    }

    if (extension === 'xlsx' || extension === 'xls') {
        if (typeof window.XLSX === 'undefined') {
            throw new Error('XLSX parser niet beschikbaar');
        }
        const arrayBuffer = await file.arrayBuffer();
        const workbook = window.XLSX.read(arrayBuffer, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const firstSheet = workbook.Sheets[firstSheetName];
        return window.XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
    }

    throw new Error('Onbekend bestandsformaat');
}

function parseCsvRows(text) {
    const rows = [];
    const firstLine = String(text || '').split(/\r?\n/).find((line) => line.trim() !== '') || '';
    const semicolonCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const delimiter = semicolonCount >= commaCount ? ';' : ',';
    let current = '';
    let row = [];
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                current += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (!inQuotes && char === delimiter) {
            row.push(current);
            current = '';
            continue;
        }

        if (!inQuotes && (char === '\n' || char === '\r')) {
            if (char === '\r' && next === '\n') i += 1;
            row.push(current);
            current = '';
            if (row.some((cell) => String(cell).trim() !== '')) {
                rows.push(row);
            }
            row = [];
            continue;
        }

        current += char;
    }

    row.push(current);
    if (row.some((cell) => String(cell).trim() !== '')) rows.push(row);
    if (rows.length === 0) return [];

    const headers = rows[0].map((header) => normalizeImportHeader(header));
    return rows.slice(1).map((cells) => {
        const item = {};
        headers.forEach((header, index) => {
            item[header] = cells[index] !== undefined ? cells[index] : '';
        });
        return item;
    });
}

function normalizeImportedRows(rawRows) {
    return rawRows
        .map((raw) => {
            const row = mapRawImportRow(raw);
            return {
                barcode: sanitizeBarcode(row.barcode),
                artist: String(row.artist || '').trim(),
                album: String(row.album || '').trim(),
                purchasePrice: normalizeNumericText(row.purchasePrice),
                salePrice: normalizeNumericText(row.salePrice),
                stock: normalizeIntegerText(row.stock)
            };
        })
        .filter((row) => row.barcode !== '' || row.artist !== '' || row.album !== '');
}

function mapRawImportRow(raw) {
    const normalizedKeys = Object.keys(raw || {}).reduce((acc, key) => {
        acc[normalizeImportHeader(key)] = raw[key];
        return acc;
    }, {});

    return {
        barcode: getFirstValue(normalizedKeys, ['barcode', 'ean', 'upc']),
        artist: getFirstValue(normalizedKeys, ['artiest', 'artist']),
        album: getFirstValue(normalizedKeys, ['album', 'albumnaam', 'title']),
        purchasePrice: getFirstValue(normalizedKeys, ['inkoopprijs', 'purchaseprice', 'inkoop']),
        salePrice: getFirstValue(normalizedKeys, ['verkoopprijs', 'saleprice', 'verkoop']),
        stock: getFirstValue(normalizedKeys, ['voorraad', 'stock', 'hoeveelheid', 'aantal'])
    };
}

async function enrichMissingMetadata(rows) {
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!row.barcode) continue;
        if (row.artist && row.album) continue;

        try {
            const metadata = await fetchReleaseByBarcode(row.barcode);
            if (!metadata) continue;
            if (!row.artist) row.artist = metadata.artist || '';
            if (!row.album) row.album = metadata.album || '';
        } catch {
            // Keep row editable by user if lookup fails.
        }
    }
}

function validateImportRows(rows) {
    const errors = [];
    rows.forEach((row, index) => {
        const rowNo = index + 1;
        const barcode = sanitizeBarcode(row.barcode);
        const artist = String(row.artist || '').trim();
        const album = String(row.album || '').trim();
        const purchasePrice = Number.parseFloat(row.purchasePrice);
        const salePrice = Number.parseFloat(row.salePrice);
        const stock = Number.parseInt(row.stock, 10);

        if (!barcode) errors.push(`Rij ${rowNo}: barcode ontbreekt.`);
        if (!artist) errors.push(`Rij ${rowNo}: artiest ontbreekt.`);
        if (!album) errors.push(`Rij ${rowNo}: album ontbreekt.`);
        if (!Number.isFinite(purchasePrice) || purchasePrice < 0) errors.push(`Rij ${rowNo}: ongeldige inkoopprijs.`);
        if (!Number.isFinite(salePrice) || salePrice < 0) errors.push(`Rij ${rowNo}: ongeldige verkoopprijs.`);
        if (!Number.isInteger(stock) || stock < 0) errors.push(`Rij ${rowNo}: ongeldige voorraad.`);
    });
    return errors;
}

function renderImportPreviewTable() {
    const tableBody = document.getElementById('importPreviewTableBody');
    if (!tableBody) return;

    if (importPreviewRows.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="6" class="empty-row">Nog geen importbestand geladen.</td></tr>';
        return;
    }

    tableBody.innerHTML = importPreviewRows.map((row, index) => `
        <tr>
            <td><input type="text" value="${escapeHtml(row.barcode || '')}" data-row-index="${index}" data-field="barcode"></td>
            <td><input type="text" value="${escapeHtml(row.artist || '')}" data-row-index="${index}" data-field="artist"></td>
            <td><input type="text" value="${escapeHtml(row.album || '')}" data-row-index="${index}" data-field="album"></td>
            <td><input type="number" min="0" step="0.01" value="${escapeHtml(row.purchasePrice || '')}" data-row-index="${index}" data-field="purchasePrice"></td>
            <td><input type="number" min="0" step="0.01" value="${escapeHtml(row.salePrice || '')}" data-row-index="${index}" data-field="salePrice"></td>
            <td><input type="number" min="0" step="1" value="${escapeHtml(row.stock || '')}" data-row-index="${index}" data-field="stock"></td>
        </tr>
    `).join('');
}

function showImportMessage(message, type) {
    const messageElement = document.getElementById('importMessage');
    if (!messageElement) return;
    messageElement.textContent = message;
    messageElement.className = 'form-message show';
    if (type === 'error') messageElement.classList.add('error');
    if (type === 'success') messageElement.classList.add('success');
    if (type === 'info') messageElement.classList.add('info');
}

function normalizeImportHeader(header) {
    return String(header || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[^\w]/g, '');
}

function getFirstValue(object, keys) {
    for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (Object.prototype.hasOwnProperty.call(object, key)) {
            return object[key];
        }
    }
    return '';
}

function normalizeNumericText(value) {
    const text = String(value ?? '')
        .trim()
        .replace(/[^\d,.\-]/g, '')
        .replace(',', '.');
    return text;
}

function normalizeIntegerText(value) {
    const text = String(value ?? '').trim().replace(',', '.');
    if (text === '') return '';
    const parsed = Number.parseInt(text, 10);
    return Number.isFinite(parsed) ? String(parsed) : text;
}

async function fetchReleaseByBarcode(barcode) {
    const candidates = getBarcodeCandidates(barcode);
    const metadataCache = getMetadataCache();

    for (const candidate of candidates) {
        const cached = metadataCache[candidate];
        if (cached && cached.artist && cached.album) {
            return {
                artist: cached.artist,
                album: cached.album,
                source: 'cache'
            };
        }
    }

    for (const candidate of candidates) {
        const url = `https://musicbrainz.org/ws/2/release/?query=barcode:${encodeURIComponent(candidate)}&fmt=json&limit=25`;
        const response = await fetch(url, {
            headers: {
                Accept: 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`MusicBrainz error (${response.status})`);
        }

        const data = await response.json();
        const releases = Array.isArray(data.releases) ? data.releases : [];
        if (releases.length === 0) continue;

        const best = pickBestMusicBrainzRelease(releases);
        if (best) {
            setCachedMetadata(candidate, { artist: best.artist, album: best.album });
            return {
                artist: best.artist,
                album: best.album,
                source: 'musicbrainz'
            };
        }
    }

    for (const candidate of candidates) {
        const bertusMetadata = await fetchBertusMetadata(candidate);
        if (bertusMetadata) {
            setCachedMetadata(candidate, { artist: bertusMetadata.artist, album: bertusMetadata.album });
            return {
                artist: bertusMetadata.artist,
                album: bertusMetadata.album,
                source: 'bertus'
            };
        }
    }

    return null;
}

async function fetchBertusMetadata(barcode) {
    const bertusConfig = getBertusConfig();
    if (!bertusConfig.enabled) return null;

    const url = `https://myapi.bertus.com/prod/api/v1/accounts/${encodeURIComponent(bertusConfig.accountId)}/articles/${encodeURIComponent(barcode)}`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Ocp-Apim-Subscription-Key': bertusConfig.apiKey
            }
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            throw new Error(`Bertus error (${response.status})`);
        }

        const payload = await response.json();
        return extractBertusArtistAlbum(payload);
    } catch (error) {
        console.warn('Bertus metadata lookup failed:', error);
        return null;
    }
}

function getBertusConfig() {
    const apiKey = String(localStorage.getItem(BERTUS_API_KEY_STORAGE) || '').trim();
    const accountId = String(localStorage.getItem(BERTUS_ACCOUNT_ID_STORAGE) || '').trim();
    return {
        enabled: apiKey !== '' && accountId !== '',
        apiKey,
        accountId
    };
}

function extractBertusArtistAlbum(payload) {
    const candidates = flattenObjects(payload);
    for (let i = 0; i < candidates.length; i += 1) {
        const item = candidates[i];
        if (!item || typeof item !== 'object') continue;

        const artist = pickFirstStringValue(item, ['Artist', 'artist', 'Performer', 'MainArtist', 'ArtistName']);
        const album = pickFirstStringValue(item, ['Title', 'title', 'Album', 'AlbumName', 'Description', 'ArticleDescription', 'Name']);
        if (artist && album) {
            return { artist, album };
        }
    }

    return null;
}

function flattenObjects(input) {
    const result = [];

    function walk(node) {
        if (Array.isArray(node)) {
            node.forEach((item) => walk(item));
            return;
        }
        if (!node || typeof node !== 'object') return;
        result.push(node);
        Object.keys(node).forEach((key) => {
            walk(node[key]);
        });
    }

    walk(input);
    return result;
}

function pickFirstStringValue(object, keys) {
    for (let i = 0; i < keys.length; i += 1) {
        const value = object[keys[i]];
        if (typeof value === 'string' && value.trim() !== '') {
            return value.trim();
        }
    }
    return '';
}

function pickBestMusicBrainzRelease(releases) {
    let bestItem = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    releases.forEach((release) => {
        const artist = normalizeArtistFromCredit(release['artist-credit']);
        const album = release && release.title ? String(release.title).trim() : '';
        if (!artist || !album) return;

        const apiScore = Number.parseInt(release.score || release['ext:score'] || '0', 10);
        const formats = getReleaseFormats(release);
        const hasVinyl = formats.some((f) => /vinyl|lp|12"|10"|7"/i.test(f));
        const hasOnlyCd = formats.length > 0 && formats.every((f) => /cd/i.test(f));
        const status = String(release.status || '').toLowerCase();

        let weightedScore = Number.isFinite(apiScore) ? apiScore : 0;
        if (hasVinyl) weightedScore += 35;
        if (hasOnlyCd) weightedScore -= 20;
        if (status === 'official') weightedScore += 8;

        if (weightedScore > bestScore) {
            bestScore = weightedScore;
            bestItem = { artist, album };
        }
    });

    return bestItem;
}

function getReleaseFormats(release) {
    if (!release || !Array.isArray(release.media)) return [];
    return release.media
        .map((m) => (m && m.format ? String(m.format).trim() : ''))
        .filter(Boolean);
}

function normalizeArtistFromCredit(artistCredit) {
    const credits = Array.isArray(artistCredit) ? artistCredit : [];
    return credits
        .map((credit) => {
            if (!credit) return '';
            if (typeof credit === 'string') return credit;
            if (credit.name) return credit.name;
            if (credit.artist && credit.artist.name) return credit.artist.name;
            return '';
        })
        .join('')
        .trim();
}

function getStoredProducts() {
    const raw = localStorage.getItem(PRODUCTS_STORAGE_KEY);
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function getCurrentUserName() {
    if (currentServerSession && currentServerSession.username) {
        return String(currentServerSession.username);
    }
    return '';
}

function getStoredProductByBarcode(barcode) {
    const candidates = getBarcodeCandidates(barcode);
    const products = getStoredProducts();
    return products.find((product) => candidates.includes(String(product.barcode || ''))) || null;
}

function renderProductsTable() {
    const tableBody = document.getElementById('productsTableBody');
    if (!tableBody) return;

    if (sessionAddedProducts.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="7" class="empty-row">Nog geen producten toegevoegd in deze sessie.</td></tr>';
        return;
    }

    const rows = sessionAddedProducts
        .slice()
        .sort((a, b) => (a.artist || '').localeCompare(b.artist || '', 'nl'))
        .map((product) => `
            <tr>
                <td>${escapeHtml(product.barcode)}</td>
                <td>${escapeHtml(product.artist)}</td>
                <td>${escapeHtml(product.album)}</td>
                <td>EUR ${formatCurrency(product.purchasePrice)}</td>
                <td>EUR ${formatCurrency(product.salePrice)}</td>
                <td><input type="number" min="0" step="1" value="${Number.isFinite(product.stock) ? product.stock : 0}" class="stock-add-input session-stock-input" data-barcode="${escapeHtml(product.barcode)}"></td>
                <td><button type="button" class="danger-btn remove-session-btn" data-barcode="${escapeHtml(product.barcode)}">X</button></td>
            </tr>
        `)
        .join('');

    tableBody.innerHTML = rows;
}

function renderSearchResults(query = '') {
    const tableBody = document.getElementById('searchResultsTableBody');
    if (!tableBody) return;

    const products = getStoredProducts();
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const filteredProducts = normalizedQuery
        ? products.filter((product) => matchesProductQuery(product, normalizedQuery))
        : products.slice();

    if (filteredProducts.length === 0) {
        const message = products.length === 0
            ? 'Nog geen producten beschikbaar.'
            : 'Geen producten gevonden voor deze zoekopdracht.';
        tableBody.innerHTML = `<tr><td colspan="6" class="empty-row">${message}</td></tr>`;
        return;
    }

    const rows = sortProductsForSearch(filteredProducts)
        .map((product) => `
            <tr>
                <td>${escapeHtml(product.barcode)}</td>
                <td>${escapeHtml(product.artist)}</td>
                <td>${escapeHtml(product.album)}</td>
                <td>
                    <div class="stock-inline-editor">
                        <button type="button" class="stock-display-btn" data-barcode="${escapeHtml(product.barcode)}">${Number.isFinite(product.stock) ? product.stock : 0}</button>
                        <div class="stock-edit-group hidden" data-barcode="${escapeHtml(product.barcode)}">
                            <input type="number" min="0" step="1" value="${Number.isFinite(product.stock) ? product.stock : 0}" class="stock-edit-input" data-barcode="${escapeHtml(product.barcode)}">
                            <button type="button" class="success-btn stock-save-btn" data-barcode="${escapeHtml(product.barcode)}">âœ“</button>
                        </div>
                    </div>
                </td>
                <td><input type="number" min="0" step="0.01" value="${formatNumberForInput(product.salePrice)}" class="sale-price-input" data-barcode="${escapeHtml(product.barcode)}"></td>
                <td>
                    <button type="button" class="danger-btn delete-product-btn" data-barcode="${escapeHtml(product.barcode)}">Verwijder</button>
                </td>
            </tr>
        `)
        .join('');

    tableBody.innerHTML = rows;
    updateSortButtons();
}

function setSearchSort(nextKey) {
    if (SEARCH_SORT_STATE.key === nextKey) {
        SEARCH_SORT_STATE.direction = SEARCH_SORT_STATE.direction === 'asc' ? 'desc' : 'asc';
        return;
    }
    SEARCH_SORT_STATE.key = nextKey;
    SEARCH_SORT_STATE.direction = nextKey === 'stock' || nextKey === 'salePrice' ? 'desc' : 'asc';
}

function sortProductsForSearch(products) {
    const directionFactor = SEARCH_SORT_STATE.direction === 'asc' ? 1 : -1;
    return products.slice().sort((a, b) => {
        if (SEARCH_SORT_STATE.key === 'stock' || SEARCH_SORT_STATE.key === 'salePrice') {
            const numericKey = SEARCH_SORT_STATE.key;
            const valueA = Number.isFinite(a[numericKey]) ? a[numericKey] : 0;
            const valueB = Number.isFinite(b[numericKey]) ? b[numericKey] : 0;
            return (valueA - valueB) * directionFactor;
        }

        const valueA = String(a[SEARCH_SORT_STATE.key] || '').toLowerCase();
        const valueB = String(b[SEARCH_SORT_STATE.key] || '').toLowerCase();
        return valueA.localeCompare(valueB, 'nl') * directionFactor;
    });
}

function updateSortButtons() {
    const sortButtons = document.querySelectorAll('.sort-btn');
    sortButtons.forEach((button) => {
        const key = button.getAttribute('data-sort-key');
        const baseLabel = button.textContent ? button.textContent.split(' ')[0] : '';
        if (!key || !baseLabel) return;

        button.classList.remove('active');
        button.textContent = baseLabel;

        if (key === SEARCH_SORT_STATE.key) {
            button.classList.add('active');
            const marker = SEARCH_SORT_STATE.direction === 'asc' ? 'ASC' : 'DESC';
            button.textContent = `${baseLabel} ${marker}`;
        }
    });
}

function upsertSessionProduct(productRecord) {
    const existingIndex = sessionAddedProducts.findIndex((item) => item.barcode === productRecord.barcode);
    if (existingIndex >= 0) {
        sessionAddedProducts[existingIndex] = {
            ...sessionAddedProducts[existingIndex],
            ...productRecord,
            updatedAt: new Date().toISOString()
        };
    } else {
        sessionAddedProducts.push(productRecord);
    }
}

function resetProductForm(elements) {
    elements.barcodeInput.value = '';
    elements.artistInput.value = '';
    elements.albumInput.value = '';
    elements.purchasePriceInput.value = '';
    elements.salePriceInput.value = '';
    elements.stockInput.value = '';
    elements.saveProductBtn.disabled = true;
    setMetadataInputsManualMode(false);
    elements.barcodeInput.focus();
}

function getBarcodeCandidates(barcode) {
    const cleaned = sanitizeBarcode(barcode);
    const candidates = [cleaned];

    if (cleaned.length === 13 && cleaned.startsWith('0')) {
        candidates.push(cleaned.slice(1));
    }
    if (cleaned.length === 12) {
        candidates.push(`0${cleaned}`);
    }

    return [...new Set(candidates)];
}

function getMetadataCache() {
    const raw = localStorage.getItem(BARCODE_METADATA_CACHE_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function setCachedMetadata(barcode, metadata) {
    const candidates = getBarcodeCandidates(barcode);
    const cache = getMetadataCache();
    const payload = {
        artist: String(metadata.artist || '').trim(),
        album: String(metadata.album || '').trim(),
        updatedAt: new Date().toISOString()
    };
    if (!payload.artist || !payload.album) return;

    candidates.forEach((candidate) => {
        cache[candidate] = payload;
    });

    localStorage.setItem(BARCODE_METADATA_CACHE_KEY, JSON.stringify(cache));
}

function setMetadataInputsManualMode(enabled) {
    const artistInput = document.getElementById('artistInput');
    const albumInput = document.getElementById('albumInput');
    if (!artistInput || !albumInput) return;

    artistInput.readOnly = !enabled;
    albumInput.readOnly = !enabled;
}

function matchesProductQuery(product, normalizedQuery) {
    const barcode = String(product.barcode || '').toLowerCase();
    const artist = String(product.artist || '').toLowerCase();
    const album = String(product.album || '').toLowerCase();
    return barcode.includes(normalizedQuery) || artist.includes(normalizedQuery) || album.includes(normalizedQuery);
}

function sanitizeBarcode(value) {
    return String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

function formatCurrency(value) {
    const amount = Number.parseFloat(value);
    if (!Number.isFinite(amount)) return '0,00';
    return amount.toFixed(2).replace('.', ',');
}

function formatNumberForInput(value) {
    const amount = Number.parseFloat(value);
    if (!Number.isFinite(amount)) return '0.00';
    return amount.toFixed(2);
}

function getTodayDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function roundCurrency(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showProductFormMessage(message, type) {
    const messageElement = document.getElementById('productFormMessage');
    if (!messageElement) return;

    messageElement.textContent = message;
    messageElement.className = 'form-message show';
    if (type === 'error') messageElement.classList.add('error');
    if (type === 'success') messageElement.classList.add('success');
    if (type === 'info') messageElement.classList.add('info');
}

function showSearchMessage(message, type) {
    const messageElement = document.getElementById('searchMessage');
    if (!messageElement) return;

    messageElement.textContent = message;
    messageElement.className = 'form-message show';
    if (type === 'error') messageElement.classList.add('error');
    if (type === 'success') messageElement.classList.add('success');
    if (type === 'info') messageElement.classList.add('info');
}

function showFairPlannerMessage(message, type) {
    const messageElement = document.getElementById('fairPlannerMessage');
    if (!messageElement) return;

    messageElement.textContent = message;
    messageElement.className = 'form-message show';
    if (type === 'error') messageElement.classList.add('error');
    if (type === 'success') messageElement.classList.add('success');
    if (type === 'info') messageElement.classList.add('info');
}

function showCashierMessage(message, type) {
    const messageElement = document.getElementById('cashierMessage');
    if (!messageElement) return;

    messageElement.textContent = message;
    messageElement.className = 'form-message show';
    if (type === 'error') messageElement.classList.add('error');
    if (type === 'success') messageElement.classList.add('success');
    if (type === 'info') messageElement.classList.add('info');
}

function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
    }
    return String(value).replace(/"/g, '\\"');
}

function logout() {
    if (confirm('Weet je zeker dat je wil uitloggen?')) {
        stopCameraBarcodeScan();
        if (cashierConnectivityTimer) {
            clearInterval(cashierConnectivityTimer);
            cashierConnectivityTimer = null;
        }
        if (sharedDataSyncTimer) {
            clearInterval(sharedDataSyncTimer);
            sharedDataSyncTimer = null;
        }
        apiRequest('./api/logout', { method: 'POST' })
            .finally(() => {
                currentServerSession = null;
                goToRoute('login');
            });
    }
}

window.addEventListener('pageshow', function (event) {
    if (event.persisted && document.getElementById('logoutBtn')) {
        if (isDashboardPage) checkAuthentication('admin');
        if (isCashierPage) checkAuthentication('cashier');
    }
});









