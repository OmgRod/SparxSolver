# sparx solver because sparx sucks!

## setup guide

You need to install Node.js (version 20-ish best but overall go for a more modern version): https://nodejs.org/en/download

Then, download the repository by scrolling up, clicking "Code" -> "Download as zip"

Then, unzip it.

Then go into the folder and open a command prompt in it.

Inside, run the following commands in the exact order:

```
npm i
cd extension
npm i
npm run build
cd ..
npm start
```

If there is an issue, run the following command:

```
npm i -g playwright
npx playwright install chromium
```

Then run:

```
npm start
```

## THEN FOLLOW THE INSTRUCTIONS ON SCREEN!!!
