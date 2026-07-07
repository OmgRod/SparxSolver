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
        tools: [{ functionDeclarations: [playwright_click, playwright_fill, playwright_evaluate, get_screenshot_and_html, task_done, calculate_answer] }],
        systemInstruction: "You are a Sparx Maths agent. Your goal is to solve the homework question. 1. Call get_screenshot_and_html to see the page. 2. CRITICAL: You MUST call `calculate_answer` to write out your step-by-step mathematical working BEFORE you attempt to click any answer slots. 3. Filling Slots: ALWAYS use `playwright_fill` for every answer slot. The server handles clicking the correct tile automatically. IMPORTANT: For equations like y = mx + c, there are SEPARATE slots for the gradient, the +/- operator sign, and the intercept. Fill each slot independently with its single value. Example: for y = 5x - 22, call playwright_fill 3 times: once with '5' for the gradient slot, once with '-' for the sign slot, once with '22' for the intercept slot. Do NOT pass '-22' to a sign slot. 4. Use the `data-ai-id` from the `interactiveElements` list. Do NOT use standard `id=` selectors. NOTE: IDs regenerate on every get_screenshot_and_html call! 5. Use task_done when finished, providing the bookwork_code and answer."
      };
      
      let contents: any[] = [];
      let promptText = "Start the task. Look at the page using get_screenshot_and_html. Then use calculate_answer to do the working out, and finally enter the answer.";
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
              await page.waitForTimeout(500);
              toolResult = { status: "Success" };
            } else {
              toolResult = { error: `Selector ${toolCall.args.selector} not found.` };
            }
          }
          else if (toolCall.name === 'playwright_fill') {
            const val = String(toolCall.args.value).trim();
            const el = page.locator(toolCall.args.selector as string).first();
            if (await el.count() === 0) {
              toolResult = { error: `Selector ${toolCall.args.selector} not found.` };
            } else {
              // Step 1: Click the slot to open the keypad/tile drawer
              await el.click({ force: true });
              await page.waitForTimeout(700);

              // Step 2: Scan ALL interactive elements (buttons AND Sparx custom div/span tiles)
              const tiles = await page.evaluate(() => {
                const results: { selector: string; text: string }[] = [];
                const seen = new Set<Element>();
                // Cast wide net: buttons, role=button, tabindex elements
                const candidates = document.querySelectorAll(
                  'button, [role="button"], [tabindex="0"], [tabindex="-1"]'
                );
                let idCounter = Date.now(); // unique IDs so they don't collide with existing ones
                candidates.forEach((node) => {
                  if (seen.has(node)) return;
                  seen.add(node);
                  // Prefer KaTeX annotation for math, fall back to innerText
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

              console.log(`[Agent] Tiles found after clicking slot:`, tiles.map(t => t.text).join(', '));

              // Step 3: Normalise & find best tile match
              // Tiles come as KaTeX annotations like {5}, {-5}, {\frac{1}{5}}
              const normalise = (s: string) => s
                .replace(/\s+/g, '')
                .replace(/\u2212/g, '-') // unicode minus
                .replace(/\u2014/g, '-') // em-dash
                .replace(/^\{/, '').replace(/\}$/, '') // strip outer {}
                .replace(/\\frac\{(\d+)\}\{(\d+)\}/g, '$1/$2'); // \frac{a}{b} -> a/b
              const normVal = normalise(val);
              const exact = tiles.find(t => normalise(t.text) === normVal);

              if (exact) {
                console.log(`[Agent] ✅ Clicking tile "${exact.text}" for value "${val}"`);
                await page.locator(exact.selector).first().click({ force: true });
                await page.waitForTimeout(400);
                toolResult = { status: `Filled "${val}" by clicking tile.` };
              } else {
                // Step 4: Fallback — click individual digit/char buttons one at a time
                console.log(`[Agent] No exact tile for "${val}". Trying character-by-character...`);
                let allOk = true;
                for (const char of val.split('')) {
                  const normChar = normalise(char);
                  const digitTile = tiles.find(t => normalise(t.text) === normChar);
                  if (digitTile) {
                    await page.locator(digitTile.selector).first().click({ force: true });
                    await page.waitForTimeout(200);
                  } else {
                    console.log(`[Agent] ⚠️ No button found for char '${char}'`);
                    allOk = false;
                  }
                }
                toolResult = { status: allOk ? `Filled "${val}" char-by-char.` : `Partial fill for "${val}" — some chars not found on keypad.` };
              }
            }
          }
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
