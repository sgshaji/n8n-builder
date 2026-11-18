// Pretend RBIS: a small stand-in for the real council tax system, for local
// development and tests only. It holds made-up accounts, answers the questions
// the HARSLL Performer asks, accepts the changes it makes, and records every
// change so tests can check exactly what was done.
//
// Plain Node.js, no packages. See mock-rbis/README.md for the endpoints.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Names and addresses match ignoring capitals, punctuation and extra spaces.
export function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function createMockRbis({ accountsFile }) {
  let state;

  function load() {
    const raw = JSON.parse(readFileSync(accountsFile, "utf8"));
    state = {
      accounts: new Map(raw.accounts.map((a) => [a.ref, withDefaults(a)])),
      changes: [],
      seq: 0,
      outage: null,
    };
  }

  function withDefaults(account) {
    return structuredClone({
      isFlat: false,
      canTerminate: true,
      refuseParties: [],
      liabilities: [],
      details: [],
      contacts: [],
      forwardingAddress: null,
      ...account,
    });
  }

  const current = (account) => account.liabilities.filter((l) => l.end === null);

  // What a caller sees. Test-only switches (canTerminate, refuseParties, note) are left out.
  function view(account) {
    return {
      ref: account.ref,
      address: account.address,
      postcode: account.postcode,
      isFlat: account.isFlat,
      current: current(account).map(({ party, type, start }) => ({ party, type, start })),
      liabilities: account.liabilities,
      details: account.details,
      contacts: account.contacts,
      forwardingAddress: account.forwardingAddress,
    };
  }

  function record(ref, operation, detail) {
    const entry = { seq: ++state.seq, at: new Date().toISOString(), ref, operation, ...detail };
    state.changes.push(entry);
    return entry;
  }

  const ok = (body, status = 200) => ({ status, body });
  const fail = (status, error, message) => ({ status, body: { error, message } });

  // ---- Operations. Each returns { status, body }. ----

  const operations = {
    getAccount(account) {
      return ok(view(account));
    },

    terminationOptions(account) {
      const hasCurrent = current(account).length > 0;
      return ok({
        ref: account.ref,
        canTerminate: account.canTerminate && hasCurrent,
        reason: !hasCurrent ? "NO_CURRENT_LIABILITY" : account.canTerminate ? null : "TERMINATION_NOT_ALLOWED",
      });
    },

    terminate(account, body) {
      if (!isIsoDate(body.endDate)) return fail(400, "INVALID_DATE", "endDate must be a real date, yyyy-MM-dd");
      const open = current(account);
      if (open.length === 0) return fail(409, "NO_CURRENT_LIABILITY", "Nobody is currently liable on this account");
      if (!account.canTerminate) return fail(409, "TERMINATION_NOT_ALLOWED", "This account does not offer the option to terminate");
      if (open.some((l) => l.start && body.endDate < l.start)) {
        return fail(422, "END_BEFORE_START", "endDate is before the start of the current liability");
      }
      for (const liability of open) liability.end = body.endDate;
      record(account.ref, "terminate", { endDate: body.endDate, ended: open.map((l) => l.party) });
      return ok(view(account));
    },

    addLiableParty(account, body) {
      if (typeof body.name !== "string" || !body.name.trim()) return fail(400, "INVALID_NAME", "name is required");
      if (!["tenant", "landlord"].includes(body.type)) return fail(400, "INVALID_TYPE", "type must be tenant or landlord");
      if (!isIsoDate(body.startDate)) return fail(400, "INVALID_DATE", "startDate must be a real date, yyyy-MM-dd");
      const name = normalise(body.name);
      if (account.refuseParties.some((p) => normalise(p) === name)) {
        return fail(422, "PARTY_REFUSED", "This person cannot be added to the account");
      }
      if (current(account).some((l) => normalise(l.party) === name)) {
        return fail(409, "ALREADY_LIABLE", "This party is already liable on the account");
      }
      account.liabilities.push({ party: body.name.trim(), type: body.type, start: body.startDate, end: null });
      record(account.ref, "addLiableParty", { name: body.name.trim(), type: body.type, startDate: body.startDate });
      return ok(view(account), 201);
    },

    createDetail(account, body) {
      if (!isIsoDate(body.startDate)) return fail(400, "INVALID_DATE", "startDate must be a real date, yyyy-MM-dd");
      if (!Array.isArray(body.tenants) || body.tenants.length === 0) return fail(400, "INVALID_TENANTS", "tenants must list at least one name");
      if (account.details.some((d) => d.startDate === body.startDate)) {
        return fail(409, "DETAIL_EXISTS", "A detail record already exists for this start date");
      }
      account.details.push({ startDate: body.startDate, tenants: body.tenants });
      record(account.ref, "createDetail", { startDate: body.startDate, tenants: body.tenants });
      return ok(view(account), 201);
    },

    setContact(account, body) {
      if (typeof body.name !== "string" || !body.name.trim()) return fail(400, "INVALID_NAME", "name is required");
      if (!body.email && !body.phone) return fail(400, "NO_CONTACT_DETAILS", "email or phone is required");
      const contact = { name: body.name.trim(), email: body.email || null, phone: body.phone || null };
      const index = account.contacts.findIndex((c) => normalise(c.name) === normalise(contact.name));
      if (index >= 0) account.contacts[index] = contact;
      else account.contacts.push(contact);
      record(account.ref, "setContact", contact);
      return ok(view(account));
    },

    setForwardingAddress(account, body) {
      if (typeof body.address !== "string" || !body.address.trim()) return fail(400, "INVALID_ADDRESS", "address is required");
      account.forwardingAddress = body.address.trim();
      record(account.ref, "setForwardingAddress", { address: account.forwardingAddress });
      return ok(view(account));
    },
  };

  const WRITES = new Set(["terminate", "addLiableParty", "createDetail", "setContact", "setForwardingAddress"]);

  // ---- Deliberate failures, for testing what HARSLL does when RBIS misbehaves. ----
  // mode "before":      answer 503 and change nothing.
  // mode "afterChange": make the change, then answer 503 (the reply is "lost").
  function outageFor(operation, ref) {
    const o = state.outage;
    if (!o) return null;
    if (o.ref && o.ref !== ref) return null;
    if (o.operations && !o.operations.includes(operation)) return null;
    if (!WRITES.has(operation) && !o.includeReads) return null;
    if (o.skip > 0) {
      o.skip -= 1;
      return null;
    }
    if (o.count !== null) {
      if (o.count <= 0) return null;
      o.count -= 1;
    }
    return o.mode;
  }

  function runOperation(operation, ref, body) {
    const account = state.accounts.get(ref);
    if (!account) return fail(404, "ACCOUNT_NOT_FOUND", `No account with reference ${ref}`);
    const outage = outageFor(operation, ref);
    const unavailable = fail(503, "RBIS_UNAVAILABLE", "Simulated outage");
    if (outage === "before" || (outage === "afterChange" && !WRITES.has(operation))) return unavailable;
    const result = operations[operation](account, body);
    if (outage === "afterChange") {
      const last = state.changes.at(-1);
      if (result.status < 400 && last) last.replyLost = true;
      return unavailable;
    }
    return result;
  }

  function setOutage(body) {
    if (!body || body.mode === "off" || body.mode === undefined) {
      state.outage = null;
      return ok({ outage: null });
    }
    if (!["before", "afterChange"].includes(body.mode)) return fail(400, "INVALID_MODE", "mode must be off, before or afterChange");
    if (body.operations && (!Array.isArray(body.operations) || body.operations.some((op) => !(op in operations)))) {
      return fail(400, "INVALID_OPERATIONS", `operations must be a list from: ${Object.keys(operations).join(", ")}`);
    }
    state.outage = {
      mode: body.mode,
      operations: body.operations || null,
      ref: body.ref || null,
      skip: Number.isInteger(body.skip) ? body.skip : 0,
      count: Number.isInteger(body.count) ? body.count : null,
      includeReads: body.includeReads === true,
    };
    return ok({ outage: state.outage });
  }

  // ---- HTTP routing ----

  function route(method, path, query, body) {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);

    if (method === "GET" && path === "/health") return ok({ status: "ok", accounts: state.accounts.size });
    if (method === "GET" && path === "/changes") return ok(state.changes);
    if (method === "POST" && path === "/reset") {
      load();
      return ok({ reset: true, accounts: state.accounts.size });
    }
    if (method === "POST" && path === "/simulate-outage") return setOutage(body);

    // Test-only: add, replace or remove an account while the service is running.
    if (parts[0] === "admin" && parts[1] === "accounts" && parts.length === 3) {
      if (method === "PUT") {
        if (!body.address || !body.postcode) return fail(400, "INVALID_ACCOUNT", "address and postcode are required");
        state.accounts.set(parts[2], withDefaults({ ...body, ref: parts[2] }));
        return ok(view(state.accounts.get(parts[2])));
      }
      if (method === "DELETE") return ok({ deleted: state.accounts.delete(parts[2]) });
    }

    if (parts[0] !== "accounts") return fail(404, "NOT_FOUND", "Unknown path");

    if (method === "GET" && parts.length === 1) {
      const address = normalise(query.get("address"));
      const postcode = normalise(query.get("postcode"));
      const outage = outageFor("getAccount", null);
      if (outage) return fail(503, "RBIS_UNAVAILABLE", "Simulated outage");
      const matches = [...state.accounts.values()].filter(
        (a) => (!address || normalise(a.address) === address) && (!postcode || normalise(a.postcode) === postcode),
      );
      return ok(matches.map(view));
    }

    const ref = parts[1];
    const action = parts[2];
    if (method === "GET" && parts.length === 2) return runOperation("getAccount", ref, {});
    if (method === "GET" && action === "termination-options") return runOperation("terminationOptions", ref, {});
    if (method === "POST" && action === "terminate") return runOperation("terminate", ref, body);
    if (method === "POST" && action === "liable-parties") return runOperation("addLiableParty", ref, body);
    if (method === "POST" && action === "details") return runOperation("createDetail", ref, body);
    if (method === "PUT" && action === "contact") return runOperation("setContact", ref, body);
    if (method === "PUT" && action === "forwarding-address") return runOperation("setForwardingAddress", ref, body);

    return fail(404, "NOT_FOUND", "Unknown path");
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) reject(new Error("Body too large"));
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  load();

  const server = createServer(async (req, res) => {
    let result;
    const url = new URL(req.url, "http://localhost");
    try {
      const text = await readBody(req);
      let body = {};
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          result = fail(400, "INVALID_JSON", "The request body is not valid JSON");
        }
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        result = fail(400, "INVALID_JSON", "The request body must be a JSON object");
      }
      result ??= route(req.method, url.pathname, url.searchParams, body);
    } catch (err) {
      result = fail(500, "INTERNAL_ERROR", err.message);
    }
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
    // The health check runs every few seconds; leave it out of the log.
    if (process.env.MOCK_RBIS_LOG !== "off" && url.pathname !== "/health") {
      console.log(`${req.method} ${url.pathname} -> ${result.status}`);
    }
  });

  return server;
}

// Start the service when this file is run directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  const accountsFile = process.env.ACCOUNTS_FILE || "/test-data/rbis-accounts.json";
  const server = createMockRbis({ accountsFile });
  server.listen(port, () => console.log(`Pretend RBIS listening on port ${port}, accounts from ${accountsFile}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
}
