const apiKeysEl = document.getElementById("apiKeys");
const save = document.getElementById("saveKey");
const toggleKeys = document.getElementById("toggleKeys");

chrome.storage.local.get(
    ["apiKeys"],
    data => {
        apiKeysEl.value = data.apiKeys ?? "";
    }
);

save.onclick = () => {
    chrome.storage.local.set({
        apiKeys: apiKeysEl.value
    });
};

toggleKeys.onchange = () => {
    if (toggleKeys.checked) {
        apiKeysEl.classList.remove("censored");
    } else {
        apiKeysEl.classList.add("censored");
    }
};

const start = document.getElementById("start");

start.onclick = async () => {
    const keysArray = apiKeysEl.value.split('\n').map(k => k.trim()).filter(k => k);

    if (start.classList.contains("start")) {
        if (keysArray.length === 0) {
            alert("Please enter at least one Gemini API key first!");
            return;
        }

        start.disabled = true;
        start.innerText = "Connecting...";

        try {
            const res = await fetch("http://localhost:3000/start", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ apiKeys: keysArray })
            });

            if (!res.ok) {
                const text = await res.text();
                alert(`Failed to start server automation: ${text}`);
                start.disabled = false;
                start.innerText = "Start Automation";
                return;
            }

            start.classList.replace("start", "stop");
            start.innerText = "Stop Automation";
            start.disabled = false;
        } catch (err) {
            alert(`Error connecting to local server (http://localhost:3000). Is 'npm start' running?\n\nDetails: ${err.message}`);
            start.disabled = false;
            start.innerText = "Start Automation";
        }

    } else {
        start.disabled = true;
        start.innerText = "Stopping...";

        try {
            await fetch("http://localhost:3000/stop", {
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                }
            });
        } catch (err) {}

        start.classList.replace("stop", "start");
        start.innerText = "Start Automation";
        start.disabled = false;
    }
};


// Poll for status
const statusIndicator = document.getElementById("statusIndicator");
setInterval(async () => {
    try {
        const res = await fetch("http://localhost:3000/status");
        const data = await res.json();
        
        statusIndicator.innerText = `Status: ${data.status.text}`;
        statusIndicator.className = `status-${data.status.level}`;
        
        // Sync button state if needed (e.g. if server stopped externally)
        if (!data.running && start.classList.contains("stop")) {
            start.classList.replace("stop", "start");
            start.innerText = "Start Automation";
        } else if (data.running && start.classList.contains("start")) {
            start.classList.replace("start", "stop");
            start.innerText = "Stop Automation";
        }
    } catch (e) {
        statusIndicator.innerText = "Status: Server Offline";
        statusIndicator.className = "status-warn";
    }
}, 1000);

let currentBookworkMemory = {};

function renderBookworkUI(bookworkMap) {
    currentBookworkMemory = { ...bookworkMap };
    const bwDiv = document.getElementById("bookwork");
    const entries = Object.entries(bookworkMap);
    if (entries.length === 0) {
        bwDiv.innerHTML = "No bookwork detected yet.";
        return;
    }

    bwDiv.innerHTML = entries.map(([code, answer]) => `
        <div class="bw-item" style="display: flex; justify-content: space-between; align-items: center; margin: 6px 0; padding: 6px 8px; background: #f3f4f6; border-radius: 8px;">
            <div style="flex-grow: 1; word-break: break-word; margin-right: 8px;">
                <strong>Code ${code}</strong>: <span class="bw-answer">${answer}</span>
            </div>
            <button class="clear-single-bw" data-code="${code}" style="width: auto; padding: 3px 8px; font-size: 11px; background: #9ca3af; border-radius: 6px; flex-shrink: 0;">Delete</button>
        </div>
    `).join("");

    // Render KaTeX for all math formulas in answers
    if (window.renderMathInElement) {
        try {
            window.renderMathInElement(bwDiv, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '$', right: '$', display: false},
                    {left: '\\(', right: '\\)', display: false},
                    {left: '\\[', right: '\\]', display: true}
                ],
                throwOnError: false
            });
        } catch (e) {
            console.error("KaTeX rendering error:", e);
        }
    }

    // Attach single item clear listeners
    document.querySelectorAll(".clear-single-bw").forEach(btn => {
        btn.onclick = async (e) => {
            const code = e.currentTarget.getAttribute("data-code");
            delete currentBookworkMemory[code];
            
            // Record deletion in local storage
            const stored = await chrome.storage.local.get(["bookworkMemory", "deletedBookworks"]);
            const deletedSet = stored.deletedBookworks || {};
            deletedSet[code] = true;

            await chrome.storage.local.set({ 
                bookworkMemory: currentBookworkMemory,
                deletedBookworks: deletedSet
            });
            
            // Sync server
            try {
                await fetch(`http://localhost:3000/bookwork/${encodeURIComponent(code)}`, { method: "DELETE" });
            } catch (err) {}
            renderBookworkUI(currentBookworkMemory);
        };
    });
}

// Clear All handler
document.getElementById("clearAllBw").onclick = async () => {
    currentBookworkMemory = {};
    const stored = await chrome.storage.local.get(["bookworkMemory"]);
    const allCodes = Object.keys(stored.bookworkMemory || {});
    const deletedSet = {};
    allCodes.forEach(c => deletedSet[c] = true);

    await chrome.storage.local.set({ bookworkMemory: {}, deletedBookworks: deletedSet });
    try {
        await fetch("http://localhost:3000/bookwork", { method: "DELETE" });
    } catch (e) {}
    renderBookworkUI({});
};

// Poll server for Bookwork updates
setInterval(async () => {
    try {
        const res = await fetch("http://localhost:3000/bookwork");
        const data = await res.json();
        
        if (data.bookworks) {
            chrome.storage.local.get(["bookworkMemory", "deletedBookworks"], (storedData) => {
                const existing = storedData.bookworkMemory || {};
                const deletedSet = storedData.deletedBookworks || {};
                let updated = false;
                
                // Only ADD new items if they haven't been deleted by user
                data.bookworks.forEach(b => {
                    if (!existing.hasOwnProperty(b.code) && !deletedSet[b.code]) {
                        existing[b.code] = b.answer;
                        updated = true;
                    }
                });

                if (updated) {
                    chrome.storage.local.set({ bookworkMemory: existing });
                    renderBookworkUI(existing);
                }
            });
        }
    } catch (e) {
        // Server might be off or starting up
    }
}, 2000);

// Load persisted bookwork memory on popup load and sync server to match local storage
chrome.storage.local.get(["bookworkMemory"], async (data) => {
    const memory = data.bookworkMemory || {};
    renderBookworkUI(memory);
    
    // Sync server with local storage state on load
    const bwArray = Object.entries(memory).map(([c, a]) => ({ code: c, answer: a }));
    try {
        await fetch("http://localhost:3000/bookwork", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bookworks: bwArray })
        });
    } catch (e) {}
});





