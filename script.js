// Hardcoded admin gebruiker
const ADMIN_USER = {
    username: 'admin',
    password: 'admin123'
};

const SESSION_STORAGE_KEY = 'userSession';

// ==================== LOGIN PAGE ==================== 

// Check if on login page and handle login form
if (document.getElementById('loginForm')) {
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    
    loginForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        
        // Validate credentials
        if (username === ADMIN_USER.username && password === ADMIN_USER.password) {
            // Store session
            const sessionData = {
                username: username,
                loginTime: new Date().toISOString(),
                isAuthenticated: true
            };
            localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessionData));
            
            // Redirect to dashboard
            window.location.href = 'dashboard.html';
        } else {
            // Show error message
            errorMessage.textContent = 'Gebruikersnaam of wachtwoord is onjuist.';
            errorMessage.classList.add('show');
            
            // Clear password field
            document.getElementById('password').value = '';
            
            // Hide error after 5 seconds
            setTimeout(() => {
                errorMessage.classList.remove('show');
            }, 5000);
        }
    });
}

// ==================== DASHBOARD PAGE ==================== 

// Check if on dashboard page
if (document.getElementById('logoutBtn')) {
    checkAuthentication();
    initializeDashboard();
    
    document.getElementById('logoutBtn').addEventListener('click', logout);
}

function checkAuthentication() {
    const sessionData = localStorage.getItem(SESSION_STORAGE_KEY);
    
    if (!sessionData) {
        // Not authenticated, redirect to login
        window.location.href = 'index.html';
        return;
    }
    
    const session = JSON.parse(sessionData);
    
    // Optional: Check if session is expired (e.g., 24 hours)
    const loginTime = new Date(session.loginTime);
    const now = new Date();
    const hoursDiff = (now - loginTime) / (1000 * 60 * 60);
    
    if (hoursDiff > 24) {
        localStorage.removeItem(SESSION_STORAGE_KEY);
        window.location.href = 'index.html';
        return;
    }
    
    // Update UI with username
    const displayName = session.username.charAt(0).toUpperCase() + session.username.slice(1);
    document.getElementById('userName').textContent = displayName;
    document.getElementById('dashboardUserName').textContent = displayName;
    document.getElementById('sessionUser').textContent = displayName;
    
    // Update session time
    updateSessionTime(loginTime);
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
    // Add click handlers to dashboard cards
    const dashboardCards = document.querySelectorAll('.dashboard-card');
    dashboardCards.forEach((card, index) => {
        card.addEventListener('click', function() {
            const cardText = card.querySelector('h3').textContent;
            console.log(`Navigeren naar: ${cardText}`);
            // In een echte applicatie zou je hier navigeren naar de relevante pagina
        });
    });
}

function logout() {
    // Confirm logout
    if (confirm('Weet je zeker dat je wil uitloggen?')) {
        // Clear session
        localStorage.removeItem(SESSION_STORAGE_KEY);
        
        // Redirect to login
        window.location.href = 'index.html';
    }
}

// Prevent going back to dashboard without authentication
window.addEventListener('pageshow', function(event) {
    if (event.persisted) {
        // Page was restored from cache
        if (document.getElementById('logoutBtn')) {
            checkAuthentication();
        }
    }
});
