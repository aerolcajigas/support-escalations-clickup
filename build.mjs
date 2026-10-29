// Generates the three workflows into workflows/*.json from src/core.js + config.json (or config.example.json).
//   node build.mjs [--deploy]   (--deploy needs env N8N_API_URL, N8N_API_KEY)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadCore, makeBuilder, deploy } from './lib/n8n.mjs';

const here = (p) => new URL(p, import.meta.url);
const cfg = JSON.parse(readFileSync(here(existsSync(here('config.json')) ? 'config.json' : 'config.example.json'), 'utf8'));
const { credentials: C, clickupListId, clickupTeamId, intercomTagId, intercomLookbackMinutes, webhookPath, ...logic } = cfg;
const b = makeBuilder({ core: loadCore(here('src/core.js')), config: logic });
const ZD = `https://${logic.zendeskSubdomain}.zendesk.com/api/v2`;
const CU = 'https://api.clickup.com/api/v2';
const IC = 'https://api.intercom.io';
const IC_HEADERS = { 'Intercom-Version': '2.11', Accept: 'application/json' };

const createTask = () => b.http('Create ClickUp Task', { credType: 'clickUpApi', cred: C.clickup, method: 'POST',
  url: `${CU}/list/${clickupListId}/task`, jsonBody: '={{ JSON.stringify($json.task) }}' });
const zendeskNote = (name) => b.http(name, { credType: 'zendeskApi', cred: C.zendesk, method: 'PUT',
  url: `=${ZD}/tickets/{{ $json.id }}.json`, jsonBody: '={{ JSON.stringify($json.body) }}' });
const intercomNote = (name) => b.http(name, { credType: 'intercomApi', cred: C.intercom, method: 'POST', headers: IC_HEADERS,
  url: `=${IC}/conversations/{{ $json.id }}/reply`, jsonBody: '={{ JSON.stringify($json.body) }}' });

// ---------- 1. Zendesk -> ClickUp ----------
const zendesk = b.workflow('Escalations / Zendesk to ClickUp', [
  b.webhook('Zendesk Webhook', webhookPath, C.webhookAuth),
  b.http('Get Ticket', { credType: 'zendeskApi', cred: C.zendesk, url: `=${ZD}/tickets/{{ $json.body.ticket_id }}.json?include=users` }),
  b.code('Prepare Task', `
const t = taskFromZendesk($input.first().json, new Date().toISOString(), CONFIG);
return t.skip ? [] : [{ json: t }];`),
  createTask(),
  b.code('Link Back', `
return [{ json: linkBack($('Prepare Task').first().json, $input.first().json, CONFIG) }];`),
  zendeskNote('Note on Ticket'),
], 'Zendesk ticket tagged "escalate" -> ClickUp task with SLA due date -> private note with the task link + "clickup_linked" tag.');

// ---------- 2. Intercom -> ClickUp ----------
const intercom = b.workflow('Escalations / Intercom to ClickUp', [
  b.schedule('Every 5 Minutes', { field: 'minutes', minutesInterval: 5 }),
  // Rolling lookback window; duplicates are filtered in "New Conversations".
  b.http('Search Escalated', { credType: 'intercomApi', cred: C.intercom, method: 'POST', headers: IC_HEADERS, url: `${IC}/conversations/search`,
    jsonBody: `={{ JSON.stringify({ query: { operator: 'AND', value: [{ field: 'tag_ids', operator: 'IN', value: [${JSON.stringify(String(intercomTagId))}] }, { field: 'updated_at', operator: '>', value: Math.floor(Date.now() / 1000) - ${Number(intercomLookbackMinutes) || 60} * 60 }] }, pagination: { per_page: 50 } }) }}` }),
  b.code('New Conversations', `
const seen = $getWorkflowStaticData('global').seen;
const now = new Date().toISOString();
return newIntercomConversations($input.first().json, seen).map((conv) => ({ json: taskFromIntercom(conv, now, CONFIG) }));`),
  createTask(),
  b.code('Link Back', `
const items = $('New Conversations').all().map((i) => i.json);
const out = $input.all().map((t, i) => linkBack(items[i], t.json, CONFIG));
const store = $getWorkflowStaticData('global');
store.seen = rememberSeen(store.seen, out.map((o) => o.id), new Date().toISOString(), CONFIG);
return out.map((json) => ({ json }));`),
  intercomNote('Note on Conversation'),
], 'Every 5 min: Intercom conversations with the escalation tag -> ClickUp task (once each) -> internal note with the task link.');

// ---------- 3. ClickUp closed -> note on the source ----------
const close = b.workflow('Escalations / ClickUp Closed to Source', [
  b.node('ClickUp Trigger', 'n8n-nodes-base.clickUpTrigger', 1, { authentication: 'accessToken', team: String(clickupTeamId), events: ['taskStatusUpdated'], filters: { listId: String(clickupListId) } },
    { webhookId: randomUUID(), credentials: { clickUpApi: C.clickup } }),
  b.http('Get Task', { credType: 'clickUpApi', cred: C.clickup, url: `=${CU}/task/{{ $json.task_id }}` }),
  b.code('Build Note', `
const note = closeNote($('ClickUp Trigger').first().json, $input.first().json, CONFIG);
return note ? [{ json: note }] : [];`),
  b.node('Zendesk or Intercom?', 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'is-zendesk', leftValue: '={{ $json.source }}', rightValue: 'zendesk', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' },
    options: {} }),
  zendeskNote('Note on Ticket'),
  intercomNote('Note on Conversation'),
], 'ClickUp task closed -> internal note on the Zendesk ticket or Intercom conversation it came from (found via the [source#id] in the task name).',
[['ClickUp Trigger', 'Get Task'], ['Get Task', 'Build Note'], ['Build Note', 'Zendesk or Intercom?'], ['Zendesk or Intercom?', 'Note on Ticket', 0], ['Zendesk or Intercom?', 'Note on Conversation', 1]]);

const all = { 'zendesk-to-clickup': zendesk, 'intercom-to-clickup': intercom, 'clickup-closed-to-source': close };
mkdirSync(here('workflows/'), { recursive: true });
for (const [f, w] of Object.entries(all)) writeFileSync(here(`workflows/${f}.json`), JSON.stringify(w, null, 2) + '\n');
console.log(`wrote ${Object.keys(all).length} workflows to workflows/`);
if (process.argv.includes('--deploy')) await deploy(Object.values(all));
