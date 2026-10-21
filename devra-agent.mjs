// DEVRA - Autonomous Software Engineering Agent
// Dibuat khusus untuk ekosistem Ir. Nor Anisa, S.Kom., M.Kom.
// Mengintegrasikan Telegram Bot (@devra9920_bot), GitHub API (noura-nis), Render Cloud API, dan 9Router/Bansos AI Gateway

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Muat .env lokal secara otomatis jika ada
try {
  const envRaw = await fs.readFile(path.join(__dirname, '.env'), 'utf-8');
  for (const line of envRaw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch (e) {}

// Konfigurasi Kredensial & Lingkungan
const DEVRA_BOT_TOKEN = process.env.DEVRA_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'noura-nis';
const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://bansos-router.onrender.com/v1').replace(/\/+$/, '');
const AI_API_KEY = process.env.AI_API_KEY || 'bansos';
const PRIMARY_AI_MODEL = process.env.AI_MODEL || 'codestral-latest';

if (!DEVRA_BOT_TOKEN || DEVRA_BOT_TOKEN === 'disabled') {
  console.log('[DEVRA] Disabled (no DEVRA_BOT_TOKEN configured)');
  process.exit(0);
}

const telegramEndpoint = 'https://api.telegram.org/bot' + DEVRA_BOT_TOKEN + '/';
let offset = 0;
const botUsername = 'devra9920_bot';

console.log('[DEVRA] Initializing Autonomous Software Engineering Agent...');
console.log(`[DEVRA] Target GitHub Owner: ${GITHUB_OWNER}`);
console.log(`[DEVRA] AI Gateway: ${AI_BASE_URL} (Model: ${PRIMARY_AI_MODEL})`);

// -------------------------------------------------------------
// Telegram API Helper
// -------------------------------------------------------------
async function telegram(method, body) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), 35000);
  try {
    const res = await fetch(telegramEndpoint + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: c.signal
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram ${res.status}: ${json.description}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function send(chatId, text, replyToId = null, threadId = null) {
  // Hapus semua tanda bintang (*) agar pesan rapi sesuai instruksi user
  const cleanText = String(text).replace(/\*/g, '');
  const chunks = cleanText.match(/[\s\S]{1,3800}/g) || [''];
  for (const chunk of chunks) {
    const payload = { chat_id: chatId, text: chunk };
    if (replyToId) payload.reply_to_message_id = replyToId;
    if (threadId) payload.message_thread_id = threadId;
    await telegram('sendMessage', payload);
  }
}

async function sendTyping(chatId, threadId = null) {
  try {
    const payload = { chat_id: chatId, action: 'typing' };
    if (threadId) payload.message_thread_id = threadId;
    await telegram('sendChatAction', payload);
  } catch (e) {}
}

// -------------------------------------------------------------
// GitHub REST API Engine
// -------------------------------------------------------------
async function githubRequest(apiPath, options = {}) {
  const url = apiPath.startsWith('http') ? apiPath : `https://api.github.com${apiPath}`;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'DEVRA-Autonomous-Agent/2.0 (+https://github.com/noura-nis)',
    ...(GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {}),
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub API ${res.status}: ${errText}`);
  }
  return res.json();
}

async function listUserRepos() {
  const repos = await githubRequest(`/user/repos?per_page=100&sort=updated`);
  return repos.filter(r => r.owner && r.owner.login.toLowerCase() === GITHUB_OWNER.toLowerCase());
}

async function getRepoTree(repo, branch = 'main') {
  try {
    const commit = await githubRequest(`/repos/${GITHUB_OWNER}/${repo}/commits/${branch}`);
    const treeSha = commit.commit.tree.sha;
    const treeData = await githubRequest(`/repos/${GITHUB_OWNER}/${repo}/git/trees/${treeSha}?recursive=1`);
    return treeData.tree || [];
  } catch (e) {
    // Coba fallback ke branch master jika main tidak ada
    if (branch === 'main') {
      return getRepoTree(repo, 'master');
    }
    throw e;
  }
}

async function getFileContent(repo, filePath, branch = null) {
  const query = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const data = await githubRequest(`/repos/${GITHUB_OWNER}/${repo}/contents/${filePath}${query}`);
  if (data.encoding === 'base64') {
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content, sha: data.sha, size: data.size, path: data.path };
  }
  throw new Error(`Unsupported encoding: ${data.encoding}`);
}

async function commitFileChange(repo, filePath, newContent, commitMessage, branch = 'main') {
  let currentSha = null;
  try {
    const existing = await getFileContent(repo, filePath, branch);
    currentSha = existing.sha;
  } catch (e) {
    // Berkas baru, currentSha tetap null
  }

  const payload = {
    message: commitMessage,
    content: Buffer.from(newContent, 'utf-8').toString('base64'),
    branch: branch,
    committer: {
      name: 'DEVRA Autonomous Agent',
      email: 'devra@noura-studio.id'
    }
  };
  if (currentSha) {
    payload.sha = currentSha;
  }

  const result = await githubRequest(`/repos/${GITHUB_OWNER}/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return result;
}

// -------------------------------------------------------------
// Render API Engine
// -------------------------------------------------------------
async function renderRequest(apiPath, options = {}) {
  if (!RENDER_API_KEY) {
    throw new Error('RENDER_API_KEY belum dikonfigurasi di Environment Variable Render');
  }
  const url = apiPath.startsWith('http') ? apiPath : `https://api.render.com/v1${apiPath}`;
  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${RENDER_API_KEY}`,
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Render API ${res.status}: ${errText}`);
  }
  return res.json();
}

async function listRenderServices() {
  return renderRequest('/services?limit=20');
}

async function getRenderDeploys(serviceId) {
  return renderRequest(`/services/${serviceId}/deploys?limit=5`);
}

async function triggerRenderDeploy(serviceId) {
  return renderRequest(`/services/${serviceId}/deploys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearCache: 'do_not_clear' })
  });
}

// -------------------------------------------------------------
// Bansos / 9Router AI Gateway Caller
// -------------------------------------------------------------
async function askAI(systemPrompt, userPrompt, preferredModel = PRIMARY_AI_MODEL) {
  const candidateModels = [preferredModel, 'antigravity', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'codestral-latest', 'fast'];
  let lastErr = null;

  for (const model of candidateModels) {
    try {
      const c = new AbortController();
      const timer = setTimeout(() => c.abort(), 60000);
      const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2
        }),
        signal: c.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`AI HTTP ${res.status}`);
      }
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content;
      if (reply) return { text: reply, modelUsed: model };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw new Error(`Semua AI model gateway gagal: ${lastErr?.message}`);
}

async function getTelegramPhotoBase64(fileId) {
  const fileRes = await telegram('getFile', { file_id: fileId });
  if (!fileRes?.file_path) throw new Error('Telegram file_path tidak ditemukan.');
  const fileUrl = `https://api.telegram.org/file/bot${DEVRA_BOT_TOKEN}/${fileRes.file_path}`;
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Gagal mengunduh gambar Telegram: HTTP ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function askVisionAI(systemPrompt, userPrompt, base64Image, preferredModel = 'glm-5.3-flash-free') {
  const candidateModels = ['antigravity', preferredModel, 'glm-5.3-flash-free', 'mimo-v2.6-flash-free', 'gemini-2.0-flash-exp', 'fast'];
  let lastErr = null;

  for (const model of candidateModels) {
    try {
      const c = new AbortController();
      const timer = setTimeout(() => c.abort(), 60000);
      const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                { type: 'text', text: userPrompt || 'Tolong jelaskan dan analisis tangkapan layar ini secara komprehensif.' },
                { type: 'image_url', image_url: { url: base64Image } }
              ]
            }
          ],
          temperature: 0.2
        }),
        signal: c.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content;
      if (reply) return { text: reply, modelUsed: model };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw new Error(`Semua AI Vision gateway gagal: ${lastErr?.message}`);
}

// -------------------------------------------------------------
// Autonomous Engineering Workflows
// -------------------------------------------------------------
async function autonomousCodeFix(chatId, threadId, replyId, repoName, issueDescription) {
  const reply = (text) => send(chatId, text, replyId, threadId);
  const typing = () => sendTyping(chatId, threadId);

  await reply(`🤖 DEVRA Autonomous Agent sedang menganalisis repositori ${repoName}...\nMasalah: ${issueDescription}`);
  await typing();

  try {
    // 1. Ambil struktur berkas repositori
    const repos = await listUserRepos();
    const matched = repos.find(r => r.name.toLowerCase() === repoName.toLowerCase() || r.name.toLowerCase().includes(repoName.toLowerCase()));
    if (!matched) {
      return reply(`❌ Repositori "${repoName}" tidak ditemukan di akun ${GITHUB_OWNER}.\nGunakan /repos untuk melihat daftar repositori.`);
    }

    const actualRepo = matched.name;
    const defaultBranch = matched.default_branch || 'main';
    const tree = await getRepoTree(actualRepo, defaultBranch);
    const fileList = tree
      .filter(f => f.type === 'blob' && !f.path.includes('node_modules') && !f.path.includes('.git/') && !f.path.includes('.next/'))
      .map(f => f.path);

    await typing();

    // 2. Tentukan berkas mana yang relevan menggunakan AI
    const selectPrompt = `Daftar berkas di repositori ${actualRepo}:\n${fileList.slice(0, 150).join('\n')}\n\nTugas: Dari daftar berkas di atas, pilih 1 sampai 3 berkas yang paling relevan untuk memperbaiki masalah berikut:\n"${issueDescription}"\nJawab HANYA dengan format baris nama berkas tanpa penjelasan lain.`;
    const selectedFilesRes = await askAI(
      'Kamu adalah AI Software Architect yang memilih berkas kode yang tepat untuk diinspeksi.',
      selectPrompt,
      'fast'
    );
    const candidateFiles = selectedFilesRes.text.split('\n').map(s => s.trim()).filter(s => fileList.includes(s));
    const targetFile = candidateFiles[0] || fileList.find(f => f.endsWith('.py') || f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.html'));

    if (!targetFile) {
      return reply(`❌ Tidak dapat menentukan berkas target di repositori ${actualRepo}.`);
    }

    await reply(`🔍 Berkas target teridentifikasi: ${targetFile} (Branch: ${defaultBranch})\nMengunduh kode sumber dan merancang perbaikan...`);
    await typing();

    // 3. Baca isi berkas
    const fileData = await getFileContent(actualRepo, targetFile, defaultBranch);
    const originalCode = fileData.content;

    // Batasi ukuran naskah agar muat di prompt LLM
    const codeSnippet = originalCode.length > 30000 ? originalCode.slice(0, 30000) + '\n[...truncated]' : originalCode;

    // 4. Minta AI menuliskan kode perbaikan secara lengkap
    const fixPrompt = `Repositori: ${actualRepo}\nBerkas: ${targetFile}\nMasalah/Kebutuhan:\n${issueDescription}\n\nKode Asli Saat Ini:\n\`\`\`\n${codeSnippet}\n\`\`\`\n\nTugas:\nPerbaiki atau modifikasi kode tersebut agar masalah teratasi dengan standar industri tinggi. Berikan KODE LENGKAP yang siap menggantikan isi berkas secara utuh.\nJawab HANYA dengan blok kode Markdown murni (\`\`\`...\`\`\`) tanpa penjelasan pembuka atau penutup.`;

    const fixResult = await askAI(
      'Kamu adalah DEVRA, Autonomous Senior Principal Software Engineer. Kamu menghasilkan kode produksi yang bebas bug, modular, dan bersih.',
      fixPrompt,
      'codestral-latest'
    );

    let fixedCode = fixResult.text.trim();
    // Bersihkan pembungkus markdown ``` jika ada
    if (fixedCode.startsWith('```')) {
      fixedCode = fixedCode.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '').trim();
    }

    if (!fixedCode || fixedCode.length < 20) {
      return reply(`❌ Gagal menghasilkan kode perbaikan yang valid dari AI engine.`);
    }

    await reply(`⚡ Solusi selesai dirancang oleh ${fixResult.modelUsed}. Melakukan commit otomatis ke GitHub...`);
    await typing();

    // 5. Commit perubahan ke GitHub
    const commitMsg = `fix(devra): ${issueDescription.slice(0, 72)}`;
    const commitRes = await commitFileChange(actualRepo, targetFile, fixedCode, commitMsg, defaultBranch);

    const commitSha = commitRes.commit?.sha?.slice(0, 7) || 'latest';
    const commitUrl = commitRes.commit?.html_url || `https://github.com/${GITHUB_OWNER}/${actualRepo}/commit/${commitSha}`;

    let report = `✅ DEVRA Autonomous Fix Berhasil Diterapkan!\n\n`;
    report += `📁 Repositori: ${actualRepo}\n`;
    report += `📄 Berkas: ${targetFile}\n`;
    report += `🌿 Branch: ${defaultBranch}\n`;
    report += `🔖 Commit: ${commitSha}\n`;
    report += `🔗 Link Commit: ${commitUrl}\n`;
    report += `🧠 Model AI: ${fixResult.modelUsed}\n\n`;
    report += `Perubahan telah terdorong ke repositori GitHub. Render akan mendeteksi perubahan ini dan memicu build secara otomatis.`;

    await reply(report);

  } catch (err) {
    console.error('[DEVRA Autonomous Fix Error]', err);
    await reply(`❌ Error saat menjalankan Autonomous Fix: ${err.message}`);
  }
}

async function autonomousCreateCode(chatId, threadId, replyId, repoName, instruction) {
  const reply = (text) => send(chatId, text, replyId, threadId);
  const typing = () => sendTyping(chatId, threadId);

  await reply(`🚀 DEVRA Autonomous Agent sedang merancang kode baru untuk ${repoName}...\nInstruksi: ${instruction}`);
  await typing();

  try {
    const repos = await listUserRepos();
    const matched = repos.find(r => r.name.toLowerCase() === repoName.toLowerCase() || r.name.toLowerCase().includes(repoName.toLowerCase()));
    if (!matched) {
      return reply(`❌ Repositori "${repoName}" tidak ditemukan di akun ${GITHUB_OWNER}.`);
    }

    const actualRepo = matched.name;
    const defaultBranch = matched.default_branch || 'main';

    const codePrompt = `Repositori: ${actualRepo}\nInstruksi Pembuatan Kode:\n${instruction}\n\nTugas:\n1. Tentukan path berkas yang tepat (misal: scripts/sync-backup.js, api/v1/helper.py, dll)\n2. Buat seluruh kode lengkap siap pakai.\n\nFormat Jawaban HANYA berupa JSON valid:\n{\n  "filePath": "path/ke/berkas.ext",\n  "code": "isi kode lengkap disini",\n  "summary": "penjelasan singkat dalam 1-2 kalimat"\n}`;

    const aiRes = await askAI(
      'Kamu adalah DEVRA, Autonomous Full-Stack AI Engineer. Jawab HANYA dengan format JSON valid tanpa tanda markdown.',
      codePrompt,
      'codestral-latest'
    );

    let cleanJson = aiRes.text.trim();
    if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (e) {
      // Fallback regex jika JSON agak kotor
      const matchPath = cleanJson.match(/"filePath"\s*:\s*"([^"]+)"/);
      const matchCode = cleanJson.match(/"code"\s*:\s*"([\s\S]+)"\s*,\s*"summary"/);
      if (matchPath) {
        parsed = {
          filePath: matchPath[1],
          code: matchCode ? matchCode[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : cleanJson,
          summary: 'Fitur baru digenerate oleh DEVRA'
        };
      } else {
        throw new Error('Gagal mem-parsing keluaran JSON kode baru dari AI.');
      }
    }

    await reply(`📝 Menuliskan berkas baru: ${parsed.filePath}\nMelakukan commit ke branch ${defaultBranch}...`);
    await typing();

    const commitMsg = `feat(devra): ${instruction.slice(0, 72)}`;
    const commitRes = await commitFileChange(actualRepo, parsed.filePath, parsed.code, commitMsg, defaultBranch);
    const commitSha = commitRes.commit?.sha?.slice(0, 7) || 'latest';
    const commitUrl = commitRes.commit?.html_url || `https://github.com/${GITHUB_OWNER}/${actualRepo}/commit/${commitSha}`;

    let report = `✅ Kode Baru Berhasil Ditulis & Dicommit oleh DEVRA!\n\n`;
    report += `📁 Repositori: ${actualRepo}\n`;
    report += `📄 Berkas Baru: ${parsed.filePath}\n`;
    report += `🌿 Branch: ${defaultBranch}\n`;
    report += `🔖 Commit: ${commitSha}\n`;
    report += `🔗 Link Commit: ${commitUrl}\n`;
    report += `💡 Ringkasan: ${parsed.summary || instruction}`;

    await reply(report);

  } catch (err) {
    console.error('[DEVRA Autonomous Code Error]', err);
    await reply(`❌ Error saat membuat kode: ${err.message}`);
  }
}

// -------------------------------------------------------------
// Message Router
// -------------------------------------------------------------
async function handle(msg) {
  const id = msg.chat?.id;
  const rawText = msg.text?.trim() || msg.caption?.trim() || '';
  const photoList = msg.photo || msg.reply_to_message?.photo;
  const hasPhoto = Array.isArray(photoList) && photoList.length > 0;
  if (!id || (!rawText && !hasPhoto)) return;

  const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup';
  const messageId = msg.message_id;
  const threadId = msg.message_thread_id || null;

  let txt = rawText;
  let isCommand = txt.startsWith('/');
  let cmd = '';
  let arg = '';

  if (isCommand) {
    const parts = txt.split(' ');
    cmd = parts[0].split('@')[0].toLowerCase();
    arg = txt.slice(parts[0].length).trim();
  }

  const isMentioned = txt.toLowerCase().includes('@' + botUsername);
  const isReplyToBot = msg.reply_to_message?.from?.username === botUsername;

  // Di grup, hanya tanggapi jika dipanggil (command, mention, atau reply)
  if (isGroup && !isCommand && !isMentioned && !isReplyToBot) {
    return;
  }

  const reply = (text) => send(id, text, isGroup ? messageId : null, threadId);
  const typing = () => sendTyping(id, threadId);

  // Vision Handler: jika ada foto dan ditujukan ke bot (atau perintah /vision)
  if (hasPhoto && (cmd === '/vision' || isMentioned || isReplyToBot || !isGroup)) {
    await typing();
    try {
      const photo = photoList[photoList.length - 1];
      const base64Img = await getTelegramPhotoBase64(photo.file_id);
      const cleanPrompt = txt.replace(new RegExp('@' + botUsername, 'gi'), '').replace(/^\/vision\s*/i, '').trim();
      const visionRes = await askVisionAI(
        'Kamu adalah DEVRA, Autonomous Software Engineering Agent dengan kapabilitas Computer Vision cerdas untuk Ir. Nor Anisa, S.Kom., M.Kom. Kamu ahli dalam menganalisis tangkapan layar dashboard, kode program, error console, konfigurasi jaringan/cloud, dan arsitektur sistem. Berikan penjelasan yang komprehensif, teliti, solutif, dan tanpa menggunakan karakter asterisk (*).',
        cleanPrompt || 'Tolong telusuri dan analisis tangkapan layar ini secara mendalam dan berikan laporan solusinya.',
        base64Img
      );
      return reply(`👁️ [DEVRA Vision Multimodal Analysis]\nModel: ${visionRes.modelUsed}\n\n${visionRes.text}`);
    } catch (err) {
      console.error('[DEVRA Vision Error]', err);
      return reply(`❌ DEVRA Vision gagal menganalisis gambar: ${err.message}`);
    }
  }

  // 1. /start atau /help
  if (cmd === '/start' || cmd === '/help') {
    const helpMsg = `🤖 Halo! Saya DEVRA (Autonomous Software Engineering Agent)
Dibuat khusus untuk Ir. Nor Anisa, S.Kom., M.Kom.

Saya terhubung langsung dengan:
1. Akun GitHub: ${GITHUB_OWNER} (Full Read/Write/Commit/Branch)
2. Cloud Infrastructure: Render Deployment Engine
3. AI Coding Core: Codestral & DeepSeek (via 9Router/Bansos Gateway)

Perintah Utama:
/repos - Melihat semua repositori aktif
/files <repo> - Melihat daftar berkas dalam repositori
/read <repo> <path> - Membaca isi berkas kode
/fix <repo> <masalah> - Memperbaiki bug otomatis & commit langsung ke GitHub
/code <repo> <instruksi> - Membuat kode/fitur baru dan commit ke GitHub
/render - Memeriksa status service dan deployment di Render
/deploy <service_id> - Memicu redeploy service di Render

Atau cukup mention saya:
Contoh: @${botUsername} perbaiki error 500 pada berkas engine.py di openplag.id`;
    return reply(helpMsg);
  }

  // 2. /repos
  if (cmd === '/repos') {
    await typing();
    try {
      const repos = await listUserRepos();
      if (!repos.length) return reply(`Tidak ada repositori yang ditemukan untuk ${GITHUB_OWNER}.`);

      let out = `📂 DAFTAR REPOSITORI GITHUB (${GITHUB_OWNER}):\n\n`;
      for (const r of repos.slice(0, 15)) {
        const vis = r.private ? '🔒 Private' : '🌐 Public';
        const date = r.updated_at ? r.updated_at.substring(0, 10) : '';
        out += `• ${r.name} (${vis})\n  Branch: ${r.default_branch} | Update: ${date}\n  URL: ${r.html_url}\n\n`;
      }
      return reply(out);
    } catch (e) {
      return reply(`❌ Gagal mengambil daftar repositori: ${e.message}`);
    }
  }

  // 3. /files <repo>
  if (cmd === '/files') {
    if (!arg) return reply('Format salah. Contoh penggunaan:\n/files openplag.id');
    await typing();
    try {
      const tree = await getRepoTree(arg.trim());
      const files = tree.filter(f => f.type === 'blob').map(f => f.path);
      let out = `📁 STRUKTUR BERKAS (${arg.trim()}):\nTotal: ${files.length} berkas\n\n`;
      out += files.slice(0, 40).map(p => `• ${p}`).join('\n');
      if (files.length > 40) out += `\n...dan ${files.length - 40} berkas lainnya.`;
      return reply(out);
    } catch (e) {
      return reply(`❌ Gagal mengambil struktur berkas: ${e.message}`);
    }
  }

  // 4. /read <repo> <path>
  if (cmd === '/read') {
    const parts = arg.trim().split(/\s+/);
    if (parts.length < 2) return reply('Format salah. Contoh penggunaan:\n/read openplag.id engine.py');
    const [repo, filePath] = parts;
    await typing();
    try {
      const fileData = await getFileContent(repo, filePath);
      const header = `📄 ${repo} / ${filePath} (${fileData.size} bytes):\n\n`;
      const preview = fileData.content.length > 3500 ? fileData.content.slice(0, 3500) + '\n\n[...konten terpotong karena batas panjang pesan]' : fileData.content;
      return reply(header + preview);
    } catch (e) {
      return reply(`❌ Gagal membaca berkas: ${e.message}`);
    }
  }

  // 5. /fix <repo> <masalah>
  if (cmd === '/fix') {
    const parts = arg.trim().split(/\s+/);
    if (parts.length < 2) return reply('Format salah. Contoh penggunaan:\n/fix openplag.id perbaiki edge-case parsing tabel docx');
    const targetRepo = parts[0];
    const issue = parts.slice(1).join(' ');
    return autonomousCodeFix(id, threadId, isGroup ? messageId : null, targetRepo, issue);
  }

  // 6. /code <repo> <instruksi>
  if (cmd === '/code') {
    const parts = arg.trim().split(/\s+/);
    if (parts.length < 2) return reply('Format salah. Contoh penggunaan:\n/code bansos-router buatkan fungsi webhook telegram baru');
    const targetRepo = parts[0];
    const instr = parts.slice(1).join(' ');
    return autonomousCreateCode(id, threadId, isGroup ? messageId : null, targetRepo, instr);
  }

  // 7. /render
  if (cmd === '/render') {
    await typing();
    if (!RENDER_API_KEY) {
      return reply('⚠️ RENDER_API_KEY belum dikonfigurasi di Environment Variable server Render.\nTambahkan RENDER_API_KEY untuk memantau liveness dan memicu redeploy dari Telegram.');
    }
    try {
      const services = await listRenderServices();
      let out = `☁️ RENDER CLOUD SERVICES:\n\n`;
      for (const item of (services || []).slice(0, 10)) {
        const s = item.service || item;
        out += `• ${s.name} (${s.type})\n  Status: ${s.suspended === 'not_suspended' ? '🟢 Aktif' : '⏸️ Suspended'}\n  ID: ${s.id}\n  URL: ${s.serviceDetails?.url || '-'}\n\n`;
      }
      return reply(out);
    } catch (e) {
      return reply(`❌ Gagal mengambil status Render: ${e.message}`);
    }
  }

  // 8. Natural Language & Mention Routing
  if (isMentioned || isReplyToBot || (!isGroup && !isCommand)) {
    await typing();
    const cleanPrompt = txt.replace(new RegExp('@' + botUsername, 'gi'), '').trim();

    // Deteksi apakah user ingin memperbaiki bug atau membuat kode
    const lower = cleanPrompt.toLowerCase();
    const repos = await listUserRepos().catch(() => []);
    const repoNames = repos.map(r => r.name);

    // Cari tahu repo mana yang disebut dalam pesan
    let matchedRepo = repoNames.find(name => lower.includes(name.toLowerCase()));
    if (!matchedRepo) {
      if (lower.includes('plagiasi') || lower.includes('openplag')) matchedRepo = 'openplag.id';
      else if (lower.includes('router') || lower.includes('bansos')) matchedRepo = 'bansos-router';
      else if (lower.includes('mibp') || lower.includes('9router')) matchedRepo = '9router-mibp-version';
      else if (lower.includes('song') || lower.includes('lagu')) matchedRepo = 'ai-song-automation';
    }

    if (matchedRepo && (lower.includes('fix') || lower.includes('perbaiki') || lower.includes('error') || lower.includes('bug') || lower.includes('rusak'))) {
      return autonomousCodeFix(id, threadId, isGroup ? messageId : null, matchedRepo, cleanPrompt);
    }

    if (matchedRepo && (lower.includes('buat') || lower.includes('bikin') || lower.includes('tambah') || lower.includes('code') || lower.includes('fitur'))) {
      return autonomousCreateCode(id, threadId, isGroup ? messageId : null, matchedRepo, cleanPrompt);
    }

    try {
      // Jika pesan adalah cek atau buka URL (misal: "buka https://...")
      const urlMatch = cleanPrompt.match(/https?:\/\/[^\s]+/i);
      if (urlMatch && (lower.includes('buka') || lower.includes('cek') || lower.includes('periksa') || lower.includes('dashboard') || lower.includes('endpoint'))) {
        const targetUrl = urlMatch[0];
        try {
          const testRes = await fetch(targetUrl, { method: 'GET', signal: AbortSignal.timeout(8000) });
          return reply(`🌐 [DEVRA URL Inspector]\nTarget: ${targetUrl}\nStatus: HTTP ${testRes.status} (${testRes.ok ? '🟢 Aktif / Online' : 'Respon Diterima'})\n\nLayanan dashboard 9Router dapat diakses langsung melalui browser Anda. Fitur ini mengelola endpoint gateway dan integrasi multi-model AI.`);
        } catch (e) {
          return reply(`🌐 [DEVRA URL Inspector]\nTarget: ${targetUrl}\nStatus: ⚠️ Gagal memverifikasi (${e.message})`);
        }
      }

      // Jawaban AI Umum Rekayasa Perangkat Lunak
      const aiChat = await askAI(
        `Kamu adalah DEVRA, Autonomous Software Engineering Agent untuk Ir. Nor Anisa, S.Kom., M.Kom. Kamu ahli dalam Python, Node.js, Next.js, FastAPI, database, dan cloud deployment. Jawab dengan ramah, cerdas, solutif, dan tanpa menggunakan karakter asterisk (*).`,
        cleanPrompt,
        'fast'
      );
      return reply(aiChat.text);
    } catch (aiErr) {
      console.warn('[DEVRA AI Chat Failover]', aiErr.message);
      return reply(`🤖 Halo Bu Nor Anisa! DEVRA Autonomous Agent tetap aktif dan siap siaga.\nSaat ini saya memantau repositori GitHub (${GITHUB_OWNER}) dan infrastruktur Render.\n\nPerintah cepat:\n/repos ➔ Daftar repositori aktif\n/render ➔ Status service cloud Render\n/read <repo> <path> ➔ Membaca berkas kode\n/fix <repo> <masalah> ➔ Perbaikan bug otomatis`);
    }
  }
}

// -------------------------------------------------------------
// Long Polling Loop
// -------------------------------------------------------------
async function poll() {
  console.log('[DEVRA] Polling worker started.');
  while (true) {
    try {
      const updates = await telegram('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message']
      });
      if (Array.isArray(updates)) {
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          if (u.message) {
            handle(u.message).catch(err => {
              console.error('[DEVRA Handler Error]', err);
            });
          }
        }
      }
    } catch (e) {
      if (e.message?.includes('409: Conflict')) {
        console.warn('[DEVRA] Polling conflict detected (another instance running). Waiting 10s...');
        await new Promise(r => setTimeout(r, 10000));
      } else {
        console.warn('[DEVRA] Polling error:', e.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
}

poll();
