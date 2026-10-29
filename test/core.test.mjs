import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, wf, node, run, checkWiring } from './harness.mjs';

const c = core();
const NOW = '2026-10-30T12:00:00.000Z';
const CFG = { intercomAdminId: '42', zendeskSubdomain: 'acme', intercomAppId: 'abc123' };
const zd = (over = {}) => ({
  ticket: { id: 77, subject: 'Charged twice for order #1042', description: 'I see two charges on my card.', priority: 'high', requester_id: 5, tags: ['billing', 'escalate'], ...over },
  users: [{ id: 5, name: 'Sam Lee', email: 'sam@example.com' }],
});
const conv = (id, over = {}) => ({ id: String(id), priority: 'not_priority',
  source: { subject: '', body: '<p>The app <b>crashes</b> when I pay&nbsp;with PayPal.</p>', author: { name: 'Ana', email: 'ana@example.com' } }, ...over });

test('Zendesk ticket -> ClickUp task with priority, SLA due date and a source ref', () => {
  const t = c.taskFromZendesk(zd(), NOW, CFG);
  assert.equal(t.source, 'zendesk');
  assert.equal(t.task.name, 'Charged twice for order #1042 [zendesk#77]');
  assert.equal(t.task.priority, 2);
  assert.equal(t.task.due_date, Date.parse(NOW) + 24 * 3600000);
  assert.match(t.task.markdown_description, /\[ticket #77\]\(https:\/\/acme\.zendesk\.com\/agent\/tickets\/77\)/);
  assert.match(t.task.markdown_description, /Sam Lee <sam@example\.com>/);
});

test('Zendesk: missing priority = normal (72h), already-linked ticket is skipped', () => {
  const t = c.taskFromZendesk(zd({ priority: null }), NOW, CFG);
  assert.equal(t.task.priority, 3);
  assert.equal(t.task.due_date, Date.parse(NOW) + 72 * 3600000);
  assert.deepEqual(c.taskFromZendesk(zd({ tags: ['clickup_linked'] }), NOW, CFG), { skip: 'already linked' });
});

test('SLA hours are configurable', () => {
  assert.equal(c.dueDate('urgent', NOW, { slaHours: { urgent: 1 } }), Date.parse(NOW) + 3600000);
  assert.equal(c.dueDate('nonsense', NOW), Date.parse(NOW) + 72 * 3600000);
});

test('Intercom conversation -> task, HTML stripped, priority flag respected', () => {
  const t = c.taskFromIntercom(conv(900, { priority: 'priority' }), NOW, CFG);
  assert.equal(t.task.name, 'The app crashes when I pay with PayPal. [intercom#900]');
  assert.equal(t.task.priority, 2);
  assert.match(t.task.markdown_description, /app\.intercom\.com\/a\/inbox\/abc123\/inbox\/conversation\/900/);
});

test('Intercom de-dupe: only unseen conversations, remembered only after linking, capped', () => {
  const res = { conversations: [conv(1), conv(2), conv(3)] };
  assert.deepEqual(c.newIntercomConversations(res, { 2: NOW }).map((x) => x.id), ['1', '3']);
  const seen = c.rememberSeen({ a: '2026-01-01T00:00:00Z', b: '2026-02-01T00:00:00Z' }, ['1', '3'], NOW, { maxSeen: 3 });
  assert.deepEqual(Object.keys(seen).sort(), ['1', '3', 'b']);
});

test('search body uses the tag and the lookback window', () => {
  const q = c.intercomSearch('555', 1700000000);
  assert.deepEqual(q.query.value[0], { field: 'tag_ids', operator: 'IN', value: ['555'] });
  assert.equal(q.query.value[1].value, 1700000000);
});

test('link back: Zendesk gets a private note + linked tag, Intercom an admin note', () => {
  const task = { id: 'abc', url: 'https://app.clickup.com/t/abc', due_date: String(Date.parse(NOW)) };
  const z = c.linkBack({ source: 'zendesk', sourceId: '77' }, task, CFG);
  assert.deepEqual(z.body.ticket.additional_tags, ['clickup_linked']);
  assert.equal(z.body.ticket.comment.public, false);
  assert.match(z.body.ticket.comment.body, /app\.clickup\.com\/t\/abc \(due 2026-10-30 12:00 UTC\)/);
  const i = c.linkBack({ source: 'intercom', sourceId: '900' }, task, CFG);
  assert.equal(i.body.admin_id, '42');
  assert.equal(i.body.message_type, 'note');
  assert.throws(() => c.linkBack({ source: 'zendesk', sourceId: '1' }, {}, CFG), /did not return a task/);
});

test('closing the task notes the source; other status changes do nothing', () => {
  const task = { id: 'abc', url: 'https://app.clickup.com/t/abc', name: 'Charged twice [zendesk#77]', status: { status: 'complete' } };
  const hook = (after) => ({ event: 'taskStatusUpdated', task_id: 'abc', history_items: [{ field: 'status', after }] });
  const n = c.closeNote(hook({ status: 'complete', type: 'closed' }), task, CFG);
  assert.equal(n.source, 'zendesk');
  assert.equal(n.id, '77');
  assert.match(n.body.ticket.comment.body, /"Charged twice" was marked complete/);
  assert.equal(c.closeNote(hook({ status: 'in progress', type: 'custom' }), { ...task, status: { status: 'in progress' } }, CFG), null);
  assert.equal(c.closeNote(hook({ status: 'done', type: 'custom' }), { ...task, name: 'Internal task, no ref' }, CFG), null);
  const ic = c.closeNote(hook({ status: 'done', type: 'custom' }), { ...task, name: 'Crash <PayPal> [intercom#900]' }, CFG);
  assert.equal(ic.source, 'intercom');
  assert.match(ic.body.body, /Crash &lt;PayPal>/);
});

test('parseRef only reads a ref at the end of the name', () => {
  assert.deepEqual(c.parseRef('Refund [zendesk#12]'), { source: 'zendesk', id: '12' });
  assert.equal(c.parseRef('[zendesk#12] moved to front'), null);
});

test('workflows: wiring and Code nodes with mocked n8n', () => {
  for (const f of ['zendesk-to-clickup', 'intercom-to-clickup', 'clickup-closed-to-source']) checkWiring(wf(f));

  const z = wf('zendesk-to-clickup');
  const [prep] = run(node(z, 'Prepare Task'), [zd()]);
  assert.equal(prep.source, 'zendesk');
  assert.deepEqual(run(node(z, 'Prepare Task'), [zd({ tags: ['clickup_linked'] })]), []);
  const [link] = run(node(z, 'Link Back'), [{ id: 'abc', url: 'https://app.clickup.com/t/abc', due_date: String(Date.parse(NOW)) }], { nodes: { 'Prepare Task': [prep] } });
  assert.equal(link.id, '77');

  // Intercom: a conversation is only remembered after its task was created.
  const i = wf('intercom-to-clickup');
  const staticData = {};
  const res = { conversations: [conv(1), conv(2)] };
  const tasks = run(node(i, 'New Conversations'), [res], { staticData });
  assert.equal(tasks.length, 2);
  assert.equal(staticData.seen, undefined);
  const created = [{ id: 't1', url: 'u1', due_date: '0' }, { id: 't2', url: 'u2', due_date: '0' }];
  const notes = run(node(i, 'Link Back'), created, { nodes: { 'New Conversations': tasks }, staticData });
  assert.deepEqual(notes.map((n) => n.id), ['1', '2']);
  assert.deepEqual(Object.keys(staticData.seen), ['1', '2']);
  assert.equal(run(node(i, 'New Conversations'), [res], { staticData }).length, 0);

  const cl = wf('clickup-closed-to-source');
  const out = run(node(cl, 'Build Note'), [{ id: 'abc', url: 'u', name: 'X [intercom#9]', status: { status: 'done' } }],
    { nodes: { 'ClickUp Trigger': [{ history_items: [{ field: 'status', after: { status: 'done', type: 'closed' } }] }] } });
  assert.equal(out[0].source, 'intercom');
  const branch = cl.connections['Zendesk or Intercom?'].main;
  assert.equal(branch[0][0].node, 'Note on Ticket');
  assert.equal(branch[1][0].node, 'Note on Conversation');
});
