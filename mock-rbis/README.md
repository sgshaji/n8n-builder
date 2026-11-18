# Pretend RBIS

A small stand-in for the real RBIS (the council tax system), used to build and test the HARSLL workflows. **It is not RBIS and holds no real data.** It exists because the real RBIS is not available yet, and nobody has confirmed how it can be reached.

It is one file of plain Node.js, [`server.mjs`](server.mjs), with no extra packages.

| | |
| --- | --- |
| From your machine | http://localhost:8088 |
| From n8n workflows | `http://mock-rbis:8080` |
| Accounts it loads | [`test-data/rbis-accounts.json`](../test-data/rbis-accounts.json), made-up |
| Starts with | `docker compose up -d` (it is part of the local stack) |

## What it models

Each account has an address and a **history of liabilities**: who was liable, whether they are the landlord or a tenant, from when, and to when. Whoever has no end date is liable now.

This follows the design's key assumption: **the landlord is liable while a property is empty**. A move-in ends the landlord's liability and starts the tenant's; a move-out does the reverse. If the real RBIS works differently, this service and the RBIS adapter workflow change; the rest of HARSLL does not.

## Endpoints

### What HARSLL uses

| Method and path | What it does | Fails with |
| --- | --- | --- |
| `GET /accounts/{ref}` | The account: address, who is liable now, history, details, contacts, forwarding address | `404 ACCOUNT_NOT_FOUND` |
| `GET /accounts?address=&postcode=` | Search by address and postcode, ignoring capitals and punctuation | |
| `GET /accounts/{ref}/termination-options` | Whether the current liability can be ended | `404` |
| `POST /accounts/{ref}/terminate` | End every current liability. Body: `{"endDate": "2026-10-31"}` | `409 NO_CURRENT_LIABILITY`, `409 TERMINATION_NOT_ALLOWED`, `422 END_BEFORE_START` |
| `POST /accounts/{ref}/liable-parties` | Make someone liable. Body: `{"name", "type": "tenant" or "landlord", "startDate"}` | `409 ALREADY_LIABLE`, `422 PARTY_REFUSED` |
| `POST /accounts/{ref}/details` | Create the detail record for a tenancy. Body: `{"startDate", "tenants": [...]}` | `409 DETAIL_EXISTS` |
| `PUT /accounts/{ref}/contact` | Save a person's contact details. Body: `{"name", "email", "phone"}` | |
| `PUT /accounts/{ref}/forwarding-address` | Save the leaver's new address. Body: `{"address"}` | |

Dates are `yyyy-MM-dd`. A badly formed request gets `400`.

The service itself does **not** make repeated calls safe: a second `terminate` is an error, as it would be in a real system. Making writes safe to repeat is the job of the RBIS adapter workflow, which looks before it acts.

### For tests only

| Method and path | What it does |
| --- | --- |
| `GET /health` | `{"status": "ok", "accounts": 31}` |
| `GET /changes` | Every change made since the last reset, in order. Tests compare this with what they expected |
| `POST /reset` | Reload the accounts from the file, clear the change log, and switch off any outage |
| `POST /simulate-outage` | Make calls fail on purpose (below) |
| `PUT /admin/accounts/{ref}` | Add or replace an account while running. Body: an account as in the accounts file |
| `DELETE /admin/accounts/{ref}` | Remove an account while running |

### Simulating an outage

`POST /simulate-outage` with a body such as:

```json
{ "mode": "before", "ref": "AC100024", "operations": ["addLiableParty"], "skip": 0, "count": 1 }
```

| Field | Meaning |
| --- | --- |
| `mode` | `before`: answer 503 and change nothing. `afterChange`: **make the change, then answer 503**, as if the reply were lost. `off`: stop |
| `ref` | Only this account. Leave out for all accounts |
| `operations` | Only these: `terminate`, `addLiableParty`, `createDetail`, `setContact`, `setForwardingAddress`, `getAccount`, `terminationOptions`. Leave out for all |
| `skip` | Let this many matching calls through first |
| `count` | Fail this many calls, then recover. Leave out to keep failing |
| `includeReads` | `true` to fail read calls too. By default only changes fail |

## Checks

The service has its own checks, separate from the HARSLL tests:

```bash
node --test mock-rbis/
```

or, inside the container, which uses the same Node.js version as the running service:

```bash
docker compose exec mock-rbis node --test
```

## Changing it

- **Accounts:** edit `test-data/rbis-accounts.json`, then `curl -X POST http://localhost:8088/reset`.
- **Behaviour:** edit `server.mjs`, run the checks, then `docker compose restart mock-rbis`.
