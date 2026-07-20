import { useEffect, useMemo, useState } from "react";

const TOKEN_KEY = "sbm-user-manager-token";
const dateFields = ["Birth Date", "Initiation Date"];
const addressLimitFields = ["Address Line 1", "Address Line 2"];

const sections = [
  {
    title: "Identity",
    fields: [
      "S No",
      "Badge no.",
      "First Name",
      "Middle Name",
      "Last Name",
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
  {
    title: "Verification",
    fields: [
      "Verification Status",
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
      ) : route.name === "new-person" ? (
        <PersonPage token={token} isNew />
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
          <button className="primary-button" onClick={() => (window.location.hash = "#/people/new")}>
            Create new user
          </button>
          <button className="secondary-button" onClick={() => (window.location.hash = "#/summary")}>
            Summary
          </button>
          <button className="secondary-button" onClick={() => (window.location.hash = "#/audit")}>
            Audit history
          </button>
          <button className="secondary-button" onClick={downloadExcel} disabled={downloading}>
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
  const [downloading, setDownloading] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
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

  async function reloadAudits() {
    const payload = await apiFetch("/api/audits?limit=1000", { token });
    setAudits(payload.results || []);
  }

  async function downloadAuditExcel() {
    setDownloading(true);
    setError("");
    try {
      const response = await fetch("/api/export/audits.xlsx", {
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
      link.download = filenameFromDisposition(
        response.headers.get("Content-Disposition"),
        "sbm-audit-history.xlsx"
      );
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

  async function restoreAuditEntry(entry) {
    const displayName = entry.name || "this deleted record";
    if (!window.confirm(`Restore ${displayName}?`)) return;

    setRestoringId(entry.id);
    setError("");
    try {
      await apiFetch(`/api/audits/${entry.id}/restore`, {
        method: "POST",
        token,
      });
      await reloadAudits();
    } catch (err) {
      setError(err.message);
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <main className="page audit-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Audit history</p>
          <h1>Saved form changes</h1>
        </div>
        <div className="page-actions">
          <button className="primary-button" onClick={downloadAuditExcel} disabled={downloading}>
            {downloading ? "Preparing..." : "Download audit Excel"}
          </button>
          <button className="secondary-button" onClick={() => (window.location.hash = "#/home")}>
            Back to search
          </button>
        </div>
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
                  <div className="audit-title-line">
                    <h2>{entry.name || "Unnamed user"}</h2>
                    <span className={`audit-action ${entry.action || "update"}`}>
                      {auditActionLabel(entry.action)}
                    </span>
                  </div>
                  <p>
                    Badge {entry.badgeNo || "-"} · Record #{entry.personId} · Changes done by:{" "}
                    {entry.changedBy || "system"}
                  </p>
                </div>
                <div className="audit-entry-tools">
                  {entry.restorable ? (
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={() => restoreAuditEntry(entry)}
                      disabled={restoringId === entry.id}
                    >
                      {restoringId === entry.id ? "Restoring..." : "Restore"}
                    </button>
                  ) : null}
                  <time>{formatDateTime(entry.createdAt)}</time>
                </div>
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

function PersonPage({ id, token, isNew = false }) {
  const [person, setPerson] = useState(null);
  const [fields, setFields] = useState([]);
  const [dropdownOptions, setDropdownOptions] = useState({});
  const [formData, setFormData] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    const requests = isNew
      ? [apiFetch("/api/fields", { token })]
      : [
          apiFetch("/api/fields", { token }),
          apiFetch(`/api/people/${id}`, { token }),
        ];

    Promise.all(requests)
      .then(([fieldPayload, personPayload]) => {
        if (cancelled) return;
        const nextFields = fieldPayload.fields || [];
        setFields(nextFields);
        setDropdownOptions(fieldPayload.dropdownOptions || {});
        if (isNew) {
          setPerson(null);
          setFormData(blankFormData(nextFields));
        } else {
          setPerson(personPayload);
          setFormData(personPayload.data || {});
        }
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
  }, [id, isNew, token]);

  const groupedSections = useMemo(() => buildSections(fields), [fields]);

  function updateField(field, value) {
    setFormData((current) => ({ ...current, [field]: value }));
  }

  async function save(event) {
    event.preventDefault();
    setNotice("");
    setError("");
    const displayName = displayFullName(formData) || person?.fullName || "this person";
    const verificationStatus = String(formData["Verification Status"] || "").trim().toLowerCase();
    const confirmationMessage =
      verificationStatus === "" || verificationStatus === "none"
        ? `Verification status is not set for ${displayName}.\n\nClick OK to ${isNew ? "create this user" : "save anyway"}.`
        : isNew
          ? `Create new user ${displayName}?`
          : `Save changes for ${displayName}?`;
    if (!window.confirm(confirmationMessage)) return;

    setSaving(true);
    try {
      const updated = await apiFetch(isNew ? "/api/people" : `/api/people/${id}`, {
        method: isNew ? "POST" : "PUT",
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

  async function deleteEntry() {
    setNotice("");
    setError("");
    const displayName = displayFullName(formData) || person?.fullName || "this person";
    if (!window.confirm(`Delete ${displayName}? This will remove the entry from search and exports.`)) return;

    setDeleting(true);
    try {
      await apiFetch(`/api/people/${id}`, {
        method: "DELETE",
        token,
      });
      window.location.hash = "#/home";
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <main className="page">
        <p className="empty-state">Loading record...</p>
      </main>
    );
  }

  if (error && !person && !isNew) {
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
          <h1>{displayFullName(formData) || (isNew ? "Create new user" : "User record")}</h1>
          {isNew ? (
            <p>S No will be assigned automatically when this user is saved.</p>
          ) : (
            <p>
              Badge {formData["Badge no."] || "-"} · Department{" "}
              {formData["Sewa Dept - Local Centre"] || formData["Sewa Dept - Major Centre"] || "-"}
            </p>
          )}
        </div>
        {!isNew ? (
          <button
            type="button"
            className="danger-button record-delete-button"
            onClick={deleteEntry}
            disabled={saving || deleting}
          >
            {deleting ? "Deleting..." : "Delete entry"}
          </button>
        ) : null}
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
                  readOnly={field === "S No"}
                  placeholder={field === "S No" ? "Assigned automatically" : ""}
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
          <button type="submit" className="primary-button" disabled={saving || deleting}>
            {saving ? (isNew ? "Creating..." : "Saving...") : isNew ? "Create user" : "Save changes"}
          </button>
        </div>
      </form>
    </main>
  );
}

function FieldControl({ field, value, options = [], readOnly = false, placeholder = "", onChange }) {
  const multiline = [
    "Address Line 1",
    "Address Line 2",
    "New Address",
    "Jatha Remarks",
  ].includes(field);
  const isDateField = dateFields.includes(field);
  const maxLength = addressLimitFields.includes(field) ? 75 : undefined;
  const type = inputType(field);
  const selectOptions = useMemo(() => {
    if (!options.length) return [];
    return [...new Set(options.filter(Boolean))];
  }, [options, value]);

  return (
    <label className={multiline ? "span-2" : ""}>
      <span>{field}</span>
      {readOnly ? (
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          readOnly
        />
      ) : isDateField ? (
        <div className="date-field">
          <input
            type="text"
            value={dateDisplayValue(value)}
            placeholder="12-sep-80"
            readOnly
          />
          <input
            type="date"
            aria-label={`Choose ${field}`}
            value={dateInputValue(value)}
            onChange={(event) => onChange(formatStoredDate(event.target.value))}
          />
        </div>
      ) : selectOptions.length ? (
        <div className="combo-field">
          <input
            type={type}
            value={value}
            maxLength={maxLength}
            onChange={(event) => onChange(event.target.value)}
          />
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
        <textarea
          value={value}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
        />
      ) : (
        <input
          type={type}
          value={value}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
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
  if (hash === "#/people/new") return { name: "new-person" };
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

function blankFormData(fields) {
  const data = Object.fromEntries(fields.map((field) => [field, ""]));
  if (fields.includes("Verification Status")) data["Verification Status"] = "None";
  return data;
}

function inputType(field) {
  if (/email/i.test(field)) return "email";
  if (/mobile|phone|contact|aadhaar|pin code/i.test(field)) return "tel";
  return "text";
}

function dateInputValue(value) {
  const parsed = parseDateParts(value);
  if (!parsed) return "";
  return `${parsed.year}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
}

function dateDisplayValue(value) {
  const formatted = formatStoredDate(value);
  return formatted || String(value || "");
}

function formatStoredDate(value) {
  const parsed = parseDateParts(value);
  if (!parsed) return "";
  return `${parsed.day}-${monthNames[parsed.month - 1]}-${String(parsed.year).slice(-2)}`;
}

const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseDateParts(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = text.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,9})[-/\s](\d{2,4})$/);
  if (match) {
    const month = monthFromText(match[2]);
    if (!month) return null;
    return validDate(expandYear(match[3]), month, Number(match[1]));
  }

  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) return validDate(expandYear(match[3]), Number(match[2]), Number(match[1]));

  return null;
}

function monthFromText(value) {
  const index = monthNames.findIndex((month) => value.toLowerCase().startsWith(month));
  return index === -1 ? 0 : index + 1;
}

function expandYear(value) {
  const year = Number(value);
  if (String(value).length === 4) return year;
  const currentTwoDigitYear = new Date().getFullYear() % 100;
  return year <= currentTwoDigitYear ? 2000 + year : 1900 + year;
}

function validDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function displayFullName(data) {
  return [data["First Name"], data["Middle Name"], data["Last Name"]]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function filenameFromDisposition(disposition, fallback = "sbm-users.xlsx") {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1] || fallback;
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

function auditActionLabel(action) {
  if (action === "create") return "Created";
  if (action === "delete") return "Deleted";
  if (action === "restore") return "Restored";
  return "Updated";
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
