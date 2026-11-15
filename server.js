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

async function handleChat(req, res) {
    if (!API_KEY) return sendJson(res, 503, { error: 'Falta GEMINI_API_KEY.' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: 'Solicitud inválida.' }); }

    const contents = (payload.messages || []).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));

    try {
        const upstream = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
                contents: contents,
                generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
            })
        });
        const data = await upstream.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No pude responder.';
        sendJson(res, 200, { reply });
    } catch (err) {
        sendJson(res, 502, { error: 'Error al contactar al modelo.' });
    }
}

async function handleDeconstruct(req, res) {
    if (!API_KEY) return sendJson(res, 503, { error: 'Falta GEMINI_API_KEY.' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: 'Solicitud inválida.' }); }

    const { task } = payload;
    if (!task) return sendJson(res, 400, { error: 'Falta la tarea' });

    const prompt = `Actúa como Kaia, una asistente de bienestar estudiantil con el lema "como a pasos de tortuga". El usuario tiene esta tarea: "${task}". 
    Divídela en 3 a 5 micro-pasos realistas y sencillos.
    Devuelve la respuesta estrictamente como un arreglo JSON plano, sin markdown, donde cada objeto tenga: "title" y "time" (ej. "15 min").`;

    try {
        const upstream = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: 600, temperature: 0.6 }
            })
        });
        const data = await upstream.json();
        let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const steps = JSON.parse(text);
        sendJson(res, 200, { steps });
    } catch (error) {
        sendJson(res, 500, { error: 'No se pudo generar el desglose' });
    }
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
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No encontrado');
    } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { error: 'Error interno.' });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Kaia lista en puerto ${PORT}`);
});