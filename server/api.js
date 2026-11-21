import { getSettings, updateSettings, DEFAULT_SETTINGS } from './config.js';
import { log, all, one, run } from './db.js';
import { resolveDshCommand } from './dsh.js';
import {
  getConversation,
  listConversations,
  listMessages,
  listUsers,
  stats,
  updateConversation,
  updateUser,
  deleteConversation,
  clearConversation,
} from './store.js';
import { listPersonas, getPersona, createPersona, updatePersona, deletePersona } from './personas.js';
import { llmReady, testLLM } from './llm.js';
import { visionStatus, testVision, resolveImageBytes, captionImage } from './vision.js';
import { cqToSegments } from './text.js';
import { getMood, setMood } from './mood.js';
import {
  listStickers,
  syncStickers,
  setStickerEnabled,
  deleteSticker,
  readSticker,
  countStickers,
  describeStickers,
  searchStickers,
  stickerCatalog,
} from './stickers.js';

const MAX_BODY = 2 * 1024 * 1024;

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

export function createApi({ bot, ob, broadcast, proactive = null, dsh = null }) {
  return async function handleApi(req, res, url) {
    const json = (code, payload) => send(res, code, payload);
    const method = req.method || 'GET';
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const [root, id, sub] = parts;

    try {
      // ————————————— 状态 —————————————
      if (root === 'status' && method === 'GET') {
        const s = getSettings();
        return json(200, {
          onebot: ob.getStatus(),
          llm: {
            ready: llmReady(),
            model: s.model,
            base: s.api_base,
            has_key: Boolean(String(s.api_key).trim()),
          },
          vision: visionStatus(),
          dsh: {
            enabled: Boolean(getSettings().dsh_enabled),
            configured: Boolean(resolveDshCommand(getSettings()).trim()),
            keywords: String(getSettings().dsh_keywords || ''),
            running: dsh ? dsh.list().length : 0,
          },
          stats: stats(),
          uptime: Math.round(process.uptime()),
          node: process.version,
        });
      }

      if (root === 'stickers' && (id === 'describe') && (method === 'POST' || method === 'PUT')) {
        const body = await readJson(req);
        return json(200, await describeStickers({ limit: body?.limit, force: Boolean(body?.force) }));
      }
      if (root === 'stickers' && (id === 'search') && (method === 'POST' || method === 'PUT')) {
        const body = await readJson(req);
        const s = getSettings();
        if (!s.sticker_web_enabled) return json(400, { error: '「允许上网找表情包」没开' });
        return json(200, await searchStickers(body?.q, { count: body?.count, endpoint: s.sticker_search_url }));
      }

      // ————————————— DSH 转交 —————————————
      if (root === 'link' && method === 'GET') {
        const st = getSettings();
        const mainId = Number(st.main_conversation_id) || 0;
        let mainTitle = '';
        if (mainId) {
          const row = one('SELECT title FROM conversations WHERE id = ?', mainId);
          mainTitle = row?.title || '';
        }
        return json(200, {
          now: Date.now(),
          uptime: Math.round(process.uptime()),
          node: process.version,
          onebot: ob.getStatus(),
          llm: { ready: llmReady(), model: st.model, has_key: Boolean(String(st.api_key || '').trim()) },
          vision: visionStatus(),
          main: { id: mainId, title: mainTitle },
          proactive: {
            enabled: Boolean(st.proactive_enabled),
            min: Number(st.proactive_min_minutes) || 0,
            max: Number(st.proactive_max_minutes) || 0,
            idle: Number(st.proactive_idle_minutes) || 0,
            quiet: `${st.proactive_quiet_start}–${st.proactive_quiet_end}`,
            cap: Number(st.proactive_daily_cap) || 0,
            followup: Boolean(st.followup_enabled),
            followup_minutes: Number(st.followup_minutes) || 0,
            followup_max: Number(st.followup_max) || 0,
          },
          dsh: {
            enabled: Boolean(st.dsh_enabled),
            configured: Boolean(resolveDshCommand(st).trim()),
            keywords: String(st.dsh_keywords || ''),
            command: resolveDshCommand(st),
            cwd: String(st.dsh_cwd || '') || '(面板工作目录)',
            timeout_min: Math.round((Number(st.dsh_timeout_ms) || 240000) / 60000),
            jobs: dsh ? dsh.list() : [],
          },
        });
      }

      if (root === 'dsh' && id === 'jobs' && method === 'GET') {
        return json(200, { jobs: dsh ? dsh.list() : [] });
      }

      // ————————————— 设置 —————————————
      if (root === 'settings') {
        if (method === 'GET') {
          const s = getSettings();
          return json(200, { settings: s, defaults: DEFAULT_SETTINGS });
        }
        if (method === 'PUT' || method === 'PATCH' || method === 'POST') {
          const body = await readJson(req);
          const next = updateSettings(body);
          ob.reconfigure();
          if (proactive) proactive.reschedule();
          broadcast({ type: 'status' });
          return json(200, { settings: next });
        }
      }

      // ————————————— 人格 —————————————
      if (root === 'personas') {
        if (!id && method === 'GET') return json(200, { personas: listPersonas() });
        if (!id && method === 'POST') {
          const body = await readJson(req);
          if (!String(body.name || '').trim()) return json(400, { error: '请填写人格名称' });
          return json(200, { persona: createPersona(body) });
        }
        if (id && method === 'GET' && !sub) {
          const p = getPersona(id);
          return p ? json(200, { persona: p }) : json(404, { error: '人格不存在' });
        }
        if (id && (method === 'PUT' || method === 'PATCH') && !sub) {
          const body = await readJson(req);
          const p = updatePersona(id, body);
          return p ? json(200, { persona: p }) : json(404, { error: '人格不存在' });
        }
        if (id && method === 'DELETE' && !sub) {
          const ok = deletePersona(id);
          return ok ? json(200, { ok: true }) : json(404, { error: '人格不存在' });
        }
        if (id && sub === 'default' && method === 'POST') {
          if (!getPersona(id)) return json(404, { error: '人格不存在' });
          updateSettings({ default_persona_id: Number(id) });
          return json(200, { settings: getSettings() });
        }
      }

      // ————————————— 会话 —————————————
      if (root === 'conversations') {
        if (!id && method === 'GET') {
          const mainId = Number(getSettings().main_conversation_id) || 0;
          const rows = listConversations({
            query: url.searchParams.get('q') || '',
            kind: url.searchParams.get('kind') || '',
          }).map((c) => ({ ...c, is_main: Number(c.id) === mainId }));
          return json(200, { conversations: rows });
        }
        if (id && !sub) {
          const cid = Number(id);
          const conv = getConversation(cid);
          if (!conv) return json(404, { error: '会话不存在' });
          if (method === 'GET') return json(200, { conversation: conv });
          if (method === 'PATCH' || method === 'PUT') {
            const body = await readJson(req);
            return json(200, { conversation: updateConversation(cid, body) });
          }
          if (method === 'DELETE') {
            deleteConversation(cid);
            broadcast({ type: 'conversation_deleted', conversation_id: cid });
            return json(200, { ok: true });
          }
        }
        if (id && sub === 'main' && method === 'POST') {
          const conv = getConversation(Number(id));
          if (!conv) return json(404, { error: '会话不存在' });
          updateSettings({ main_conversation_id: Number(id) });
          broadcast({ type: 'settings' });
          broadcast({ type: 'main_changed', conversation_id: Number(id) });
          if (proactive) proactive.reschedule();
          return json(200, { ok: true, conversation: getConversation(Number(id)) });
        }
        if (id && sub === 'main' && method === 'DELETE') {
          if (Number(getSettings().main_conversation_id) === Number(id)) {
            updateSettings({ main_conversation_id: 0 });
            broadcast({ type: 'settings' });
            broadcast({ type: 'main_changed', conversation_id: 0 });
            if (proactive) proactive.reschedule();
          }
          return json(200, { ok: true });
        }
        if (id && sub === 'clear' && method === 'POST') {
          clearConversation(Number(id));
          broadcast({ type: 'conversation_cleared', conversation_id: Number(id) });
          return json(200, { ok: true });
        }
        if (id && sub === 'messages' && method === 'GET') {
          const messages = listMessages(Number(id), {
            before: Number(url.searchParams.get('before') || 0),
            limit: Number(url.searchParams.get('limit') || 60),
          });
          return json(200, { messages });
        }
        if (id && sub === 'export' && method === 'GET') {
          const conv = getConversation(Number(id));
          if (!conv) return json(404, { error: '会话不存在' });
          const rows = all(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC',
            Number(id)
          );
          const lines = [
            `# ${conv.title || conv.peer_id}（${conv.kind === 'group' ? '群聊' : '私聊'} ${conv.peer_id}）`,
            `# 人格：${conv.persona_name || '-'}　共 ${rows.length} 条`,
            '',
            ...rows.map((m) => {
              const who = m.role === 'assistant' ? '我' : m.sender || conv.title || '对方';
              const t = new Date(m.created_at).toLocaleString('zh-CN', { hour12: false });
              return `[${t}] ${who}：${m.content}`;
            }),
          ];
          const body = lines.join('\n');
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="conversation-${conv.id}.txt"`,
            'Content-Length': Buffer.byteLength(body),
          });
          res.end(body);
          return;
        }
      }

      // ————————————— 用户 —————————————
      if (root === 'users') {
        if (!id && method === 'GET') return json(200, { users: listUsers() });
        if (id && (method === 'PATCH' || method === 'PUT')) {
          const body = await readJson(req);
          return json(200, { user: updateUser(id, body) });
        }
      }

      // ————————————— 表情包 —————————————
      if (root === 'stickers') {
        if (!id && method === 'GET') {
          return json(200, {
            stickers: listStickers(),
            total: countStickers(),
            enabled: countStickers({ enabledOnly: true }),
            chance: Number(getSettings().sticker_chance) || 0,
            on: Boolean(getSettings().sticker_enabled),
          });
        }
        if (!id && (method === 'POST' || method === 'PUT')) {
          const body = await readJson(req).catch(() => ({}));
          const res = await syncStickers(ob, { count: Number(body.count) || 120 });
          broadcast({ type: 'stickers' });
          return json(200, res);
        }
        if (id && sub === 'file' && method === 'GET') {
          const row = listStickers().find((x) => Number(x.id) === Number(id));
          const buf = row ? readSticker(row) : null;
          if (!buf) return json(404, { error: '表情不存在' });
          const ext = String(row.file.split('.').pop() || 'png').toLowerCase();
          const mime =
            ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'jpg' ? 'image/jpeg' : 'image/png';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400', 'Content-Length': buf.length });
          res.end(buf);
          return;
        }
        if (id) {
          if (method === 'PATCH' || method === 'PUT') {
            const body = await readJson(req);
            const row = setStickerEnabled(Number(id), Boolean(body.enabled));
            return json(200, { ok: true, sticker: row });
          }
          if (method === 'DELETE') {
            return json(200, { ok: deleteSticker(Number(id)) });
          }
        }
      }

      // ————————————— 情绪条 —————————————
      if (root === 'mood' && id && method === 'GET') {
        const conv = one('SELECT id FROM conversations WHERE id = ?', Number(id));
        if (!conv) return json(404, { error: '会话不存在' });
        return json(200, { mood: getMood(Number(id)) });
      }
      if (root === 'mood' && id && (method === 'PATCH' || method === 'PUT')) {
        const body = await readJson(req);
        const conv = one('SELECT id FROM conversations WHERE id = ?', Number(id));
        if (!conv) return json(404, { error: '会话不存在' });
        return json(200, { mood: setMood(Number(id), body || {}) });
      }

      // ————————————— 主对话主动消息 —————————————
      if (root === 'proactive' && id === 'now' && method === 'POST') {
        if (!proactive) return json(503, { error: '主动消息调度未启动' });
        const res = await proactive.tick({ force: true });
        return json(200, res);
      }

      // ————————————— 手动发送 —————————————
      if (root === 'send' && method === 'POST') {
        const body = await readJson(req);
        const kind = body.kind === 'group' ? 'group' : 'private';
        const peerId = String(body.peer_id || '').trim();
        const text = String(body.text || '').trim();
        if (!peerId || !text) return json(400, { error: '缺少 peer_id 或内容' });
        if (!ob.getStatus().connected) return json(409, { error: 'OneBot 未连接，无法发送' });
        const sent = await bot.sendManual(kind, peerId, text);
        return json(200, { ok: true, sent });
      }

      // ————————————— 日志 —————————————
      if (root === 'logs') {
        if (method === 'GET') {
          const limit = Math.min(500, Number(url.searchParams.get('limit') || 120));
          const rows = all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', limit);
          return json(200, { logs: rows.reverse() });
        }
        if (method === 'DELETE') {
          run('DELETE FROM logs');
          return json(200, { ok: true });
        }
      }

      // ————————————— 识图测试 —————————————
    


  if (root === 'vision' && id === 'probe' && method === 'POST') {
    const payload = await readJson(req);
    try {
      const kind = String(payload.kind || 'private');
      const peer = String(payload.peer_id || '');
      const count = Math.min(120, Math.max(1, Number(payload.count) || 10));
      const act = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
      const params = kind === 'group' ? { group_id: peer, count } : { user_id: peer, count };
      const hist = await ob.sendAction(act, params, 20000);
      const list = hist?.data?.messages || hist?.data || [];
      const out = [];
      for (const msg of (Array.isArray(list) ? list : [])) {
        const message = msg.message ?? msg.raw_message ?? [];
        const arr = Array.isArray(message)
          ? message
          : typeof message === 'string'
            ? cqToSegments(message)
            : [];
        const img = arr.find((x) => x && x.type === 'image');
        if (!img) continue;
        const meta = {
          message_id: msg.message_id,
          file: img.data?.file,
          url: String(img.data?.url || '').slice(0, 60),
        };
        try {
          const buf = await resolveImageBytes(ob, img, 20000, msg.message_id);
          meta.bytes = buf.length;
          meta.caption = await captionImage(buf).catch((e) => 'ERR ' + e.message);
        } catch (e) {
          meta.error = e.message;
        }
        out.push(meta);
        if (out.length >= 2) break;
      }
      return json(200, { ok: true, found: out.length, items: out, raw: out.length ? [] : String(JSON.stringify(hist)).slice(0, 500) });
    } catch (e) {
      return json(500, { ok: false, error: String(e && e.message) });
    }
  }

  if (root === 'vision' && id === 'test' && method === 'POST') {
        const out = await testVision();
        return json(out.ok ? 200 : 400, out);
      }

      // ————————————— 模型测试 —————————————
      if (root === 'llm' && id === 'test' && method === 'POST') {
        try {
          const out = await testLLM();
          return json(200, { ok: true, ...out });
        } catch (err) {
          return json(400, { ok: false, error: err.message });
        }
      }

      return json(404, { error: '接口不存在' });
    } catch (err) {
      log('error', 'api', `${method} ${url.pathname} → ${err?.message || err}`);
      return json(500, { error: err?.message || '服务器内部错误' });
    }
  };
}
