# Support Escalations to ClickUp

Support finds a bug, a billing problem or anything another team has to fix. Today that means copy-pasting into
ClickUp and remembering to tell the customer when it's done. These three n8n workflows close that loop:

| Workflow | Trigger | Does |
|---|---|---|
| **Zendesk to ClickUp** | Zendesk trigger: tag `escalate` added | Creates a ClickUp task (subject, customer, priority, ticket link, first message) with an SLA due date, then puts a private note with the task link on the ticket and tags it `clickup_linked`. |
| **Intercom to ClickUp** | Every 5 minutes | Finds Intercom conversations with the escalation tag (Search API) and does the same, with an internal note on the conversation. |
| **ClickUp Closed to Source** | ClickUp task status changed | When the task is closed, posts an internal note on the Zendesk ticket or Intercom conversation it came from, so the agent can tell the customer. |

```
Zendesk ticket ─┐                                   ┌─> note on the ticket
                ├─> ClickUp task "[zendesk#77]" ──...── task closed ──┤
Intercom conv. ─┘   (priority + SLA due date)       └─> note on the conversation
```

## Design

- **No database.** The task name ends with its source, e.g. `Charged twice for order #1042 [zendesk#77]`, so the
  close-the-loop workflow finds its way back from the task alone.
- **No duplicate tasks.** Zendesk: the `clickup_linked` tag (the Zendesk trigger excludes it, and the code checks it).
  Intercom: conversation ids are kept in workflow static data, and only *after* the task was created, so a failed
  ClickUp call is retried on the next run instead of being lost.
- **SLA due dates** by priority (urgent 4 h, high 24 h, normal 72 h, low 7 days), configurable. Zendesk priority maps
  straight across. An Intercom conversation marked priority counts as high.
- Logic lives in `src/core.js` and is pasted into the n8n Code nodes by `build.mjs`; the tests run the same code.

## Set up

1. **n8n credentials:** Zendesk API, Intercom API (access token), ClickUp API (personal token), Header Auth (for the
   Zendesk webhook).
2. `cp config.example.json config.json`: Zendesk subdomain, Intercom app id, admin id (notes are posted as this
   admin) and the escalation tag's id, ClickUp team and list ids, credential ids.
3. `npm run build`, then import `workflows/*.json` or `npm run deploy` (env `N8N_API_URL`, `N8N_API_KEY`). Activate.
4. **Zendesk:** a webhook to the n8n URL (API key auth, same header as the Header Auth credential) and a trigger:
   *Tags contain `escalate`* and *Tags do not contain `clickup_linked`* > notify the webhook with
   `{ "ticket_id": "{{ticket.id}}" }`.

```
npm test   # builds the workflows, then 10 tests: task building, SLA, de-dupe, link-back, closing, Code nodes with mocked n8n
```

Tested with sample payloads and n8n's workflow validator, not against live accounts. Built with n8n, the Zendesk,
Intercom (API 2.11) and ClickUp v2 APIs.
