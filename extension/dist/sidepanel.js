const apiKeysEl = document.getElementById("apiKeys");
const save = document.getElementById("saveKey");

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

const start = document.getElementById("start");

start.onclick = async () => {
    if (start.classList.contains("start")) {
        start.classList.replace("start", "stop");
        start.innerText = "Stop Automation";

        const keysArray = apiKeysEl.value.split('\n').map(k => k.trim()).filter(k => k);

        await fetch("http://localhost:3000/start", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ apiKeys: keysArray })
        });

    } else {
        start.classList.replace("stop", "start");
        start.innerText = "Start Automation";

        await fetch("http://localhost:3000/stop", {
            method: "GET",
            headers: {
                "Content-Type": "application/json"
            }
        });
    }
};

// Poll server for Bookwork updates
setInterval(async () => {
    try {
        const res = await fetch("http://localhost:3000/bookwork");
        const data = await res.json();
        
        const bwDiv = document.getElementById("bookwork");
        if (data.bookworks && data.bookworks.length > 0) {
            bwDiv.innerHTML = data.bookworks.map(b => 
                `<p style="margin: 5px 0;"><strong>Code ${b.code}</strong>: ${b.answer}</p>`
            ).join("");
        }
    } catch (e) {
        // Server might be off or starting up
    }
}, 2000);
