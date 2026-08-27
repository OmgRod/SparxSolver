import express from 'express';
import path from 'path';
import cors from 'cors';
import { BrowserContext, Page } from 'playwright';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve('./server')));

let browserContext: BrowserContext | null = null;
let automationRunning = false;

export function setContext(context: BrowserContext) {
  browserContext = context;
}

app.post('/start', (req, res) => {
  console.log('[Server] Received /start POST request from extension.');
  const apiKeys = req.body.apiKeys;
  const apiKey = req.body.apiKey; // Fallback for backwards compatibility
  
  const keys = apiKeys || (apiKey ? [apiKey] : []);
  
  if (!keys || keys.length === 0) {
    console.log('[Server] No API keys provided in the request body.');
    res.status(400).send('No API keys provided');
    return;
  }
  
  if (automationRunning) {
    console.log('[Server] Automation is already running.');
    res.send('Already running');
    return;
  }
  
  console.log(`[Server] Starting automation loop with ${keys.length} API keys...`);
  automationRunning = true;
  res.send('Started');
  
  // start automation loop asynchronously
  startAutomation(keys).catch(console.error);
});

app.get('/stop', (req, res) => {
  console.log('[Server] Received /stop request.');
  automationRunning = false;
  res.send('Stopped');
});

// Tool Definitions for Gemini
const playwright_click: FunctionDeclaration = {
  name: 'playwright_click',
  description: 'Click an element on the page using a CSS selector.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      selector: { type: Type.STRING, description: 'The CSS selector of the element to click.' }
    },
    required: ['selector']
  }
};

const playwright_fill: FunctionDeclaration = {
  name: 'playwright_fill',
  description: 'Fill an answer slot with a value. The server will automatically click the slot, then find and click the correct tile or keypad button. Use this for ALL answer slots — numbers, fractions, operators like +, -, etc.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      selector: { type: Type.STRING, description: 'The CSS selector of the answer slot (e.g. [data-ai-id="15"]).' },
      value: { type: Type.STRING, description: 'The value to enter, e.g. "5", "-22", "+", "-", "1/5".' }
    },
    required: ['selector', 'value']
  }
};

const playwright_evaluate: FunctionDeclaration = {
  name: 'playwright_evaluate',
  description: 'Evaluate JavaScript in the page context and return the result as a string. E.g. document.querySelector("button").innerText',
  parameters: {
    type: Type.OBJECT,
    properties: {
      script: { type: Type.STRING, description: 'The JavaScript string to evaluate.' }
    },
    required: ['script']
  }
};

const get_screenshot_and_html: FunctionDeclaration = {
  name: 'get_screenshot_and_html',
  description: 'Takes a screenshot and gets the HTML of the current page or a specific container. ALWAYS call this first to see the screen and choose selectors.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      selector: { type: Type.STRING, description: 'Optional CSS selector to scope the HTML (e.g. "div[class*=\"_AnswerScreen\"]"). Leave empty for full body.' }
    }
  }
};

const task_done: FunctionDeclaration = {
  name: 'task_done',
  description: 'Call this when you have successfully solved the current screen. If the question has multiple parts and you need to remember the answer for the next screen, provide it in memory_for_next_part. If the entire question is completely finished and you are moving to a new question, leave memory_for_next_part empty.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      message: { type: Type.STRING, description: 'A final summary of what was done.' },
      memory_for_next_part: { type: Type.STRING, description: 'Important facts or answers to remember for the next part of THIS question. Leave empty if the entire question is fully finished.' },
      bookwork_code: { type: Type.STRING, description: 'The bookwork code (e.g. "34") shown on the page.' },
      answer: { type: Type.STRING, description: 'The final answer you entered for this question. Required if this is the final part of the question.' }
    }
  }
};

const calculate_answer: FunctionDeclaration = {
  name: 'calculate_answer',
  description: 'Use this tool to write out your step-by-step mathematical working and determine the final answer BEFORE you start clicking any answer slots on the screen.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      step_by_step_working: { type: Type.STRING, description: 'Your detailed mathematical working out. Double check your math!' },
      final_answer: { type: Type.STRING, description: 'The final calculated answer.' }
    },
    required: ["step_by_step_working", "final_answer"]
  }
};

const get_bookwork_answer: FunctionDeclaration = {
  name: 'get_bookwork_answer',
  description: 'Look up a previously saved answer for a given bookwork code. Call this FIRST on bookwork check screens before looking at tiles — it returns the exact answer string that was saved when this question was originally answered.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      bookwork_code: { type: Type.STRING, description: 'The bookwork code shown on the page, e.g. "4B" or "12".' }
    },
    required: ['bookwork_code']
  }
};

async function getActivePage(): Promise<Page | null> {
  if (!browserContext) return null;
  const pages = browserContext.pages();
  let activePage = pages.find(p => p.url().includes('sparx'));
  return activePage || (pages.length > 0 ? pages[0] : null);
}

const fallbackModels = [
  // --- Gemini 3.x Family (Frontier & Agentic Workflows) ---
  'gemini-3.5-flash',         // Stable - The current default flagship for speed, coding, and loops
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro'
];
let currentModelIndex = 0;
let bookworks: { code: string, answer: string }[] = [];

app.get('/bookwork', (req, res) => {
  res.json({ bookworks });
});

async function startAutomation(apiKeys: string[]) {
  console.log(`[Automation] Initializing Gemini Agent with ${apiKeys.length} API keys...`);
  
  let currentKeyIndex = 0;
  let ai = new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
  
  let previousMemory = "";
  
  while (automationRunning) {
    try {
      const activePage = await getActivePage();
      if (!activePage) {
        console.log('[Automation] No pages found. Waiting...');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      console.log('[Automation] Starting new session to solve the current question...');
      
      const config = {
        tools: [{ functionDeclarations: [playwright_click, playwright_fill, playwright_evaluate, get_screenshot_and_html, task_done, calculate_answer, get_bookwork_answer] }],
        systemInstruction: [
          "You are a Sparx Maths agent. There are TWO types of screen you will encounter:",

          "── TYPE 1: BOOKWORK CHECK ──",
          "Detected when the page shows a bookwork code (e.g. '4B') and asks you to select a previous answer from a list of tiles (no working required).",
          "How to handle: 1) Call get_screenshot_and_html to see the page. 2) Read the bookwork code shown. 3) Call get_bookwork_answer(bookwork_code) to retrieve the saved answer. 4) Find the tile whose text matches the saved answer and click it with playwright_click. 5) Call task_done.",
          "IMPORTANT: Do NOT call calculate_answer on bookwork check screens. Just look up the stored answer.",

          "── TYPE 2: NORMAL QUESTION ──",
          "Detected when the page shows a new maths question to solve.",
          "How to handle: 1) Call get_screenshot_and_html. 2) Call calculate_answer with full working. 3) Fill every answer slot with playwright_fill EXACTLY ONCE per slot. 4) Call task_done with bookwork_code AND answer.",

          "── FILLING SLOTS (playwright_fill rules) ──",
          "The server auto-handles clicking tiles or typing. For equations like y=mx+c, there are SEPARATE slots for gradient, sign (+/-), and intercept — fill each independently.",
          "If isTextInput:true appears in interactiveElements, it is a plain text box — just call playwright_fill with the value.",
          "Use data-ai-id selectors (e.g. [data-ai-id=\"15\"]). WARNING: IDs regenerate on every get_screenshot_and_html call.",

          "── DROPDOWNS ──",
          "When playwright_click returns interactiveElements in its response, those IDs are FRESH and valid right now (the dropdown is open).",
          "DO NOT call get_screenshot_and_html after opening a dropdown — that will close it and reset all IDs, causing an infinite loop.",
          "Instead: read the interactiveElements list returned by playwright_click, find the dropdown option you want, and call playwright_click with its data-ai-id immediately.",

          "── task_done requirements ──",
          "Always provide bookwork_code and answer when finishing a normal question, so the answer is saved for future bookwork checks."
        ].join('\n')
      };
      
      let contents: any[] = [];
      let promptText = "Start the task. Call get_screenshot_and_html first. Determine whether this is a BOOKWORK CHECK or a NORMAL QUESTION, then follow the appropriate procedure from your instructions.";
      if (previousMemory) {
        promptText += `\n\nCRITICAL MEMORY FROM PREVIOUS PART OF QUESTION: ${previousMemory}`;
      }
      
      let prompt: any = [{ text: promptText }];
      let isDone = false;
      
      while (automationRunning && !isDone) {
        contents.push({ role: 'user', parts: prompt });
        
        let response: any;
        let success = false;
        let genericErrorAttempts = 0;
        
        while (automationRunning && !success) {
          try {
            console.log(`[Agent] Sending prompt to ${fallbackModels[currentModelIndex]} using Key ${currentKeyIndex + 1}/${apiKeys.length}...`);
            response = await ai.models.generateContent({
              model: fallbackModels[currentModelIndex],
              contents: contents,
              config: config
            });
            success = true;
            genericErrorAttempts = 0;
          } catch (e: any) {
            const errStr = String(e.message || e).toLowerCase();
            if (e.status === 429 || errStr.includes('429') || errStr.includes('quota') || errStr.includes('exhausted')) {
               currentKeyIndex++;
               if (currentKeyIndex >= apiKeys.length) {
                   currentKeyIndex = 0;
                   currentModelIndex = (currentModelIndex + 1) % fallbackModels.length;
                   console.log(`[Agent] ⚠️ Rate limits exhausted on all keys for ${fallbackModels[currentModelIndex === 0 ? fallbackModels.length - 1 : currentModelIndex - 1]}. Switching to next model...`);
               } else {
                   console.log(`[Agent] ⚠️ Rate limit hit. Switching to backup API key ${currentKeyIndex + 1}/${apiKeys.length}...`);
               }
               
               // Re-initialize AI with new key
               ai = new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
               genericErrorAttempts = 0;
            } else {
               genericErrorAttempts++;
               console.log(`[Agent] ⚠️ Error on ${fallbackModels[currentModelIndex]} (${genericErrorAttempts}/10): ${e.message}`);
               if (genericErrorAttempts >= 10) {
                   console.log(`[Agent] ⚠️ 10 consecutive errors reached. Switching to next model...`);
                   currentModelIndex = (currentModelIndex + 1) % fallbackModels.length;
                   currentKeyIndex = 0;
                   ai = new GoogleGenAI({ apiKey: apiKeys[currentKeyIndex] });
                   genericErrorAttempts = 0;
               }
            }
          }
        }

        if (!automationRunning) break;
        
        const candidateContent = response.candidates?.[0]?.content;
        if (candidateContent) {
          contents.push(candidateContent);
        }

        const functionCalls = response.functionCalls;
        
        if (!functionCalls || functionCalls.length === 0) {
          console.log(`[Agent] Gemini responded with text:`, response.text);
          await new Promise(r => setTimeout(r, 1000));
          prompt = [{ text: "Please call a tool to interact with the page or task_done." }];
          continue;
        }

        const toolCall = functionCalls[0];
        console.log(`[Agent] 🤖 Gemini called tool: ${toolCall.name} with args:`, toolCall.args);
        
        let toolResult: any;
        const page = await getActivePage();
        if (!page) throw new Error("Browser page lost.");

        try {
          if (toolCall.name === 'playwright_click') {
            const el = page.locator(toolCall.args.selector as string).first();
            if (await el.count() > 0) {
              await el.click({ force: true });
              // Wait for any dropdown/overlay animation to finish
              await page.waitForTimeout(600);

              // Re-inject data-ai-id ONLY on elements that don't already have one.
              // This preserves existing IDs from the last get_screenshot_and_html scan
              // (so subsequent playwright_fill calls still work), while giving fresh IDs
              // to any NEW elements that appeared after the click (e.g. dropdown items).
              const freshElements = await page.evaluate(() => {
                let idCounter = Date.now(); // Use timestamp to avoid collisions with existing numeric IDs
                const results: any[] = [];
                const clickables = document.querySelectorAll(
                  'button, [role="button"], [tabindex="0"], [tabindex="-1"], input, a, [role="option"], [role="listbox"] *, [role="menu"] *, [role="menuitem"]'
                );
                clickables.forEach((node) => {
                  // Preserve existing ID; only assign a new one to brand-new elements
                  let id = node.getAttribute('data-ai-id');
                  if (!id) {
                    id = `__new_${idCounter++}`;
                    node.setAttribute('data-ai-id', id);
                  }
                  const annotation = node.querySelector('.katex-mathml annotation');
                  let text = annotation
                    ? (annotation.textContent || '').trim()
                    : (node as HTMLElement).innerText?.trim().replace(/\n/g, ' ') || '';
                  const ariaLabel = node.getAttribute('aria-label') || '';
                  const role = node.getAttribute('role') || '';
                  const tag = node.tagName.toLowerCase();
                  if (text || ariaLabel) {
                    results.push({ data_ai_id: id, tag, role, text, ariaLabel });
                  }
                });
                return results;
              });

              toolResult = {
                status: 'Clicked successfully.',
                note: 'Some new elements appeared and have been assigned __new_ IDs (listed below). IMPORTANT: __new_ IDs are ONLY valid for playwright_click (e.g. to select a dropdown option). NEVER pass a __new_ ID to playwright_fill — that will hit a button instead of the answer slot and corrupt the input. For playwright_fill, always use the numeric IDs from the last get_screenshot_and_html call.',
                interactiveElements: freshElements
              };
            } else {
              toolResult = { error: `Selector ${toolCall.args.selector} not found.` };
            }
          }
          else if (toolCall.name === 'playwright_fill') {
            const val = String(toolCall.args.value).trim();
            const selectorArg = toolCall.args.selector as string;

            // Guard: __new_ IDs are assigned to elements that appeared after a click
            // (e.g. keypad buttons). Using them in playwright_fill would click a keypad
            // button instead of the answer slot, corrupting the input with extra digits.
            if (selectorArg.includes('__new_')) {
              toolResult = {
                error: 'Invalid selector: __new_ IDs may point to keypad buttons, not answer slots. Call get_screenshot_and_html first to get the correct numeric data-ai-id for the answer slot, then call playwright_fill again.',
              };
            } else {
            const el = page.locator(selectorArg).first();
            if (await el.count() === 0) {
              toolResult = { error: `Selector ${toolCall.args.selector} not found.` };
            } else {
              // ── Step 1: check if the TARGET element itself is a plain input/textarea ──
              const tagName    = await el.evaluate((n: Element) => n.tagName.toLowerCase());
              const inputType  = await el.evaluate((n: Element) => (n as HTMLInputElement).type?.toLowerCase() || '');
              const isEditableEl = await el.evaluate((n: Element) =>
                (n as HTMLElement).isContentEditable ||
                (n.tagName.toLowerCase() === 'input' && ['text','number','search',''].includes((n as HTMLInputElement).type?.toLowerCase() || '')) ||
                n.tagName.toLowerCase() === 'textarea'
              );

              if (isEditableEl) {
                console.log(`[Agent] 🎹 Target is directly editable — typing "${val}" via keystrokes.`);
                // Blur whatever currently has focus FIRST — prevents the leading character
                // of the new value leaking into the previous field before focus moves.
                await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());
                await page.waitForTimeout(150);
                await el.click();
                // Wait long enough for the browser to fire blur on the old element and
                // focus on the new one — 400ms is safe across all tested browsers.
                await page.waitForTimeout(400);
                await page.keyboard.press('Control+a');
                await page.keyboard.press('Delete');
                await page.keyboard.type(val, { delay: 80 });
                await page.waitForTimeout(400);
                toolResult = { status: `Typed "${val}" directly into editable element.` };
              } else {
                // ── Step 2: Click the slot to open keypad/tile drawer ──
                await el.click({ force: true });
                await page.waitForTimeout(700);

                // ── Step 3: Check if clicking focused a text input or contenteditable ──
                const focusedIsTypeable = await page.evaluate(() => {
                  const f = document.activeElement as HTMLElement | null;
                  if (!f) return false;
                  const tag  = f.tagName.toLowerCase();
                  const type = (f as HTMLInputElement).type?.toLowerCase() || '';
                  return (
                    (tag === 'input' && ['text','number','search',''].includes(type)) ||
                    tag === 'textarea' ||
                    f.isContentEditable
                  );
                });

                if (focusedIsTypeable) {
                  console.log(`[Agent] 🎹 Slot opened a typeable element — typing "${val}" via keyboard.`);
                  await page.keyboard.press('Control+a');
                  await page.keyboard.press('Delete');
                  await page.keyboard.type(val, { delay: 70 });
                  await page.waitForTimeout(300);
                  toolResult = { status: `Typed "${val}" into focused editable after clicking slot.` };
                } else {
                  // ── Step 4: Scan for tile/keypad buttons ──
                  const tiles = await page.evaluate(() => {
                    const results: { selector: string; text: string }[] = [];
                    const seen = new Set<Element>();
                    const candidates = document.querySelectorAll(
                      'button, [role="button"], [tabindex="0"], [tabindex="-1"]'
                    );
                    let idCounter = Date.now();
                    candidates.forEach((node) => {
                      if (seen.has(node)) return;
                      seen.add(node);
                      const annotation = node.querySelector('.katex-mathml annotation');
                      let text = annotation
                        ? (annotation.textContent || '').trim()
                        : (node as HTMLElement).innerText?.trim().replace(/\s+/g, '') || '';
                      if (!text) return;
                      const existingId = node.getAttribute('data-ai-id');
                      const id = existingId || `__t_${idCounter++}`;
                      if (!existingId) node.setAttribute('data-ai-id', id);
                      results.push({ selector: `[data-ai-id="${id}"]`, text });
                    });
                    return results;
                  });

                  console.log(`[Agent] Tiles found:`, tiles.map(t => t.text).join(', '));

                  const normalise = (s: string) => s
                    .replace(/\s+/g, '')
                    .replace(/\u2212/g, '-')
                    .replace(/\u2014/g, '-')
                    .replace(/^\{/, '').replace(/\}$/, '')
                    .replace(/\\frac\{(\d+)\}\{(\d+)\}/g, '$1/$2');
                  const normVal = normalise(val);
                  const exact   = tiles.find(t => normalise(t.text) === normVal);

                  if (exact) {
                    // ── Step 5a: Click matching tile ──
                    console.log(`[Agent] ✅ Clicking tile "${exact.text}" for "${val}"`);
                    await page.locator(exact.selector).first().click({ force: true });
                    await page.waitForTimeout(400);
                    toolResult = { status: `Filled "${val}" by clicking tile.` };
                  } else {
                    // ── Step 5b: Try char-by-char button pressing ──
                    console.log(`[Agent] No exact tile for "${val}". Trying char-by-char...`);
                    let allOk = true;
                    for (const char of val.split('')) {
                      const normChar = normalise(char);
                      const digitTile = tiles.find(t => normalise(t.text) === normChar);
                      if (digitTile) {
                        await page.locator(digitTile.selector).first().click({ force: true });
                        await page.waitForTimeout(180);
                      } else {
                        console.log(`[Agent] ⚠️ No button for '${char}'`);
                        allOk = false;
                      }
                    }

                    if (!allOk) {
                      // ── Step 5c: ID-based click fallback — re-scan with data-ai-id ──
                      // Before touching the keyboard, try to find a tile that contains the
                      // full value (or a normalised form of it) by clicking its data-ai-id.
                      console.log(`[Agent] 🔎 Char-by-char incomplete — trying ID-based tile click for "${val}"`);

                      const idTiles = await page.evaluate(() => {
                        const results: { selector: string; text: string; id: string }[] = [];
                        const seen = new Set<Element>();
                        const candidates = document.querySelectorAll(
                          'button, [role="button"], [tabindex="0"], [tabindex="-1"]'
                        );
                        let idCounter = Date.now();
                        candidates.forEach((node) => {
                          if (seen.has(node)) return;
                          seen.add(node);
                          // Prefer LaTeX annotation text, fall back to innerText
                          const annotation = node.querySelector('.katex-mathml annotation');
                          let text = annotation
                            ? (annotation.textContent || '').trim()
                            : (node as HTMLElement).innerText?.trim().replace(/\s+/g, '') || '';
                          if (!text) return;
                          const existingId = node.getAttribute('data-ai-id');
                          const id = existingId || `__t_${idCounter++}`;
                          if (!existingId) node.setAttribute('data-ai-id', id);
                          results.push({ selector: `[data-ai-id="${id}"]`, text, id });
                        });
                        return results;
                      });

                      // Build a richer normalised set — strip LaTeX wrappers for comparison
                      const stripLatex = (s: string) => s
                        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '$1/$2')
                        .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
                        .replace(/\\left|\\right|\\cdot|\\times/g, '')
                        .replace(/[{}\\]/g, '')
                        .replace(/\s+/g, '');

                      const normValStripped = stripLatex(normalise(val));

                      // Try: exact normalised match → partial contains match
                      const idMatch =
                        idTiles.find(t => normalise(t.text) === normVal) ||
                        idTiles.find(t => stripLatex(normalise(t.text)) === normValStripped) ||
                        idTiles.find(t => stripLatex(normalise(t.text)).includes(normValStripped) && normValStripped.length > 1) ||
                        idTiles.find(t => normValStripped.includes(stripLatex(normalise(t.text))) && stripLatex(normalise(t.text)).length > 1);

                      if (idMatch) {
                        console.log(`[Agent] ✅ ID-click: found tile id="${idMatch.id}" text="${idMatch.text}" for "${val}"`);
                        await page.locator(idMatch.selector).first().click({ force: true });
                        await page.waitForTimeout(400);
                        toolResult = { status: `Filled "${val}" by ID-based tile click (id=${idMatch.id}).` };
                      } else {
                        // ── Step 5d: Absolute last resort — keyboard.type() ──
                        console.log(`[Agent] 🎹 ID-click failed — falling back to keyboard.type("${val}")`);
                        await page.keyboard.press('Control+a');
                        await page.keyboard.press('Delete');
                        await page.keyboard.type(val, { delay: 70 });
                        await page.waitForTimeout(300);
                        toolResult = { status: `Typed "${val}" via keyboard (no matching tile found by text or ID).` };
                      }
                    } else {
                      toolResult = { status: `Filled "${val}" char-by-char via tile buttons.` };
                    }
                  }
                }
              }
            } 
          }
        } // end else (not a __new_ selector)
          else if (toolCall.name === 'playwright_evaluate') {
            const result = await page.evaluate(toolCall.args.script as string);
            toolResult = { result: String(result) };
          }
          else if (toolCall.name === 'calculate_answer') {
            const working = toolCall.args.step_by_step_working as string;
            const final = toolCall.args.final_answer as string;
            console.log(`[Agent] 🧮 Gemini Calculation:\nWorking: ${working}\nFinal Answer: ${final}`);
            toolResult = { status: "Calculation saved successfully! Now proceed to enter this exact answer using the correct button IDs." };
          }
          else if (toolCall.name === 'get_bookwork_answer') {
            const code = String(toolCall.args.bookwork_code || '').trim();
            const entry = bookworks.find(b => b.code.trim().toLowerCase() === code.toLowerCase());
            if (entry) {
              console.log(`[Agent] 📖 Bookwork lookup: code="${code}" → answer="${entry.answer}"`);
              toolResult = { found: true, bookwork_code: entry.code, answer: entry.answer };
            } else {
              console.log(`[Agent] 📖 Bookwork lookup: code="${code}" — NOT FOUND in store (${bookworks.length} entries).`);
              // Return the full bookwork store so the agent can make an educated guess
              toolResult = {
                found: false,
                message: `No saved answer for bookwork code "${code}". You must solve it from the screenshot instead.`,
                all_saved_codes: bookworks.map(b => b.code)
              };
            }
          }
          else if (toolCall.name === 'get_screenshot_and_html') {
            const selector = toolCall.args.selector as string;
            const target = selector ? page.locator(selector).first() : page.locator('body').first();
            
            if (await target.count() === 0) {
              toolResult = { error: `Selector ${selector} not found.` };
            } else {
              // Inject data-ai-id and extract clean text/LaTeX representations
              const elementsSummary = await target.evaluate((el) => {
                let idCounter = 1;
                const results: any[] = [];
                const clickables = el.querySelectorAll('button, [role="button"], [tabindex="0"], input, a');
                
                clickables.forEach((node) => {
                  const id = String(idCounter++);
                  node.setAttribute('data-ai-id', id);
                  
                  // Extract LaTeX if available, otherwise innerText
                  const annotation = node.querySelector('.katex-mathml annotation');
                  let text = '';
                  if (annotation && annotation.textContent) {
                    text = annotation.textContent;
                  } else {
                    text = (node as HTMLElement).innerText?.trim().replace(/\n/g, ' ') || '';
                  }
                  
                  const slot = node.getAttribute('data-slot') || '';
                  const ariaLabel = node.getAttribute('aria-label') || '';
                  const tagName = node.tagName.toLowerCase();
                  
                  if (text || slot || ariaLabel || tagName === 'input') {
                    results.push({ data_ai_id: id, tag: tagName, text, slot, ariaLabel });
                  }
                });
                return results;
              });

              const screenshot = await page.screenshot();
              
              prompt = [
                {
                  functionResponse: {
                    name: toolCall.name,
                    response: { interactiveElements: elementsSummary } 
                  }
                },
                { text: 'Here is the current screenshot of the page, along with a list of interactive elements and their extracted LaTeX/text:' },
                { inlineData: { data: screenshot.toString("base64"), mimeType: 'image/png' } }
              ];
              continue; 
            }
          }
          else if (toolCall.name === 'task_done') {
            isDone = true;
            previousMemory = toolCall.args.memory_for_next_part || "";
            
            const bwCode = toolCall.args.bookwork_code;
            const bwAnswer = toolCall.args.answer;
            if (bwCode && bwAnswer) {
              const existing = bookworks.find(b => b.code === bwCode);
              if (existing) existing.answer = bwAnswer;
              else bookworks.push({ code: bwCode, answer: bwAnswer });
              console.log(`[Agent] Saved Bookwork Code ${bwCode}: ${bwAnswer}`);
            }
            
            toolResult = { status: "Task acknowledged as done." };
            console.log(`[Agent] Task completed according to Gemini. Reason:`, toolCall.args.message);
            if (previousMemory) {
              console.log(`[Agent] Saved memory for next part:`, previousMemory);
            } else {
              console.log(`[Agent] No memory saved. Question fully finished.`);
            }
          }
          
          prompt = [{
            functionResponse: {
              name: toolCall.name,
              response: toolResult
            }
          }];

        } catch (e: any) {
          console.error(`[Agent] Tool execution failed:`, e);
          prompt = [{
            functionResponse: {
              name: toolCall.name,
              response: { error: e.message }
            }
          }];
        }
      }
      
      console.log('[Automation] Finished current loop iteration. Waiting 2 seconds before the next...');
      await new Promise(r => setTimeout(r, 2000));
      
    } catch (e) {
      console.error("[Automation] Error during agent loop:", e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log('[Automation] Master loop stopped.');
}

app.listen(3000, () => {
  console.log('Running at http://localhost:3000');
});
