// Single-file WebUI for Orchestrail admin -- no external deps

export const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orchestrail</title>
<style>
  :root {
    --bg: #0b0d12;
    --surface: #13161e;
    --surface2: #1a1f2b;
    --border: #252b3a;
    --accent: #00c896;
    --accent-dim: rgba(0,200,150,0.12);
    --accent2: #4d9fff;
    --warn: #f59e0b;
    --danger: #ef4444;
    --text: #d4dae8;
    --text-dim: #6b7794;
    --text-muted: #3d4560;
    --mono: 'JetBrains Mono','Fira Code','Courier New',monospace;
    --sans: 'IBM Plex Sans','Segoe UI',system-ui,sans-serif;
    --r: 6px;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;}
  .app{display:flex;flex-direction:column;height:100vh;}

  .topbar{
    display:flex;align-items:center;gap:16px;
    padding:0 24px;height:52px;
    background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;
  }
  .logo{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:3px;color:var(--accent);text-transform:uppercase;}
  .logo span{color:var(--text-dim);font-weight:400;}
  .status-dot{width:8px;height:8px;border-radius:50%;background:var(--text-muted);margin-left:auto;transition:background .3s;}
  .status-dot.ok{background:var(--accent);box-shadow:0 0 8px var(--accent);}
  .status-dot.err{background:var(--danger);}
  .status-label{font-size:11px;color:var(--text-dim);font-family:var(--mono);}

  .tabs-bar{
    display:flex;padding:0 24px;
    background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;
  }
  .tab-btn{
    padding:12px 20px;border:none;background:none;cursor:pointer;
    color:var(--text-dim);font-size:13px;font-family:var(--sans);
    border-bottom:2px solid transparent;transition:all .15s;letter-spacing:.5px;
  }
  .tab-btn:hover{color:var(--text);}
  .tab-btn.active{color:var(--accent);border-bottom-color:var(--accent);}

  .content{flex:1;overflow-y:auto;padding:24px;}
  .tab-panel{display:none;}
  .tab-panel.active{display:block;}

  .section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;}
  .section-title{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--text-dim);font-family:var(--mono);}

  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;}
  .card{
    background:var(--surface);border:1px solid var(--border);
    border-radius:var(--r);padding:18px;transition:border-color .15s;
  }
  .card:hover{border-color:var(--text-muted);}
  .card-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:10px;}
  .card-icon{
    width:32px;height:32px;border-radius:4px;
    background:var(--accent-dim);display:flex;align-items:center;
    justify-content:center;font-size:14px;flex-shrink:0;
  }
  .card-name{font-weight:600;font-size:13px;color:var(--text);}
  .card-meta{font-size:11px;color:var(--text-dim);font-family:var(--mono);margin-top:2px;}
  .card-actions{margin-left:auto;display:flex;gap:6px;}
  .card-preview{
    font-size:12px;color:var(--text-dim);line-height:1.5;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
    overflow:hidden;margin-bottom:12px;
    border-left:2px solid var(--border);padding-left:10px;
  }
  .badges{display:flex;flex-wrap:wrap;gap:6px;}
  .badge{
    font-size:10px;font-family:var(--mono);letter-spacing:.5px;
    padding:2px 8px;border-radius:3px;border:1px solid;
  }
  .badge-model{color:var(--accent2);border-color:rgba(77,159,255,.25);background:rgba(77,159,255,.08);}
  .badge-tokens{color:var(--warn);border-color:rgba(245,158,11,.25);background:rgba(245,158,11,.08);}
  .badge-tool{color:var(--accent);border-color:rgba(0,200,150,.25);background:var(--accent-dim);}
  .badge-type{color:var(--text-dim);border-color:var(--border);background:var(--surface2);}
  .badge-enabled{color:var(--accent);border-color:rgba(0,200,150,.3);background:var(--accent-dim);}
  .badge-disabled{color:var(--text-muted);border-color:var(--border);}
  .badge-provider{color:#c084fc;border-color:rgba(192,132,252,.25);background:rgba(192,132,252,.08);}

  .btn{
    padding:6px 14px;border-radius:var(--r);border:1px solid;
    cursor:pointer;font-size:12px;font-family:var(--sans);
    transition:all .15s;display:inline-flex;align-items:center;gap:6px;
  }
  .btn-primary{background:var(--accent);border-color:var(--accent);color:#000;font-weight:600;}
  .btn-primary:hover{background:#00e5ab;border-color:#00e5ab;}
  .btn-ghost{background:transparent;border-color:var(--border);color:var(--text-dim);}
  .btn-ghost:hover{border-color:var(--text-muted);color:var(--text);}
  .btn-danger{background:transparent;border-color:rgba(239,68,68,.3);color:var(--danger);}
  .btn-danger:hover{background:rgba(239,68,68,.1);}
  .btn-sm{padding:4px 10px;font-size:11px;}
  .btn:disabled{opacity:.4;cursor:not-allowed;}

  .toggle{position:relative;display:inline-block;width:36px;height:20px;}
  .toggle input{opacity:0;width:0;height:0;}
  .toggle-track{
    position:absolute;cursor:pointer;inset:0;
    background:var(--surface2);border:1px solid var(--border);
    border-radius:20px;transition:.2s;
  }
  .toggle-track:before{
    content:'';position:absolute;height:14px;width:14px;
    left:2px;top:2px;background:var(--text-muted);
    border-radius:50%;transition:.2s;
  }
  .toggle input:checked+.toggle-track{background:var(--accent-dim);border-color:var(--accent);}
  .toggle input:checked+.toggle-track:before{transform:translateX(16px);background:var(--accent);}

  .overlay{
    position:fixed;inset:0;background:rgba(0,0,0,.75);
    display:none;align-items:center;justify-content:center;
    z-index:100;backdrop-filter:blur(4px);
  }
  .overlay.open{display:flex;}
  .modal{
    background:var(--surface);border:1px solid var(--border);
    border-radius:8px;box-shadow:0 4px 40px rgba(0,0,0,.6);
    width:680px;max-width:95vw;max-height:92vh;
    display:flex;flex-direction:column;
  }
  .modal-head{
    padding:20px 24px 16px;border-bottom:1px solid var(--border);
    display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
  }
  .modal-title{font-weight:600;font-size:15px;}
  .modal-close{
    width:28px;height:28px;border-radius:4px;border:1px solid var(--border);
    background:transparent;color:var(--text-dim);cursor:pointer;
    font-size:16px;display:flex;align-items:center;justify-content:center;
  }
  .modal-close:hover{color:var(--text);border-color:var(--text-muted);}
  .modal-body{padding:20px 24px;overflow-y:auto;flex:1;}
  .modal-foot{
    padding:16px 24px;border-top:1px solid var(--border);
    display:flex;gap:10px;justify-content:flex-end;flex-shrink:0;
  }

  .field{margin-bottom:16px;}
  .field-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;}
  .field-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:16px;}
  label.field-label{
    display:block;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;
    color:var(--text-dim);font-family:var(--mono);margin-bottom:6px;
  }
  .field input,.field select,.field textarea{
    width:100%;background:var(--bg);border:1px solid var(--border);
    border-radius:var(--r);color:var(--text);font-size:13px;
    padding:8px 12px;font-family:var(--sans);transition:border-color .15s;outline:none;
  }
  .field input:focus,.field select:focus,.field textarea:focus{border-color:var(--accent);}
  .field textarea{resize:vertical;min-height:130px;font-family:var(--mono);font-size:12px;line-height:1.6;}
  .field select option{background:var(--surface2);}
  .field-hint{font-size:11px;color:var(--text-muted);margin-top:4px;}

  .section-sep{
    font-size:10px;letter-spacing:2px;text-transform:uppercase;
    color:var(--text-muted);font-family:var(--mono);
    margin:20px 0 14px;padding-bottom:8px;
    border-bottom:1px solid var(--border);
  }

  .llm-grid{display:grid;grid-template-columns:160px 1fr;gap:14px;margin-bottom:16px;}
  .llm-fields{display:grid;gap:12px;}

  .slider-row{display:flex;align-items:center;gap:12px;}
  .slider-row input[type=range]{flex:1;accent-color:var(--accent);}
  .slider-val{font-family:var(--mono);font-size:12px;color:var(--accent);min-width:36px;text-align:right;}

  /* Tool assignment inside agent modal */
  .tool-assign-row{
    display:flex;align-items:flex-start;gap:0;
    background:var(--bg);border:1px solid var(--border);border-radius:var(--r);
    margin-bottom:8px;overflow:hidden;
    transition:border-color .15s;
  }
  .tool-assign-row:focus-within{border-color:var(--accent);}
  .tool-assign-check{
    display:flex;align-items:center;gap:10px;
    padding:10px 14px;cursor:pointer;flex:0 0 auto;min-width:200px;
    border-right:1px solid var(--border);
  }
  .tool-assign-check input[type=checkbox]{accent-color:var(--accent);width:14px;height:14px;cursor:pointer;}
  .tool-assign-name{font-size:12px;font-weight:500;}
  .tool-assign-meta{font-size:10px;color:var(--text-dim);font-family:var(--mono);}
  .tool-assign-config{flex:1;padding:10px 14px;display:none;}
  .tool-assign-config.visible{display:block;}
  .tool-assign-config label{font-size:10px;color:var(--text-dim);font-family:var(--mono);letter-spacing:1px;text-transform:uppercase;display:block;margin-bottom:5px;}
  .tool-assign-config select{
    width:100%;background:var(--surface2);border:1px solid var(--border);
    border-radius:4px;color:var(--text);font-size:12px;padding:6px 10px;
    font-family:var(--mono);outline:none;
  }
  .tool-assign-config select:focus{border-color:var(--accent);}
  .collection-loading{font-size:11px;color:var(--text-muted);font-family:var(--mono);padding:4px 0;}

  /* Tool card config fields */
  .config-fields{display:flex;flex-direction:column;gap:10px;}
  .config-field{display:grid;grid-template-columns:130px 1fr;gap:10px;align-items:center;}
  .config-field label{font-size:11px;color:var(--text-dim);font-family:var(--mono);}
  .config-field input{
    width:100%;background:var(--bg);border:1px solid var(--border);
    border-radius:var(--r);color:var(--text);font-size:12px;
    padding:6px 10px;font-family:var(--mono);outline:none;
  }
  .config-field input:focus{border-color:var(--accent);}

  .divider{border:none;border-top:1px solid var(--border);margin:16px 0;}

  .tvar{
    font-size:10px;font-family:var(--mono);
    color:var(--accent2);background:rgba(77,159,255,.08);
    border:1px solid rgba(77,159,255,.25);border-radius:3px;
    padding:2px 7px;letter-spacing:.3px;
  }

  .toast{
    position:fixed;bottom:24px;right:24px;z-index:200;
    background:var(--surface2);border:1px solid var(--border);
    padding:10px 18px;border-radius:var(--r);font-size:12px;color:var(--text);
    transform:translateY(80px);opacity:0;transition:all .25s;pointer-events:none;
  }
  .toast.show{transform:translateY(0);opacity:1;}
  .toast.ok{border-color:var(--accent);color:var(--accent);}
  .toast.err{border-color:var(--danger);color:var(--danger);}

  .empty{text-align:center;padding:60px 24px;color:var(--text-muted);font-size:13px;}
  .empty-icon{font-size:32px;margin-bottom:12px;opacity:.4;}

  /* Debug log */
  .log-entry{
    background:var(--surface);border:1px solid var(--border);
    border-radius:var(--r);overflow:hidden;
  }
  .log-entry.err{border-color:rgba(239,68,68,.35);}
  .log-entry.override{border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.03);}
  .log-dot.override{background:var(--warn);}
  .override-badge{
    font-size:9px;font-family:var(--mono);font-weight:700;letter-spacing:1px;
    color:var(--warn);border:1px solid rgba(245,158,11,.4);
    background:rgba(245,158,11,.1);border-radius:3px;
    padding:1px 6px;flex-shrink:0;
  }
  .log-entry-head{
    display:flex;align-items:center;gap:10px;
    padding:8px 14px;cursor:pointer;user-select:none;
  }
  .log-entry-head:hover{background:var(--surface2);}
  .log-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
  .log-dot.ok{background:var(--accent);}
  .log-dot.err{background:var(--danger);}
  .log-agent{font-size:11px;font-family:var(--mono);color:var(--accent);font-weight:600;flex-shrink:0;}
  .log-agent.coord{color:var(--accent2);}
  .log-tool{font-size:11px;font-family:var(--mono);color:var(--accent2);flex-shrink:0;}
  .log-preview{font-size:11px;color:var(--text-dim);font-family:var(--mono);
    overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1;min-width:0;}
  .log-meta{font-size:10px;color:var(--text-muted);font-family:var(--mono);flex-shrink:0;}
  .log-body{
    display:none;padding:12px 14px;border-top:1px solid var(--border);
    background:var(--bg);
  }
  .log-body.open{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  .log-section-label{
    font-size:10px;letter-spacing:1.5px;text-transform:uppercase;
    color:var(--text-muted);font-family:var(--mono);margin-bottom:6px;
  }
  .log-code{
    font-size:11px;font-family:var(--mono);color:var(--text);
    background:var(--surface2);border:1px solid var(--border);
    border-radius:4px;padding:8px 10px;
    white-space:pre-wrap;word-break:break-all;
    max-height:200px;overflow-y:auto;
  }
</style>
</head>
<body>
<div class="app">

  <div class="topbar">
    <div class="logo">ORCHEST<span>RAIL</span></div>
    <div style="width:1px;height:20px;background:var(--border)"></div>
    <div class="status-label" id="status-label">connecting...</div>
    <div class="status-dot" id="status-dot"></div>
  </div>

  <div class="tabs-bar">
    <button class="tab-btn active" onclick="switchTab('agents',this)">Agents</button>
    <button class="tab-btn" onclick="switchTab('tools',this)">Tools</button>
    <button class="tab-btn" onclick="switchTab('coordinator',this)">Coordinator</button>
    <button class="tab-btn" onclick="switchTab('debug',this)">Debug</button>
  </div>

  <div class="content">
    <div class="tab-panel active" id="tab-agents">
      <div class="section-head">
        <div class="section-title">Agent Configuration</div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-ghost btn-sm" onclick="exportAgents()" title="Download agents as JSON">&#8659; Export</button>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer" title="Import agents from JSON">
            &#8657; Import
            <input type="file" id="import-file" accept=".json" style="display:none" onchange="importAgents(this)">
          </label>
          <button class="btn btn-primary btn-sm" onclick="openAgentModal(null)">+ Add Agent</button>
        </div>
      </div>
      <div class="cards" id="agents-grid"></div>
    </div>

    <div class="tab-panel" id="tab-tools">
      <div class="section-head">
        <div class="section-title">Tool Registry</div>
        <button class="btn btn-primary btn-sm" onclick="openToolModal(null)">+ Add Tool</button>
      </div>
      <div class="cards" id="tools-grid"></div>
    </div>

    <div class="tab-panel" id="tab-coordinator">
      <div class="section-head">
        <div class="section-title">Coordinator LLM</div>
        <button class="btn btn-primary btn-sm" onclick="saveCoordinator()">Save</button>
      </div>
      <div style="max-width:640px">
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:20px;line-height:1.6">
          The coordinator handles goal decomposition, clarification intake, and final synthesis.
          It runs before and after the agent team — configure it independently of individual agents.
          <br><br>
          <span style="color:var(--text-muted)">&#9432;</span>
          <span style="color:var(--text-muted)">
            <strong style="color:var(--text-dim)">Dispatch:</strong> the coordinator receives the user goal, breaks it into tasks, and assigns each task to an agent.
            <strong style="color:var(--text-dim)">Synthesis:</strong> once all agents complete, the coordinator collects their outputs and writes the final unified response.
            Both steps use this LLM — choose a model with strong instruction-following and long-context capability.
          </span>
        </div>
        <div class="card" style="padding:24px">
          <div class="section-sep" style="margin-top:0">LLM Target</div>
          <div class="llm-grid">
            <div class="field" style="margin:0">
              <label class="field-label">Provider</label>
              <select id="c-provider" onchange="onCoordProviderChange()">
                <option value="local">Local (Ollama)</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div class="llm-fields">
              <div id="coord-url-row" class="field" style="margin:0">
                <label class="field-label">Base URL</label>
                <input type="text" id="c-llm-url" placeholder="http://ip:11434/v1">
              </div>
              <div class="field-row" style="margin:0">
                <div class="field" style="margin:0">
                  <label class="field-label">API Key</label>
                  <input type="password" id="c-llm-key" placeholder="ollama / sk-...">
                </div>
                <div class="field" style="margin:0">
                  <label class="field-label">Model</label>
                  <select id="c-model"></select>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="card" style="padding:24px;margin-top:16px">
          <div class="section-sep" style="margin-top:0">Inference Flags</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px;line-height:1.6">
            Flags are prepended to every system prompt — coordinator <em>and</em> all agents — so you never have to touch individual prompts.
            Only one thinking flag should be active at a time.
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--text)">
              <input type="checkbox" id="flag-no-think" onchange="onFlagChange('flag-no-think','flag-think')"
                style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer">
              <span><code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-size:12px">/no_think</code>
                &nbsp;Disable thinking / reasoning mode <span style="color:var(--text-muted)">(Qwen3, Gemma4)</span></span>
            </label>
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--text)">
              <input type="checkbox" id="flag-think" onchange="onFlagChange('flag-think','flag-no-think')"
                style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer">
              <span><code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-size:12px">/think</code>
                &nbsp;Force thinking / reasoning mode <span style="color:var(--text-muted)">(Qwen3, Gemma4)</span></span>
            </label>
          </div>
          <div class="field" style="margin:0">
            <label class="field-label">Custom Flags <span style="color:var(--text-muted);font-weight:400">(one per line)</span></label>
            <textarea id="flag-custom" rows="3" placeholder="e.g. /no_think" style="width:100%;resize:vertical;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:13px;font-family:var(--mono);padding:8px 12px;outline:none;transition:border-color .15s;box-sizing:border-box"></textarea>
            <div class="field-hint">Added after checkbox flags. Avoid duplicating flags already checked above.</div>
          </div>
        </div>

        <!-- DECOMPOSITION PROMPT -->
        <div class="card" style="padding:24px;margin-top:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div class="section-sep" style="margin:0;border:none">Decomposition Prompt</div>
            <button class="btn btn-ghost btn-sm" onclick="resetPrompt('c-decomposition-prompt','decompositionPrompt')">Reset to default</button>
          </div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;line-height:1.6">
            Called once when a goal arrives. The coordinator reads this prompt to decide whether to use
            <strong style="color:var(--text)">PIPELINE</strong> (design ? implement ? review ? test) or
            <strong style="color:var(--text)">PARALLEL</strong> (independent tasks), then produces a JSON task plan.
            The agent roster and pipeline example are injected at runtime via template variables —
            always keep <code style="background:var(--bg);padding:1px 5px;border-radius:3px">{{AGENT_ROSTER}}</code> and
            <code style="background:var(--bg);padding:1px 5px;border-radius:3px">{{PIPELINE_EXAMPLE}}</code>
            or the coordinator won't know who to assign work to.
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
            <span style="font-size:10px;color:var(--text-muted);font-family:var(--mono);padding-top:2px">Available vars:</span>
            <code class="tvar">{{AGENT_ROSTER}}</code>
            <code class="tvar">{{PIPELINE_EXAMPLE}}</code>
            <code class="tvar">{{AGENT_COUNT}}</code>
            <code class="tvar">{{AGENT_NAMES}}</code>
          </div>
          <div class="field" style="margin:0">
            <textarea id="c-decomposition-prompt" rows="18"
              placeholder="Leave blank to use built-in default, or click Reset to default to load and edit it."
              style="width:100%;resize:vertical;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:12px;font-family:var(--mono);padding:8px 12px;outline:none;transition:border-color .15s;line-height:1.6;box-sizing:border-box"></textarea>
            <div class="field-hint">Blank = use built-in default. When set, {{AGENT_ROSTER}} and {{PIPELINE_EXAMPLE}} are substituted at runtime before the prompt is sent.</div>
          </div>
        </div>

        <!-- ROUTING PROMPT -->
        <div class="card" style="padding:24px;margin-top:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div class="section-sep" style="margin:0;border:none">Routing Prompt</div>
            <button class="btn btn-ghost btn-sm" onclick="resetPrompt('c-routing-prompt','routingPrompt')">Reset to default</button>
          </div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;line-height:1.6">
            Called after every pipeline stage completes. The coordinator reads the stage output and decides:
            <strong style="color:var(--text)">NEXT</strong> (proceed),
            <strong style="color:var(--text)">ESCALATE</strong> (send for fixes),
            <strong style="color:var(--text)">REWIND</strong> (re-run a prior stage),
            or <strong style="color:var(--text)">SYNTHESIZE</strong> (skip remaining and finalize).
            The goal, remaining stages, and completed stage list are injected at runtime — use the vars below to position them in the prompt.
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
            <span style="font-size:10px;color:var(--text-muted);font-family:var(--mono);padding-top:2px">Available vars:</span>
            <code class="tvar">{{AGENT_ROSTER}}</code>
            <code class="tvar">{{GOAL}}</code>
            <code class="tvar">{{REMAINING_STAGES}}</code>
            <code class="tvar">{{COMPLETED_STAGES}}</code>
          </div>
          <div class="field" style="margin:0">
            <textarea id="c-routing-prompt" rows="16"
              placeholder="Leave blank to use built-in default, or click Reset to default to load and edit it."
              style="width:100%;resize:vertical;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:12px;font-family:var(--mono);padding:8px 12px;outline:none;transition:border-color .15s;line-height:1.6;box-sizing:border-box"></textarea>
            <div class="field-hint">Blank = use built-in default. {{REMAINING_STAGES}} and {{COMPLETED_STAGES}} expand to formatted stage lists. The stage output and routing question arrive in the user message automatically.</div>
          </div>
        </div>

        <!-- CLARIFICATION PROMPT -->
        <div class="card" style="padding:24px;margin-top:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div class="section-sep" style="margin:0;border:none">Clarification Prompt</div>
            <button class="btn btn-ghost btn-sm" onclick="resetPrompt('c-clarification-prompt','clarificationPrompt')">Reset to default</button>
          </div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;line-height:1.6">
            Run before any agent work begins, on the first message only. The coordinator analyzes the incoming goal
            and responds with either <strong style="color:var(--text)">PROCEED</strong> (start work immediately) or
            <strong style="color:var(--text)">CLARIFY</strong> followed by up to 4 numbered questions.
            Only questions that would change the architecture or task structure should be asked.
            No template variables — the goal arrives in the user message.
          </div>
          <div class="field" style="margin:0">
            <textarea id="c-clarification-prompt" rows="14"
              placeholder="Leave blank to use built-in default, or click Reset to default to load and edit it."
              style="width:100%;resize:vertical;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:12px;font-family:var(--mono);padding:8px 12px;outline:none;transition:border-color .15s;line-height:1.6;box-sizing:border-box"></textarea>
            <div class="field-hint">Blank = use built-in default. Must respond with PROCEED or CLARIFY (followed by numbered questions) — any other response is treated as PROCEED.</div>
          </div>
        </div>

        <!-- SYNTHESIS PROMPT -->
        <div class="card" style="padding:24px;margin-top:16px;margin-bottom:24px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div class="section-sep" style="margin:0;border:none">Synthesis Prompt</div>
            <button class="btn btn-ghost btn-sm" onclick="resetPrompt('c-synthesis-prompt','synthesisPrompt')">Reset to default</button>
          </div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;line-height:1.6">
            Called after all agents complete (or after SYNTHESIZE routing) to assemble the final response.
            The original goal and all agent outputs arrive in the user message automatically —
            this system prompt controls how they're combined.
            The built-in default instructs the synthesizer to reproduce implementation code verbatim
            and not rewrite or simplify it — override here to change that behavior.
            No template variables needed.
          </div>
          <div class="field" style="margin:0">
            <textarea id="c-synthesis-prompt" rows="10"
              placeholder="Leave blank to use built-in default, or click Reset to default to load and edit it."
              style="width:100%;resize:vertical;background:var(--bg);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:12px;font-family:var(--mono);padding:8px 12px;outline:none;transition:border-color .15s;line-height:1.6;box-sizing:border-box"></textarea>
            <div class="field-hint">Blank = use built-in default. The user message always contains the goal and all specialist results — only the system-level behavior needs to be set here.</div>
          </div>
        </div>

      </div>
    </div>

    <div class="tab-panel" id="tab-debug">
      <div class="section-head">
        <div class="section-title">Tool Execution Log</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span id="debug-status" style="font-size:11px;color:var(--text-muted);font-family:var(--mono)">idle</span>
          <button class="btn btn-ghost btn-sm" onclick="exportDebugLog()">Export</button>
          <button class="btn btn-ghost btn-sm" onclick="clearDebugLog()">Clear</button>
        </div>
      </div>
      <div id="debug-log" style="display:flex;flex-direction:column;gap:8px;"></div>
    </div>
  </div>
</div>

<!-- AGENT MODAL -->
<div class="overlay" id="agent-overlay" onclick="maybeCloseAgent(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-head">
      <div class="modal-title" id="agent-modal-title">Edit Agent</div>
      <button class="modal-close" onclick="closeAgentModal()">&#x2715;</button>
    </div>
    <div class="modal-body">

      <div class="field">
        <label class="field-label">Agent Name</label>
        <input type="text" id="a-name" placeholder="e.g. power-analyst">
        <div class="field-hint">Slug format, no spaces. Used as assignee ID by the coordinator.</div>
      </div>

      <div class="section-sep">LLM Target</div>

      <div class="llm-grid">
        <div class="field" style="margin:0">
          <label class="field-label">Provider</label>
          <select id="a-provider" onchange="onProviderChange()">
            <option value="local">Local (Ollama)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div class="llm-fields">
          <div id="llm-url-row" class="field" style="margin:0">
            <label class="field-label">Base URL</label>
            <input type="text" id="a-llm-url" placeholder="http://ip:11434/v1">
          </div>
          <div class="field-row" style="margin:0">
            <div class="field" style="margin:0">
              <label class="field-label">API Key</label>
              <input type="password" id="a-llm-key" placeholder="ollama / sk-...">
            </div>
            <div class="field" style="margin:0">
              <label class="field-label">Model</label>
              <select id="a-model"></select>
            </div>
          </div>
        </div>
      </div>

      <div class="section-sep">Parameters</div>

      <div class="field-row">
        <div class="field" style="margin:0">
          <label class="field-label">Max Tokens</label>
          <input type="number" id="a-maxtokens" value="4096" min="256" max="32768" step="256">
        </div>
        <div class="field" style="margin:0">
          <label class="field-label">Temperature &nbsp;<span id="a-temp-val" style="color:var(--accent);font-family:var(--mono)">0.00</span></label>
          <div class="slider-row" style="margin-top:8px">
            <input type="range" id="a-temp-range" min="0" max="2" step="0.05" value="0"
              oninput="document.getElementById('a-temp-val').textContent=parseFloat(this.value).toFixed(2);document.getElementById('a-temp').value=this.value">
            <span style="font-size:11px;color:var(--text-muted);font-family:var(--mono)">2.0</span>
          </div>
          <input type="hidden" id="a-temp" value="0">
        </div>
        <div class="field" style="margin:0">
          <label class="field-label">Pipeline Order</label>
          <input type="number" id="a-order" placeholder="e.g. 1" min="1" max="99" step="1">
          <div class="field-hint">Stage sequence (1=first). Leave blank to use list order.</div>
        </div>
      </div>

      <div class="section-sep">System Prompt</div>

      <div class="field">
        <textarea id="a-prompt" rows="8" placeholder="You are a specialist in..."></textarea>
      </div>

      <div class="section-sep">Tools</div>

      <div id="a-tools-list">
        <div style="color:var(--text-muted);font-size:12px">No tools configured. Add tools in the Tools tab first.</div>
      </div>

    </div>

    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeAgentModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveAgent()">Save Agent</button>
    </div>
  </div>
</div>

<!-- TOOL MODAL -->
<div class="overlay" id="tool-overlay" onclick="maybeCloseTool(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-head">
      <div class="modal-title" id="tool-modal-title">Edit Tool</div>
      <button class="modal-close" onclick="closeToolModal()">&#x2715;</button>
    </div>
    <div class="modal-body">
      <div class="field-row">
        <div class="field" style="margin:0">
          <label class="field-label">Tool ID</label>
          <input type="text" id="t-id" placeholder="e.g. qdrant-rag">
        </div>
        <div class="field" style="margin:0">
          <label class="field-label">Display Name</label>
          <input type="text" id="t-name" placeholder="e.g. Qdrant RAG">
        </div>
      </div>

      <div class="field-row" style="margin-top:16px">
        <div class="field" style="margin:0">
          <label class="field-label">Type</label>
          <select id="t-type" onchange="renderToolConfigFields()">
            <option value="qdrant_rag">qdrant_rag — Qdrant Vector Search</option>
            <option value="openai_tools">openai_tools — OpenAI Tools Endpoint</option>
          </select>
        </div>
        <div class="field" style="margin:0;display:flex;align-items:center;gap:12px;padding-top:22px">
          <label style="font-size:13px;color:var(--text)">Enabled</label>
          <label class="toggle">
            <input type="checkbox" id="t-enabled">
            <span class="toggle-track"></span>
          </label>
        </div>
      </div>

      <hr class="divider">

      <div class="field">
        <label class="field-label">Configuration</label>
        <div class="config-fields" id="tool-config-fields"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeToolModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveTool()">Save Tool</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var agents = [];
var tools  = [];
var ollamaModels = [];
var editingAgentName = null;
var editingToolId = null;

var PROVIDER_DEFAULTS = {
  local:     { url: 'http://host.docker.internal:11434/v1', key: 'ollama' },
  openai:    { url: 'https://api.openai.com/v1',  key: '' },
  anthropic: { url: 'https://api.anthropic.com/v1', key: '' },
  custom:    { url: '', key: '' },
};

var TOOL_SCHEMAS = {
  qdrant_rag:   [['url','Qdrant URL'],['embeddingUrl','TEI Embedding URL']],
  openai_tools: [['url','Endpoint URL'],['apiKey','API Key']],
};

var AGENT_ICONS = ['??','?','???','??','??','???','???','??','??','??'];

// -- Init ----------------------------------------------------------------------

window.onload = function() {
  checkStatus();
  startDebugPoll();
  // loadModels must complete before loadCoordinator so the model dropdown
  // has the full Ollama list rather than just the currently-saved model.
  loadModels().then(function() {
    Promise.all([loadAgents(), loadTools(), loadCoordinator(), loadCoordinatorDefaults()]);
  });
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
  return fetch('/api/ollama/models').then(function(r){return r.json();}).then(function(data){
    ollamaModels = Array.isArray(data) ? data : [];
  }).catch(function(){ ollamaModels = []; });
}

function loadAgents() {
  return fetch('/api/agents').then(function(r){return r.json();}).then(function(data){
    agents = data; renderAgents(); wireAgentGrid();
  });
}

function loadTools() {
  return fetch('/api/tools').then(function(r){return r.json();}).then(function(data){
    tools = data; renderTools(); wireToolGrid();
  });
}

function loadCoordinator() {
  return fetch('/api/coordinator').then(function(r){return r.json();}).then(function(data){
    renderCoordinator(data);
  }).catch(function(){});
}

// -- Debug log -----------------------------------------------------------------

var debugPollTimer = null;
var debugLastTs = 0;
var debugEntries = [];

function startDebugPoll() {
  if (debugPollTimer) return;   // already running
  pollDebugLog();
  debugPollTimer = setInterval(pollDebugLog, 1000);
}

function pollDebugLog() {
  fetch('/api/tool-log?since=' + debugLastTs)
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (!Array.isArray(data) || !data.length) return;
      // data is newest-first; find any entries newer than our cursor
      var fresh = data.filter(function(e){ return e.ts > debugLastTs; });
      if (!fresh.length) return;
      debugLastTs = fresh[0].ts;
      // prepend to local buffer, trim to max
      debugEntries = fresh.concat(debugEntries);
      renderDebugLog();
      document.getElementById('debug-status').textContent = 'last update: ' + new Date().toLocaleTimeString();
    })
    .catch(function(){});
}

function renderDebugLog() {
  var container = document.getElementById('debug-log');
  if (!debugEntries.length) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">??</div>No tool calls yet. Run a prompt to see activity here.</div>';
    return;
  }
  container.innerHTML = debugEntries.map(function(e) {
    var isCoord   = e.agent === 'coordinator';
    var parsed    = null;
    try { parsed = JSON.parse(e.result); } catch(x) {}
    var isOverride = isCoord && e.tool === 'route' && parsed && parsed.override === true;

    var statusCls = isOverride ? 'override' : (e.ok ? 'ok' : 'err');
    var dotCls    = isOverride ? 'override' : (e.ok ? 'ok' : 'err');
    var entryCls  = isOverride ? 'log-entry override' : ('log-entry' + (e.ok ? '' : ' err'));
    var agentCls  = isCoord ? 'log-agent coord' : 'log-agent';

    var argsStr   = JSON.stringify(e.args, null, 2);
    var resultStr = isCoord ? JSON.stringify(parsed, null, 2) : tryPrettyJson(e.result);
    var preview   = isCoord
      ? buildCoordPreview(e.tool, parsed)
      : resultStr.split(String.fromCharCode(10)).join(' ').slice(0, 120);
    var timeStr   = new Date(e.ts).toLocaleTimeString();

    return '<div class="' + entryCls + '" id="le-' + e.id + '">' +
      '<div class="log-entry-head" onclick="toggleLogEntry(\\'' + e.id + '\\')">' +
        '<div class="log-dot ' + dotCls + '"></div>' +
        '<span class="' + agentCls + '">' + esc(e.agent) + '</span>' +
        '<span style="color:var(--text-muted);font-size:11px;font-family:var(--mono)">›</span>' +
        '<span class="log-tool">' + esc(e.tool) + '</span>' +
        (isOverride ? '<span class="override-badge">OVERRIDE</span>' : '') +
        '<span class="log-preview">' + esc(preview) + '</span>' +
        '<span class="log-meta">' + e.durationMs + 'ms &nbsp; ' + timeStr + '</span>' +
      '</div>' +
      '<div class="log-body" id="lb-' + e.id + '">' +
        '<div>' +
          '<div class="log-section-label">Input</div>' +
          '<div class="log-code">' + esc(argsStr) + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="log-section-label">Decision</div>' +
          '<div class="log-code">' + esc(resultStr || e.result) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function buildCoordPreview(tool, parsed) {
  if (!parsed) return '(no result)';
  if (tool === 'clarify')    return parsed.decision + (parsed.decision === 'CLARIFY' ? ': ' + (parsed.questions||'').slice(0,80) : '');
  if (tool === 'decompose')  return parsed.mode + ' — ' + (parsed.stages||parsed.tasks||[]).map(function(s){ return s.assignee||s; }).join(' ? ');
  if (tool === 'route')      return parsed.action + (parsed.override ? ' [overrode ' + (parsed.note||'agent signal') + ']' : '') + (parsed.reason ? ' — ' + parsed.reason.slice(0,80) : '');
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
    // If result has an output field (code execution), surface that directly
    if (parsed && typeof parsed === 'object') {
      if (parsed.output !== undefined) return String(parsed.output || '(no output)');
      if (parsed.results) return JSON.stringify(parsed.results, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  } catch(e) {
    return str;
  }
}

function exportDebugLog() {
  fetch('/api/tool-log')
    .then(function(r){ return r.json(); })
    .then(function(data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href   = url;
      a.download = 'tool-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click();
      URL.revokeObjectURL(url);
      toast('Log exported', 'ok');
    })
    .catch(function(e){ toast('Export failed: ' + e.message, 'err'); });
}

function clearDebugLog() {
  fetch('/api/tool-log', { method: 'DELETE' })
    .then(function(){ debugEntries = []; debugLastTs = 0; renderDebugLog(); toast('Log cleared', 'ok'); })
    .catch(function(e){ toast('Clear failed: ' + e.message, 'err'); });
}

var coordinatorDefaults = {};

function loadCoordinatorDefaults() {
  return fetch('/api/coordinator/defaults')
    .then(function(r){ return r.json(); })
    .then(function(d){ coordinatorDefaults = d; })
    .catch(function(){});
}

function resetPrompt(textareaId, key) {
  var val = coordinatorDefaults[key];
  if (!val) { toast('Defaults not loaded yet','err'); return; }
  document.getElementById(textareaId).value = val;
  toast('Reset to default — remember to Save','ok');
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
    opt.value = '__custom__'; opt.textContent = '— enter model name below —';
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
  };
  fetch('/api/coordinator', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.error) { toast(d.error,'err'); return; }
      toast('Coordinator saved','ok');
    })
    .catch(function(e){ toast('Save failed: '+e.message,'err'); });
}

// -- Tabs ----------------------------------------------------------------------

function switchTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active');});
  document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});
  btn.classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
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
        '<div class="card-icon">'+AGENT_ICONS[i%AGENT_ICONS.length]+'</div>' +
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
        '<span class="badge badge-model">'+esc(llm.model||'—')+'</span>' +
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
      if (e[0].toLowerCase().includes('key')||e[0].toLowerCase().includes('token')) v = v?'••••••':'(not set)';
      return esc(e[0])+': '+esc(v||'(empty)');
    }).join(' &nbsp;·&nbsp; ');
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
    models = ollamaModels.length ? ollamaModels : (currentModel ? [currentModel] : ['llama3.2']);
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
    custom.value = '__custom__'; custom.textContent = '— enter model name below —';
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
            '<option value="">— loading collections... —</option>' +
          '</select>' +
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
  });
}

function onToolToggle(toolId) {
  var checked  = document.getElementById('tc-'+toolId).checked;
  var configEl = document.getElementById('tool-config-'+toolId);
  if (configEl) {
    configEl.className = 'tool-assign-config ' + (checked ? 'visible' : '');
    if (checked) loadCollections(toolId, '');
  }
}

function loadCollections(toolId, selectedCollection) {
  var selEl = document.getElementById('col-sel-'+toolId);
  if (!selEl) return;
  selEl.innerHTML = '<option value="">loading...</option>';

  fetch('/api/qdrant/collections?toolId='+encodeURIComponent(toolId))
    .then(function(r){ return r.json(); })
    .then(function(data) {
      if (data.error) { selEl.innerHTML = '<option value="">'+esc(data.error)+'</option>'; return; }
      var cols = Array.isArray(data) ? data : [];
      if (!cols.length) { selEl.innerHTML = '<option value="">(no collections found)</option>'; return; }
      selEl.innerHTML = '<option value="">— pick collection —</option>' +
        cols.map(function(c) {
          return '<option value="'+esc(c)+'" '+(c===selectedCollection?'selected':'')+'>'+esc(c)+'</option>';
        }).join('');
    })
    .catch(function(e) {
      selEl.innerHTML = '<option value="">(Qdrant unreachable)</option>';
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
  };

  var method = editingAgentName ? 'PUT' : 'POST';
  var url    = editingAgentName ? '/api/agents/'+encodeURIComponent(editingAgentName) : '/api/agents';

  fetch(url, { method: method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
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
  fetch('/api/agents/'+encodeURIComponent(name),{method:'DELETE'})
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
        return fetch('/api/agents', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(a) }).then(function(r){ return r.json(); });
      })).then(function(results) {
        var failed = results.filter(function(r) { return r.error; });
        if (failed.length) toast(failed.length + ' failed to import', 'err');
        else toast('Imported ' + toAdd.length + ' agent(s)', 'ok');
        loadAgents();
      }).catch(function(e) { toast('Import error: ' + e.message, 'err'); });
    } else {
      if (!confirm('Replace ALL ' + agents.length + ' existing agent(s) with ' + parsed.length + ' from file?')) return;
      fetch('/api/agents', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(parsed) })
        .then(function(r){ return r.json(); })
        .then(function(d) { if (d.error) { toast(d.error,'err'); return; } toast('Replaced all agents (' + parsed.length + ' imported)','ok'); loadAgents(); })
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
</script>
</body>
</html>`;
