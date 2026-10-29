// Escalated support conversations (Zendesk tickets, Intercom conversations) -> ClickUp tasks for the team that has to
// act, with an SLA due date. When the task is closed in ClickUp, the ticket/conversation gets an internal note.
// Plain JS, no imports: build.mjs pastes it into the n8n Code nodes; the tests run the same functions.

const DEFAULTS = {
  zendeskSubdomain: 'yourcompany',
  intercomAppId: 'your-app-id',
  linkedTag: 'clickup_linked',      // Zendesk tag added once a task exists (the Zendesk trigger should exclude it)
  doneStatuses: ['complete', 'closed', 'done', 'resolved'],
  slaHours: { urgent: 4, high: 24, normal: 72, low: 168 },
  maxSeen: 2000,                    // Intercom conversation ids remembered to avoid duplicate tasks
};
const cfgOf = (c) => ({ ...DEFAULTS, ...(c || {}), slaHours: { ...DEFAULTS.slaHours, ...((c && c.slaHours) || {}) } });
const CLICKUP_PRIORITY = { urgent: 1, high: 2, normal: 3, low: 4 };
const clip = (s, n) => { s = String(s || '').replace(/\s+\n/g, '\n').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// The source reference goes in the task name so the close-the-loop workflow can find its way back without a database.
const refTag = (source, id) => `[${source}#${id}]`;
function parseRef(name) {
  const m = String(name || '').match(/\[(zendesk|intercom)#([A-Za-z0-9_-]+)\]\s*$/);
  return m ? { source: m[1], id: m[2] } : null;
}

function dueDate(priority, now, c) {
  const cfg = cfgOf(c);
  return new Date(now).getTime() + (cfg.slaHours[priority] || cfg.slaHours.normal) * 3600000;
}

// ---------- Zendesk ----------
// Zendesk priority (urgent/high/normal/low or null) maps straight across; missing = normal.
function taskFromZendesk(res, now, c) {
  const cfg = cfgOf(c);
  const t = res && res.ticket;
  if (!t) return { skip: 'no ticket' };
  if ((t.tags || []).includes(cfg.linkedTag)) return { skip: 'already linked' };
  const requester = (res.users || []).find((u) => u.id === t.requester_id) || {};
  const priority = CLICKUP_PRIORITY[t.priority] ? t.priority : 'normal';
  const url = `https://${cfg.zendeskSubdomain}.zendesk.com/agent/tickets/${t.id}`;
  return {
    source: 'zendesk', sourceId: String(t.id),
    task: {
      name: `${clip(t.subject || 'Zendesk ticket', 120)} ${refTag('zendesk', t.id)}`,
      markdown_description: [`**From Zendesk:** [ticket #${t.id}](${url})`, `**Customer:** ${requester.name || ''} ${requester.email ? `<${requester.email}>` : ''}`.trim(),
        `**Priority:** ${priority} · **Tags:** ${(t.tags || []).join(', ') || 'none'}`, '', clip(t.description, 3000)].join('\n'),
      priority: CLICKUP_PRIORITY[priority], due_date: dueDate(priority, now, cfg), due_date_time: true, tags: ['support', 'zendesk'],
    },
  };
}

// ---------- Intercom ----------
// Search API results -> conversations that don't have a task yet. seen: { [conversationId]: linkedAtIso } in workflow
// static data. Ids are only remembered after the task exists (rememberSeen), so a failed ClickUp call is retried
// on the next run instead of being lost.
function newIntercomConversations(res, seen) {
  return ((res && res.conversations) || []).filter((conv) => !(seen || {})[conv.id]);
}
function rememberSeen(seen, ids, now, c) {
  const cfg = cfgOf(c);
  const state = { ...(seen || {}) };
  for (const id of ids) state[id] = new Date(now).toISOString();
  const all = Object.keys(state);
  if (all.length > cfg.maxSeen) all.sort((a, b) => state[a].localeCompare(state[b])).slice(0, all.length - cfg.maxSeen).forEach((id) => delete state[id]);
  return state;
}

function taskFromIntercom(conv, now, c) {
  const cfg = cfgOf(c);
  const src = conv.source || {};
  const author = src.author || {};
  const priority = conv.priority === 'priority' ? 'high' : 'normal';
  const url = `https://app.intercom.com/a/inbox/${cfg.intercomAppId}/inbox/conversation/${conv.id}`;
  const subject = stripHtml(src.subject) || clip(stripHtml(src.body), 80) || 'Intercom conversation';
  return {
    source: 'intercom', sourceId: String(conv.id),
    task: {
      name: `${clip(subject, 120)} ${refTag('intercom', conv.id)}`,
      markdown_description: [`**From Intercom:** [conversation ${conv.id}](${url})`, `**Customer:** ${author.name || ''} ${author.email ? `<${author.email}>` : ''}`.trim(),
        `**Priority:** ${priority}`, '', clip(stripHtml(src.body), 3000)].join('\n'),
      priority: CLICKUP_PRIORITY[priority], due_date: dueDate(priority, now, cfg), due_date_time: true, tags: ['support', 'intercom'],
    },
  };
}

// Intercom search for conversations carrying the escalation tag, updated since `sinceSec`.
function intercomSearch(tagId, sinceSec) {
  return { query: { operator: 'AND', value: [{ field: 'tag_ids', operator: 'IN', value: [String(tagId)] }, { field: 'updated_at', operator: '>', value: sinceSec }] },
    pagination: { per_page: 50 } };
}

// ---------- after the task is created ----------
const intercomNote = (cfg, text) => ({ message_type: 'note', type: 'admin', admin_id: String(cfg.intercomAdminId), body: `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` });

function linkBack(item, task, c) {
  const cfg = cfgOf(c);
  if (!task || !task.id) throw new Error(`ClickUp did not return a task for ${item.source} ${item.sourceId}`);
  const text = `Escalated to ClickUp: ${task.url} (due ${new Date(Number(task.due_date)).toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
  if (item.source === 'zendesk') return { source: 'zendesk', id: item.sourceId, body: { ticket: { comment: { body: text, public: false }, additional_tags: [cfg.linkedTag] } } };
  return { source: 'intercom', id: item.sourceId, body: intercomNote(cfg, text) };
}

// ---------- ClickUp task closed -> note on the source ----------
// hook: ClickUp webhook payload (taskStatusUpdated). task: GET /task/{id}. Returns null when nothing to do.
function closeNote(hook, task, c) {
  const cfg = cfgOf(c);
  const change = ((hook && hook.history_items) || []).find((h) => h.field === 'status');
  const after = change && change.after;
  const status = String((after && after.status) || (task.status && task.status.status) || '').toLowerCase();
  const closed = (after && after.type === 'closed') || cfg.doneStatuses.includes(status);
  if (!closed) return null;
  const ref = parseRef(task.name);
  if (!ref) return null;
  const text = `ClickUp task "${task.name.replace(/\s*\[.*\]$/, '')}" was marked ${status || 'done'}: ${task.url}`;
  if (ref.source === 'zendesk') return { source: 'zendesk', id: ref.id, body: { ticket: { comment: { body: text, public: false } } } };
  return { source: 'intercom', id: ref.id, body: intercomNote(cfg, text) };
}

// @export
if (typeof module !== 'undefined') module.exports = { DEFAULTS, parseRef, dueDate, taskFromZendesk, newIntercomConversations, rememberSeen, taskFromIntercom, intercomSearch, linkBack, closeNote };
