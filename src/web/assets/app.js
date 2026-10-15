var agents = [];
var tools  = [];
var ollamaModels = [];
var editingAgentName = null;
var editingToolId = null;
var allSkills = [];

var PROVIDER_DEFAULTS = {
  local:     { url: 'http://host.docker.internal:11434/v1', key: 'ollama' },
  openai:    { url: 'https://api.openai.com/v1',  key: '' },
  anthropic: { url: 'https://api.anthropic.com/v1', key: '' },
  custom:    { url: '', key: '' },
};

var TOOL_SCHEMAS = {
  qdrant_rag:   [['url','Qdrant URL'],['embeddingUrl','TEI Embedding URL']],
  openai_tools: [['url','Endpoint URL'],['apiKey','API Key']],
  rag_manager:  [['url','RAG Manager URL']],
  searxng:      [['url','SearXNG Base URL']],
  aiwiki:       [],
  self_improve: [],
};

// -- Auth state ----------------------------------------------------------------

var authToken   = localStorage.getItem('orchestrail_token') || '';
var authEmail   = localStorage.getItem('orchestrail_email') || '';
var authRole    = localStorage.getItem('orchestrail_role')  || '';

function apiFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
  return fetch(url, opts).then(function(r) {
    if (r.status === 401) { showLogin(); return Promise.reject(new Error('Unauthorized')); }
    return r;
  });
}

function showLogin() {
  document.getElementById('login-overlay').style.display = 'flex';
  document.getElementById('login-email').focus();
}

function hideLogin() {
  document.getElementById('login-overlay').style.display = 'none';
}

function doLogin() {
  var email    = document.getElementById('login-email').value.trim();
  var password = document.getElementById('login-password').value;
  var errEl    = document.getElementById('login-error');
  errEl.style.display = 'none';
  if (!email || !password) { errEl.textContent = 'Email and password required.'; errEl.style.display = 'block'; return; }
  fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password }),
  })
  .then(function(r) { return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
  .then(function(res) {
    if (!res.ok) { errEl.textContent = res.d.error || 'Login failed.'; errEl.style.display = 'block'; return; }
    authToken = res.d.token; authEmail = res.d.email; authRole = res.d.role;
    localStorage.setItem('orchestrail_token', authToken);
    localStorage.setItem('orchestrail_email', authEmail);
    localStorage.setItem('orchestrail_role',  authRole);
    hideLogin();
    updateUserPill();
    initApp();
  })
  .catch(function(e) { errEl.textContent = 'Network error: ' + e.message; errEl.style.display = 'block'; });
}

function logout() {
  apiFetch('/api/auth/logout', { method: 'POST' }).catch(function(){});
  authToken = ''; authEmail = ''; authRole = '';
  localStorage.removeItem('orchestrail_token');
  localStorage.removeItem('orchestrail_email');
  localStorage.removeItem('orchestrail_role');
  showLogin();
}

function updateUserPill() {
  if (!authToken) return;
  var pill  = document.getElementById('user-pill');
  var label = document.getElementById('user-email-label');
  var badge = document.getElementById('user-role-badge');
  label.textContent = authEmail;
  if (authRole === 'admin') {
    badge.textContent = 'admin';
    badge.style.cssText = 'font-size:10px;font-family:var(--mono);padding:2px 7px;border-radius:3px;border:1px solid rgba(0,200,150,.3);color:var(--accent);background:var(--accent-dim);';
  } else {
    badge.textContent = 'user';
    badge.style.cssText = 'font-size:10px;font-family:var(--mono);padding:2px 7px;border-radius:3px;border:1px solid var(--border);color:var(--text-dim);background:var(--surface2);';
  }
  pill.style.display = 'flex';
}

// -- Init ----------------------------------------------------------------------

window.onload = function() {
  checkStatus();
  if (authToken) {
    // Validate existing token
    fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + authToken } })
      .then(function(r) {
        if (!r.ok) { showLogin(); return; }
        return r.json();
      })
      .then(function(data) {
        if (!data) return;
        authRole = data.role; authEmail = data.email;
        localStorage.setItem('orchestrail_role', authRole);
        localStorage.setItem('orchestrail_email', authEmail);
        hideLogin();
        updateUserPill();
        initApp();
      })
      .catch(function() { showLogin(); });
  } else {
    showLogin();
  }
};

function initApp() {
  // loadModels must complete before loadCoordinator so the model dropdown
  // has the full Ollama list rather than just the currently-saved model.
  loadModels().then(function() {
    Promise.all([loadAgents(), loadTools(), loadCoordinator(), loadCoordinatorDefaults()]);
  });
  initDebugTab();
  // Show admin-only tabs only for admins; regular users only see Conversation Logs
  var isAdmin = authRole === 'admin';
  ['tab-btn-agents','tab-btn-tools','tab-btn-coordinator','tab-btn-configuration'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = isAdmin ? '' : 'none';
  });
  var usersBtn = document.getElementById('tab-btn-users');
  if (usersBtn) usersBtn.style.display = isAdmin ? '' : 'none';
  var skillsBtn = document.getElementById('tab-btn-skills');
  if (skillsBtn) skillsBtn.style.display = isAdmin ? '' : 'none';
  // All users land on Chat tab; load the conversation list
  loadChatConvList();
};

function checkStatus() {
  fetch('/health').then(function(r){return r.json();}).then(function(){
    document.getElementById('status-dot').className = 'status-dot ok';
    document.getElementById('status-label').textContent = 'connected';
  }).catch(function(){
    document.getElementById('status-dot').className = 'status-dot err';
    document.getElementById('status-label').textContent = 'offline';
  });
}

function loadModels() {
  return apiFetch('/api/ollama/models').then(function(r){return r.json();}).then(function(data){
    ollamaModels = Array.isArray(data) ? data : [];
  }).catch(function(){ ollamaModels = []; });
}

function loadAgents() {
  return apiFetch('/api/agents').then(function(r){return r.json();}).then(function(data){
    agents = data; renderAgents(); wireAgentGrid();
  });
}

function loadTools() {
  return apiFetch('/api/tools').then(function(r){return r.json();}).then(function(data){
    tools = data; renderTools(); wireToolGrid();
  });
}

function loadCoordinator() {
  return apiFetch('/api/coordinator').then(function(r){return r.json();}).then(function(data){
    renderCoordinator(data);
  }).catch(function(){});
}

// -- Debug log -----------------------------------------------------------------

// -- Debug tab state -----------------------------------------------------------
// Three-level drill-down:
//   Admin:        User list  ->  Conversation list  ->  Tool log
//   Regular user: Conversation list  ->  Tool log

var debugAllUsers    = [];   // [{email, displayName, role}]
var debugAllConvs    = [];   // ConversationMeta[] for current drill context
var debugEntries     = [];   // ToolLogEntry[] for current conversation
var debugConvCtx     = null; // currently selected conversationId
var debugUserCtx     = null; // currently selected userId (admin drill-in)
var debugPollTimer   = null;
var debugLastTs      = 0;

function initDebugTab() {
  if (authRole === 'admin') {
    loadDebugUsers();
  } else {
    loadDebugConvs(authEmail);
  }
}

// -- Level 1 (admin): user list ------------------------------------------------

function loadDebugUsers() {
  // Load all conversations to derive the full user list (includes unregistered OpenWebUI users),
  // then merge with registered users to pick up displayName/role where available.
  Promise.all([
    apiFetch('/api/conversations').then(function(r){ return r.json(); }),
    apiFetch('/api/users').then(function(r){ return r.json(); }).catch(function(){ return []; }),
  ]).then(function(results) {
    var convs    = Array.isArray(results[0]) ? results[0] : [];
    var regUsers = Array.isArray(results[1]) ? results[1] : [];
    var regMap   = {};
    regUsers.forEach(function(u) { regMap[u.email] = u; });
    // Build unique user list from conversation metadata
    var seenEmails = {};
    var userList = [];
    convs.forEach(function(c) {
      if (!c.userId || seenEmails[c.userId]) return;
      seenEmails[c.userId] = true;
      var reg = regMap[c.userId];
      userList.push({
        email:       c.userId,
        displayName: reg ? (reg.displayName || reg.email) : c.userId,
        role:        reg ? reg.role : 'unregistered',
      });
    });
    // Also include registered users who have no conversations yet
    regUsers.forEach(function(u) {
      if (!seenEmails[u.email]) {
        seenEmails[u.email] = true;
        userList.push({ email: u.email, displayName: u.displayName || u.email, role: u.role });
      }
    });
    debugAllUsers = userList;
    showDebugUsers();
  }).catch(function(){});
}

function showDebugUsers() {
  document.getElementById('debug-user-list').style.display = 'block';
  document.getElementById('debug-conv-list').style.display = 'none';
  document.getElementById('debug-log-view').style.display  = 'none';
  document.getElementById('debug-breadcrumb').style.display = 'none';
  renderDebugUserRows(debugAllUsers);
}

function renderDebugUserRows(list) {
  var rows = document.getElementById('debug-user-rows');
  if (!list.length) {
    rows.innerHTML = '<div class="empty"><div class="empty-icon">[ ]</div>No users yet.</div>';
    return;
  }
  rows.innerHTML = list.map(function(u) {
    var roleColor = u.role === 'admin' ? 'var(--accent)' : 'var(--text-dim)';
    return '<div class="card" style="cursor:pointer;display:flex;align-items:center;gap:14px;padding:14px 18px;" onclick="drillToUser(' + esc(JSON.stringify(u.email)) + ',' + esc(JSON.stringify(u.displayName||u.email)) + ')">' +
      '<div class="card-icon">'+esc((u.displayName||u.email||'?').charAt(0).toUpperCase())+'</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:600;font-size:13px">' + esc(u.displayName || u.email) + '</div>' +
        '<div style="font-family:var(--mono);font-size:11px;color:var(--text-dim);margin-top:2px">' + esc(u.email) + '</div>' +
      '</div>' +
      '<span style="font-size:10px;font-family:var(--mono);padding:2px 7px;border-radius:3px;color:' + roleColor + ';border:1px solid currentColor;">' + esc(u.role) + '</span>' +
      '<span style="font-size:12px;color:var(--text-muted)">></span>' +
    '</div>';
  }).join('');
}

function filterDebugUsers() {
  var q = document.getElementById('debug-user-search').value.toLowerCase();
  var filtered = debugAllUsers.filter(function(u) {
    return (u.email||'').toLowerCase().includes(q) || (u.displayName||'').toLowerCase().includes(q);
  });
  renderDebugUserRows(filtered);
}

function drillToUser(email, displayName) {
  debugUserCtx = email;
  // Breadcrumb
  document.getElementById('debug-breadcrumb').style.display = 'block';
  document.getElementById('debug-bc-user').textContent = displayName || email;
  document.getElementById('debug-bc-user').onclick = function(){ drillBackToUsers(); };
  document.getElementById('debug-bc-sep1').style.display = 'inline';
  document.getElementById('debug-bc-conv').textContent = '';
  document.getElementById('debug-bc-sep2').style.display = 'none';
  document.getElementById('debug-bc-log').textContent = '';
  loadDebugConvs(email);
}

function drillBackToUsers() {
  debugUserCtx = null;
  debugConvCtx = null;
  stopDebugPoll();
  showDebugUsers();
}

// -- Level 2: conversation list ------------------------------------------------

function loadDebugConvs(userId) {
  var url = '/api/conversations' + (authRole === 'admin' && userId ? '?userId=' + encodeURIComponent(userId) : '');
  apiFetch(url)
    .then(function(r){ return r.json(); })
    .then(function(data) {
      debugAllConvs = Array.isArray(data) ? data : [];
      showDebugConvs(userId);
    })
    .catch(function(){});
}

function showDebugConvs(userId) {
  document.getElementById('debug-user-list').style.display = 'none';
  document.getElementById('debug-conv-list').style.display = 'block';
  document.getElementById('debug-log-view').style.display  = 'none';
  if (authRole !== 'admin') {
    document.getElementById('debug-breadcrumb').style.display = 'none';
  }
  renderDebugConvRows(debugAllConvs);
}

function renderDebugConvRows(list) {
  var rows  = document.getElementById('debug-conv-rows');
  var title = document.getElementById('debug-conv-title');
  title.textContent = authRole === 'admin' && debugUserCtx
    ? 'Conversations - ' + debugUserCtx
    : 'Your Conversations';

  if (!list.length) {
    rows.innerHTML = '<div class="empty"><div class="empty-icon">[ ]</div>No conversations recorded yet. Run a prompt through OpenWebUI to see them here.</div>';
    return;
  }
  rows.innerHTML = list.map(function(c) {
    var dt = new Date(c.lastActive).toLocaleString();
    return '<div class="card" style="cursor:pointer;" onclick="drillToConv(' + esc(JSON.stringify(c.id)) + ',' + esc(JSON.stringify(c.title||c.id)) + ')">' +
      '<div style="display:flex;align-items:center;gap:12px;">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;font-size:13px;margin-bottom:3px">' + esc(c.title || c.id) + '</div>' +
          '<div style="font-family:var(--mono);font-size:11px;color:var(--text-dim)">' + esc(c.id) + '</div>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);white-space:nowrap">' + esc(dt) + '</div>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--danger);padding:2px 8px;font-size:11px;flex-shrink:0;" ' +
          'onclick="event.stopPropagation();deleteConv(' + esc(JSON.stringify(c.id)) + ')" ' +
          'title="Delete conversation">✕</button>' +
        '<span style="font-size:12px;color:var(--text-muted)">></span>' +
      '</div>' +
    '</div>';
  }).join('');
}

function filterDebugConvs() {
  var q = document.getElementById('debug-conv-search').value.toLowerCase();
  var filtered = debugAllConvs.filter(function(c) {
    return (c.id||'').toLowerCase().includes(q) || (c.title||'').toLowerCase().includes(q);
  });
  renderDebugConvRows(filtered);
}

function deleteConv(convId) {
  if (!confirm('Delete conversation "' + convId + '"? This cannot be undone.')) return;
  apiFetch('/api/conversations/' + encodeURIComponent(convId), { method: 'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (data.ok) {
        toast('Conversation deleted', 'ok');
        debugAllConvs = debugAllConvs.filter(function(c){ return c.id !== convId; });
        renderDebugConvRows(debugAllConvs);
      } else {
        toast('Delete failed: ' + (data.error || 'unknown error'), 'err');
      }
    })
    .catch(function(e){ toast('Delete failed: ' + e.message, 'err'); });
}

function debugDrillUser() {
  // Breadcrumb click: go back to user list (admin only)
  drillBackToUsers();
}

function debugDrillConv() {
  // Breadcrumb click: go back to conversation list
  debugConvCtx = null;
  stopDebugPoll();
  var uid = debugUserCtx || authEmail;
  document.getElementById('debug-bc-sep2').style.display = 'none';
  document.getElementById('debug-bc-log').textContent = '';
  showDebugConvs(uid);
  loadDebugConvs(uid);
}

function drillToConv(convId, title) {
  debugConvCtx = convId;
  // Update breadcrumb
  document.getElementById('debug-breadcrumb').style.display = 'block';
  if (authRole === 'admin') {
    document.getElementById('debug-bc-sep1').style.display = 'inline';
    document.getElementById('debug-bc-conv').textContent = title.slice(0, 40) + (title.length > 40 ? '...' : '');
    document.getElementById('debug-bc-conv').onclick = function(){ debugDrillConv(); };
    document.getElementById('debug-bc-sep2').style.display = 'inline';
    document.getElementById('debug-bc-log').textContent = 'Tool Log';
  } else {
    document.getElementById('debug-bc-user').textContent = title.slice(0, 60) + (title.length > 60 ? '...' : '');
    document.getElementById('debug-bc-user').onclick = function(){ debugDrillConv(); };
    document.getElementById('debug-bc-sep1').style.display = 'inline';
    document.getElementById('debug-bc-conv').textContent = 'Tool Log';
    document.getElementById('debug-bc-conv').onclick = null;
    document.getElementById('debug-bc-sep2').style.display = 'none';
  }

  document.getElementById('debug-user-list').style.display = 'none';
  document.getElementById('debug-conv-list').style.display = 'none';
  document.getElementById('debug-log-view').style.display  = 'block';
  document.getElementById('debug-log-title').textContent   = 'Tool Log - ' + convId;

  // Only admins can clear the global log
  document.getElementById('debug-clear-btn').style.display = authRole === 'admin' ? 'inline-flex' : 'none';

  debugEntries = [];
  debugLastTs  = 0;
  loadConvToolLog();
  startDebugPoll();
}

// -- Level 3: tool log for a conversation -------------------------------------

function loadConvToolLog() {
  var url = '/api/conversations/' + encodeURIComponent(debugConvCtx) + '/tool-log';
  apiFetch(url)
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (!Array.isArray(data)) return;
      debugEntries = data;
      renderDebugLog();
      if (data.length) {
        debugLastTs = data[0].ts;
        document.getElementById('debug-status').textContent = 'last update: ' + new Date().toLocaleTimeString();
      }
    })
    .catch(function(){});
}

function startDebugPoll() {
  stopDebugPoll();
  debugPollTimer = setInterval(pollDebugLog, 2000);
}

function stopDebugPoll() {
  if (debugPollTimer) { clearInterval(debugPollTimer); debugPollTimer = null; }
}

function pollDebugLog() {
  if (!debugConvCtx) return;
  apiFetch('/api/conversations/' + encodeURIComponent(debugConvCtx) + '/tool-log?since=' + debugLastTs)
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (!Array.isArray(data) || !data.length) return;
      var fresh = data.filter(function(e){ return e.ts > debugLastTs; });
      if (!fresh.length) return;
      debugLastTs  = fresh[0].ts;
      debugEntries = fresh.concat(debugEntries);
      renderDebugLog();
      document.getElementById('debug-status').textContent = 'last update: ' + new Date().toLocaleTimeString();
    })
    .catch(function(){});
}

function renderDebugLog() {
  var container = document.getElementById('debug-log');
  if (!debugEntries.length) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">[ ]</div>No tool calls recorded for this conversation yet.</div>';
    return;
  }
  container.innerHTML = debugEntries.map(function(e) {
    var isCoord    = e.agent === 'coordinator';
    var parsed     = null;
    try { parsed = JSON.parse(e.result); } catch(x) {}
    var isOverride = isCoord && e.tool === 'route' && parsed && parsed.override === true;
    var dotCls     = isOverride ? 'override' : (e.ok ? 'ok' : 'err');
    var entryCls   = isOverride ? 'log-entry override' : ('log-entry' + (e.ok ? '' : ' err'));
    var agentCls   = isCoord ? 'log-agent coord' : 'log-agent';
    var argsStr    = JSON.stringify(e.args, null, 2);
    var resultStr  = isCoord ? JSON.stringify(parsed, null, 2) : tryPrettyJson(e.result);
    var preview    = isCoord
      ? buildCoordPreview(e.tool, parsed)
      : resultStr.split(String.fromCharCode(10)).join(' ').slice(0, 120);
    var timeStr    = new Date(e.ts).toLocaleTimeString();
    return '<div class="' + entryCls + '" id="le-' + e.id + '">' +
      '<div class="log-entry-head" onclick="toggleLogEntry(' + esc(JSON.stringify(e.id)) + ')">' +
        '<div class="log-dot ' + dotCls + '"></div>' +
        '<span class="' + agentCls + '">' + esc(e.agent) + '</span>' +
        '<span style="color:var(--text-muted);font-size:11px;font-family:var(--mono)">></span>' +
        '<span class="log-tool">' + esc(e.tool) + '</span>' +
        (isOverride ? '<span class="override-badge">OVERRIDE</span>' : '') +
        '<span class="log-preview">' + esc(preview) + '</span>' +
        '<span class="log-meta">' + e.durationMs + 'ms &nbsp; ' + timeStr + '</span>' +
      '</div>' +
      '<div class="log-body" id="lb-' + e.id + '">' +
        '<div><div class="log-section-label">Input</div><div class="log-code">' + esc(argsStr) + '</div></div>' +
        '<div><div class="log-section-label">Output</div><div class="log-code">' + esc(resultStr || e.result) + '</div></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function buildCoordPreview(tool, parsed) {
  if (!parsed) return '(no result)';
  if (tool === 'clarify')    return parsed.decision + (parsed.decision === 'CLARIFY' ? ': ' + (parsed.questions||'').slice(0,80) : '');
  if (tool === 'decompose')  return parsed.mode + ' > ' + (parsed.stages||parsed.tasks||[]).map(function(s){ return s.assignee||s; }).join(' -> ');
  if (tool === 'route')      return parsed.action + (parsed.override ? ' [overrode ' + (parsed.note||'agent signal') + ']' : '') + (parsed.reason ? ' > ' + parsed.reason.slice(0,80) : '');
  if (tool === 'synthesize') return (parsed.preview||'').slice(0,120);
  return JSON.stringify(parsed).slice(0,120);
}

function toggleLogEntry(id) {
  var body = document.getElementById('lb-' + id);
  if (body) body.className = body.className.includes('open') ? 'log-body' : 'log-body open';
}

function tryPrettyJson(str) {
  try {
    var parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object') {
      if (parsed.output !== undefined) return String(parsed.output || '(no output)');
      if (parsed.results) return JSON.stringify(parsed.results, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  } catch(e) { return str; }
}

function exportDebugLog() {
  if (!debugConvCtx) { toast('Open a conversation first', 'err'); return; }
  apiFetch('/api/conversations/' + encodeURIComponent(debugConvCtx) + '/tool-log')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href   = url;
      a.download = 'tool-log-' + debugConvCtx + '-' + new Date().toISOString().replace(/[:.]/g,'-') + '.json';
      a.click();
      URL.revokeObjectURL(url);
      toast('Log exported', 'ok');
    })
    .catch(function(e){ toast('Export failed: ' + e.message, 'err'); });
}

function clearDebugLog() {
  if (!confirm('Clear the entire in-memory tool log? This cannot be undone.')) return;
  apiFetch('/api/tool-log', { method: 'DELETE' })
    .then(function(){ debugEntries = []; debugLastTs = 0; renderDebugLog(); toast('Log cleared', 'ok'); })
    .catch(function(e){ toast('Clear failed: ' + e.message, 'err'); });
}

var coordinatorDefaults = {};

function loadCoordinatorDefaults() {
  return apiFetch('/api/coordinator/defaults')
    .then(function(r){ return r.json(); })
    .then(function(d){ coordinatorDefaults = d; })
    .catch(function(){});
}

function resetPrompt(textareaId, key) {
  var val = coordinatorDefaults[key];
  if (!val) { toast('Defaults not loaded yet','err'); return; }
  document.getElementById(textareaId).value = val;
  toast('Reset to default - remember to Save','ok');
}

function renderCoordinator(cfg) {
  var llm = (cfg && cfg.llm) ? cfg.llm : { provider:'local', url: PROVIDER_DEFAULTS.local.url, apiKey:'ollama', model:'' };
  document.getElementById('c-provider').value = llm.provider || 'local';
  document.getElementById('c-llm-url').value  = llm.url || '';
  populateCoordModelDropdown(llm.provider, llm.model);
  onCoordProviderChange();

  // Flags
  var flags = (cfg && Array.isArray(cfg.flags)) ? cfg.flags : [];
  document.getElementById('flag-no-think').checked = flags.includes('/no_think');
  document.getElementById('flag-think').checked    = flags.includes('/think');
  var known = ['/no_think', '/think'];
  var custom = flags.filter(function(f){ return !known.includes(f); });
  document.getElementById('flag-custom').value = custom.join(String.fromCharCode(10));

  // Prompts
  document.getElementById('c-decomposition-prompt').value = (cfg && cfg.decompositionPrompt) || '';
  document.getElementById('c-routing-prompt').value       = (cfg && cfg.routingPrompt)       || '';
  document.getElementById('c-clarification-prompt').value = (cfg && cfg.clarificationPrompt) || '';
  document.getElementById('c-synthesis-prompt').value     = (cfg && cfg.synthesisPrompt)     || '';

  // Extended memory
  var mem = (cfg && cfg.memory) ? cfg.memory : {};
  document.getElementById('mem-enabled').checked           = !!mem.enabled;
  document.getElementById('mem-qdrant-url').value          = mem.qdrantUrl        || '';
  document.getElementById('mem-tei-url').value             = mem.teiUrl           || '';
  document.getElementById('mem-vector-size').value         = mem.vectorSize       != null ? String(mem.vectorSize)    : '';
  document.getElementById('mem-retention-days').value      = mem.retentionDays    != null ? String(mem.retentionDays) : '';
  document.getElementById('mem-conv-col').value            = mem.conversationCollection || '';
  document.getElementById('mem-user-col').value            = mem.userCollection        || '';
  document.getElementById('mem-meta-col').value            = mem.metaCollection        || '';
  onMemEnabledChange();
}

function populateCoordModelDropdown(provider, currentModel) {
  var sel = document.getElementById('c-model');
  sel.innerHTML = '';
  var models = [];
  if (provider === 'local') {
    models = ollamaModels.length ? ollamaModels : (currentModel ? [currentModel] : []);
  } else if (provider === 'openai') {
    models = ['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-3.5-turbo'];
  } else if (provider === 'anthropic') {
    models = ['claude-sonnet-4-6','claude-opus-4-6','claude-haiku-4-5-20251001'];
  } else {
    models = currentModel ? [currentModel] : [];
  }
  if (currentModel && !models.includes(currentModel)) models.unshift(currentModel);
  if (provider !== 'local') {
    var opt = document.createElement('option');
    opt.value = '__custom__'; opt.textContent = '-- enter model name below --';
    sel.appendChild(opt);
  }
  models.forEach(function(m) {
    var opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (currentModel && m === currentModel) opt.selected = true;
    sel.appendChild(opt);
  });
  var customRow = document.getElementById('c-model-custom-row');
  if (!customRow) {
    customRow = document.createElement('div');
    customRow.id = 'c-model-custom-row';
    customRow.style.marginTop = '6px';
    var inp = document.createElement('input');
    inp.type = 'text'; inp.id = 'c-model-custom';
    inp.placeholder = 'Custom model name...';
    inp.style.cssText = 'width:100%;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:13px;padding:8px 12px;outline:none;transition:border-color .15s;';
    inp.addEventListener('focus', function(){ this.style.borderColor='var(--accent)'; });
    inp.addEventListener('blur',  function(){ this.style.borderColor='var(--border)'; });
    customRow.appendChild(inp);
    sel.parentNode.appendChild(customRow);
  }
  if (provider !== 'local') {
    customRow.style.display = 'block';
    var known = ['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-3.5-turbo','claude-sonnet-4-6','claude-opus-4-6','claude-haiku-4-5-20251001'];
    document.getElementById('c-model-custom').value = (currentModel && !known.includes(currentModel)) ? currentModel : '';
  } else {
    customRow.style.display = 'none';
  }
}

function onCoordProviderChange() {
  var provider = document.getElementById('c-provider').value;
  var defaults = PROVIDER_DEFAULTS[provider] || { url:'', key:'' };
  var urlField = document.getElementById('c-llm-url');
  var isDefault = Object.values(PROVIDER_DEFAULTS).some(function(d){ return d.url === urlField.value; });
  if (!urlField.value || isDefault) urlField.value = defaults.url;
  document.getElementById('coord-url-row').style.display =
    (provider === 'openai' || provider === 'anthropic') ? 'none' : 'block';
  populateCoordModelDropdown(provider, document.getElementById('c-model').value);
}

function getCoordModel() {
  var provider = document.getElementById('c-provider').value;
  if (provider !== 'local') {
    var custom = document.getElementById('c-model-custom');
    if (custom && custom.value.trim()) return custom.value.trim();
  }
  var sel = document.getElementById('c-model');
  return sel.value === '__custom__' ? '' : sel.value;
}

// Ensures only one of two mutually exclusive checkboxes is checked at a time
function onFlagChange(checkedId, otherId) {
  if (document.getElementById(checkedId).checked) {
    document.getElementById(otherId).checked = false;
  }
}

function collectFlags() {
  var flags = [];
  if (document.getElementById('flag-no-think').checked) flags.push('/no_think');
  if (document.getElementById('flag-think').checked)    flags.push('/think');
  var custom = document.getElementById('flag-custom').value;
  custom.split(String.fromCharCode(10)).forEach(function(f) {
    f = f.trim();
    if (f && !flags.includes(f)) flags.push(f);
  });
  return flags;
}

function saveCoordinator() {
  var provider = document.getElementById('c-provider').value;
  var url      = document.getElementById('c-llm-url').value.trim();
  var key      = document.getElementById('c-llm-key').value;
  var model    = getCoordModel();
  if (provider === 'openai'     && !url) url = 'https://api.openai.com/v1';
  if (provider === 'anthropic'  && !url) url = 'https://api.anthropic.com/v1';
  if (!model) { toast('Model is required','err'); return; }
  var payload = {
    llm:                 { provider: provider, url: url, apiKey: key || 'ollama', model: model },
    flags:               collectFlags(),
    decompositionPrompt: document.getElementById('c-decomposition-prompt').value,
    routingPrompt:       document.getElementById('c-routing-prompt').value,
    clarificationPrompt: document.getElementById('c-clarification-prompt').value,
    synthesisPrompt:     document.getElementById('c-synthesis-prompt').value,
    memory: {
      enabled:                document.getElementById('mem-enabled').checked,
      qdrantUrl:              document.getElementById('mem-qdrant-url').value.trim(),
      teiUrl:                 document.getElementById('mem-tei-url').value.trim(),
      vectorSize:             parseInt(document.getElementById('mem-vector-size').value) || 1024,
      retentionDays:          parseInt(document.getElementById('mem-retention-days').value) || 90,
      conversationCollection: document.getElementById('mem-conv-col').value.trim() || 'orchestrail_conversations',
      userCollection:         document.getElementById('mem-user-col').value.trim() || 'orchestrail_users',
      metaCollection:         document.getElementById('mem-meta-col').value.trim() || 'orchestrail_meta',
    },
  };
  apiFetch('/api/coordinator', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.error) { toast(d.error,'err'); return; }
      toast('Coordinator saved','ok');
      loadCoordinator();
    })
    .catch(function(e){ toast('Save failed: '+e.message,'err'); });
}

// -- Tabs ----------------------------------------------------------------------

var TAB_LOADERS = {
  agents:        function() { loadAgents(); },
  tools:         function() { loadTools(); },
  coordinator:   function() { loadCoordinator(); },
  configuration: function() { loadCoordinator(); },
  users:         function() { loadManagedUsers(); },
  skills:        function() { loadSkills(); },
  debug:         function() {
    // Only refresh the top-level list if not currently drilled into a conversation
    if (!debugConvCtx) initDebugTab();
  },
  bullettrain:   function() { btInit(); },
};

function switchTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active');});
  document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});
  btn.classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
  var loader = TAB_LOADERS[tab];
  if (loader) loader();
}

// -- Render Agents -------------------------------------------------------------

function renderAgents() {
  var grid = document.getElementById('agents-grid');
  if (!agents.length) {
    grid.innerHTML = '<div class="empty"><div class="empty-icon">??</div>No agents configured</div>';
    return;
  }
  grid.innerHTML = agents.map(function(a, i) {
    var llm = a.llm || {};
    var providerLabel = llm.provider || 'local';
    var toolBadges = (a.tools||[]).map(function(tid){
      var t = tools.find(function(x){return x.id===tid;});
      var col = a.toolCollections && a.toolCollections[tid] ? ' / '+a.toolCollections[tid] : '';
      return '<span class="badge badge-tool">'+ esc(t?t.name:tid) + esc(col) +'</span>';
    }).join('');
    return '<div class="card">' +
      '<div class="card-header">' +
        '<div class="card-icon">'+esc((a.name||'?').charAt(0).toUpperCase())+'</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="card-name">'+esc(a.name)+'</div>' +
          '<div class="card-meta">'+esc(llm.model||'no model')+'</div>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn btn-ghost btn-sm" data-action="edit-agent" data-name="'+esc(a.name)+'">Edit</button>' +
          '<button class="btn btn-danger btn-sm" data-action="del-agent"  data-name="'+esc(a.name)+'">Del</button>' +
        '</div>' +
      '</div>' +
      '<div class="card-preview">'+esc((a.systemPrompt||'').slice(0,180))+'</div>' +
      '<div class="badges">' +
        '<span class="badge badge-provider">'+esc(providerLabel)+'</span>' +
        '<span class="badge badge-model">'+esc(llm.model||'-')+'</span>' +
        '<span class="badge badge-tokens">'+(a.maxTokens||4096)+' tok</span>' +
        toolBadges +
      '</div>' +
    '</div>';
  }).join('');
}

// -- Render Tools --------------------------------------------------------------

function renderTools() {
  var grid = document.getElementById('tools-grid');
  if (!tools.length) {
    grid.innerHTML = '<div class="empty"><div class="empty-icon">??</div>No tools configured</div>';
    return;
  }
  grid.innerHTML = tools.map(function(t) {
    var configLines = Object.entries(t.config||{}).map(function(e){
      var v = e[1];
      if (e[0].toLowerCase().includes('key')||e[0].toLowerCase().includes('token')) v = v?'********':'(not set)';
      return esc(e[0])+': '+esc(v||'(empty)');
    }).join(' &nbsp;-&nbsp; ');
    return '<div class="card">' +
      '<div class="card-header">' +
        '<div class="card-icon">??</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="card-name">'+esc(t.name)+'</div>' +
          '<div class="card-meta">'+esc(t.id)+'</div>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn btn-ghost btn-sm" data-action="edit-tool" data-id="'+esc(t.id)+'">Edit</button>' +
          '<button class="btn btn-danger btn-sm" data-action="del-tool"  data-id="'+esc(t.id)+'">Del</button>' +
        '</div>' +
      '</div>' +
      '<div class="card-preview">'+configLines+'</div>' +
      '<div class="badges">' +
        '<span class="badge badge-type">'+esc(t.type)+'</span>' +
        '<span class="badge '+(t.enabled?'badge-enabled':'badge-disabled')+'">'+(t.enabled?'enabled':'disabled')+'</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

// -- Agent Modal ---------------------------------------------------------------

function openAgentModal(name) {
  editingAgentName = name;
  var a = name ? agents.find(function(x){return x.name===name;}) : null;
  document.getElementById('agent-modal-title').textContent = name ? 'Edit Agent' : 'Add Agent';
  document.getElementById('a-name').value = a ? a.name : '';
  document.getElementById('a-name').readOnly = !!name;
  document.getElementById('a-prompt').value = a ? (a.systemPrompt||'') : '';
  document.getElementById('a-maxtokens').value = a ? (a.maxTokens||4096) : 4096;
  document.getElementById('a-order').value = (a && a.order !== undefined && a.order !== null) ? a.order : '';

  var temp = a ? (a.temperature||0) : 0;
  document.getElementById('a-temp-range').value = temp;
  document.getElementById('a-temp-val').textContent = parseFloat(temp).toFixed(2);
  document.getElementById('a-temp').value = temp;

  // LLM
  var llm = (a && a.llm) ? a.llm : { provider:'local', url: PROVIDER_DEFAULTS.local.url, apiKey: PROVIDER_DEFAULTS.local.key, model: ollamaModels[0]||'' };
  document.getElementById('a-provider').value = llm.provider || 'local';
  document.getElementById('a-llm-url').value  = llm.url || '';
  document.getElementById('a-llm-key').value  = '';  // never pre-fill secrets from server

  populateModelDropdown(llm.provider, llm.model);
  onProviderChange();

  // Tool rows
  renderAgentToolRows(a);

  document.getElementById('agent-overlay').classList.add('open');
}

function populateModelDropdown(provider, currentModel) {
  var sel = document.getElementById('a-model');
  sel.innerHTML = '';

  var models = [];
  if (provider === 'local') {
    models = ollamaModels.length ? ollamaModels : (currentModel ? [currentModel] : ['qwen3.8:27b-orchestrail']);
  } else if (provider === 'openai') {
    models = ['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-3.5-turbo'];
  } else if (provider === 'anthropic') {
    models = ['claude-sonnet-4-6','claude-opus-4-6','claude-haiku-4-5-20251001'];
  } else {
    models = currentModel ? [currentModel] : [];
  }

  // Always keep current model even if not in list
  if (currentModel && !models.includes(currentModel)) models.unshift(currentModel);
  // Allow free-text for custom
  if (provider === 'custom' || provider === 'openai' || provider === 'anthropic') {
    var custom = document.createElement('option');
    custom.value = '__custom__'; custom.textContent = '-- enter model name below --';
    sel.appendChild(custom);
  }
  models.forEach(function(m) {
    var opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (currentModel && m === currentModel) opt.selected = true;
    sel.appendChild(opt);
  });

  // Add a text input for custom model if non-local
  var customRow = document.getElementById('a-model-custom-row');
  if (!customRow) {
    customRow = document.createElement('div');
    customRow.id = 'a-model-custom-row';
    customRow.style.marginTop = '6px';
    var customInp = document.createElement('input');
    customInp.type = 'text';
    customInp.id = 'a-model-custom';
    customInp.placeholder = 'Custom model name...';
    customInp.style.cssText = 'width:100%;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:13px;padding:8px 12px;outline:none;transition:border-color .15s;';
    customInp.addEventListener('focus', function(){ this.style.borderColor = 'var(--accent)'; });
    customInp.addEventListener('blur',  function(){ this.style.borderColor = 'var(--border)'; });
    customRow.appendChild(customInp);
    sel.parentNode.appendChild(customRow);
  }
  if (provider !== 'local') {
    customRow.style.display = 'block';
    document.getElementById('a-model-custom').value = (currentModel && !['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-3.5-turbo','claude-sonnet-4-6','claude-opus-4-6','claude-haiku-4-5-20251001'].includes(currentModel)) ? currentModel : '';
  } else {
    customRow.style.display = 'none';
  }
}

function onProviderChange() {
  var provider = document.getElementById('a-provider').value;
  var defaults = PROVIDER_DEFAULTS[provider] || { url:'', key:'' };

  // Only auto-fill URL if field is empty or matches another provider default
  var urlField = document.getElementById('a-llm-url');
  var isDefaultUrl = Object.values(PROVIDER_DEFAULTS).some(function(d){ return d.url === urlField.value; });
  if (!urlField.value || isDefaultUrl) urlField.value = defaults.url;

  // URL field visibility (hide for known cloud providers)
  var urlRow = document.getElementById('llm-url-row');
  urlRow.style.display = (provider === 'openai' || provider === 'anthropic') ? 'none' : 'block';

  populateModelDropdown(provider, document.getElementById('a-model').value);
}

function renderPeerRows(agent) {
  var container = document.getElementById('a-peers-list');
  var currentName = agent ? agent.name : null;
  var currentPeers = (agent && Array.isArray(agent.peers)) ? agent.peers : [];
  var others = agents.filter(function(a){ return a.name !== currentName; });
  if (!others.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No other agents available.</div>';
    return;
  }
  container.innerHTML = others.map(function(a) {
    var checked = currentPeers.includes(a.name) ? 'checked' : '';
    return '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text);padding:4px 6px;border-radius:4px">' +
      '<input type="checkbox" id="peer-'+esc(a.name)+'" value="'+esc(a.name)+'" '+checked+
      ' style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer">' +
      '<span>'+esc(a.name)+'</span>' +
      '</label>';
  }).join('');
}

function collectPeers() {
  var peers = [];
  agents.forEach(function(a) {
    var cb = document.getElementById('peer-'+a.name);
    if (cb && cb.checked) peers.push(a.name);
  });
  return peers;
}

function renderAgentToolRows(agent) {
  var container = document.getElementById('a-tools-list');
  if (!tools.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px">No tools configured yet. Add tools in the Tools tab first.</div>';
    return;
  }
  container.innerHTML = tools.map(function(t) {
    var assigned  = agent && agent.tools && agent.tools.includes(t.id);
    var savedCol  = agent && agent.toolCollections && agent.toolCollections[t.id] || '';
    var rowId     = 'tool-row-'+t.id;
    var configId  = 'tool-config-'+t.id;
    var colSelId  = 'col-sel-'+t.id;

    return '<div class="tool-assign-row" id="'+rowId+'">' +
      '<label class="tool-assign-check">' +
        '<input type="checkbox" id="tc-'+t.id+'" value="'+esc(t.id)+'" '+(assigned?'checked':'')+
          ' onchange="onToolToggle('+JSON.stringify(t.id)+')">' +
        '<div><div class="tool-assign-name">'+esc(t.name)+'</div>' +
          '<div class="tool-assign-meta">'+esc(t.type)+'</div>' +
        '</div>' +
      '</label>' +
      (t.type === 'qdrant_rag' ?
        '<div class="tool-assign-config '+(assigned?'visible':'')+'" id="'+configId+'">' +
          '<label>Collection</label>' +
          '<select id="'+colSelId+'">' +
            '<option value="">- loading collections... -</option>' +
          '</select>' +
        '</div>'
      : t.type === 'rag_manager' ?
        '<div class="tool-assign-config '+(assigned?'visible':'')+'" id="'+configId+'">' +
          '<label style="font-size:12px;color:var(--text-muted);margin-bottom:4px;display:block">Allowed collections (empty = all)</label>' +
          '<div id="rag-checks-'+t.id+'" style="font-size:12px">loading...</div>' +
        '</div>'
      : '') +
    '</div>';
  }).join('');

  // Load collections for any already-assigned qdrant tools
  tools.forEach(function(t) {
    if (t.type === 'qdrant_rag') {
      var savedCol = agent && agent.toolCollections && agent.toolCollections[t.id] || '';
      loadCollections(t.id, savedCol);
    }
    if (t.type === 'rag_manager') {
      var savedAllowlist = agent && agent.toolCollections && agent.toolCollections[t.id] || '';
      loadRagEndpoints(t.id, savedAllowlist);
    }
  });
}

function onToolToggle(toolId) {
  var checked  = document.getElementById('tc-'+toolId).checked;
  var configEl = document.getElementById('tool-config-'+toolId);
  if (configEl) {
    configEl.className = 'tool-assign-config ' + (checked ? 'visible' : '');
    var t = tools.find(function(x){ return x.id === toolId; });
    if (checked && t) {
      if (t.type === 'qdrant_rag')  loadCollections(toolId, '');
      if (t.type === 'rag_manager') loadRagEndpoints(toolId, '');
    }
  }
}

function loadCollections(toolId, selectedCollection) {
  var selEl = document.getElementById('col-sel-'+toolId);
  if (!selEl) return;
  selEl.innerHTML = '<option value="">loading...</option>';

  apiFetch('/api/qdrant/collections?toolId='+encodeURIComponent(toolId))
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (data.error) { selEl.innerHTML = '<option value="">'+esc(data.error)+'</option>'; return; }
      var cols = Array.isArray(data) ? data : [];
      if (!cols.length) { selEl.innerHTML = '<option value="">(no collections found)</option>'; return; }
      selEl.innerHTML = '<option value="">- pick collection -</option>' +
        cols.map(function(c) {
          return '<option value="'+esc(c)+'" '+(c===selectedCollection?'selected':'')+'>'+esc(c)+'</option>';
        }).join('');
    })
    .catch(function(e) {
      selEl.innerHTML = '<option value="">(Qdrant unreachable)</option>';
    });
}

function loadRagEndpoints(toolId, savedAllowlist) {
  var container = document.getElementById('rag-checks-'+toolId);
  if (!container) return;
  var saved = savedAllowlist ? savedAllowlist.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
  container.innerHTML = 'loading...';
  apiFetch('/api/rag-manager/endpoints?toolId='+encodeURIComponent(toolId))
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (!Array.isArray(data) || !data.length) {
        container.innerHTML = '<span style="color:var(--text-muted)">'+(data.error||'No endpoints found')+'</span>';
        return;
      }
      container.innerHTML = data.map(function(ep) {
        var isChecked = !saved.length || saved.indexOf(ep.operationId) !== -1;
        return '<label style="display:flex;align-items:center;gap:6px;margin:2px 0;cursor:pointer">' +
          '<input type="checkbox" class="rag-ep-cb" data-toolid="'+esc(toolId)+'" value="'+esc(ep.operationId)+'" '+(isChecked?'checked':'')+'>'+
          '<span>'+esc(ep.summary)+'</span>'+
          '</label>';
      }).join('');
    })
    .catch(function() {
      container.innerHTML = '<span style="color:var(--text-muted)">(RAG Manager unreachable)</span>';
    });
}

function getSelectedModel() {
  var provider = document.getElementById('a-provider').value;
  if (provider !== 'local') {
    var custom = document.getElementById('a-model-custom');
    if (custom && custom.value.trim()) return custom.value.trim();
  }
  var sel = document.getElementById('a-model');
  return sel.value === '__custom__' ? '' : sel.value;
}

function closeAgentModal() {
  document.getElementById('agent-overlay').classList.remove('open');
  editingAgentName = null;
  var cr = document.getElementById('a-model-custom-row');
  if (cr) cr.remove();
}
function maybeCloseAgent(e) {
  if (e.target === document.getElementById('agent-overlay')) closeAgentModal();
}

function saveAgent() {
  var name = document.getElementById('a-name').value.trim();
  if (!name) { toast('Agent name is required','err'); return; }

  var provider = document.getElementById('a-provider').value;
  var llmUrl   = document.getElementById('a-llm-url').value.trim();
  var llmKey   = document.getElementById('a-llm-key').value;
  var llmModel = getSelectedModel();

  // For known cloud providers, set canonical URLs if blank
  if (provider === 'openai' && !llmUrl) llmUrl = 'https://api.openai.com/v1';
  if (provider === 'anthropic' && !llmUrl) llmUrl = 'https://api.anthropic.com/v1';

  // Collect tool assignments + collections
  var assignedTools = [];
  var toolCollections = {};
  tools.forEach(function(t) {
    var cb = document.getElementById('tc-'+t.id);
    if (cb && cb.checked) {
      assignedTools.push(t.id);
      if (t.type === 'qdrant_rag') {
        var colSel = document.getElementById('col-sel-'+t.id);
        if (colSel && colSel.value) toolCollections[t.id] = colSel.value;
      }
      if (t.type === 'rag_manager') {
        var allCbs     = document.querySelectorAll('.rag-ep-cb[data-toolid="'+t.id+'"]');
        var checkedCbs = Array.prototype.filter.call(allCbs, function(cb){ return cb.checked; });
        if (checkedCbs.length && checkedCbs.length < allCbs.length) {
          toolCollections[t.id] = checkedCbs.map(function(cb){ return cb.value; }).join(',');
        }
      }
    }
  });

  // If editing and key field is blank, keep existing key
  var existingAgent = editingAgentName ? agents.find(function(a){ return a.name===editingAgentName; }) : null;
  var finalKey = llmKey || (existingAgent && existingAgent.llm ? existingAgent.llm.apiKey : '') || 'ollama';

  var orderRaw = document.getElementById('a-order').value.trim();
  var payload = {
    name: name,
    systemPrompt: document.getElementById('a-prompt').value,
    llm: { provider: provider, url: llmUrl, apiKey: finalKey, model: llmModel },
    temperature: parseFloat(document.getElementById('a-temp').value),
    maxTokens: parseInt(document.getElementById('a-maxtokens').value) || 4096,
    tools: assignedTools,
    toolCollections: toolCollections,
    order: orderRaw !== '' ? parseInt(orderRaw) : undefined,
    // Preserve server-managed fields that have no UI inputs.
    // PUT /api/agents/:name spreads req.body over the stored object, so
    // omitting these would silently wipe them on every UI save.
    requiredOutputSlots: existingAgent ? (existingAgent.requiredOutputSlots || []) : [],
    readOnlySlots:       existingAgent ? (existingAgent.readOnlySlots       || []) : [],
  };

  var method = editingAgentName ? 'PUT' : 'POST';
  var url    = editingAgentName ? '/api/agents/'+encodeURIComponent(editingAgentName) : '/api/agents';

  apiFetch(url, { method: method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.error) { toast(d.error,'err'); return; }
      toast('Agent saved','ok');
      closeAgentModal();
      loadAgents();
    })
    .catch(function(e){ toast('Save failed: '+e.message,'err'); });
}

function deleteAgent(name) {
  if (!confirm('Delete agent "'+name+'"?')) return;
  apiFetch('/api/agents/'+encodeURIComponent(name),{method:'DELETE'})
    .then(function(){ toast('Agent deleted','ok'); loadAgents(); })
    .catch(function(e){ toast('Delete failed: '+e.message,'err'); });
}

// -- Tool Modal ----------------------------------------------------------------

function openToolModal(id) {
  editingToolId = id;
  var t = id ? tools.find(function(x){return x.id===id;}) : null;
  document.getElementById('tool-modal-title').textContent = id ? 'Edit Tool' : 'Add Tool';
  document.getElementById('t-id').value   = t ? t.id : '';
  document.getElementById('t-id').readOnly = !!id;
  document.getElementById('t-name').value  = t ? t.name : '';
  document.getElementById('t-type').value  = t ? t.type : 'qdrant_rag';
  document.getElementById('t-enabled').checked = t ? !!t.enabled : false;
  renderToolConfigFields(t ? t.config : null);
  document.getElementById('tool-overlay').classList.add('open');
}

function renderToolConfigFields(existingConfig) {
  var type   = document.getElementById('t-type').value;
  var schema = TOOL_SCHEMAS[type] || [];
  var conf   = existingConfig || {};
  document.getElementById('tool-config-fields').innerHTML = schema.map(function(pair) {
    var key=pair[0], label=pair[1];
    var isSecret = key.toLowerCase().includes('key')||key.toLowerCase().includes('token');
    return '<div class="config-field">' +
      '<label>'+esc(label)+'</label>' +
      '<input type="'+(isSecret?'password':'text')+'" id="tc-cfg-'+key+'" value="'+esc(conf[key]||'')+'" placeholder="'+(isSecret?'(blank = keep existing)':'')+'">' +
    '</div>';
  }).join('');
}

function onMemEnabledChange() {
  var enabled = document.getElementById('mem-enabled').checked;
  var fields  = document.getElementById('mem-fields');
  fields.style.opacity = enabled ? '1' : '0.5';
}

function closeToolModal() {
  document.getElementById('tool-overlay').classList.remove('open');
  editingToolId = null;
}
function maybeCloseTool(e) {
  if (e.target === document.getElementById('tool-overlay')) closeToolModal();
}

function saveTool() {
  var id   = document.getElementById('t-id').value.trim();
  var name = document.getElementById('t-name').value.trim();
  if (!id||!name) { toast('ID and name are required','err'); return; }
  var type   = document.getElementById('t-type').value;
  var schema = TOOL_SCHEMAS[type] || [];
  var config = {};
  var existing = editingToolId ? tools.find(function(x){return x.id===editingToolId;}) : null;
  if (existing) Object.assign(config, existing.config||{});
  schema.forEach(function(pair) {
    var key=pair[0];
    var inp=document.getElementById('tc-cfg-'+key);
    if (!inp) return;
    var isSecret = key.toLowerCase().includes('key')||key.toLowerCase().includes('token');
    if (!isSecret||inp.value.length>0) config[key]=inp.value;
  });
  var payload = { id:id, name:name, type:type, enabled:document.getElementById('t-enabled').checked, config:config };
  var method  = editingToolId ? 'PUT' : 'POST';
  var url     = editingToolId ? '/api/tools/'+encodeURIComponent(editingToolId) : '/api/tools';
  fetch(url, { method:method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.error) { toast(d.error,'err'); return; }
      toast('Tool saved','ok');
      closeToolModal();
      loadTools();
    })
    .catch(function(e){ toast('Save failed: '+e.message,'err'); });
}

function deleteTool(id) {
  if (!confirm('Delete tool "'+id+'"?')) return;
  fetch('/api/tools/'+encodeURIComponent(id),{method:'DELETE'})
    .then(function(){ toast('Tool deleted','ok'); loadTools(); })
    .catch(function(e){ toast('Delete failed: '+e.message,'err'); });
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var toastTimer;
function toast(msg, type) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast '+(type||'')+' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.className='toast'; }, 2800);
}

function exportAgents() {
  var json = JSON.stringify(agents, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url; a.download = 'orchestrail-agents.json'; a.click();
  URL.revokeObjectURL(url);
  toast('Exported ' + agents.length + ' agent' + (agents.length !== 1 ? 's' : ''), 'ok');
}

function importAgents(input) {
  var file = input.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var parsed;
    try { parsed = JSON.parse(e.target.result); }
    catch(err) { toast('Invalid JSON: ' + err.message, 'err'); input.value = ''; return; }
    if (!Array.isArray(parsed) || !parsed.length) { toast('JSON must be a non-empty array of agents', 'err'); input.value = ''; return; }
    var invalid = parsed.filter(function(a) { return !a.name || !a.systemPrompt; });
    if (invalid.length) { toast(invalid.length + ' agent(s) missing name or systemPrompt', 'err'); input.value = ''; return; }
    var existingNames = agents.map(function(a) { return a.name; });
    var newNames      = parsed.map(function(a) { return a.name; });
    var conflicts     = newNames.filter(function(n) { return existingNames.includes(n); });
    var conflictMsg   = conflicts.length ? ' Conflicts: ' + conflicts.join(', ') + '.' : '';
    var doMerge = confirm('Import ' + parsed.length + ' agent(s).' + conflictMsg + ' OK = Merge. Cancel = Replace all.');
    input.value = '';
    if (doMerge) {
      var toAdd = parsed.filter(function(a) { return !existingNames.includes(a.name); });
      if (!toAdd.length) { toast('No new agents (all names already exist)', 'err'); return; }
      Promise.all(toAdd.map(function(a) {
        return apiFetch('/api/agents', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(a) }).then(function(r){ return r.json(); });
      })).then(function(results) {
        var failed = results.filter(function(r) { return r.error; });
        if (failed.length) toast(failed.length + ' failed to import', 'err');
        else toast('Imported ' + toAdd.length + ' agent(s)', 'ok');
        loadAgents();
      }).catch(function(e) { toast('Import error: ' + e.message, 'err'); });
    } else {
      if (!confirm('Replace ALL ' + agents.length + ' existing agent(s) with ' + parsed.length + ' from file?')) return;
      apiFetch('/api/agents', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(parsed) })
        .then(function(r){ return r.json(); })
        .then(function(d) {
          if (d.error) { toast(d.error,'err'); return; }
          toast('Replaced all agents (' + parsed.length + ' imported)','ok');
          loadAgents();
        })
        .catch(function(e){ toast('Import error: ' + e.message, 'err'); });
    }
  };
  reader.readAsText(file);
}

function wireAgentGrid() {
  var grid = document.getElementById('agents-grid');
  grid.onclick = function(e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'edit-agent') openAgentModal(btn.dataset.name);
    if (btn.dataset.action === 'del-agent')  deleteAgent(btn.dataset.name);
  };
}

function wireToolGrid() {
  var grid = document.getElementById('tools-grid');
  grid.onclick = function(e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'edit-tool') openToolModal(btn.dataset.id);
    if (btn.dataset.action === 'del-tool')  deleteTool(btn.dataset.id);
  };
}

// -- Skills tab ----------------------------------------------------------------

function loadSkills() {
  var badge = document.getElementById('skills-status-badge');
  var body  = document.getElementById('skills-status-body');
  if (badge) badge.textContent = 'loading…';
  if (body)  body.textContent  = 'Loading…';

  apiFetch('/api/skills/status')
    .then(function(r){ return r.json(); })
    .then(function(status) {
      if (!status.enabled) {
        if (badge) badge.textContent = 'disabled';
        if (body)  body.innerHTML =
          'Skills system is not configured. Set <code>skills.skillsDir</code> under Coordinator ' +
          '→ Configuration and ensure Extended Memory (Qdrant + TEI) is enabled.';
        return;
      }
      if (body) body.innerHTML =
        'Skills dir: <b>' + esc(status.skillsDir || '—') + '</b><br>' +
        'Qdrant: <b>' + esc(status.qdrantUrl || '—') + '</b> &nbsp; ' +
        'TEI: <b>' + esc(status.teiUrl || '—') + '</b>';
    })
    .catch(function(e) {
      if (body) body.textContent = 'Status error: ' + e.message;
    });

  apiFetch('/api/skills')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      allSkills = Array.isArray(data) ? data : [];
      var badge2 = document.getElementById('skills-status-badge');
      if (badge2) badge2.textContent = 'enabled — ' + allSkills.length + ' skill(s)';
      renderSkillRows();
    })
    .catch(function(e) {
      var badge2 = document.getElementById('skills-status-badge');
      if (badge2) badge2.textContent = 'error';
      console.error('Skills load error:', e);
    });
}

function renderSkillRows() {
  var filterEl = document.getElementById('skill-filter-status');
  var filter   = filterEl ? filterEl.value : 'all';
  var rows     = document.getElementById('skill-rows');
  if (!rows) return;

  var list = filter === 'all'
    ? allSkills
    : allSkills.filter(function(s){ return s.status === filter; });

  if (!list.length) {
    rows.innerHTML =
      '<div class="empty"><div class="empty-icon">[ ]</div>' +
      (allSkills.length ? 'No skills match this filter.' : 'No skills indexed yet.') +
      '</div>';
    return;
  }

  rows.innerHTML = list.map(function(s) {
    var statusColor =
      s.status === 'stable'      ? 'var(--accent)'    :
      s.status === 'provisional' ? 'var(--accent2)'   : 'var(--text-muted)';
    var conf = (typeof s.confidence === 'number')
      ? (s.confidence * 100).toFixed(0) + '%' : '—';
    var successRate = (s.invocation_count > 0)
      ? ((s.success_count / s.invocation_count) * 100).toFixed(0) + '%' : '—';
    var tags = (Array.isArray(s.tags) && s.tags.length)
      ? s.tags.map(function(t) {
          return '<span style="background:var(--surface2);border:1px solid var(--border);' +
                 'border-radius:3px;padding:1px 5px;font-size:10px">' + esc(t) + '</span>';
        }).join(' ')
      : '';
    return (
      '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);' +
      'padding:12px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
            '<span style="font-family:var(--mono);font-size:13px;font-weight:600">' + esc(s.name) + '</span>' +
            '<span style="font-size:10px;font-family:var(--mono);padding:1px 6px;border-radius:3px;' +
              'border:1px solid ' + statusColor + ';color:' + statusColor + '">' + esc(s.status) + '</span>' +
            '<span style="font-size:10px;color:var(--text-muted);font-family:var(--mono)">' + esc(s.agent_role || '') + '</span>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">' + esc(s.description || '') + '</div>' +
          '<div style="display:flex;gap:12px;font-size:11px;font-family:var(--mono);color:var(--text-muted);margin-bottom:4px">' +
            '<span>confidence: ' + conf + '</span>' +
            '<span>invocations: ' + (s.invocation_count || 0) + '</span>' +
            '<span>success: ' + successRate + '</span>' +
          '</div>' +
          (tags ? '<div style="display:flex;gap:4px;flex-wrap:wrap">' + tags + '</div>' : '') +
        '</div>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--text-muted);flex-shrink:0" ' +
          'onclick="doDeprecateSkill(' + JSON.stringify(s.name) + ')" ' +
          'title="Deprecate skill">✕</button>' +
      '</div>'
    );
  }).join('');
}

function importSkillFile() {
  var contentEl = document.getElementById('skill-import-content');
  var resultEl  = document.getElementById('skill-import-result');
  var content   = contentEl ? contentEl.value.trim() : '';
  if (!content) {
    if (resultEl) resultEl.textContent = 'Paste or upload a skill file first.';
    return;
  }
  if (resultEl) resultEl.textContent = 'Importing…';
  apiFetch('/api/skills/import', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ content: content }),
  })
  .then(function(r){ return r.json(); })
  .then(function(d) {
    var msg = d.result || d.error || 'done';
    if (resultEl) resultEl.textContent = msg;
    if (d.result && d.result !== 'error' && d.result !== 'skipped') {
      if (contentEl) contentEl.value = '';
      toast('Skill ' + d.result, 'ok');
      loadSkills();
    } else if (d.result === 'skipped') {
      toast('Skill unchanged (hash match)', 'ok');
    } else {
      toast('Import failed: ' + msg, 'err');
    }
  })
  .catch(function(e) {
    if (resultEl) resultEl.textContent = 'Error: ' + e.message;
    toast('Import error: ' + e.message, 'err');
  });
}

function loadSkillFileInput(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var contentEl = document.getElementById('skill-import-content');
    if (contentEl) contentEl.value = e.target.result;
    input.value = '';
  };
  reader.readAsText(file);
}

function doDeprecateSkill(name) {
  if (!confirm('Deprecate skill "' + name + '"?\n\nIt will be moved to deprecated/ and removed from active recall. This cannot be undone from the UI.')) return;
  apiFetch('/api/skills/' + encodeURIComponent(name), { method: 'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.ok) {
        toast('Skill deprecated', 'ok');
        loadSkills();
      } else {
        toast('Deprecate failed: ' + (d.error || 'unknown'), 'err');
      }
    })
    .catch(function(e){ toast('Error: ' + e.message, 'err'); });
}

// -- Proposed Changes ---------------------------------------------------------

var _currentChangeId = null;

function loadPendingChanges() {
  apiFetch('/api/pending-changes')
    .then(function(r){ return r.json(); })
    .then(function(changes) {
      var pending = changes.filter(function(c){ return c.status === 'pending'; });
      var badge = document.getElementById('changes-count-badge');
      if (badge) badge.textContent = pending.length + ' pending / ' + changes.length + ' total';
      var empty = document.getElementById('changes-empty');
      var list  = document.getElementById('changes-list');
      if (!list) return;
      if (changes.length === 0) {
        if (empty) empty.style.display = 'block';
        list.innerHTML = '';
        return;
      }
      if (empty) empty.style.display = 'none';
      list.innerHTML = changes.map(function(c) {
        var statusColor = c.status === 'approved' ? 'var(--green)' : c.status === 'rejected' ? 'var(--red)' : 'var(--accent)';
        var rubric = c.rubricGaps && c.rubricGaps.length ? c.rubricGaps.join(', ') : 'none specified';
        var changeTypeBadge = c.changeType ? '<span style="font-size:10px;font-family:var(--mono);background:rgba(127,127,127,0.12);border-radius:3px;padding:1px 5px;margin-left:6px">' + escHtml(c.changeType) + '</span>' : '';
        var reviewerBadge = '';
        if (c.status === 'pending') {
          if (!c.reviewerVerdict) {
            reviewerBadge = '<span style="font-size:10px;color:var(--text-dim);border:1px solid var(--border);border-radius:3px;padding:1px 5px;margin-left:4px">awaiting R1 review</span>';
          } else if (c.reviewerVerdict === 'approved') {
            reviewerBadge = '<span style="font-size:10px;color:var(--green);border:1px solid var(--green);border-radius:3px;padding:1px 5px;margin-left:4px">R1: approved</span>';
          } else {
            reviewerBadge = '<span style="font-size:10px;color:var(--red);border:1px solid var(--red);border-radius:3px;padding:1px 5px;margin-left:4px">R1: flagged</span>';
          }
        }
        return '<div style="border:1px solid ' + (c.reviewerVerdict === 'flagged' && c.status === 'pending' ? 'rgba(220,50,50,0.35)' : 'var(--border)') + ';border-radius:6px;padding:14px 16px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px;">' +
            '<div style="display:flex;flex-direction:column;gap:3px;">' +
              '<span style="font-size:13px;font-weight:600;font-family:var(--mono)">' + escHtml(c.file) + changeTypeBadge + '</span>' +
              '<span style="font-size:11px;color:var(--text-dim)">by ' + escHtml(c.agent) + ' - ' + new Date(c.timestamp).toLocaleString() + ' - rubric: ' + escHtml(rubric) + '</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:4px">' +
              reviewerBadge +
              '<span style="font-size:11px;font-weight:600;color:' + statusColor + ';text-transform:uppercase;white-space:nowrap">' + c.status + '</span>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;line-height:1.5">' + escHtml(c.rationale.slice(0, 200)) + (c.rationale.length > 200 ? '...' : '') + '</div>' +
          (c.reviewerVerdict === 'flagged' && c.reviewerNote && c.status === 'pending'
            ? '<div style="font-size:11px;background:rgba(220,50,50,0.07);border-left:3px solid var(--red);padding:6px 10px;margin-bottom:8px;border-radius:0 4px 4px 0;color:var(--text-dim)"><strong style="color:var(--red)">R1 flagged:</strong> ' + escHtml(c.reviewerNote.slice(0, 300)) + '</div>'
            : c.reviewerVerdict === 'approved' && c.reviewerNote && c.status === 'pending'
              ? '<div style="font-size:11px;background:rgba(50,180,50,0.07);border-left:3px solid var(--green);padding:6px 10px;margin-bottom:8px;border-radius:0 4px 4px 0;color:var(--text-dim)"><strong style="color:var(--green)">R1 approved:</strong> ' + escHtml(c.reviewerNote.slice(0, 300)) + '</div>'
              : '') +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<button class="btn btn-ghost btn-sm" onclick="openChangeModal(' + JSON.stringify(c.id) + ')">View diff</button>' +
            (c.status === 'pending'
              ? '<button class="btn btn-primary btn-sm" onclick="approveChange(' + JSON.stringify(c.id) + ')">Approve</button>' +
                '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="rejectChange(' + JSON.stringify(c.id) + ')">Reject</button>'
              : '') +
          '</div>' +
        '</div>';
      }).join('');
    })
    .catch(function(e){ toast('Error loading changes: ' + e.message, 'err'); });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function openChangeModal(id) {
  _currentChangeId = id;
  apiFetch('/api/pending-changes')
    .then(function(r){ return r.json(); })
    .then(function(changes) {
      var c = changes.find(function(x){ return x.id === id; });
      if (!c) { toast('Change not found', 'err'); return; }
      var title = document.getElementById('change-modal-title');
      var body  = document.getElementById('change-modal-body');
      var acts  = document.getElementById('change-modal-actions');
      if (title) title.textContent = c.file;
      var reviewerSection = '';
      if (c.reviewerVerdict) {
        var rvColor = c.reviewerVerdict === 'approved' ? 'var(--green)' : 'var(--red)';
        reviewerSection =
          '<div style="margin-bottom:12px;padding:8px 12px;border-radius:4px;border:1px solid ' + rvColor + ';background:' + (c.reviewerVerdict === 'approved' ? 'rgba(50,180,50,0.07)' : 'rgba(220,50,50,0.07)') + '">' +
            '<div style="font-size:11px;font-weight:600;color:' + rvColor + ';text-transform:uppercase;margin-bottom:4px">R1 Reviewer: ' + c.reviewerVerdict + '</div>' +
            (c.reviewerNote ? '<div style="font-size:12px;color:var(--text-dim)">' + escHtml(c.reviewerNote) + '</div>' : '') +
            (c.reviewerAt ? '<div style="font-size:10px;color:var(--text-dim);margin-top:4px">Reviewed at: ' + new Date(c.reviewerAt).toLocaleString() + '</div>' : '') +
          '</div>';
      } else if (c.status === 'pending') {
        reviewerSection = '<div style="margin-bottom:12px;padding:6px 10px;border-radius:4px;border:1px solid var(--border);font-size:11px;color:var(--text-dim)">R1 review pending (deepseek-r1:671b -- may take up to 10 minutes)</div>';
      }
      if (body) body.innerHTML =
        '<div style="margin-bottom:12px;font-size:12px;color:var(--text-dim)">' +
          '<strong>Agent:</strong> ' + escHtml(c.agent) + ' - ' +
          '<strong>Type:</strong> ' + escHtml(c.changeType || 'src-change') + ' - ' +
          '<strong>Triggered by:</strong> ' + escHtml(c.triggeredBy) + ' - ' +
          '<strong>Rubric gaps:</strong> ' + escHtml((c.rubricGaps||[]).join(', ')||'none') +
        '</div>' +
        reviewerSection +
        '<div style="margin-bottom:10px;font-size:13px;line-height:1.6">' + escHtml(c.rationale) + '</div>' +
        '<div style="margin-bottom:6px;font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase">Original (will be removed)</div>' +
        '<pre style="background:rgba(220,50,50,0.08);border:1px solid rgba(220,50,50,0.2);border-radius:4px;padding:10px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-all">' + escHtml(c.original) + '</pre>' +
        '<div style="margin:10px 0 6px;font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase">Replacement (will be inserted)</div>' +
        '<pre style="background:rgba(50,180,50,0.08);border:1px solid rgba(50,180,50,0.2);border-radius:4px;padding:10px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-all">' + escHtml(c.replacement) + '</pre>' +
        (c.reviewNote ? '<div style="margin-top:10px;font-size:12px;color:var(--text-dim)"><strong>Review note:</strong> ' + escHtml(c.reviewNote) + '</div>' : '');
      if (acts) acts.innerHTML = c.status === 'pending'
        ? '<button class="btn btn-ghost btn-sm" onclick="closeChangeModal()">Close</button>' +
          '<button class="btn btn-primary btn-sm" onclick="approveChange(' + JSON.stringify(id) + ',true)">Approve and apply</button>' +
          '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="rejectChange(' + JSON.stringify(id) + ',true)">Reject</button>'
        : '<button class="btn btn-primary btn-sm" onclick="closeChangeModal()">Close</button>';
      var overlay = document.getElementById('change-overlay');
      if (overlay) { overlay.style.display = 'flex'; }
    });
}

function closeChangeModal() {
  var overlay = document.getElementById('change-overlay');
  if (overlay) overlay.style.display = 'none';
  _currentChangeId = null;
}

function approveChange(id, fromModal) {
  if (!confirm('Apply this patch to the source file on disk? You will need to rebuild the container for it to take effect.')) return;
  apiFetch('/api/pending-changes/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: '{}' })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.ok) {
        toast('Patch applied to ' + d.file + '. Rebuild to activate.', 'ok');
        if (fromModal) closeChangeModal();
        loadPendingChanges();
      } else {
        toast('Approve failed: ' + (d.error || 'unknown'), 'err');
        loadPendingChanges();
      }
    })
    .catch(function(e){ toast('Error: ' + e.message, 'err'); });
}

function rejectChange(id, fromModal) {
  var note = prompt('Optional rejection note:') || '';
  apiFetch('/api/pending-changes/' + encodeURIComponent(id) + '/reject', {
    method: 'POST',
    body: JSON.stringify({ note: note })
  })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.ok) {
        toast('Change rejected', 'ok');
        if (fromModal) closeChangeModal();
        loadPendingChanges();
      } else {
        toast('Reject failed: ' + (d.error || 'unknown'), 'err');
      }
    })
    .catch(function(e){ toast('Error: ' + e.message, 'err'); });
}

function exportPendingChanges() {
  window.location.href = '/api/pending-changes/export';
}

// -- User Management -----------------------------------------------------------

var managedUsers = [];
var editingUserId = null;

function loadManagedUsers() {
  apiFetch('/api/users')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (data.error) { toast(data.error, 'err'); return; }
      managedUsers = data;
      renderManagedUsers();
    })
    .catch(function(e){ toast('Failed to load users: ' + e.message, 'err'); });
}

function renderManagedUsers() {
  var rows = document.getElementById('user-mgmt-rows');
  if (!managedUsers.length) {
    rows.innerHTML = '<div class="empty"><div class="empty-icon">[ ]</div>No users found.</div>';
    return;
  }
  rows.innerHTML = managedUsers.map(function(u) {
    var isSelf = u.email === authEmail;
    var roleClass = u.role === 'admin' ? 'badge-provider' : 'badge-model';
    return '<div class="card">' +
      '<div class="card-header">' +
        '<div class="card-icon">' + esc((u.displayName || u.email).charAt(0).toUpperCase()) + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="card-name">' + esc(u.displayName || u.email) + (isSelf ? ' <span style="font-size:11px;color:var(--text-dim)">(you)</span>' : '') + '</div>' +
          '<div class="card-meta">' + esc(u.email) + '</div>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn btn-ghost btn-sm" onclick="openEditUserModal(' + esc(JSON.stringify(u.id)) + ')">Edit</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="openResetPasswordModal(' + esc(JSON.stringify(u.id)) + ')">Password</button>' +
          (!isSelf ? '<button class="btn btn-danger btn-sm" onclick="deleteUserById(' + esc(JSON.stringify(u.id)) + ', ' + esc(JSON.stringify(u.displayName || u.email)) + ')">Del</button>' : '') +
        '</div>' +
      '</div>' +
      '<div class="badges">' +
        '<span class="badge ' + roleClass + '">' + esc(u.role) + '</span>' +
        '<span class="badge badge-type">joined ' + (u.createdAt ? u.createdAt.slice(0,10) : '?') + '</span>' +
        (u.lastActive ? '<span class="badge badge-disabled">active ' + u.lastActive.slice(0,10) + '</span>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// -- Add User Modal ------------------------------------------------------------

function openAddUserModal() {
  editingUserId = null;
  document.getElementById('new-user-email').value    = '';
  document.getElementById('new-user-name').value     = '';
  document.getElementById('new-user-password').value = '';
  document.getElementById('new-user-role').value     = 'user';
  var err = document.getElementById('add-user-error');
  err.style.display = 'none';
  err.textContent   = '';
  document.getElementById('add-user-overlay').classList.add('open');
  document.getElementById('new-user-email').focus();
}

function closeAddUserModal() {
  _resetAddUserModal();
  document.getElementById('add-user-overlay').classList.remove('open');
}

function maybeCloseAddUser(e) {
  if (e.target === document.getElementById('add-user-overlay')) closeAddUserModal();
}

function saveNewUser() {
  var email    = document.getElementById('new-user-email').value.trim();
  var name     = document.getElementById('new-user-name').value.trim();
  var password = document.getElementById('new-user-password').value;
  var role     = document.getElementById('new-user-role').value;

  var errEl = document.getElementById('add-user-error');
  function showErr(msg) {
    errEl.textContent   = msg;
    errEl.style.display = 'block';
  }

  if (!email) { showErr('Email is required.'); return; }
  if (!password) { showErr('Password is required.'); return; }
  if (password.length < 8) { showErr('Password must be at least 8 characters.'); return; }

  var payload = { email: email, displayName: name || email, password: password, role: role };
  apiFetch('/api/users', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.error) { showErr(d.error); return; }
      toast('User created', 'ok');
      closeAddUserModal();
      loadManagedUsers();
    })
    .catch(function(e){ showErr('Request failed: ' + e.message); });
}

// -- Edit User Modal (reuses add-user overlay, mutates title+fields) -----------

function openEditUserModal(userId) {
  var user = managedUsers.find(function(u){ return u.id === userId; });
  if (!user) { toast('User not found', 'err'); return; }
  editingUserId = userId;

  // Repurpose the add-user modal for editing (swap title, hide password, prefill)
  document.querySelector('#add-user-overlay .modal-title').textContent = 'Edit User';
  document.getElementById('new-user-email').value    = user.email;
  document.getElementById('new-user-email').disabled = true;
  document.getElementById('new-user-name').value     = user.displayName || '';
  document.getElementById('new-user-password').value = '';
  // Hide password field when editing -- use separate Password button
  document.getElementById('new-user-password').closest('.field').style.display = 'none';
  document.getElementById('new-user-role').value = user.role;

  var err = document.getElementById('add-user-error');
  err.style.display = 'none';
  err.textContent   = '';

  // Swap Create button label
  var createBtn = document.querySelector('#add-user-overlay .modal-foot .btn-primary');
  createBtn.textContent = 'Save Changes';
  createBtn.setAttribute('onclick', 'saveEditUser()');

  document.getElementById('add-user-overlay').classList.add('open');
}

function saveEditUser() {
  if (!editingUserId) return;
  var name = document.getElementById('new-user-name').value.trim();
  var role = document.getElementById('new-user-role').value;
  var user = managedUsers.find(function(u){ return u.id === editingUserId; });
  if (!user) return;

  // Prevent self-demotion in UI
  if (user.email === authEmail && role !== user.role) {
    document.getElementById('add-user-error').textContent = 'Cannot change your own role.';
    document.getElementById('add-user-error').style.display = 'block';
    return;
  }

  var payload = { displayName: name, role: role };
  apiFetch('/api/users/' + encodeURIComponent(editingUserId), {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload),
  })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.error) {
        document.getElementById('add-user-error').textContent = d.error;
        document.getElementById('add-user-error').style.display = 'block';
        return;
      }
      toast('User updated', 'ok');
      _resetAddUserModal();
      closeAddUserModal();
      loadManagedUsers();
    })
    .catch(function(e){
      document.getElementById('add-user-error').textContent = 'Request failed: ' + e.message;
      document.getElementById('add-user-error').style.display = 'block';
    });
}

// Reset add-user modal back to create-mode state after edit
function _resetAddUserModal() {
  document.querySelector('#add-user-overlay .modal-title').textContent = 'Add User';
  document.getElementById('new-user-email').disabled = false;
  document.getElementById('new-user-password').closest('.field').style.display = '';
  var createBtn = document.querySelector('#add-user-overlay .modal-foot .btn-primary');
  createBtn.textContent = 'Create User';
  createBtn.setAttribute('onclick', 'saveNewUser()');
  editingUserId = null;
}

// -- Reset Password (inline prompt, no extra modal needed) --------------------

function openResetPasswordModal(userId) {
  var user = managedUsers.find(function(u){ return u.id === userId; });
  if (!user) return;
  var isSelf = user.email === authEmail;
  var label  = isSelf ? 'Enter new password (min 8 chars):' : 'New password for ' + user.email + ' (min 8 chars):';
  var pw = window.prompt(label);
  if (!pw) return;
  if (pw.length < 8) { toast('Password must be at least 8 characters', 'err'); return; }

  var url = isSelf
    ? '/api/users/me/password'
    : '/api/users/' + encodeURIComponent(userId) + '/password';

  apiFetch(url, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ password: pw }),
  })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.error) { toast(d.error, 'err'); return; }
      toast('Password updated', 'ok');
    })
    .catch(function(e){ toast('Failed: ' + e.message, 'err'); });
}

// -- Delete User ---------------------------------------------------------------

function deleteUserById(userId, label) {
  if (!confirm('Delete user "' + label + '"? This cannot be undone.')) return;
  apiFetch('/api/users/' + encodeURIComponent(userId), { method: 'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.error) { toast(d.error, 'err'); return; }
      toast('User deleted', 'ok');
      loadManagedUsers();
    })
    .catch(function(e){ toast('Delete failed: ' + e.message, 'err'); });
}

// ============================================================================
// CHAT PANEL
// ============================================================================

var currentConvId    = null;   // active conversation ID (null = new chat)
var chatMessages     = [];     // { role, content, ts } displayed in current conv
var chatStreaming     = false;  // true while SSE stream is open
var chatConvList     = [];     // ConversationMeta[] for sidebar

// -- TAB_LOADERS entry -------------------------------------------------------
// Injected at runtime -- see TAB_LOADERS definition above.
// TAB_LOADERS['chat'] is set below after functions are defined.

// -- Sidebar -----------------------------------------------------------------

// -- AIWiki project binding -----------------------------------------------------
// The selected project is the conversation's bound project: agents see and
// write only that project's memory. Chosen here by the user, never by a model.

var chatProject  = null;
var chatProjects = [];

function chatLoadProjects() {
  apiFetch('/api/wiki/status').then(function(r){ return r.json(); }).then(function(st) {
    var bar = document.getElementById('chat-project-bar');
    if (!st || !st.enabled) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    return apiFetch('/api/wiki/projects').then(function(r){ return r.json(); }).then(function(list) {
      chatProjects = Array.isArray(list) ? list.map(function(p){ return p.project; }) : [];
      renderChatProjectSelect();
    });
  }).catch(function(){});
}

function renderChatProjectSelect() {
  var sel = document.getElementById('chat-project-select');
  if (!sel) return;
  var names = chatProjects.slice();
  if (chatProject && names.indexOf(chatProject) === -1) names.unshift(chatProject);
  sel.innerHTML = '<option value="">No project (general)</option>' +
    names.map(function(n){ return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') +
    '<option value="__new__">+ New project...</option>';
  sel.value = chatProject || '';
  var hint = document.getElementById('chat-project-hint');
  if (hint) hint.textContent = chatProject
    ? 'Agents read and update this project\'s memory; other projects are hidden.'
    : 'Agents can see all your projects but write to none.';
}

function chatProjectChanged() {
  var sel = document.getElementById('chat-project-select');
  var v = sel.value;
  if (v === '__new__') {
    var name = window.prompt('New project name (letters, digits, dashes):', '');
    var slug = (name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    if (!slug) { renderChatProjectSelect(); return; }
    if (chatProjects.indexOf(slug) === -1) chatProjects.unshift(slug);
    v = slug;
  }
  chatProject = v || null;
  renderChatProjectSelect();
  if (currentConvId) {
    apiFetch('/api/conversations/' + encodeURIComponent(currentConvId) + '/project', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: chatProject })
    }).then(function(){ loadChatConvList(); }).catch(function(){});
  }
}

function loadChatConvList() {
  apiFetch('/api/conversations')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (data.error) return;
      chatConvList = Array.isArray(data) ? data : [];
      renderChatSidebar();
    })
    .catch(function(){});
}

function renderChatSidebar() {
  var list = document.getElementById('chat-conv-list');
  if (!chatConvList.length) {
    list.innerHTML = '<div style="padding:16px;font-size:11px;color:var(--text-muted);font-family:var(--mono);">No conversations yet.</div>';
    return;
  }
  list.innerHTML = chatConvList.map(function(c) {
    var active = c.id === currentConvId ? ' active' : '';
    var date   = c.lastActive ? c.lastActive.slice(0,10) : '';
    return '<div class="chat-conv-item' + active + '" onclick="chatOpenConv(' + esc(JSON.stringify(c.id)) + ')">' +
      '<div class="chat-conv-title">' + esc(c.title || 'Untitled') + '</div>' +
      '<div class="chat-conv-meta">' + esc(date) + (c.project ? ' &middot; ' + esc(c.project) : '') + '</div>' +
    '</div>';
  }).join('');
}

function chatOpenConv(convId) {
  if (chatStreaming) return;
  currentConvId = convId;
  var meta = chatConvList.filter(function(c){ return c.id === convId; })[0];
  chatProject = (meta && meta.project) || null;
  renderChatProjectSelect();
  chatMessages  = [];
  renderChatSidebar();
  renderChatMessages();
  // Load message history from disk
  apiFetch('/api/conversations/' + encodeURIComponent(convId) + '/messages')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (!Array.isArray(data)) return;
      chatMessages = data.map(function(m) {
        return { role: m.role, content: m.content, ts: m.ts };
      });
      renderChatMessages();
      chatScrollBottom();
    })
    .catch(function(){});
}

function chatNewConversation() {
  if (chatStreaming) return;
  currentConvId = null;
  chatMessages  = [];
  renderChatSidebar();
  renderChatMessages();
  document.getElementById('chat-input').focus();
}

// -- Message rendering -------------------------------------------------------

function renderChatMessages() {
  var container = document.getElementById('chat-messages');
  if (!chatMessages.length) {
    container.innerHTML =
      '<div style="margin:auto;text-align:center;color:var(--text-muted);font-size:13px;">' +
      '<div style="font-size:28px;margin-bottom:12px;opacity:.3;">&#x25A1;</div>' +
      'Start a conversation' +
      '</div>';
    return;
  }
  container.innerHTML = chatMessages.map(function(m) {
    var isUser = m.role === 'user';
    var ts = m.ts ? new Date(m.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
    return '<div class="chat-msg ' + (isUser ? 'user' : 'asst') + '">' +
      '<div class="chat-bubble">' + renderChatContent(m.content, isUser) + '</div>' +
      (ts ? '<div class="chat-ts">' + esc(ts) + '</div>' : '') +
    '</div>';
  }).join('');
}

// Minimal pipeline-aware markdown renderer.
function renderChatContent(raw, isUser) {
  if (isUser) return esc(raw);

  // Strip the CLARIFY_MARKER
  raw = raw.split('<!' + '--' + ' __CLARIFY__ ' + '--' + '>').join('');

  // Process <details>...</details> blocks using indexOf (no regex with </)
  var out = '';
  var rest = raw;
  while (true) {
    var ds = rest.indexOf('<details>');
    if (ds === -1) { out += rest; break; }
    out += rest.slice(0, ds);
    rest = rest.slice(ds + 9); // skip <details>
    var de = rest.indexOf('</details>');
    if (de === -1) { out += rest; break; }
    var inner = rest.slice(0, de);
    rest = rest.slice(de + 10); // skip </details>
    var ss = inner.indexOf('<summary>');
    var se = inner.indexOf('</summary>');
    var summary = (ss !== -1 && se !== -1) ? inner.slice(ss + 9, se) : 'Details';
    var body = (se !== -1) ? inner.slice(se + 10).trim() : inner;
    out += '__DET__' + esc(summary) + '__SEP__' + esc(body) + '__END__';
  }
  raw = out;

  var lines  = raw.split(String.fromCharCode(10));
  var output = [];
  var inCode  = false;
  var codeBuf = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    // Fenced code blocks (triple backtick = char code 96 x3)
    if (trimmed.charCodeAt(0) === 96 && trimmed.charCodeAt(1) === 96 && trimmed.charCodeAt(2) === 96) {
      if (inCode) {
        output.push('<pre>' + esc(codeBuf.join(String.fromCharCode(10))) + '</pre>');
        codeBuf = []; inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // HR
    if (trimmed === '---' || trimmed === '----' || trimmed === '-----') {
      output.push('<hr>');
      continue;
    }

    // Details placeholder
    if (line.startsWith('__DET__')) {
      var p1 = line.indexOf('__SEP__');
      var p2 = line.indexOf('__END__');
      var sumEsc = p1 !== -1 ? line.slice(7, p1) : '';
      var bdyEsc = (p1 !== -1 && p2 !== -1) ? line.slice(p1 + 7, p2) : '';
      var after  = p2 !== -1 ? line.slice(p2 + 7) : '';
      output.push(
        '<details><summary>' + sumEsc + '</summary>' +
        '<div class="detail-body">' + bdyEsc + '</div></details>'
      );
      if (after) output.push('<span>' + inlineFormat(after) + '</span>');
      continue;
    }

    // Status lines (> **[...]**)
    if (line.startsWith('> ')) {
      var inner2 = line.slice(2);
      var cls    = 'chat-status-line';
      if (inner2.indexOf('[coordinator]') !== -1) cls += ' coord';
      else if (inner2.indexOf('[done]') !== -1)   cls += ' done';
      else if (inner2.indexOf('max retries') !== -1) cls += ' warn';
      output.push('<span class="' + cls + '">' + inlineFormat(inner2) + '</span>');
      continue;
    }

    output.push('<span>' + inlineFormat(line) + '</span>');
  }

  if (inCode) output.push('<pre>' + esc(codeBuf.join(String.fromCharCode(10))) + '</pre>');

  return output.join(String.fromCharCode(10));
}

// Inline markdown: bold, em, code -- no regex with special HTML chars
function inlineFormat(text) {
  var s = esc(text);
  // bold -- replace pairs of ** using split
  s = s.split('**').map(function(part, i) {
    return i % 2 === 1 ? '<strong>' + part + '</strong>' : part;
  }).join('');
  // em -- replace pairs of * using split
  s = s.split('*').map(function(part, i) {
    return i % 2 === 1 ? '<em>' + part + '</em>' : part;
  }).join('');
  // code (backtick, char code 96)
  var bt = String.fromCharCode(96);
  s = s.split(bt).map(function(part, i) {
    return i % 2 === 1 ? '<code>' + part + '</code>' : part;
  }).join('');
  return s;
}

function chatScrollBottom() {
  var el = document.getElementById('chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
}

// -- Streaming assistant message ---------------------------------------------

function chatAppendStreamingBubble() {
  var container = document.getElementById('chat-messages');
  var div = document.createElement('div');
  div.className  = 'chat-msg asst';
  div.id         = 'chat-streaming-msg';
  div.innerHTML  =
    '<div class="chat-bubble" id="chat-streaming-bubble">' +
    '<div class="chat-typing"><span></span><span></span><span></span></div>' +
    '</div>';
  container.appendChild(div);
  chatScrollBottom();
}

function chatUpdateStreamingBubble(fullContent) {
  var bubble = document.getElementById('chat-streaming-bubble');
  if (!bubble) return;
  bubble.innerHTML = renderChatContent(fullContent, false);
  chatScrollBottom();
}

function chatFinalizeStreamingBubble(fullContent, ts) {
  var msg = document.getElementById('chat-streaming-msg');
  if (!msg) return;
  var tsStr = ts ? new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
  msg.removeAttribute('id');
  msg.querySelector('.chat-bubble').innerHTML = renderChatContent(fullContent, false);
  if (tsStr) {
    var tsEl = document.createElement('div');
    tsEl.className = 'chat-ts';
    tsEl.textContent = tsStr;
    msg.appendChild(tsEl);
  }
}

// -- Send + SSE --------------------------------------------------------------

function chatSend() {
  if (chatStreaming) return;
  var input = document.getElementById('chat-input');
  var msg   = input.value.trim();
  if (!msg) return;

  input.value = '';
  chatInputResize(input);

  // Append user message locally
  var now = Date.now();
  chatMessages.push({ role: 'user', content: msg, ts: now });

  // If this is a fresh conversation, render the user bubble manually
  // (renderChatMessages would clear the empty-state placeholder)
  var container = document.getElementById('chat-messages');
  // Clear empty state if needed
  var emptyEl = container.querySelector('div[style*="margin:auto"]');
  if (emptyEl) container.innerHTML = '';

  var tsStr = new Date(now).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  var userDiv = document.createElement('div');
  userDiv.className = 'chat-msg user';
  userDiv.innerHTML =
    '<div class="chat-bubble">' + esc(msg) + '</div>' +
    '<div class="chat-ts">' + esc(tsStr) + '</div>';
  container.appendChild(userDiv);
  chatScrollBottom();

  // Disable input
  chatStreaming = true;
  input.disabled = true;
  document.getElementById('chat-send-btn').disabled = true;

  // Show typing indicator
  chatAppendStreamingBubble();

  var body = JSON.stringify({ message: msg, conversationId: currentConvId || undefined, project: chatProject });
  var streamContent = '';

  fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + authToken,
    },
    body: body,
  })
  .then(function(res) {
    if (!res.ok) {
      return res.json().then(function(d) { throw new Error(d.error || 'Request failed'); });
    }
    var reader  = res.body.getReader();
    var decoder = new TextDecoder();
    var buf     = '';

    function pump() {
      return reader.read().then(function(chunk) {
        if (chunk.done) {
          chatFinishStream(streamContent);
          return;
        }
        buf += decoder.decode(chunk.value, { stream: true });
        var lines = buf.split(String.fromCharCode(10));
        buf = lines.pop(); // keep incomplete line
        lines.forEach(function(line) {
          if (!line.startsWith('data: ')) return;
          var json = line.slice(6).trim();
          if (!json) return;
          try {
            var evt = JSON.parse(json);
            if (evt.type === 'init') {
              // Server assigned a conversationId -- store it
              if (!currentConvId) {
                currentConvId = evt.conversationId;
              }
              if (evt.project !== undefined) { chatProject = evt.project || null; renderChatProjectSelect(); }
            } else if (evt.type === 'chunk') {
              streamContent += evt.content;
              chatUpdateStreamingBubble(streamContent);
            } else if (evt.type === 'done') {
              chatFinishStream(streamContent);
            } else if (evt.type === 'error') {
              chatFinishStream(streamContent || ('**Error:** ' + (evt.content || 'Unknown error')));
            }
          } catch(e) {}
        });
        return pump();
      });
    }
    return pump();
  })
  .catch(function(e) {
    chatFinishStream('**Error:** ' + e.message);
  });
}

function chatFinishStream(finalContent) {
  chatStreaming = false;
  var input = document.getElementById('chat-input');
  input.disabled = false;
  document.getElementById('chat-send-btn').disabled = false;
  input.focus();

  // Finalize bubble
  chatFinalizeStreamingBubble(finalContent, Date.now());

  // Store in local messages array
  chatMessages.push({ role: 'assistant', content: finalContent, ts: Date.now() });

  // Refresh sidebar (new conv will now appear)
  loadChatConvList();
}

// -- Input helpers -----------------------------------------------------------

function chatInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatSend();
  }
}

function chatInputResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

// Wire TAB_LOADERS
TAB_LOADERS['chat'] = function() {
  chatLoadProjects();
  loadChatConvList();
};

// Chat list loaded by initApp on auth success.

// -- BulletTrain tab -----------------------------------------------------------
// Alpha UI: project list -> create -> start run -> poll status.json -> download.

var btProjects = [];
var btCurrentSlug = null;
var btPollTimer = null;

function btInit() {
  btBackToProjects();
  btLoadProjects();
}

function btLoadProjects() {
  apiFetch('/api/bullettrain/projects')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      btProjects = d.projects || [];
      btRenderProjectList();
    })
    .catch(function() {});
}

function btRenderProjectList() {
  var rows = document.getElementById('bt-projects-rows');
  var empty = document.getElementById('bt-projects-empty');
  if (!btProjects.length) {
    empty.style.display = 'block';
    rows.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  rows.innerHTML = btProjects.map(function(p) {
    var runLabel = p.current_run
      ? '<span style="color:var(--accent)">run ' + p.current_run + ' running</span>'
      : (p.last_run ? 'last run ' + p.last_run : 'no runs yet');
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);cursor:pointer;" onclick="btOpenProject(\'' + p.slug + '\')">' +
      '<div><div style="font-size:13px;font-weight:600">' + escapeHtml(p.title) + '</div>' +
      '<div style="font-size:11px;font-family:var(--mono);color:var(--text-dim)">' + escapeHtml(p.slug) + '</div></div>' +
      '<div style="font-size:11px;font-family:var(--mono);color:var(--text-dim)">' + runLabel + '</div>' +
      '</div>';
  }).join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

function btShowNewProjectForm() {
  document.getElementById('bt-project-list-view').style.display = 'none';
  document.getElementById('bt-project-detail').style.display = 'none';
  document.getElementById('bt-new-project-form').style.display = 'block';
  document.getElementById('bt-new-project-error').style.display = 'none';
  document.getElementById('bt-new-title').value = '';
  document.getElementById('bt-new-slug').value = '';
  document.getElementById('bt-new-brief').value = '';
}

function btCancelNewProject() {
  document.getElementById('bt-new-project-form').style.display = 'none';
  document.getElementById('bt-project-list-view').style.display = 'block';
}

function btLoadBriefFile(evt) {
  var file = evt.target.files && evt.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function() { document.getElementById('bt-new-brief').value = reader.result; };
  reader.readAsText(file);
}

function btCreateProject() {
  var title = document.getElementById('bt-new-title').value.trim();
  var slug  = document.getElementById('bt-new-slug').value.trim();
  var brief = document.getElementById('bt-new-brief').value;
  var errEl = document.getElementById('bt-new-project-error');
  errEl.style.display = 'none';
  if (!title || !slug || !brief.trim()) {
    errEl.textContent = 'Title, slug, and brief are all required.';
    errEl.style.display = 'block';
    return;
  }
  apiFetch('/api/bullettrain/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title, slug: slug, brief: brief }),
  })
  .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(res) {
    if (!res.ok) { errEl.textContent = res.d.error || 'Failed to create project.'; errEl.style.display = 'block'; return; }
    document.getElementById('bt-new-project-form').style.display = 'none';
    btLoadProjects();
    btOpenProject(res.d.project.slug);
  })
  .catch(function(e) { errEl.textContent = 'Network error: ' + e.message; errEl.style.display = 'block'; });
}

function btBackToProjects() {
  if (btPollTimer) { clearInterval(btPollTimer); btPollTimer = null; }
  btCurrentSlug = null;
  document.getElementById('bt-new-project-form').style.display = 'none';
  document.getElementById('bt-project-detail').style.display = 'none';
  document.getElementById('bt-project-list-view').style.display = 'block';
  btLoadProjects();
}

function btOpenProject(slug) {
  btCurrentSlug = slug;
  document.getElementById('bt-project-list-view').style.display = 'none';
  document.getElementById('bt-new-project-form').style.display = 'none';
  document.getElementById('bt-project-detail').style.display = 'block';
  document.getElementById('bt-download-btn').style.display = 'none';
  document.getElementById('bt-run-status').style.display = 'none';
  document.getElementById('bt-tasks-rows').innerHTML = '';

  apiFetch('/api/bullettrain/projects/' + encodeURIComponent(slug))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      document.getElementById('bt-detail-title').textContent = d.project.title + '  (' + d.project.slug + ')';
      var startBtn = document.getElementById('bt-start-run-btn');
      startBtn.disabled = !!d.project.current_run;
      startBtn.textContent = d.project.current_run ? 'Run in progress...' : 'Start run';
      if (d.project.current_run) {
        btPollStatus(slug, d.project.current_run);
      } else if (d.project.last_run) {
        btPollStatus(slug, d.project.last_run, true);
      } else {
        document.getElementById('bt-tasks-empty').style.display = 'block';
      }
    })
    .catch(function() {});
}

function btStartRun() {
  if (!btCurrentSlug) return;
  var btn = document.getElementById('bt-start-run-btn');
  btn.disabled = true;
  btn.textContent = 'Starting...';
  apiFetch('/api/bullettrain/projects/' + encodeURIComponent(btCurrentSlug) + '/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(res) {
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = 'Start run';
      alert(res.d.error || 'Failed to start run.');
      return;
    }
    btn.textContent = 'Run in progress...';
    btPollStatus(btCurrentSlug, res.d.runNo);
  })
  .catch(function(e) {
    btn.disabled = false;
    btn.textContent = 'Start run';
    alert('Network error: ' + e.message);
  });
}

function btPollStatus(slug, runNo, oneShot) {
  if (btPollTimer) { clearInterval(btPollTimer); btPollTimer = null; }

  function tick() {
    apiFetch('/api/bullettrain/projects/' + encodeURIComponent(slug) + '/runs/' + encodeURIComponent(runNo) + '/status')
      .then(function(r) { return r.json(); })
      .then(function(d) { btRenderStatus(slug, runNo, d); })
      .catch(function() {});
  }

  tick();
  if (!oneShot) btPollTimer = setInterval(tick, 3000);
}

var BT_MARK_LABEL = { ' ': 'pending', '>': 'in progress', 'x': 'verified', '!': 'blocked', '?': 'manual', '-': 'abandoned' };
var BT_MARK_COLOR = { ' ': 'var(--text-dim)', '>': 'var(--accent2)', 'x': 'var(--accent)', '!': 'var(--danger)', '?': 'var(--warn)', '-': 'var(--text-muted)' };

function btRenderStatus(slug, runNo, d) {
  var status = d.status;
  var tasks = d.tasks || [];
  var box = document.getElementById('bt-run-status');
  box.style.display = 'block';
  document.getElementById('bt-status-run').textContent = runNo;
  document.getElementById('bt-status-state').textContent = status.state + (status.halt_reason ? ' (' + status.halt_reason + ')' : '');
  document.getElementById('bt-status-phase').textContent = status.phase ? (' / ' + status.phase) : '';
  document.getElementById('bt-status-counters').textContent =
    status.counters.tasks_verified + '/' + status.counters.tasks_total + ' verified -- ' +
    'session ' + status.session_no + ' -- ' + status.counters.wall_seconds + 's';
  document.getElementById('bt-status-message').textContent = status.message || '';

  var terminal = (status.state === 'done' || status.state === 'halted' || status.state === 'failed' || status.state === 'cancelled');
  if (terminal && btPollTimer) { clearInterval(btPollTimer); btPollTimer = null; }
  if (terminal) {
    var startBtn = document.getElementById('bt-start-run-btn');
    startBtn.disabled = false;
    startBtn.textContent = 'Start run';
  }

  var dlBtn = document.getElementById('bt-download-btn');
  if (status.state === 'done') {
    dlBtn.style.display = 'inline-flex';
    dlBtn.href = '/api/bullettrain/projects/' + encodeURIComponent(slug) + '/runs/' + encodeURIComponent(runNo) + '/download';
  } else {
    dlBtn.style.display = 'none';
  }

  var empty = document.getElementById('bt-tasks-empty');
  var rows = document.getElementById('bt-tasks-rows');
  if (!tasks.length) {
    empty.style.display = 'block';
    rows.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  rows.innerHTML = tasks.map(function(t) {
    var color = BT_MARK_COLOR[t.mark] || 'var(--text-dim)';
    var label = BT_MARK_LABEL[t.mark] || t.mark;
    var errLine = t.error ? '<div style="color:var(--text-dim);margin-left:52px;">' + escapeHtml(t.error) + '</div>' : '';
    return '<div>' +
      '<span style="color:' + color + ';display:inline-block;min-width:104px;white-space:nowrap;padding-right:8px;">[' + label + ']</span>' +
      '<span style="color:var(--text-dim)">' + t.id + '</span> ' +
      escapeHtml(t.title) +
      '</div>' + errLine;
  }).join('');
}
