const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (typeof fetch !== 'function') {
    console.error('Necesitas Node.js 18 o superior.');
    process.exit(1);
}

try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (m && !(m[1] in process.env)) {
                process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
            }
        }
    }
} catch (e) {
    console.warn('No pude leer el archivo .env:', e.message);
}

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const HTML_FILE = ['index.html', 'coso_param.html']
    .map(f => path.join(__dirname, f))
    .find(f => fs.existsSync(f)) || path.join(__dirname, 'index.html');

const SYSTEM_PROMPT = `Eres bot-n/a, el asistente virtual del "proyecto n/a". Tu onda es de confianza, relajada y muy humana, como la de un compañero universitario de verdad. Si te preguntan quién eres, di que eres bot-n/a, del proyecto n/a.

Estilo y tono (SÚPER IMPORTANTE):
- Espejo de lenguaje: Adopta de inmediato el estilo, la jerga, los modismos y el nivel de formalidad (o informalidad) con el que te hable la persona. Si te habla relajado, escríbele igual de casual. Si te escribe corto, no le sueltes un testamento.
- Cero clichés: Evita por completo frases formales de IA o lugares comunes acartonados (como "entre libros y apuntes", "espero que tu día vaya productivo" o discursos motivacionales falsos). Háblale como un pana de verdad.
- Cero interrogatorios obligatorios: No cierres tus mensajes haciendo preguntas de manual si no viene al caso. Si la charla fluye con un consejo, una recomendación o una broma, déjala fluir.

Cómo ayudas:
- Compartes el día a día, escuchas cuando hay estrés o frustración, y das tips de estudio o descanso sin ponerte pesado.
- Si te piden recomendaciones (música, bandas, etc.), responde con datos reales y detallados.
- Si encaja orgánicamente, menciona las herramientas de la app como el "Desglose Anti-Caos" o el "Escudo Anti-Burnout".

Límites y alertas:
- No eres psicólogo ni médico. Si ves que el estrés o la situación es muy pesada, sugiere con tacto buscar apoyo profesional o usar el botón "Ver líneas de apoyo" de la app.
- Si la persona menciona sentimientos profundos de tristeza, soledad, crisis o menciona hacerse daño, responde con mucha empatía, valida lo que siente y dile que no tiene que pasar por esto en soledad.
- IMPORTANTE: Cuando detectes una situación de crisis, invítala amablemente a usar el botón "Ver líneas de apoyo" que aparece en la pantalla, para que hable con un profesional o con alguien de confianza.
- No inventes números de teléfono, solo refiérete al botón o a buscar ayuda en su entorno.

SISTEMA DE ALERTA: Si detectas que el usuario está en crisis severa (menciones de autolesión, desesperanza profunda, estrés extremo), DEBES terminar tu respuesta con la etiqueta exacta [ALERTA_AYUDA]. Si es estrés académico normal, NO uses la etiqueta. La etiqueta va sola al final del mensaje: no la expliques ni la menciones en el texto.`;

const hits = new Map();
function rateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > 25;
}

// =====================================================================
// Historial de conversaciones en archivos (anónimo: sin nombre ni datos personales)
//
//   data/users.jsonl            -> registro (log) de usuarios nuevos: fecha + ID asignado
//   data/conversations/<ID>.json -> conversación de ese usuario (se va actualizando)
//
// A cada navegador nuevo se le asigna un ID aleatorio de 128 bits, guardado en una cookie
// HttpOnly. Ese ID es lo único que permite leer una conversación, así que no es adivinable.
// =====================================================================
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const CONV_DIR = path.join(DATA_DIR, 'conversations');
const USERS_LOG = path.join(DATA_DIR, 'users.jsonl');
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 0; // 0 = no borrar nunca por antigüedad
const MAX_STORED_MESSAGES = 500;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CONV_BYTES = 2_000_000;
const COOKIE_NAME = 'bot_na_uid';
const ID_RE = /^[a-f0-9]{32}$/;

fs.mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 });

// IDs que este servidor ya asignó (se reconstruye desde users.jsonl al arrancar)
const knownUsers = new Set();
try {
    for (const line of fs.readFileSync(USERS_LOG, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const rec = JSON.parse(line);
            if (rec && rec.event === 'new_user' && ID_RE.test(rec.id)) knownUsers.add(rec.id);
        } catch (e) { /* línea dañada: se ignora */ }
    }
} catch (e) { /* aún no existe el registro */ }

function makeLimiter(max, windowMs) {
    const map = new Map();
    return (ip) => {
        const now = Date.now();
        const recent = (map.get(ip) || []).filter(t => now - t < windowMs);
        recent.push(now);
        map.set(ip, recent);
        return recent.length > max;
    };
}
const historyLimited = makeLimiter(120, 60_000);   // guardados de historial por minuto
const newUserLimited = makeLimiter(10, 3_600_000); // usuarios nuevos por hora y por IP

function readCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
        }
    }
    return null;
}

// Rechaza peticiones que vengan de otro sitio web (protección contra CSRF)
function crossSite(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return true;
    const origin = req.headers.origin;
    if (origin) {
        try { if (new URL(origin).host !== req.headers.host) return true; } catch (e) { return true; }
    }
    return false;
}

// ID del usuario si la cookie corresponde a uno ya registrado; si no, null
function getKnownUser(req) {
    const id = readCookie(req, COOKIE_NAME);
    return id && ID_RE.test(id) && knownUsers.has(id) ? id : null;
}

// Devuelve el usuario de la cookie o, si es nuevo, le asigna un ID y lo anota en users.jsonl
function ensureUser(req, res) {
    const existing = getKnownUser(req);
    if (existing) return { id: existing, isNew: false };

    if (newUserLimited(req.socket.remoteAddress || 'local')) return null;

    const id = crypto.randomBytes(16).toString('hex');
    knownUsers.add(id);
    try {
        fs.appendFileSync(USERS_LOG, JSON.stringify({ ts: new Date().toISOString(), event: 'new_user', id }) + '\n', { mode: 0o600 });
    } catch (e) {
        console.error('No pude escribir en users.jsonl:', e.message);
    }
    const secure = (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 365}${secure}`);
    return { id, isNew: true };
}

const convPath = (id) => path.join(CONV_DIR, id + '.json');

function readConversation(id) {
    try {
        const data = JSON.parse(fs.readFileSync(convPath(id), 'utf8'));
        if (data && Array.isArray(data.messages)) return data;
    } catch (e) { /* no existe o está dañado */ }
    return { id, createdAt: null, updatedAt: null, messages: [] };
}

function sanitizeStored(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(-MAX_STORED_MESSAGES)
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_MESSAGE_CHARS) }));
}

// Guarda la conversación completa; conserva la hora de los mensajes que ya estaban
function saveConversation(id, messages) {
    const prev = readConversation(id);
    const now = new Date().toISOString();
    const stored = messages.map((m, i) => {
        const old = prev.messages[i];
        const same = old && old.role === m.role && old.content === m.content;
        return { ts: same ? old.ts : now, role: m.role, content: m.content };
    });
    const json = JSON.stringify({ id, createdAt: prev.createdAt || now, updatedAt: now, messages: stored }, null, 2);
    if (Buffer.byteLength(json) > MAX_CONV_BYTES) {
        const err = new Error('conversación demasiado grande'); err.code = 'too_big'; throw err;
    }
    const tmp = convPath(id) + '.tmp';
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    fs.renameSync(tmp, convPath(id)); // escritura atómica: nunca queda un archivo a medias
}

// Borra conversaciones más antiguas que RETENTION_DAYS (solo si está configurado)
function purgeOldConversations() {
    if (!RETENTION_DAYS) return;
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of fs.readdirSync(CONV_DIR)) {
        const file = path.join(CONV_DIR, f);
        try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch (e) { /* ya no existe */ }
    }
}
purgeOldConversations();
setInterval(purgeOldConversations, 86_400_000).unref();

// GET /api/session: identifica al usuario (o lo registra) y devuelve su conversación anterior, si hay
function handleSession(req, res) {
    if (crossSite(req)) return sendJson(res, 403, { error: 'Origen no permitido.' });
    const user = ensureUser(req, res);
    if (!user) return sendJson(res, 429, { error: 'Demasiados usuarios nuevos desde esta red. Intenta más tarde.' });

    const messages = readConversation(user.id).messages.slice(-200).map(m => ({ role: m.role, content: m.content, ts: m.ts }));
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, {
        isNew: user.isNew,
        userCode: user.id.slice(0, 8).toUpperCase(), // versión corta del ID, solo para mostrar
        hasHistory: messages.length > 0,
        messages
    });
}

// POST /api/history: guarda la conversación actual del usuario
async function handleHistorySave(req, res) {
    if (crossSite(req)) return sendJson(res, 403, { error: 'Origen no permitido.' });
    if (historyLimited(req.socket.remoteAddress || 'local')) return sendJson(res, 429, { error: 'Demasiadas peticiones.' });
    const user = ensureUser(req, res);
    if (!user) return sendJson(res, 429, { error: 'Demasiados usuarios nuevos desde esta red. Intenta más tarde.' });

    let payload;
    try {
        payload = JSON.parse(await readBody(req, 1_000_000));
    } catch (e) {
        return sendJson(res, e.message === 'too_large' ? 413 : 400, { error: 'Solicitud inválida.' });
    }

    const messages = sanitizeStored(payload.messages);
    try {
        if (!messages.length) {
            try { fs.unlinkSync(convPath(user.id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        } else {
            saveConversation(user.id, messages);
        }
    } catch (e) {
        console.error('No pude guardar la conversación:', e.message);
        return sendJson(res, e.code === 'too_big' ? 413 : 500, { error: 'No se pudo guardar.' });
    }
    sendJson(res, 200, { ok: true, count: messages.length });
}

// POST /api/history/clear: borra la conversación guardada del usuario ("Nuevo chat" / papelera)
function handleHistoryClear(req, res) {
    req.resume();
    if (crossSite(req)) return sendJson(res, 403, { error: 'Origen no permitido.' });
    const id = getKnownUser(req);
    if (id) {
        try { fs.unlinkSync(convPath(id)); } catch (e) { if (e.code !== 'ENOENT') console.error('No pude borrar la conversación:', e.message); }
    }
    sendJson(res, 200, { ok: true });
}

function sanitizeMessages(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const m of raw.slice(-20)) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
        const content = m.content.trim().slice(0, 2000);
        if (!content) continue;
        const geminiRole = m.role === 'assistant' ? 'model' : 'user';
        const last = out[out.length - 1];
        if (last && last.role === geminiRole) {
            last.parts[0].text += '\n' + content;
        } else {
            out.push({ role: geminiRole, parts: [{ text: content }] });
        }
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
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
    if (!API_KEY) {
        return sendJson(res, 503, { error: 'Falta GEMINI_API_KEY en las variables de entorno o archivo .env.' });
    }
    if (rateLimited(req.socket.remoteAddress || 'local')) {
        return sendJson(res, 429, { error: 'Demasiados mensajes seguidos. Espera un momento.' });
    }

    let payload;
    try {
        payload = JSON.parse(await readBody(req));
    } catch (e) {
        return sendJson(res, e.message === 'too_large' ? 413 : 400, { error: 'Solicitud inválida.' });
    }

    const contents = sanitizeMessages(payload.messages);
    if (!contents.length || contents[contents.length - 1].role !== 'user') {
        return sendJson(res, 400, { error: 'El último mensaje debe ser del usuario.' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);

    try {
        const upstream = await fetch(API_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
            body: JSON.stringify({
                system_instruction: {
                    parts: [{ text: SYSTEM_PROMPT }]
                },
                contents: contents,
                generationConfig: {
                    maxOutputTokens: 800,
                    temperature: 0.7,
                    // Sin "pensamiento" extra: respuestas más rápidas y sin quedarse sin tokens
                    ...(/2\.5-flash/.test(MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
                }
            })
        });

        if (!upstream.ok) {
            const detail = await upstream.text();
            console.error('Error de la API de Gemini:', upstream.status, detail.slice(0, 500));
            return sendJson(res, 502, { error: 'El modelo no respondió.' });
        }

        const data = await upstream.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        const reply = parts.map(p => p.text || '').join('').trim();

        if (!reply) {
            console.warn('Respuesta vacía. finishReason:', data.candidates?.[0]?.finishReason,
                '| bloqueo:', data.promptFeedback?.blockReason || 'ninguno');
            return sendJson(res, 502, { error: 'Respuesta vacía del modelo.' });
        }
        sendJson(res, 200, { reply });
    } catch (err) {
        console.error('Fallo al llamar a la API:', err.message);
        sendJson(res, 502, { error: 'No pude contactar al modelo.' });
    } finally {
        clearTimeout(timer);
    }
}

const server = http.createServer(async (req, res) => {
    try {
        const url = (req.url || '/').split('?')[0];

        if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/coso_param.html')) {
            const html = fs.readFileSync(HTML_FILE);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        }
        if (req.method === 'POST' && url === '/api/chat') {
            return await handleChat(req, res);
        }
        if (req.method === 'GET' && url === '/api/session') {
            return handleSession(req, res);
        }
        if (req.method === 'POST' && url === '/api/history') {
            return await handleHistorySave(req, res);
        }
        if (req.method === 'POST' && url === '/api/history/clear') {
            return handleHistoryClear(req, res);
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No encontrado');
    } catch (err) {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Error interno.' });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`bot-n/a listo en http://localhost:${PORT}`);
    console.log(`Modelo Gemini: ${MODEL}`);
    console.log(`Historial en: ${DATA_DIR}` + (RETENTION_DAYS ? ` (se borra tras ${RETENTION_DAYS} días)` : ''));
    console.log('Página:', path.basename(HTML_FILE), fs.existsSync(HTML_FILE) ? '(encontrada)' : '(NO ENCONTRADA: ponla junto a server.js)');
    if (!API_KEY) console.warn('AVISO: no hay GEMINI_API_KEY. Revisa que tu archivo se llame .env (con punto) y esté junto a server.js.');
});

// Ruta para el Desglose Anti-Caos con IA
app.post('/api/deconstruct', async (req, res) => {
    try {
        const { task } = req.body;
        if (!task) return res.status(400).json({ error: 'Falta la tarea' });

        const prompt = `Actúa como Kaia, una asistente de bienestar estudiantil con el lema "como a pasos de tortuga". El usuario tiene la siguiente situación o tarea en mente: "${task}". 
        Divídela en 3 a 5 micro-pasos realistas y sencillos.( Obviamente variara dependiendo de la tarea/situacion)
        Devuelve la respuesta estrictamente como un arreglo JSON plano, sin texto adicional ni bloques de markdown complejos, donde cada objeto tenga exactamente estas dos propiedades: 
        "title" (el texto del micro-paso de forma amigable) y "time" (un tiempo estimado corto, ej. "15 min", "20 min").`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });

        let text = response.text.trim();
        // Limpiar marcas de código markdown si las trae la respuesta
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        
        const steps = JSON.parse(text);
        res.json({ steps });
    } catch (error) {
        console.error('Error en desglose con IA:', error);
        res.status(500).json({ error: 'No se pudo generar el desglose' });
    }
});
