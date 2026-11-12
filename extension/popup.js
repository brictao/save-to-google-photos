// ============================================================
// Save to Google Photos — Popup Script
// ============================================================

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const statusHint = document.getElementById("statusHint");
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");

// --------------------------------------------------
// Check auth status on popup open
// --------------------------------------------------
async function checkAuthStatus() {
    try {
        const response = await sendMessage({
            action: "getAuthToken",
            interactive: false,
        });

        if (response.success && response.token) {
            setSignedIn();
        } else {
            setSignedOut();
        }
    } catch {
        setSignedOut();
    }
}

// --------------------------------------------------
// UI state helpers
// --------------------------------------------------
function setSignedIn() {
    statusDot.className = "dot online";
    statusText.textContent = "Signed In";
    statusHint.textContent = "You're connected to Google Photos.";
    signInBtn.style.display = "none";
    signOutBtn.style.display = "flex";
}

function setSignedOut() {
    statusDot.className = "dot offline";
    statusText.textContent = "Not Signed In";
    statusHint.textContent = "Sign in to start saving images.";
    signInBtn.style.display = "flex";
    signOutBtn.style.display = "none";
}

function setLoading(text) {
    statusDot.className = "dot";
    statusText.textContent = text;
    statusHint.textContent = "";
    signInBtn.style.display = "none";
    signOutBtn.style.display = "none";
}

// --------------------------------------------------
// Button handlers
// --------------------------------------------------
signInBtn.addEventListener("click", async () => {
    setLoading("Signing in…");
    try {
        const response = await sendMessage({
            action: "getAuthToken",
            interactive: true,
        });
        if (response.success) {
            setSignedIn();
        } else {
            setSignedOut();
            statusHint.textContent = response.error || "Sign-in failed.";
        }
    } catch {
        setSignedOut();
        statusHint.textContent = "Sign-in failed. Please try again.";
    }
});

signOutBtn.addEventListener("click", async () => {
    setLoading("Signing out…");
    try {
        await sendMessage({ action: "signOut" });
    } catch {
        // ignore errors
    }
    setSignedOut();
});

// --------------------------------------------------
// Messaging helper
// --------------------------------------------------
function sendMessage(msg) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response);
            }
        });
    });
}

// --------------------------------------------------
// Init
// --------------------------------------------------
checkAuthStatus();
