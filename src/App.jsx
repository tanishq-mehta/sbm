import { useEffect, useMemo, useState } from "react";

const TOKEN_KEY = "sbm-user-manager-token";

const sections = [
  {
    title: "Identity",
    fields: [
      "Badge no.",
      "First Name",
      "Middle Name",
      "Last Name",
      "Verification Status",
      "Gender",
      "Birth Date",
      "Aadhaar No",
      "Marital Status",
    ],
  },
  {
    title: "Contact",
    fields: [
      "Mobile No",
      "Emergency Contact No",
      "Email Id",
      "Satsang Centre",
      "Address Line 1",
      "Address Line 2",
      "New Address",
      "State",
      "District",
      "City",
      "Pin Code",
    ],
  },
  {
    title: "Family & Personal",
    fields: [
      "Birth Date",
      "Father Name",
      "Spouse Name",
      "Educational Qualification",
      "Profession",
      "Designation",
      "Blood Group",
    ],
  },
  {
    title: "Seva Details",
    fields: [
      "Sewa Dept - Local Centre",
      "Sewa Dept - Major Centre",
      "Skills - 1",
      "Skills - 2",
      "Initiation Date",
      "Initiation_By",
      "INITIATION_PLACE",
      "Jatha Remarks",
      "Photo File Name",
    ],
  },
];

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) window.location.hash = "#/home";
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function handleLogin(nextToken) {
    localStorage.setItem(TOKEN_KEY, nextToken);
    setToken(nextToken);
    window.location.hash = "#/home";
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
  }

  if (!token) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <Shell onLogout={handleLogout}>
      {route.name === "audit" ? (
        <AuditPage token={token} />
      ) : route.name === "summary" ? (
        <SummaryPage token={token} />
      ) : route.name === "person" ? (
        <PersonPage id={route.id} token={token} />
      ) : (
        <HomePage token={token} />
      )}
    </Shell>
  );
}

function LoginPage({ onLogin }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || "Login failed.");
      onLogin(payload.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark">SBM</span>
          <div>
            <p className="eyebrow">User records</p>
            <h1 id="login-title">Sign in</h1>
          </div>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Shell({ children, onLogout }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand-button" onClick={() => (window.location.hash = "#/home")}>
          <span className="brand-mark small">SBM</span>
          <span>User Manager</span>
        </button>
        <div className="topbar-actions">
          <button className="secondary-button compact" onClick={() => (window.location.hash = "#/summary")}>
            Summary
          </button>
          <button className="secondary-button compact" onClick={() => (window.location.hash = "#/audit")}>
            Audit history
          </button>
          <button className="secondary-button compact" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

function HomePage({ token }) {
  const [fields, setFields] = useState([]);
  const [searchableFields, setSearchableFields] = useState(["All fields"]);
  const [query, setQuery] = useState("");
  const [field, setField] = useState("All fields");
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    apiFetch("/api/fields", { token })
      .then((payload) => {
        setFields(payload.fields || []);
        setSearchableFields(payload.searchableFields || ["All fields", ...(payload.fields || [])]);
      })
      .catch((err) => setError(err.message));
  }, [token]);

  async function search(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setSearched(true);
    try {
      const params = new URLSearchParams({ q: query, field, limit: "200" });
      const payload = await apiFetch(`/api/people?${params.toString()}`, { token });
      setResults(payload.results || []);
      setTotal(payload.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function downloadExcel() {
    setDownloading(true);
    setError("");
    try {
      const response = await fetch("/api/export/people.xlsx", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.message || "Download failed.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFromDisposition(response.headers.get("Content-Disposition"));
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main className="page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Search directory</p>
          <h1>Find and update user data</h1>
        </div>
        <div className="page-actions">
          <button className="secondary-button" onClick={() => (window.location.hash = "#/summary")}>
            Summary
          </button>
          <button className="secondary-button" onClick={() => (window.location.hash = "#/audit")}>
            Audit history
          </button>
          <button className="primary-button" onClick={downloadExcel} disabled={downloading}>
            {downloading ? "Preparing..." : "Download latest Excel"}
          </button>
          <p className="record-count">{fields.length} fields available</p>
        </div>
      </section>

      <form className="search-bar" onSubmit={search}>
        <label>
          <span>Search text</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, phone, badge no., department..."
          />
        </label>
        <label>
          <span>Search in</span>
          <select value={field} onChange={(event) => setField(event.target.value)}>
            {searchableFields.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary-button" disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {error ? <p className="form-error wide">{error}</p> : null}

      <section className="results-panel" aria-live="polite">
        <div className="results-header">
          <h2>Results</h2>
          {searched ? <span>{total} match{total === 1 ? "" : "es"}</span> : null}
        </div>
        {!searched ? (
          <p className="empty-state">Enter a value and search across all fields or one selected field.</p>
        ) : results.length === 0 ? (
          <p className="empty-state">No matching records found.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Badge number</th>
                  <th>Department</th>
                  <th>Phone number</th>
                </tr>
              </thead>
              <tbody>
                {results.map((person) => (
                  <tr
                    key={person.id}
                    tabIndex={0}
                    onClick={() => (window.location.hash = `#/people/${person.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") window.location.hash = `#/people/${person.id}`;
                    }}
                  >
                    <td>
                      <strong>{person.name}</strong>
                    </td>
                    <td>{person.badgeNo || "-"}</td>
                    <td>{person.department || "-"}</td>
                    <td>{person.phoneNumber || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > results.length ? (
          <p className="result-note">Showing first {results.length} records. Narrow the search to see fewer matches.</p>
        ) : null}
      </section>
    </main>
  );
}

function AuditPage({ token }) {
  const [audits, setAudits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    apiFetch("/api/audits?limit=1000", { token })
      .then((payload) => {
        if (!cancelled) setAudits(payload.results || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="page audit-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Audit history</p>
          <h1>Saved form changes</h1>
        </div>
        <button className="secondary-button" onClick={() => (window.location.hash = "#/home")}>
          Back to search
        </button>
      </section>

      {error ? <p className="form-error wide">{error}</p> : null}
      {loading ? <p className="empty-state">Loading audit history...</p> : null}

      {!loading && !audits.length ? (
        <section className="results-panel">
          <p className="empty-state">No audited changes yet.</p>
        </section>
      ) : null}

      {!loading && audits.length ? (
        <section className="audit-list">
          {audits.map((entry) => (
            <article className="audit-entry" key={entry.id}>
              <header className="audit-entry-header">
                <div>
                  <h2>{entry.name || "Unnamed user"}</h2>
                  <p>
                    Badge {entry.badgeNo || "-"} · Record #{entry.personId} · Changes done by:{" "}
                    {entry.changedBy || "system"}
                  </p>
                </div>
                <time>{formatDateTime(entry.createdAt)}</time>
              </header>
              <div className="audit-change-list">
                {Object.entries(entry.change || {}).map(([field, values]) => (
                  <div className="audit-change" key={field}>
                    <strong>{field}</strong>
                    <div>
                      <span>{displayAuditValue(values.old)}</span>
                      <em>-&gt;</em>
                      <span>{displayAuditValue(values.new)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </main>
  );
}

function SummaryPage({ token }) {
  const [department, setDepartment] = useState("");
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (department) params.set("department", department);
    apiFetch(`/api/summary?${params.toString()}`, { token })
      .then((payload) => {
        if (!cancelled) setSummary(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [department, token]);

  const rows = summary ? statusRows(summary.counts) : [];

  return (
    <main className="page summary-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Verification summary</p>
          <h1>Verification status</h1>
        </div>
        <button className="secondary-button" onClick={() => (window.location.hash = "#/home")}>
          Back to search
        </button>
      </section>

      <section className="summary-toolbar">
        <label>
          <span>Department</span>
          <select value={department} onChange={(event) => setDepartment(event.target.value)}>
            <option value="">All departments</option>
            {(summary?.departments || []).map((option) => (
              <option key={option.department || "__blank"} value={option.department}>
                {option.label} ({option.total})
              </option>
            ))}
          </select>
        </label>
        <div className="summary-total">
          <span>Total people</span>
          <strong>{summary?.total ?? "-"}</strong>
        </div>
      </section>

      {error ? <p className="form-error wide">{error}</p> : null}
      {loading ? <p className="empty-state">Loading summary...</p> : null}

      {summary && !loading ? (
        <>
          <section className="summary-grid">
            {rows.map((row) => (
              <div className="status-card" key={row.key}>
                <span className={`status-dot ${row.key}`} />
                <p>{row.label}</p>
                <strong>{row.value}</strong>
              </div>
            ))}
          </section>

          <section className="chart-panel">
            <div className="results-header">
              <h2>Status chart</h2>
              <span>{department ? "Filtered by department" : "All departments"}</span>
            </div>
            <div className="bar-chart">
              {rows.map((row) => (
                <div className="bar-row" key={row.key}>
                  <span>{row.label}</span>
                  <div className="bar-track">
                    <div
                      className={`bar-fill ${row.key}`}
                      style={{ width: `${barPercent(row.value, rows)}%` }}
                    />
                  </div>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="results-panel">
            <div className="results-header">
              <h2>Department breakdown</h2>
              <span>{summary.byDepartment.length} departments</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Department</th>
                    <th>Total</th>
                    <th>Attended</th>
                    <th>Rectified</th>
                    <th>Not Attended</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byDepartment.map((row) => (
                    <tr key={row.department || "__blank_department"}>
                      <td><strong>{row.label}</strong></td>
                      <td>{row.total}</td>
                      <td>{row.counts.attended}</td>
                      <td>{row.counts.rectified}</td>
                      <td>{row.counts.notAttended}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

function PersonPage({ id, token }) {
  const [person, setPerson] = useState(null);
  const [fields, setFields] = useState([]);
  const [dropdownOptions, setDropdownOptions] = useState({});
  const [formData, setFormData] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch("/api/fields", { token }),
      apiFetch(`/api/people/${id}`, { token }),
    ])
      .then(([fieldPayload, personPayload]) => {
        if (cancelled) return;
        setFields(fieldPayload.fields || []);
        setDropdownOptions(fieldPayload.dropdownOptions || {});
        setPerson(personPayload);
        setFormData(personPayload.data || {});
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, token]);

  const groupedSections = useMemo(() => buildSections(fields), [fields]);

  function updateField(field, value) {
    setFormData((current) => ({ ...current, [field]: value }));
  }

  async function save(event) {
    event.preventDefault();
    setNotice("");
    setError("");
    const displayName = displayFullName(formData) || person?.fullName || "this person";
    if (!window.confirm(`Save changes for ${displayName}?`)) return;

    setSaving(true);
    try {
      const updated = await apiFetch(`/api/people/${id}`, {
        method: "PUT",
        token,
        body: JSON.stringify({ data: formData }),
      });
      setPerson(updated);
      setFormData(updated.data || {});
      window.location.hash = "#/home";
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="page">
        <p className="empty-state">Loading record...</p>
      </main>
    );
  }

  if (error && !person) {
    return (
      <main className="page">
        <button className="secondary-button" onClick={() => (window.location.hash = "#/home")}>
          Back to search
        </button>
        <p className="form-error wide">{error}</p>
      </main>
    );
  }

  return (
    <main className="page detail-page">
      <section className="record-header">
        <button className="secondary-button compact" onClick={() => (window.location.hash = "#/home")}>
          Back
        </button>
        <div>
          <p className="eyebrow">Directory record</p>
          <h1>{displayFullName(formData) || "User record"}</h1>
          <p>
            Badge {formData["Badge no."] || "-"} · Department{" "}
            {formData["Sewa Dept - Local Centre"] || formData["Sewa Dept - Major Centre"] || "-"}
          </p>
        </div>
      </section>

      <form onSubmit={save} className="record-form">
        {groupedSections.map((section) => (
          <fieldset key={section.title}>
            <legend>{section.title}</legend>
            <div className="field-grid">
              {section.fields.map((field) => (
                <FieldControl
                  key={field}
                  field={field}
                  value={formData[field] || ""}
                  options={dropdownOptions[field] || []}
                  onChange={(value) => updateField(field, value)}
                />
              ))}
            </div>
          </fieldset>
        ))}

        {error ? <p className="form-error wide">{error}</p> : null}
        {notice ? <p className="form-success">{notice}</p> : null}

        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={() => (window.location.hash = "#/home")}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </form>
    </main>
  );
}

function FieldControl({ field, value, options = [], onChange }) {
  const multiline = [
    "Address Line 1",
    "Address Line 2",
    "New Address",
    "Jatha Remarks",
  ].includes(field);
  const type = inputType(field, value);
  const selectOptions = useMemo(() => {
    if (!options.length) return [];
    return [...new Set(options.filter(Boolean))];
  }, [options, value]);

  return (
    <label className={multiline ? "span-2" : ""}>
      <span>{field}</span>
      {selectOptions.length ? (
        <div className="combo-field">
          <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
          <select value={selectOptions.includes(value) ? value : ""} onChange={(event) => onChange(event.target.value)}>
            <option value="">Select</option>
            {selectOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      ) : multiline ? (
        <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} />
      ) : (
        <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

async function apiFetch(path, { token, method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, { method, headers, body });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "Request failed.");
  return payload;
}

function readRoute() {
  const hash = window.location.hash || "#/home";
  const personMatch = hash.match(/^#\/people\/(\d+)$/);
  if (personMatch) return { name: "person", id: personMatch[1] };
  if (hash === "#/audit") return { name: "audit" };
  if (hash === "#/summary") return { name: "summary" };
  return { name: "home" };
}

function buildSections(fields) {
  const used = new Set();
  const result = sections.map((section) => {
    const present = section.fields.filter((field) => fields.includes(field) && !used.has(field));
    present.forEach((field) => used.add(field));
    return { ...section, fields: present };
  }).filter((section) => section.fields.length > 0);

  const remaining = fields.filter((field) => !used.has(field));
  if (remaining.length) result.push({ title: "Other", fields: remaining });
  return result;
}

function inputType(field, value) {
  if (/email/i.test(field)) return "email";
  if (/mobile|phone|contact|aadhaar|pin code/i.test(field)) return "tel";
  if (field === "Birth Date" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  return "text";
}

function displayFullName(data) {
  return [data["First Name"], data["Middle Name"], data["Last Name"]]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function filenameFromDisposition(disposition) {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1] || "sbm-users.xlsx";
}

function statusRows(counts = {}) {
  return [
    { key: "attended", label: "Attended", value: counts.attended || 0 },
    { key: "rectified", label: "Rectified", value: counts.rectified || 0 },
    { key: "notAttended", label: "Not Attended", value: counts.notAttended || 0 },
  ];
}

function barPercent(value, rows) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return Math.max(2, (value / max) * 100);
}

function displayAuditValue(value) {
  return value === "" || value === null || value === undefined ? "(blank)" : String(value);
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
