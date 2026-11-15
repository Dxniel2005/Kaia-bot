const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (typeof fetch !== 'function') {
    console.error('Necesitas Node.js 18 o superior.');
    process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const HTML_FILE = path.join(__dirname, 'index.html');

const SYSTEM_PROMPT = `Eres Kaia, la asistente virtual de bienestar estudiantil. Tu onda es de confianza, relajada y muy humana, con el lema "como a pasos de tortuga".`;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const CONV_DIR = path.join(DATA_DIR, 'conversations');
const USERS_LOG = path.join(DATA_DIR, 'users.jsonl');
const COOKIE_NAME = 'bot_na_uid';
const ID_RE = /^[a-f0-9]{32}$/;

fs.mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 });

const knownUsers = new Set();
try {
    for (const line of fs.readFileSync(USERS_LOG, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const rec = JSON.parse(line);
            if (rec && rec.event === 'new_user' && ID_RE.test(rec.id)) knownUsers.add(rec.id);
        } catch (e) { }
    }
} catch (e) { }

function readCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
        }
    }
    return null;
}

function ensureUser(req, res) {
    const id = readCookie(req, COOKIE_NAME);
    if (id && ID_RE.test(id) && knownUsers.has(id)) return { id, isNew: false };

    const newId = crypto.randomBytes(16).toString('hex');
    knownUsers.add(newId);
    try {
        fs.appendFileSync(USERS_LOG, JSON.stringify({ ts: new Date().toISOString(), event: 'new_user', id: newId }) + '\n', { mode: 0o600 });
    } catch (e) { }
    const secure = (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${newId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 365}${secure}`);
    return { id: newId, isNew: true };
}

const convPath = (id) => path.join(CONV_DIR, id + '.json');

function readConversation(id) {
    try {
        const data = JSON.parse(fs.readFileSync(convPath(id), 'utf8'));
        if (data && Array.isArray(data.messages)) return data;
    } catch (e) { }
    return { id, messages: [] };
}

function saveConversation(id, messages) {
    const prev = readConversation(id);
    const now = new Date().toISOString();
    const stored = messages.map((m, i) => {
        const old = prev.messages[i];
        const same = old && old.role === m.role && old.content === m.content;
        return { ts: same ? old.ts : now, role: m.role, content: m.content };
    });
    const json = JSON.stringify({ id, createdAt: prev.createdAt || now, updatedAt: now, messages: stored }, null, 2);
    fs.writeFileSync(convPath(id), json, { mode: 0o600 });
}

function readBody(req, limit = 100_000) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

// Convierte la respuesta del modelo en una lista de pasos válida.
// Acepta: arreglo JSON, objeto { steps: [...] }, o JSON rodeado de ```json ... ``` / texto extra.
function extractSteps(text) {
    const t = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const tryParse = (str) => { try { return JSON.parse(str); } catch (e) { return null; } };

    let data = tryParse(t);
    if (!data) {
        const a = t.indexOf('['), b = t.lastIndexOf(']');
        if (a !== -1 && b > a) data = tryParse(t.slice(a, b + 1));
    }
    if (data && !Array.isArray(data) && Array.isArray(data.steps)) data = data.steps;
    if (!Array.isArray(data)) return [];

    return data
        .filter(st => st && typeof st.title === 'string' && st.title.trim())
        .slice(0, 6)
        .map(st => ({
            title: st.title.trim().slice(0, 200),
            time: typeof st.time === 'string' && st.time.trim() ? st.time.trim().slice(0, 30) : '15 min'
        }));
}

// Traduce un error HTTP de Gemini a un mensaje claro (y el código que se devuelve al navegador)
function describeGeminiError(status, detail) {
    if (status === 429) return { status: 429, error: 'Se alcanzó el límite del servicio gratuito. Espera un minuto e inténtalo de nuevo.' };
    if (status === 400 && /API key/i.test(detail)) return { status: 502, error: 'La clave de Gemini no es válida o venció. Revisa GEMINI_API_KEY.' };
    if (status === 401 || status === 403) return { status: 502, error: 'La clave de Gemini no tiene permiso. Revisa GEMINI_API_KEY y que la API esté habilitada.' };
    if (status === 404) return { status: 502, error: `El modelo "${MODEL}" no existe o no está disponible para tu clave. Revisa GEMINI_MODEL.` };
    return { status: 502, error: 'El modelo no respondió. Inténtalo de nuevo.' };
}

// Config de generación común. Gemini 2.5 Flash "piensa" antes de responder y esos tokens cuentan dentro
// de maxOutputTokens: sin desactivarlo, podía quedarse sin espacio y devolver una respuesta vacía.
const noThinking = () => (/2\.5-flash/.test(MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {});

// Llama a Gemini y devuelve { value } o { status, error }.
// accept(texto) devuelve el resultado válido o null; si falla algo pasajero (5xx o respuesta vacía) reintenta una vez.
async function askGemini(body, label, accept) {
    let last = { status: 502, error: 'El modelo no respondió. Inténtalo de nuevo.' };

    for (let attempt = 1; attempt <= 2; attempt++) {
        let upstream;
        try {
            upstream = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
                body: JSON.stringify(body)
            });
        } catch (err) {
            console.error(`${label} (intento ${attempt}): no pude contactar a Gemini:`, err.message);
            last = { status: 502, error: 'No pude contactar al modelo. Revisa tu conexión.' };
            continue;
        }

        if (!upstream.ok) {
            const detail = (await upstream.text()).slice(0, 500);
            console.error(`${label} (intento ${attempt}): Gemini respondió ${upstream.status}:`, detail);
            last = describeGeminiError(upstream.status, detail);
            if (upstream.status >= 500 && attempt === 1) { await new Promise(r => setTimeout(r, 800)); continue; }
            return last;
        }

        const data = await upstream.json();
        const cand = data.candidates && data.candidates[0];
        const text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
        const value = accept(text);
        if (value) return { value };

        console.warn(`${label} (intento ${attempt}) sin resultado válido. finishReason: ${cand && cand.finishReason} | bloqueo: ${(data.promptFeedback && data.promptFeedback.blockReason) || 'ninguno'} | texto recibido: ${JSON.stringify(text.slice(0, 200))}`);
        last = { status: 502, error: 'El modelo no devolvió una respuesta válida. Inténtalo de nuevo.' };
    }
    return last;
}

// Limpia el historial que llega del navegador: roles alternados, empieza y termina con "user"
// (Gemini rechaza la petición si hay dos mensajes seguidos del mismo rol)
function sanitizeChatMessages(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const m of raw.slice(-20)) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
        const content = m.content.trim().slice(0, 2000);
        if (!content || (m.role === 'assistant' && content === 'No pude responder.')) continue; // restos de fallos antiguos
        const role = m.role === 'assistant' ? 'model' : 'user';
        const last = out[out.length - 1];
        if (last && last.role === role) last.parts[0].text += '\n' + content;
        else out.push({ role, parts: [{ text: content }] });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
}

async function handleChat(req, res) {
    if (!API_KEY) return sendJson(res, 503, { error: 'Falta GEMINI_API_KEY en el servidor.' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: 'Solicitud inválida.' }); }

    const contents = sanitizeChatMessages(payload.messages);
    if (!contents.length || contents[contents.length - 1].role !== 'user') {
        return sendJson(res, 400, { error: 'El último mensaje debe ser del usuario.' });
    }

    const result = await askGemini({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { maxOutputTokens: 800, temperature: 0.7, ...noThinking() }
    }, 'Chat', text => text.trim() || null);

    if (result.value) return sendJson(res, 200, { reply: result.value });
    sendJson(res, result.status, { error: result.error });
}

// Convierte la respuesta del modelo en una lista de pasos válida.
// Acepta: arreglo JSON, objeto { steps: [...] }, o JSON rodeado de ```json ... ``` / texto extra.
function extractSteps(text) {
    const t = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const tryParse = (str) => { try { return JSON.parse(str); } catch (e) { return null; } };

    let data = tryParse(t);
    if (!data) {
        const a = t.indexOf('['), b = t.lastIndexOf(']');
        if (a !== -1 && b > a) data = tryParse(t.slice(a, b + 1));
    }
    if (data && !Array.isArray(data) && Array.isArray(data.steps)) data = data.steps;
    if (!Array.isArray(data)) return [];

    return data
        .filter(st => st && typeof st.title === 'string' && st.title.trim())
        .slice(0, 6)
        .map(st => ({
            title: st.title.trim().slice(0, 200),
            time: typeof st.time === 'string' && st.time.trim() ? st.time.trim().slice(0, 30) : '15 min'
        }));
}

async function handleDeconstruct(req, res) {
    if (!API_KEY) return sendJson(res, 503, { error: 'Falta GEMINI_API_KEY.' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: 'Solicitud inválida.' }); }

    const task = typeof payload.task === 'string' ? payload.task.trim().slice(0, 500) : '';
    if (!task) return sendJson(res, 400, { error: 'Falta la tarea' });

    const prompt = `Actúa como Kaia, una asistente de bienestar estudiantil con el lema "como a pasos de tortuga". El usuario tiene esta tarea: "${task}". 
    Divídela en 3 a 5 micro-pasos realistas y sencillos.
    Devuelve la respuesta estrictamente como un arreglo JSON plano, sin markdown, donde cada objeto tenga: "title" y "time" (ej. "15 min").`;

    const result = await askGemini({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.6,
            responseMimeType: 'application/json', // pide JSON directo, sin markdown
            ...noThinking()
        }
    }, 'Desglose', text => { const steps = extractSteps(text); return steps.length ? steps : null; });

    if (result.value) return sendJson(res, 200, { steps: result.value });
    sendJson(res, result.status, { error: result.error });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = (req.url || '/').split('?')[0];
        if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(fs.readFileSync(HTML_FILE));
        }
        if (req.method === 'POST' && url === '/api/chat') return await handleChat(req, res);
        if (req.method === 'POST' && url === '/api/deconstruct') return await handleDeconstruct(req, res);
        if (req.method === 'GET' && url === '/api/session') {
            const user = ensureUser(req, res);
            return sendJson(res, 200, { messages: readConversation(user.id).messages });
        }
        if (req.method === 'POST' && url === '/api/history') {
            const user = ensureUser(req, res);
            const payload = JSON.parse(await readBody(req, 1_000_000));
            saveConversation(user.id, payload.messages || []);
            return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url === '/api/history/clear') {
            req.resume();
            const id = readCookie(req, COOKIE_NAME);
            if (id && ID_RE.test(id) && knownUsers.has(id)) {
                try { fs.unlinkSync(convPath(id)); } catch (e) { }
            }
            return sendJson(res, 200, { ok: true });
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No encontrado');
    } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { error: 'Error interno.' });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Kaia lista en puerto ${PORT}`);
});