chrome.runtime.onMessage.addListener(
    (message) => {

        if (message.type === "START") {

            console.log(
                "Automation started"
            );

            // Playwright-style logic goes here
            // but inside the page
        }

    }
);